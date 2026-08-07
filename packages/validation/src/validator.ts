import { createHash, randomBytes } from "node:crypto";
import { chmod, lstat, mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { isAbsolute, join, relative, sep } from "node:path";
import {
  type ExecutedArtifactObservation,
  type ExpectedValidationExecution,
  expectedValidationExecutionSchema,
  type MigrationArtifact,
  type MigrationCandidate,
  migrationCandidateFingerprint,
  migrationCandidateSchema,
  sha256,
  stableJson,
  type ValidationCheckName,
  type ValidatorCommandId,
  validationArtifactSetFingerprint,
  validationOutputFingerprint,
} from "@lineageguard/domain";
import { Client, type ClientConfig, type QueryResult } from "pg";
import {
  type CommandResult,
  type CommandRunner,
  type FixedCommand,
  SpawnCommandRunner,
} from "./command-runner.js";
import { ValidationError } from "./errors.js";
import {
  type MaterializedCandidateHandle,
  observeMaterializedArtifacts,
  requireMaterialization,
  snapshotMaterializedArtifacts,
} from "./materializer.js";

export interface ExecutedCheckEvidence {
  check: ValidationCheckName;
  status: "PASS" | "FAIL";
  summary: string;
  artifactPaths: string[];
  artifactObservations: ExecutedArtifactObservation[];
  artifactSetFingerprint: string;
  validatorImplementationId: string;
  validatorVersion: string;
  validatorDigest: string;
  commandId: ValidatorCommandId;
  exitCode: number;
  startedAt: string;
  finishedAt: string;
  stdoutFingerprint: string;
  stderrFingerprint: string;
  outputFingerprint: string;
  runId: string;
  sandboxId: string;
  worktreeId: string;
  leaseId: string;
  workerId: string;
  generation: number;
}

export interface ValidationExecutionEvidence {
  candidateFingerprint: string;
  baseSha: string;
  checkoutFingerprint: string;
  artifactObservations: ExecutedArtifactObservation[];
  checks: ExecutedCheckEvidence[];
}

export interface ValidationRuntime {
  database: DatabaseConnection;
  dbtProfilesDirectory: string;
  timeoutMs: number;
  maxOutputBytes: number;
}

export interface ValidationRuntimePolicy {
  baseFixtureSql: string;
  dockerExecutable: string;
  validationRunnerImageId: string;
  postgresImageId: string;
  sqlDriverImplementationId: string;
  sqlDriverVersion: string;
  dbtImplementationId: string;
  dbtVersion: string;
  timeoutMs: number;
  maxOutputBytes: number;
}

interface DatabaseConnection {
  host: string;
  port: string;
  user: string;
  password: string;
  database: string;
}

interface CheckDefinition {
  check: ValidationCheckName;
  commandId: ValidatorCommandId;
  validator: "PSQL" | "DBT";
  artifactPaths: string[];
  command: FixedCommand;
}

export const sqlDriverCommand = "lineageguard:postgres-driver:v1";
export const dbtContainerCommand = "lineageguard:dbt-container:v1";
export const sqlDriverDigest = sha256({
  domain: "lineageguard.postgres-server-driver.v1",
  package: "pg",
  version: "8.16.3",
});

export const canonicalValidationChecks = [
  "SQL_MIGRATION",
  "BACKFILL_EQUALITY",
  "DBT_PARSE",
  "DBT_COMPILE",
  "DBT_TEST",
  "OLD_CONSUMER_COMPATIBILITY",
  "NEW_CONSUMER_COMPATIBILITY",
  "ROLLBACK",
] as const satisfies readonly ValidationCheckName[];
const checkOrder = canonicalValidationChecks;
const backfillEqualitySql = [
  "begin;",
  "do $$",
  "declare",
  "  probe_order_id uuid := '00000000-0000-4000-8000-0000000f0001';",
  "  probe_customer_id uuid := '00000000-0000-4000-8000-0000000f0002';",
  "begin",
  "  if exists (select 1 from commerce.orders where customer_id is distinct from buyer_id) then",
  "    raise exception 'existing customer_id/buyer_id mismatch';",
  "  end if;",
  "  insert into commerce.orders (order_id, customer_id) values (probe_order_id, probe_customer_id);",
  "  if exists (select 1 from commerce.orders where order_id = probe_order_id and customer_id is distinct from buyer_id) then",
  "    raise exception 'new customer_id/buyer_id mismatch';",
  "  end if;",
  "end $$;",
  "rollback;",
].join("\n");
const oldConsumerSql =
  "do $$ begin perform customer_id from commerce.orders limit 1; exception when undefined_column then raise exception 'old consumer is broken'; end $$;";
const newConsumerSql =
  "do $$ begin if exists (select 1 from commerce.orders where buyer_id is distinct from customer_id) then raise exception 'new consumer mismatch'; end if; end $$;";
const forbiddenDbtJinja =
  /\b(?:run_query|statement|adapter\s*\.\s*(?:execute|run_sql)|modules\s*\.|load_result)\b|\{%-?\s*do\b/i;

function inside(parent: string, child: string): boolean {
  const path = relative(parent, child);
  return path === "" || (path !== ".." && !path.startsWith(`..${sep}`) && !isAbsolute(path));
}

function pathsFor(candidate: MigrationCandidate, kinds: ReadonlySet<MigrationArtifact["kind"]>) {
  return candidate.artifacts
    .filter((artifact) => kinds.has(artifact.kind))
    .map((artifact) => artifact.path)
    .sort();
}

/** @internal Security parser used before any live validation container is created. */
export function assertSafeDbtProject(candidate: MigrationCandidate): void {
  for (const artifact of candidate.artifacts) {
    if (artifact.kind === "DBT_MODEL" || artifact.kind === "DBT_TEST") {
      const withoutAllowedReferences = artifact.content
        .replace(/\{\{\s*ref\(\s*['"](?:orders|stg_orders)['"]\s*\)\s*\}\}/g, "")
        .replace(/\{\{\s*source\(\s*['"]commerce['"]\s*,\s*['"]orders['"]\s*\)\s*\}\}/g, "");
      if (
        forbiddenDbtJinja.test(artifact.content) ||
        /\{[{%#]|[}%#]\}/.test(withoutAllowedReferences)
      ) {
        throw new ValidationError("COMMAND_FAILED", "dbt artifact contains non-allowlisted Jinja");
      }
    }
  }
}

function sqlCommand(
  checkout: string,
  args: readonly string[],
  timeoutMs: number,
  maxOutputBytes: number,
): FixedCommand {
  return {
    executable: sqlDriverCommand,
    args,
    cwd: checkout,
    timeoutMs,
    maxOutputBytes,
  };
}

function dbt(
  checkout: string,
  runtimeDatabase: DatabaseConnection,
  subcommand: "parse" | "compile" | "build",
  timeoutMs: number,
  maxOutputBytes: number,
): FixedCommand {
  return {
    executable: dbtContainerCommand,
    args: [
      subcommand,
      "--no-use-colors",
      "--project-dir",
      "/work/bundle/project",
      "--profiles-dir",
      "/work/bundle/profiles",
      ...(subcommand === "parse" ? [] : ["--select", "stg_orders+"]),
    ],
    cwd: checkout,
    timeoutMs,
    maxOutputBytes,
    env: {
      DBT_SEND_ANONYMOUS_USAGE_STATS: "false",
      DBT_PGHOST: runtimeDatabase.host,
      DBT_PGPORT: runtimeDatabase.port,
      DBT_PGUSER: runtimeDatabase.user,
      DBT_PGPASSWORD: runtimeDatabase.password,
      DBT_PGDATABASE: runtimeDatabase.database,
    },
  };
}

async function definitions(
  candidate: MigrationCandidate,
  checkout: string,
  runtime: ValidationRuntime,
): Promise<CheckDefinition[]> {
  const timeoutMs = runtime.timeoutMs;
  const maxOutputBytes = runtime.maxOutputBytes;
  const canonicalCheckout = await realpath(checkout);
  const profilesDirectory = await realpath(runtime.dbtProfilesDirectory);
  if (!inside(canonicalCheckout, profilesDirectory)) {
    throw new ValidationError("INVALID_PATH", "dbt profiles must be inside checkout");
  }
  const migrationPaths = pathsFor(candidate, new Set(["SQL_MIGRATION"]));
  const rollbackPaths = pathsFor(candidate, new Set(["ROLLBACK_SQL"]));
  const dbtPaths = pathsFor(candidate, new Set(["DBT_MODEL", "DBT_TEST"]));
  const compatibilityPaths = pathsFor(
    candidate,
    new Set(["SQL_MIGRATION", "DBT_MODEL", "DBT_TEST"]),
  );
  const migration = migrationPaths[0];
  const rollback = rollbackPaths[0];
  if (!migration || migrationPaths.length !== 1 || !rollback || rollbackPaths.length !== 1) {
    throw new ValidationError(
      "ARTIFACT_CONFLICT",
      "P0 requires exactly one migration and rollback",
    );
  }
  const items: CheckDefinition[] = [
    {
      check: "SQL_MIGRATION",
      commandId: "VALIDATE_SQL_MIGRATION_V1",
      validator: "PSQL",
      artifactPaths: migrationPaths,
      command: sqlCommand(checkout, ["--file", migration], timeoutMs, maxOutputBytes),
    },
    {
      check: "BACKFILL_EQUALITY",
      commandId: "VALIDATE_BACKFILL_EQUALITY_V1",
      validator: "PSQL",
      artifactPaths: migrationPaths,
      command: sqlCommand(checkout, ["--command", backfillEqualitySql], timeoutMs, maxOutputBytes),
    },
    {
      check: "DBT_PARSE",
      commandId: "VALIDATE_DBT_PARSE_V1",
      validator: "DBT",
      artifactPaths: dbtPaths,
      command: dbt(checkout, runtime.database, "parse", timeoutMs, maxOutputBytes),
    },
    {
      check: "DBT_COMPILE",
      commandId: "VALIDATE_DBT_COMPILE_V1",
      validator: "DBT",
      artifactPaths: dbtPaths,
      command: dbt(checkout, runtime.database, "compile", timeoutMs, maxOutputBytes),
    },
    {
      check: "DBT_TEST",
      commandId: "VALIDATE_DBT_TEST_V1",
      validator: "DBT",
      artifactPaths: dbtPaths,
      command: dbt(checkout, runtime.database, "build", timeoutMs, maxOutputBytes),
    },
    {
      check: "OLD_CONSUMER_COMPATIBILITY",
      commandId: "VALIDATE_OLD_CONSUMER_V1",
      validator: "PSQL",
      artifactPaths: compatibilityPaths,
      command: sqlCommand(checkout, ["--command", oldConsumerSql], timeoutMs, maxOutputBytes),
    },
    {
      check: "NEW_CONSUMER_COMPATIBILITY",
      commandId: "VALIDATE_NEW_CONSUMER_V1",
      validator: "PSQL",
      artifactPaths: compatibilityPaths,
      command: sqlCommand(checkout, ["--command", newConsumerSql], timeoutMs, maxOutputBytes),
    },
    {
      check: "ROLLBACK",
      commandId: "VALIDATE_ROLLBACK_V1",
      validator: "PSQL",
      artifactPaths: rollbackPaths,
      command: sqlCommand(
        checkout,
        [
          "--command",
          "drop view if exists analytics.orders;",
          "--file",
          rollback,
          "--command",
          "do $$ begin perform customer_id from commerce.orders limit 1; if exists (select 1 from information_schema.columns where table_schema = 'commerce' and table_name = 'orders' and column_name = 'buyer_id') then raise exception 'rollback retained buyer_id'; end if; end $$;",
        ],
        timeoutMs,
        maxOutputBytes,
      ),
    },
  ];
  if (items.some((item, index) => item.check !== checkOrder[index])) {
    throw new ValidationError("ARTIFACT_CONFLICT", "validator check set is not canonical");
  }
  return items;
}

function boundedResult(error: unknown): { result: CommandResult; summary: string } {
  if (error instanceof ValidationError) {
    return {
      result: { exitCode: -1, stdout: "", stderr: error.code },
      summary: `Validator failed closed: ${error.code}`,
    };
  }
  return {
    result: { exitCode: -1, stdout: "", stderr: "UNEXPECTED" },
    summary: "Validator failed closed: UNEXPECTED",
  };
}

export type GeneratedSqlProgram = "EXPAND_MIGRATION" | "ROLLBACK";

/** The only expand program the validator will accept. Exported so recorded examples can be generated from it rather than maintained by hand. */
export const canonicalExpandMigrationSql =
  "alter table commerce.orders add column buyer_id uuid; update commerce.orders set buyer_id = customer_id; create function commerce.sync_order_customer_buyer() returns trigger language plpgsql as $$ begin if tg_op = 'insert' then if new.buyer_id is null and new.customer_id is not null then new.buyer_id := new.customer_id; elsif new.customer_id is null and new.buyer_id is not null then new.customer_id := new.buyer_id; elsif new.customer_id is null and new.buyer_id is null then raise exception 'at least one identifier must be provided'; elsif new.customer_id is distinct from new.buyer_id then raise exception 'customer_id and buyer_id must match during compatibility window'; end if; elsif tg_op = 'update' then if new.customer_id is distinct from old.customer_id and new.buyer_id is not distinct from old.buyer_id then new.buyer_id := new.customer_id; elsif new.buyer_id is distinct from old.buyer_id and new.customer_id is not distinct from old.customer_id then new.customer_id := new.buyer_id; elsif new.customer_id is distinct from old.customer_id and new.buyer_id is distinct from old.buyer_id then if new.customer_id is distinct from new.buyer_id then raise exception 'customer_id and buyer_id must match during compatibility window'; end if; end if; end if; return new; end $$; create trigger orders_customer_buyer_compat before insert or update on commerce.orders for each row execute function commerce.sync_order_customer_buyer(); alter table commerce.orders alter column buyer_id set not null;";
/** The only rollback program the validator will accept. */
export const canonicalRollbackSql =
  "drop trigger orders_customer_buyer_compat on commerce.orders; drop function commerce.sync_order_customer_buyer(); alter table commerce.orders drop column buyer_id cascade; do $$ begin if not exists (select 1 from information_schema.columns where table_schema = 'commerce' and table_name = 'orders' and column_name = 'customer_id') then raise exception 'rollback removed customer_id'; end if; if exists (select 1 from information_schema.columns where table_schema = 'commerce' and table_name = 'orders' and column_name = 'buyer_id') then raise exception 'rollback left buyer_id in place'; end if; end $$;";

function canonicalSqlText(sql: string): string {
  if (
    Buffer.byteLength(sql, "utf8") > 100_000 ||
    sql.includes("\0") ||
    /--|\/\*|\*\/|^\s*\\/m.test(sql)
  ) {
    throw new ValidationError("COMMAND_FAILED", "generated SQL is outside the canonical grammar");
  }
  return sql
    .trim()
    .replace(/\s+/g, " ")
    .replace(/\s*;\s*/g, "; ")
    .trim()
    .toLowerCase();
}

/** @internal Exact allowlist for the sole model-generated P0 migration programs. */
export function assertCanonicalGeneratedSql(sql: string, program: GeneratedSqlProgram): void {
  const expected =
    program === "EXPAND_MIGRATION" ? canonicalExpandMigrationSql : canonicalRollbackSql;
  if (canonicalSqlText(sql) !== canonicalSqlText(expected)) {
    throw new ValidationError("COMMAND_FAILED", "generated SQL is outside the canonical grammar");
  }
}

interface BoundedSqlClient {
  query(sql: string): Promise<QueryResult | QueryResult[]>;
  end(): Promise<void>;
}

function destroyPgClient(client: BoundedSqlClient): void {
  const connection = (client as unknown as { connection?: { stream?: { destroy(): void } } })
    .connection;
  connection?.stream?.destroy();
}

async function withinSqlDeadline<T>(
  client: BoundedSqlClient,
  operation: () => Promise<T>,
  deadlineAt: number,
): Promise<T> {
  const remaining = deadlineAt - Date.now();
  if (remaining <= 0) {
    throw new ValidationError("COMMAND_TIMEOUT", "global validation deadline exceeded");
  }
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      operation(),
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => {
          destroyPgClient(client);
          reject(new ValidationError("COMMAND_TIMEOUT", "global validation deadline exceeded"));
        }, remaining);
        timer.unref?.();
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/** @internal Bounds PostgreSQL client shutdown and destroys the socket on ambiguity. */
export async function endPgClient(client: BoundedSqlClient, deadlineAt: number): Promise<void> {
  await withinSqlDeadline(client, () => client.end(), deadlineAt);
}

/** @internal Executes one non-row-producing statement under the remaining global deadline. */
async function executeBoundedPostgresQuery(
  client: BoundedSqlClient,
  sql: string,
  deadlineAt: number,
): Promise<void> {
  const remaining = deadlineAt - Date.now();
  if (remaining <= 0) {
    throw new ValidationError("COMMAND_TIMEOUT", "global validation deadline exceeded");
  }
  const statementTimeout = Math.max(1, Math.min(15_000, remaining));
  await withinSqlDeadline(
    client,
    () => client.query(`SET statement_timeout='${statementTimeout}ms'`),
    deadlineAt,
  );
  const value = await withinSqlDeadline(client, () => client.query(sql), deadlineAt);
  const results = Array.isArray(value) ? value : [value];
  if (results.some((result) => result.rows.length > 0 || result.fields.length > 0)) {
    throw new ValidationError("COMMAND_FAILED", "generated SQL returned result rows");
  }
}

/** @internal Executes one exact model-generated program after canonical allowlisting. */
export async function executeBoundedServerSql(
  client: BoundedSqlClient,
  sql: string,
  deadlineAt: number,
  program: GeneratedSqlProgram,
): Promise<void> {
  assertCanonicalGeneratedSql(sql, program);
  await executeBoundedPostgresQuery(client, sql, deadlineAt);
}

async function executeBoundedTrustedSql(
  client: BoundedSqlClient,
  sql: string,
  deadlineAt: number,
): Promise<void> {
  await executeBoundedPostgresQuery(client, sql, deadlineAt);
}

class IsolatedValidationRunner implements CommandRunner {
  constructor(
    private readonly delegate: CommandRunner,
    private readonly client: Client,
    private readonly sealedSql: ReadonlyMap<string, { sql: string; program: GeneratedSqlProgram }>,
    private readonly deadlineAt: number,
    private readonly dockerExecutable: string,
    private readonly dockerExecutableDigest: string,
    private readonly validationContainer: string,
    private readonly database: DatabaseConnection,
    private readonly bundleFingerprint: string,
  ) {}

  async #verifyBundle(cwd: string, timeoutMs: number, maxOutputBytes: number): Promise<void> {
    const verifier = [
      "import hashlib,json,pathlib,sys",
      "root=pathlib.Path('/work/bundle')",
      "raw=(root/'manifest.json').read_bytes()",
      "expected=sys.argv[1]",
      "assert hashlib.sha256(raw).hexdigest()==expected",
      "assert (root/'manifest.sha256').read_text().strip()==expected",
      "manifest=json.loads(raw)",
      "wanted={item['path'] for item in manifest['files']}",
      "actual={str(path.relative_to(root)) for path in root.rglob('*') if path.is_file()}-{'manifest.json','manifest.sha256'}",
      "assert actual==wanted",
      "assert all(len((root/item['path']).read_bytes())==item['size'] and hashlib.sha256((root/item['path']).read_bytes()).hexdigest()==item['sha256'] for item in manifest['files'])",
    ].join(";");
    const result = await this.delegate.run({
      executable: this.dockerExecutable,
      executableDigest: this.dockerExecutableDigest,
      args: [
        "exec",
        "--user",
        "10001:10001",
        "--workdir",
        "/work",
        this.validationContainer,
        "python",
        "-c",
        verifier,
        this.bundleFingerprint,
      ],
      cwd,
      timeoutMs,
      maxOutputBytes,
    });
    if (result.exitCode !== 0) {
      throw new ValidationError("ARTIFACT_CONFLICT", "sealed validation bundle changed");
    }
  }

  async run(command: FixedCommand): Promise<CommandResult> {
    const remaining = this.deadlineAt - Date.now();
    if (remaining <= 0) {
      throw new ValidationError("COMMAND_TIMEOUT", "global validation deadline exceeded");
    }
    if (command.executable === dbtContainerCommand) {
      await this.#verifyBundle(
        command.cwd,
        Math.min(command.timeoutMs, remaining),
        command.maxOutputBytes,
      );
      try {
        return await this.delegate.run({
          executable: this.dockerExecutable,
          executableDigest: this.dockerExecutableDigest,
          args: [
            "exec",
            "--user",
            "10001:10001",
            "--workdir",
            "/work/bundle/project",
            "--env",
            "DBT_SEND_ANONYMOUS_USAGE_STATS=false",
            "--env",
            `DBT_PGHOST=${this.database.host}`,
            "--env",
            `DBT_PGPORT=${this.database.port}`,
            "--env",
            `DBT_PGUSER=${this.database.user}`,
            "--env",
            `DBT_PGPASSWORD=${this.database.password}`,
            "--env",
            `DBT_PGDATABASE=${this.database.database}`,
            "--env",
            "HOME=/work/home",
            this.validationContainer,
            "dbt",
            ...command.args,
          ],
          cwd: command.cwd,
          timeoutMs: Math.min(command.timeoutMs, remaining),
          maxOutputBytes: command.maxOutputBytes,
        });
      } finally {
        await this.#verifyBundle(
          command.cwd,
          Math.min(command.timeoutMs, Math.max(1, this.deadlineAt - Date.now())),
          command.maxOutputBytes,
        );
      }
    }
    if (command.executable !== sqlDriverCommand) {
      throw new ValidationError("COMMAND_FAILED", "validation command is not allowlisted");
    }
    try {
      for (let index = 0; index < command.args.length; index += 2) {
        const operation = command.args[index];
        const value = command.args[index + 1];
        let sql: string;
        if (operation === "--command" && value !== undefined) {
          sql = value;
        } else if (operation === "--file" && value !== undefined) {
          const sealedSql = this.sealedSql.get(value);
          if (sealedSql === undefined) {
            throw new ValidationError(
              "ARTIFACT_CONFLICT",
              "SQL command references unknown artifact",
            );
          }
          sql = sealedSql.sql;
          await executeBoundedServerSql(this.client, sql, this.deadlineAt, sealedSql.program);
          continue;
        } else {
          throw new ValidationError("ARTIFACT_CONFLICT", "SQL command shape is not canonical");
        }
        await executeBoundedTrustedSql(this.client, sql, this.deadlineAt);
      }
      return { exitCode: 0, stdout: "", stderr: "" };
    } catch (error) {
      if (error instanceof ValidationError) throw error;
      return { exitCode: 1, stdout: "", stderr: "POSTGRES_VALIDATION_REJECTED" };
    }
  }
}

class GlobalDeadlineRunner implements CommandRunner {
  constructor(
    private readonly delegate: CommandRunner,
    private readonly deadlineAt: number,
  ) {}

  run(command: FixedCommand): Promise<CommandResult> {
    const remaining = this.deadlineAt - Date.now();
    if (remaining <= 0) {
      throw new ValidationError("COMMAND_TIMEOUT", "global validation deadline exceeded");
    }
    return this.delegate.run({ ...command, timeoutMs: Math.min(command.timeoutMs, remaining) });
  }
}

export async function executeEightChecks(
  untrustedCandidate: unknown,
  materialized: MaterializedCandidateHandle,
  runtime: ValidationRuntime,
  expected: ExpectedValidationExecution,
  runner: CommandRunner = new SpawnCommandRunner(),
): Promise<ValidationExecutionEvidence> {
  const candidate = migrationCandidateSchema.parse(untrustedCandidate);
  const trustedExpected = expectedValidationExecutionSchema.parse(expected);
  const materialization = requireMaterialization(materialized);
  if (
    trustedExpected.sandboxId !== materialization.sandboxId ||
    trustedExpected.worktreeId !== materialization.worktreeId
  ) {
    throw new ValidationError("ARTIFACT_CONFLICT", "execution fence does not match checkout");
  }
  if (
    candidate.artifacts.some(
      (item) => item.operation === "MODIFY" && item.expectedBaseSha !== materialization.baseSha,
    )
  ) {
    throw new ValidationError("WRONG_BASE_SHA", "opaque checkout base does not match candidate");
  }
  const allPaths = candidate.artifacts.map((artifact) => artifact.path);
  await observeMaterializedArtifacts(materialized, candidate, allPaths);
  const checks: ExecutedCheckEvidence[] = [];
  for (const definition of await definitions(candidate, materialization.checkoutPath, runtime)) {
    await observeMaterializedArtifacts(materialized, candidate, definition.artifactPaths);
    const startedAt = new Date().toISOString();
    let result: CommandResult;
    let summary: string;
    try {
      result = await runner.run(definition.command);
      summary = result.exitCode === 0 ? `${definition.check} passed` : `${definition.check} failed`;
    } catch (error) {
      ({ result, summary } = boundedResult(error));
    }
    const observations = await observeMaterializedArtifacts(
      materialized,
      candidate,
      definition.artifactPaths,
    );
    const finishedAt = new Date().toISOString();
    const stdoutFingerprint = sha256(result.stdout);
    const stderrFingerprint = sha256(result.stderr);
    const validator = trustedExpected.validators.find((item) => item.check === definition.check);
    if (!validator)
      throw new ValidationError("ARTIFACT_CONFLICT", "validator configuration missing");
    const artifactSetFingerprint = validationArtifactSetFingerprint(observations);
    const exitCode = result.exitCode < 0 ? 255 : Math.min(result.exitCode, 255);
    checks.push({
      check: definition.check,
      status: result.exitCode === 0 ? "PASS" : "FAIL",
      summary,
      artifactPaths: definition.artifactPaths,
      artifactObservations: observations,
      artifactSetFingerprint,
      validatorImplementationId: validator.implementationId,
      validatorVersion: validator.version,
      validatorDigest: validator.digest,
      commandId: definition.commandId,
      exitCode,
      startedAt,
      finishedAt,
      stdoutFingerprint,
      stderrFingerprint,
      outputFingerprint: validationOutputFingerprint({
        schemaVersion: 1,
        purpose: "LINEAGEGUARD_VALIDATOR_OUTPUT",
        check: definition.check,
        exitCode,
        stdoutFingerprint,
        stderrFingerprint,
        artifactObservations: observations,
      }),
      runId: trustedExpected.runId,
      sandboxId: trustedExpected.sandboxId,
      worktreeId: trustedExpected.worktreeId,
      leaseId: trustedExpected.leaseId,
      workerId: trustedExpected.workerId,
      generation: trustedExpected.generation,
    });
  }
  const artifactObservations = await observeMaterializedArtifacts(
    materialized,
    candidate,
    allPaths,
  );
  return {
    candidateFingerprint: migrationCandidateFingerprint(candidate),
    baseSha: materialization.baseSha,
    checkoutFingerprint: sha256({
      checkout: materialization.checkoutPath,
      baseSha: materialization.baseSha,
    }),
    artifactObservations,
    checks,
  };
}

async function validateTool(path: string): Promise<{ path: string; digest: string }> {
  if (!isAbsolute(path)) {
    throw new ValidationError("INVALID_PATH", "validator executable must be an absolute path");
  }
  const canonical = await realpath(path).catch(() => undefined);
  const stat = canonical ? await lstat(canonical).catch(() => undefined) : undefined;
  // The executable must be owned by root or by us, and must not be writable by anyone outside that
  // owner. Group- and world-writability are the real exposures: another account could swap the
  // binary and take over validation.
  //
  // Owner-writability is deliberately NOT rejected. For a file we own, the owner bit grants us
  // nothing we do not already have — the same uid runs this process and can chmod at will — so
  // rejecting it defends against nothing while making every standard macOS Docker Desktop install
  // (mode 0755, user-owned) unusable. Root-owned binaries were already judged by this same
  // group/world rule; this aligns the two cases instead of holding user-owned files to a test that
  // carries no threat-model value.
  //
  // The binary's digest is still recorded in the receipt, so a swap between runs remains visible.
  if (
    !canonical ||
    !stat?.isFile() ||
    stat.isSymbolicLink() ||
    (stat.uid !== 0 && stat.uid !== process.getuid?.()) ||
    (stat.mode & 0o022) !== 0 ||
    (stat.mode & 0o111) === 0
  ) {
    throw new ValidationError("INVALID_PATH", "validator executable is not a trusted regular file");
  }
  return { path: canonical, digest: sha256((await readFile(canonical)).toString("base64")) };
}

function validateRuntimePolicy(policy: ValidationRuntimePolicy): void {
  if (
    JSON.stringify(Object.keys(policy).sort()) !==
      JSON.stringify(
        [
          "baseFixtureSql",
          "dockerExecutable",
          "validationRunnerImageId",
          "postgresImageId",
          "sqlDriverImplementationId",
          "sqlDriverVersion",
          "dbtImplementationId",
          "dbtVersion",
          "timeoutMs",
          "maxOutputBytes",
        ].sort(),
      ) ||
    !Number.isInteger(policy.timeoutMs) ||
    policy.timeoutMs < 1_000 ||
    policy.timeoutMs > 120_000 ||
    !Number.isInteger(policy.maxOutputBytes) ||
    policy.maxOutputBytes < 4_096 ||
    policy.maxOutputBytes > 1_048_576 ||
    policy.sqlDriverImplementationId.length < 1 ||
    policy.sqlDriverImplementationId.length > 160 ||
    policy.dbtImplementationId.length < 1 ||
    policy.dbtImplementationId.length > 160 ||
    policy.sqlDriverVersion.length < 1 ||
    policy.sqlDriverVersion.length > 80 ||
    policy.dbtVersion.length < 1 ||
    policy.dbtVersion.length > 80 ||
    !/^sha256:[a-f0-9]{64}$/.test(policy.validationRunnerImageId) ||
    !/^sha256:[a-f0-9]{64}$/.test(policy.postgresImageId) ||
    Buffer.byteLength(policy.baseFixtureSql, "utf8") > 100_000 ||
    policy.baseFixtureSql.includes("\0")
  ) {
    throw new ValidationError("INVALID_PATH", "validation runtime policy is outside fixed bounds");
  }
}

async function requiredCommand(runner: CommandRunner, command: FixedCommand): Promise<void> {
  const result = await runner.run(command);
  if (result.exitCode !== 0) {
    throw new ValidationError(
      "COMMAND_FAILED",
      `validator setup exit_code=${result.exitCode} detail=${sanitizeValidationDiagnostic(result.stderr || result.stdout)}`,
    );
  }
}

function dockerCommand(
  executable: { path: string; digest: string },
  cwd: string,
  args: readonly string[],
  policy: ValidationRuntimePolicy,
): FixedCommand {
  return {
    executable: executable.path,
    executableDigest: executable.digest,
    args,
    cwd,
    timeoutMs: policy.timeoutMs,
    maxOutputBytes: policy.maxOutputBytes,
  };
}

async function requireLocalImage(
  runner: CommandRunner,
  docker: { path: string; digest: string },
  cwd: string,
  imageId: string,
  policy: ValidationRuntimePolicy,
): Promise<void> {
  const result = await runner.run(
    dockerCommand(docker, cwd, ["image", "inspect", "--format", "{{.Id}}", imageId], policy),
  );
  if (result.exitCode !== 0 || result.stdout.trim() !== imageId) {
    throw new ValidationError("MISSING_TOOL", "content-addressed validation image is not local");
  }
}

/** @internal Bounded redaction for operational failures surfaced by executable tests. */
export function sanitizeValidationDiagnostic(value: string): string {
  return [...value]
    .map((character) => {
      const code = character.charCodeAt(0);
      return code < 32 || code === 127 ? " " : character;
    })
    .join("")
    .replace(/\b[A-Za-z0-9_]*(password|token|secret)=\S+/gi, "$1=[REDACTED]")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 160);
}

async function postgresContainerDiagnostic(
  runner: CommandRunner,
  docker: { path: string; digest: string },
  cwd: string,
  containerId: string,
  policy: ValidationRuntimePolicy,
): Promise<string> {
  const diagnosticPolicy = { ...policy, timeoutMs: Math.min(policy.timeoutMs, 2_000) };
  const state = await runner
    .run(
      dockerCommand(
        docker,
        cwd,
        [
          "container",
          "inspect",
          "--format",
          "status={{.State.Status}} exit={{.State.ExitCode}} error={{.State.Error}}",
          containerId,
        ],
        diagnosticPolicy,
      ),
    )
    .catch(() => undefined);
  const logs = await runner
    .run(dockerCommand(docker, cwd, ["logs", "--tail", "20", containerId], diagnosticPolicy))
    .catch(() => undefined);
  return sanitizeValidationDiagnostic(
    `state=${state?.exitCode ?? "ERR"}:${state?.stdout ?? state?.stderr ?? "unavailable"} logs=${logs?.exitCode ?? "ERR"}:${logs?.stderr || logs?.stdout || "unavailable"}`,
  );
}

async function waitForPublishedPostgresPort(
  runner: CommandRunner,
  diagnosticRunner: CommandRunner,
  docker: { path: string; digest: string },
  cwd: string,
  containerId: string,
  deadlineAt: number,
  policy: ValidationRuntimePolicy,
): Promise<number> {
  while (Date.now() < deadlineAt) {
    const result = await runner
      .run(dockerCommand(docker, cwd, ["port", containerId, "5432/tcp"], policy))
      .catch(() => undefined);
    if (!result) break;
    const match = /^127\.0\.0\.1:(\d+)$/m.exec(result.stdout);
    if (result.exitCode === 0 && match?.[1]) return Number(match[1]);
    await new Promise((resolve) =>
      setTimeout(resolve, Math.max(1, Math.min(100, deadlineAt - Date.now()))),
    );
  }
  const diagnostic = await postgresContainerDiagnostic(
    diagnosticRunner,
    docker,
    cwd,
    containerId,
    policy,
  );
  throw new ValidationError("COMMAND_TIMEOUT", `PostgreSQL port unavailable; ${diagnostic}`);
}

function isProvenDockerNotFound(kind: "container" | "network", output: string): boolean {
  return kind === "container"
    ? /^\s*(?:Error:|Error response from daemon:) No such (?:object: )?container: [A-Za-z0-9_.:-]+\s*$/i.test(
        output,
      )
    : /^\s*(?:(?:Error:|Error response from daemon:) No such (?:object: )?network: [A-Za-z0-9_.:-]+|Error response from daemon: network [A-Za-z0-9_.:-]+ not found)\s*$/i.test(
        output,
      );
}

async function inspectOwnedDockerObject(
  runner: CommandRunner,
  docker: { path: string; digest: string },
  cwd: string,
  kind: "container" | "network",
  reference: string,
  owner: string,
  policy: ValidationRuntimePolicy,
): Promise<string | undefined> {
  const inspect = await runner.run(
    dockerCommand(
      docker,
      cwd,
      [
        kind,
        "inspect",
        "--format",
        kind === "container"
          ? '{{.Id}}\t{{index .Config.Labels "lineageguard.validation-owner"}}'
          : '{{.Id}}\t{{index .Labels "lineageguard.validation-owner"}}',
        reference,
      ],
      policy,
    ),
  );
  if (inspect.exitCode !== 0) {
    if (isProvenDockerNotFound(kind, `${inspect.stdout}\n${inspect.stderr}`)) return undefined;
    throw new ValidationError("CLEANUP_FAILED", `ambiguous Docker ${kind} inspection failure`);
  }
  const [id, actualOwner, extra] = inspect.stdout.trim().split("\t");
  if (extra !== undefined || !id || !/^[a-f0-9]{64}$/.test(id) || actualOwner !== owner) {
    throw new ValidationError("CLEANUP_FAILED", `refused cleanup of unowned Docker ${kind}`);
  }
  return id;
}

/** @internal Ownership-fenced cleanup shared with deterministic security tests. */
export async function removeOwnedDockerObject(
  runner: CommandRunner,
  docker: { path: string; digest: string },
  cwd: string,
  kind: "container" | "network",
  name: string,
  owner: string,
  policy: ValidationRuntimePolicy,
  knownId?: string,
): Promise<void> {
  const id = await inspectOwnedDockerObject(
    runner,
    docker,
    cwd,
    kind,
    knownId ?? name,
    owner,
    policy,
  );
  if (!id) return;
  await requiredCommand(
    runner,
    dockerCommand(
      docker,
      cwd,
      kind === "container" ? ["rm", "--force", id] : ["network", "rm", id],
      policy,
    ),
  );
  const after = await inspectOwnedDockerObject(runner, docker, cwd, kind, id, owner, policy);
  if (after !== undefined) {
    throw new ValidationError("CLEANUP_FAILED", `Docker ${kind} removal was not proven`);
  }
}

async function connectToPostgres(config: ClientConfig, deadlineAt: number): Promise<Client> {
  while (Date.now() < deadlineAt) {
    const remaining = deadlineAt - Date.now();
    const client = new Client({
      ...config,
      connectionTimeoutMillis: Math.max(1, Math.min(1_000, remaining)),
    });
    try {
      await withinSqlDeadline(client, () => client.connect(), deadlineAt);
      return client;
    } catch {
      await endPgClient(client, Math.min(deadlineAt, Date.now() + 500)).catch(() => {
        destroyPgClient(client);
      });
      const retryRemaining = deadlineAt - Date.now();
      if (retryRemaining > 0) {
        await new Promise((resolve) => setTimeout(resolve, Math.min(100, retryRemaining)));
      }
    }
  }
  throw new ValidationError("COMMAND_TIMEOUT", "disposable PostgreSQL did not become ready");
}

/** @internal Deterministic security plan used by production orchestration and argument tests. */
export function postgresContainerCreateArgs(input: {
  name: string;
  owner: string;
  networkName: string;
  imageId: string;
  adminPassword: string;
}): readonly string[] {
  return [
    "create",
    "--name",
    input.name,
    "--label",
    `lineageguard.validation-owner=${input.owner}`,
    "--network",
    input.networkName,
    "--network-alias",
    "validation-db",
    "--pull",
    "never",
    "--read-only",
    "--cap-drop",
    "ALL",
    "--security-opt",
    "no-new-privileges",
    "--pids-limit",
    "128",
    "--memory",
    "384m",
    "--cpus",
    "1",
    "--user",
    "70:70",
    "--tmpfs",
    "/var/lib/postgresql/data:rw,noexec,nosuid,size=256m,uid=70,gid=70",
    "--tmpfs",
    "/tmp:rw,noexec,nosuid,size=64m,uid=70,gid=70",
    "--tmpfs",
    "/var/run/postgresql:rw,noexec,nosuid,size=16m,uid=70,gid=70",
    "--publish",
    "127.0.0.1::5432",
    "--env",
    `POSTGRES_PASSWORD=${input.adminPassword}`,
    input.imageId,
    "-c",
    "max_connections=16",
    "-c",
    "shared_buffers=64MB",
  ];
}

/** @internal Deterministic security plan used by production orchestration and argument tests. */
export function validationContainerCreateArgs(input: {
  name: string;
  owner: string;
  networkName: string;
  imageId: string;
}): readonly string[] {
  return [
    "create",
    "--name",
    input.name,
    "--label",
    `lineageguard.validation-owner=${input.owner}`,
    "--network",
    input.networkName,
    "--pull",
    "never",
    "--read-only",
    "--cap-drop",
    "ALL",
    "--security-opt",
    "no-new-privileges",
    "--pids-limit",
    "128",
    "--memory",
    "512m",
    "--cpus",
    "1",
    "--user",
    "10001:10001",
    "--tmpfs",
    "/work:rw,noexec,nosuid,size=128m,uid=10001,gid=10001,mode=0755",
    "--tmpfs",
    "/tmp:rw,noexec,nosuid,size=64m,uid=10001,gid=10001,mode=0700",
    input.imageId,
  ];
}

/** @internal Connects only PostgreSQL to the internal runner network. */
export function postgresInternalNetworkConnectArgs(
  internalNetworkId: string,
  postgresContainerId: string,
): readonly string[] {
  if (!/^[a-f0-9]{64}$/.test(internalNetworkId) || !/^[a-f0-9]{64}$/.test(postgresContainerId)) {
    throw new ValidationError("CLEANUP_FAILED", "Docker topology identity is invalid");
  }
  return ["network", "connect", "--alias", "validation-db", internalNetworkId, postgresContainerId];
}

interface SealedArtifactSnapshot {
  path: string;
  bytes: Buffer;
  observation: ExecutedArtifactObservation;
}

function rawSha256(bytes: Buffer | string): string {
  return createHash("sha256").update(bytes).digest("hex");
}

/** @internal Creates the sole immutable input bundle from descriptor-observed bytes. */
export async function createSealedValidationBundle(
  bundleDirectory: string,
  candidate: MigrationCandidate,
  snapshots: readonly SealedArtifactSnapshot[],
): Promise<{
  fingerprint: string;
  sealedSql: ReadonlyMap<string, { sql: string; program: GeneratedSqlProgram }>;
  bundleFiles: readonly { path: string; bytes: Buffer }[];
}> {
  const snapshotByPath = new Map(snapshots.map((snapshot) => [snapshot.path, snapshot]));
  if (snapshotByPath.size !== candidate.artifacts.length) {
    throw new ValidationError("ARTIFACT_CONFLICT", "sealed bundle artifact set is incomplete");
  }
  const entries = new Map<string, Buffer>();
  const sealedSql = new Map<string, { sql: string; program: GeneratedSqlProgram }>();
  const add = (path: string, bytes: Buffer | string) => {
    if (!/^[A-Za-z0-9._/-]+$/.test(path) || path.startsWith("/") || path.includes("..")) {
      throw new ValidationError("INVALID_PATH", "sealed bundle path is invalid");
    }
    if (entries.has(path)) throw new ValidationError("ARTIFACT_CONFLICT", "duplicate bundle path");
    entries.set(path, Buffer.isBuffer(bytes) ? Buffer.from(bytes) : Buffer.from(bytes, "utf8"));
  };
  add(
    "project/dbt_project.yml",
    "name: lineageguard\nversion: '1.0'\nconfig-version: 2\nprofile: lineageguard\nmodel-paths: ['models']\ntest-paths: ['tests']\ntarget-path: /work/output/target\nlog-path: /work/output/logs\npackages-install-path: /work/output/packages\nclean-targets: ['/work/output']\n",
  );
  add(
    "profiles/profiles.yml",
    [
      "lineageguard:",
      "  target: validation",
      "  outputs:",
      "    validation:",
      "      type: postgres",
      "      host: \"{{ env_var('DBT_PGHOST') }}\"",
      "      port: \"{{ env_var('DBT_PGPORT') | as_number }}\"",
      "      user: \"{{ env_var('DBT_PGUSER') }}\"",
      "      password: \"{{ env_var('DBT_PGPASSWORD') }}\"",
      "      dbname: \"{{ env_var('DBT_PGDATABASE') }}\"",
      "      schema: analytics",
      "      threads: 1",
      "",
    ].join("\n"),
  );
  // Include sources.yml so dbt can resolve source('commerce', 'orders')
  add(
    "project/models/staging/sources.yml",
    "version: 2\nsources:\n  - name: commerce\n    schema: commerce\n    tables:\n      - name: orders\n",
  );
  for (const artifact of candidate.artifacts) {
    const snapshot = snapshotByPath.get(artifact.path);
    if (!snapshot) throw new ValidationError("ARTIFACT_CONFLICT", "bundle snapshot missing");
    add(`artifacts/${artifact.path}`, snapshot.bytes);
    if (artifact.kind === "DBT_MODEL" || artifact.kind === "DBT_TEST") {
      add(`project/${artifact.path.replace(/^walkthrough\/(?:dbt\/)?/, "")}`, snapshot.bytes);
    }
    if (artifact.kind === "SQL_MIGRATION" || artifact.kind === "ROLLBACK_SQL") {
      sealedSql.set(artifact.path, {
        sql: snapshot.bytes.toString("utf8"),
        program: artifact.kind === "SQL_MIGRATION" ? "EXPAND_MIGRATION" : "ROLLBACK",
      });
    }
  }
  const files = [...entries.entries()]
    .map(([path, bytes]) => ({ path, size: bytes.length, sha256: rawSha256(bytes) }))
    .sort((left, right) => left.path.localeCompare(right.path));
  const manifestBytes = Buffer.from(
    `${stableJson({ schemaVersion: 1, purpose: "LINEAGEGUARD_SEALED_VALIDATION_BUNDLE", files })}\n`,
    "utf8",
  );
  const fingerprint = rawSha256(manifestBytes);
  for (const [path, bytes] of entries) {
    const destination = join(bundleDirectory, path);
    await mkdir(join(destination, ".."), { recursive: true });
    await writeFile(destination, bytes, { mode: 0o444, flag: "wx" });
  }
  await writeFile(join(bundleDirectory, "manifest.json"), manifestBytes, {
    mode: 0o444,
    flag: "wx",
  });
  await writeFile(join(bundleDirectory, "manifest.sha256"), `${fingerprint}\n`, {
    mode: 0o444,
    flag: "wx",
  });
  await chmod(bundleDirectory, 0o555);
  return {
    fingerprint,
    sealedSql,
    bundleFiles: [
      ...[...entries.entries()].map(([path, bytes]) => ({ path, bytes: Buffer.from(bytes) })),
      { path: "manifest.json", bytes: manifestBytes },
      { path: "manifest.sha256", bytes: Buffer.from(`${fingerprint}\n`, "utf8") },
    ].sort((left, right) => left.path.localeCompare(right.path)),
  };
}

async function installSealedBundleInReadOnlyContainer(
  runner: CommandRunner,
  docker: { path: string; digest: string },
  cwd: string,
  containerId: string,
  bundleFiles: readonly { path: string; bytes: Buffer }[],
  policy: ValidationRuntimePolicy,
): Promise<void> {
  const writer = [
    "import base64,pathlib,sys",
    "root=pathlib.Path('/work/bundle')",
    "path=root/sys.argv[1]",
    "path.parent.mkdir(parents=True,exist_ok=True)",
    "path.write_bytes(base64.b64decode(sys.argv[2],validate=True))",
    "path.chmod(0o444)",
  ].join(";");
  for (const file of bundleFiles) {
    await requiredCommand(
      runner,
      dockerCommand(
        docker,
        cwd,
        [
          "exec",
          "--user",
          "10001:10001",
          containerId,
          "python",
          "-c",
          writer,
          file.path,
          file.bytes.toString("base64"),
        ],
        policy,
      ),
    );
  }
  await requiredCommand(
    runner,
    dockerCommand(
      docker,
      cwd,
      [
        "exec",
        "--user",
        "10001:10001",
        containerId,
        "python",
        "-c",
        "import pathlib; root=pathlib.Path('/work/bundle'); [path.chmod(0o555) for path in sorted((item for item in root.rglob('*') if item.is_dir()),reverse=True)]; root.chmod(0o555)",
      ],
      policy,
    ),
  );
}

/** @internal Exact least-privilege bootstrap statements for the disposable PostgreSQL cluster. */
export function postgresLeastPrivilegePlan(input: {
  roleName: string;
  rolePassword: string;
  databaseName: string;
}): readonly string[] {
  const { roleName, rolePassword, databaseName } = input;
  if (
    !/^lg_[a-f0-9]{24}$/.test(roleName) ||
    !/^lineageguard_[a-f0-9]{24}$/.test(databaseName) ||
    !/^[A-Za-z0-9_-]{32,64}$/.test(rolePassword)
  ) {
    throw new ValidationError("INVALID_PATH", "generated database identity is invalid");
  }
  return [
    "REVOKE CONNECT,TEMPORARY ON DATABASE postgres FROM PUBLIC",
    "REVOKE CONNECT,TEMPORARY ON DATABASE template1 FROM PUBLIC",
    `CREATE ROLE ${roleName} LOGIN PASSWORD '${rolePassword}' NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOREPLICATION NOBYPASSRLS CONNECTION LIMIT 4`,
    `ALTER ROLE ${roleName} SET statement_timeout='15s'`,
    `ALTER ROLE ${roleName} SET lock_timeout='5s'`,
    `ALTER ROLE ${roleName} SET idle_in_transaction_session_timeout='15s'`,
    `ALTER ROLE ${roleName} SET temp_file_limit='64MB'`,
    `ALTER ROLE ${roleName} SET work_mem='8MB'`,
    `CREATE DATABASE ${databaseName} OWNER ${roleName}`,
    `REVOKE CONNECT,TEMPORARY,CREATE ON DATABASE ${databaseName} FROM PUBLIC`,
    `GRANT CONNECT,TEMPORARY,CREATE ON DATABASE ${databaseName} TO ${roleName}`,
  ];
}

/** @internal Production authority entry: owns a fresh database and sealed runtime configuration. */
export async function executeValidationInOwnedDatabase(
  candidate: MigrationCandidate,
  materialized: MaterializedCandidateHandle,
  expected: ExpectedValidationExecution,
  policy: ValidationRuntimePolicy,
  runner: CommandRunner = new SpawnCommandRunner(),
): Promise<ValidationExecutionEvidence> {
  const record = requireMaterialization(materialized);
  validateRuntimePolicy(policy);
  const deadlineAt = Date.now() + policy.timeoutMs;
  const executionRunner = new GlobalDeadlineRunner(runner, deadlineAt);
  const docker = await validateTool(policy.dockerExecutable);
  await Promise.all([
    requireLocalImage(
      executionRunner,
      docker,
      record.checkoutPath,
      policy.validationRunnerImageId,
      policy,
    ),
    requireLocalImage(executionRunner, docker, record.checkoutPath, policy.postgresImageId, policy),
  ]);
  const toolDigests = {
    SQL: sqlDriverDigest,
    DBT: policy.validationRunnerImageId.slice("sha256:".length),
  } as const;
  for (const validator of expected.validators) {
    const tool = validator.check.startsWith("DBT") ? "DBT" : "SQL";
    const implementationId =
      tool === "DBT" ? policy.dbtImplementationId : policy.sqlDriverImplementationId;
    const version = tool === "DBT" ? policy.dbtVersion : policy.sqlDriverVersion;
    if (
      validator.implementationId !== implementationId ||
      validator.version !== version ||
      validator.digest !== toolDigests[tool]
    ) {
      throw new ValidationError("ARTIFACT_CONFLICT", "validator tool policy binding mismatch");
    }
  }
  assertSafeDbtProject(candidate);
  const databaseName = `lineageguard_${randomBytes(12).toString("hex")}`;
  const roleName = `lg_${randomBytes(12).toString("hex")}`;
  const rolePassword = randomBytes(32).toString("base64url");
  const adminPassword = randomBytes(32).toString("base64url");
  const owner = randomBytes(24).toString("hex");
  const networkName = `lineageguard-validation-${owner}`;
  const hostAccessNetworkName = `lineageguard-validation-host-${owner}`;
  const postgresContainer = `lineageguard-postgres-${owner}`;
  const validationContainer = `lineageguard-runner-${owner}`;
  const bundleDirectory = await mkdtemp(join(record.checkoutPath, ".lineageguard-bundle-"));
  const snapshots = await snapshotMaterializedArtifacts(
    materialized,
    candidate,
    candidate.artifacts.map((artifact) => artifact.path),
  );
  const sealedBundle = await createSealedValidationBundle(bundleDirectory, candidate, snapshots);
  let networkCreated = false;
  let hostAccessNetworkCreated = false;
  let postgresCreated = false;
  let validationCreated = false;
  let networkId: string | undefined;
  let hostAccessNetworkId: string | undefined;
  let postgresContainerId: string | undefined;
  let validationContainerId: string | undefined;
  let adminClient: Client | undefined;
  let validationClient: Client | undefined;
  try {
    networkCreated = true;
    await requiredCommand(
      executionRunner,
      dockerCommand(
        docker,
        record.checkoutPath,
        [
          "network",
          "create",
          "--internal",
          "--label",
          `lineageguard.validation-owner=${owner}`,
          networkName,
        ],
        policy,
      ),
    );
    networkId = await inspectOwnedDockerObject(
      executionRunner,
      docker,
      record.checkoutPath,
      "network",
      networkName,
      owner,
      policy,
    );
    if (!networkId) throw new ValidationError("CLEANUP_FAILED", "created Docker network vanished");
    hostAccessNetworkCreated = true;
    await requiredCommand(
      executionRunner,
      dockerCommand(
        docker,
        record.checkoutPath,
        [
          "network",
          "create",
          "--label",
          `lineageguard.validation-owner=${owner}`,
          hostAccessNetworkName,
        ],
        policy,
      ),
    );
    hostAccessNetworkId = await inspectOwnedDockerObject(
      executionRunner,
      docker,
      record.checkoutPath,
      "network",
      hostAccessNetworkName,
      owner,
      policy,
    );
    if (!hostAccessNetworkId) {
      throw new ValidationError("CLEANUP_FAILED", "created Docker host-access network vanished");
    }
    postgresCreated = true;
    await requiredCommand(
      executionRunner,
      dockerCommand(
        docker,
        record.checkoutPath,
        postgresContainerCreateArgs({
          name: postgresContainer,
          owner,
          networkName: hostAccessNetworkId,
          imageId: policy.postgresImageId,
          adminPassword,
        }),
        policy,
      ),
    );
    postgresContainerId = await inspectOwnedDockerObject(
      executionRunner,
      docker,
      record.checkoutPath,
      "container",
      postgresContainer,
      owner,
      policy,
    );
    if (!postgresContainerId) {
      throw new ValidationError("CLEANUP_FAILED", "created PostgreSQL container vanished");
    }
    await requiredCommand(
      executionRunner,
      dockerCommand(
        docker,
        record.checkoutPath,
        postgresInternalNetworkConnectArgs(networkId, postgresContainerId),
        policy,
      ),
    );
    await requiredCommand(
      executionRunner,
      dockerCommand(docker, record.checkoutPath, ["start", postgresContainerId], policy),
    );
    const postgresPort = await waitForPublishedPostgresPort(
      executionRunner,
      runner,
      docker,
      record.checkoutPath,
      postgresContainerId,
      deadlineAt,
      policy,
    );
    try {
      adminClient = await connectToPostgres(
        {
          host: "127.0.0.1",
          port: postgresPort,
          user: "postgres",
          password: adminPassword,
          database: "postgres",
        },
        deadlineAt,
      );
    } catch {
      const diagnostic = await postgresContainerDiagnostic(
        runner,
        docker,
        record.checkoutPath,
        postgresContainerId,
        policy,
      );
      throw new ValidationError("COMMAND_TIMEOUT", `PostgreSQL readiness failed; ${diagnostic}`);
    }
    await executeBoundedPostgresQuery(adminClient, "SET lock_timeout='5s'", deadlineAt);
    for (const statement of postgresLeastPrivilegePlan({ roleName, rolePassword, databaseName })) {
      await executeBoundedPostgresQuery(adminClient, statement, deadlineAt);
    }
    validationClient = await connectToPostgres(
      {
        host: "127.0.0.1",
        port: postgresPort,
        user: roleName,
        password: rolePassword,
        database: databaseName,
      },
      deadlineAt,
    );
    await executeBoundedTrustedSql(validationClient, policy.baseFixtureSql, deadlineAt);
    validationCreated = true;
    await requiredCommand(
      executionRunner,
      dockerCommand(
        docker,
        record.checkoutPath,
        validationContainerCreateArgs({
          name: validationContainer,
          owner,
          networkName: networkId,
          imageId: policy.validationRunnerImageId,
        }),
        policy,
      ),
    );
    validationContainerId = await inspectOwnedDockerObject(
      executionRunner,
      docker,
      record.checkoutPath,
      "container",
      validationContainer,
      owner,
      policy,
    );
    if (!validationContainerId) {
      throw new ValidationError("CLEANUP_FAILED", "created validation container vanished");
    }
    await requiredCommand(
      executionRunner,
      dockerCommand(docker, record.checkoutPath, ["start", validationContainerId], policy),
    );
    await installSealedBundleInReadOnlyContainer(
      executionRunner,
      docker,
      record.checkoutPath,
      validationContainerId,
      sealedBundle.bundleFiles,
      policy,
    );
    const database: DatabaseConnection = {
      host: "validation-db",
      port: "5432",
      user: roleName,
      password: rolePassword,
      database: databaseName,
    };
    const isolatedRunner = new IsolatedValidationRunner(
      executionRunner,
      validationClient,
      sealedBundle.sealedSql,
      deadlineAt,
      docker.path,
      docker.digest,
      validationContainerId,
      database,
      sealedBundle.fingerprint,
    );
    return await executeEightChecks(
      candidate,
      materialized,
      {
        database,
        dbtProfilesDirectory: join(bundleDirectory, "profiles"),
        timeoutMs: policy.timeoutMs,
        maxOutputBytes: policy.maxOutputBytes,
      },
      expected,
      isolatedRunner,
    );
  } finally {
    const cleanupDeadlineAt = Date.now() + Math.min(10_000, policy.timeoutMs);
    const cleanupRunner = new GlobalDeadlineRunner(runner, cleanupDeadlineAt);
    try {
      let databaseCleanupFailure: unknown;
      if (validationClient) {
        try {
          await endPgClient(validationClient, cleanupDeadlineAt);
        } catch (error) {
          destroyPgClient(validationClient);
          databaseCleanupFailure ??= error;
        }
      }
      if (adminClient) {
        try {
          await executeBoundedPostgresQuery(
            adminClient,
            `DROP DATABASE IF EXISTS ${databaseName} WITH (FORCE)`,
            cleanupDeadlineAt,
          );
          await executeBoundedPostgresQuery(
            adminClient,
            `DROP ROLE IF EXISTS ${roleName}`,
            cleanupDeadlineAt,
          );
        } catch (error) {
          databaseCleanupFailure ??= error;
        }
        try {
          await endPgClient(adminClient, cleanupDeadlineAt);
        } catch (error) {
          destroyPgClient(adminClient);
          databaseCleanupFailure ??= error;
        }
      }
      if (databaseCleanupFailure) {
        // biome-ignore lint/correctness/noUnsafeFinally: ambiguous database cleanup must fail closed.
        throw new ValidationError("CLEANUP_FAILED", "PostgreSQL cleanup was not proven");
      }
    } finally {
      try {
        let cleanupFailure: unknown;
        const ownedObjects: Array<readonly ["container" | "network", string, string | undefined]> =
          [];
        if (validationCreated)
          ownedObjects.push(["container", validationContainer, validationContainerId]);
        if (postgresCreated)
          ownedObjects.push(["container", postgresContainer, postgresContainerId]);
        if (networkCreated) ownedObjects.push(["network", networkName, networkId]);
        if (hostAccessNetworkCreated)
          ownedObjects.push(["network", hostAccessNetworkName, hostAccessNetworkId]);
        for (const [kind, name, id] of ownedObjects) {
          try {
            await removeOwnedDockerObject(
              cleanupRunner,
              docker,
              record.checkoutPath,
              kind,
              name,
              owner,
              policy,
              id,
            );
          } catch (error) {
            cleanupFailure ??= error;
          }
        }
        // biome-ignore lint/correctness/noUnsafeFinally: ambiguous owned-resource cleanup must fail closed.
        if (cleanupFailure) throw cleanupFailure;
      } finally {
        await chmod(bundleDirectory, 0o700).catch(() => undefined);
        await rm(bundleDirectory, { recursive: true, force: true });
      }
    }
  }
}
