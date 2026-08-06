import { execFile } from "node:child_process";
import { generateKeyPairSync } from "node:crypto";
import { chmod, mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import {
  type MigrationCandidate,
  migrationArtifactFingerprint,
  sha256,
} from "@lineageguard/domain";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  readRuntimeVerifiedLiveReceipt,
  readRuntimeVerifiedReplayPresentation,
} from "./attestation.js";
import type { CommandRunner, FixedCommand } from "./command-runner.js";
import {
  materializeCandidate,
  requireMaterialization,
  snapshotMaterializedArtifacts,
} from "./materializer.js";
import { loadValidationRuntimePolicy } from "./runtime-config.js";
import { startEffectAuthorizationProcess } from "./server/effect-authorization.js";
import { startValidationReceiptIssuerProcess } from "./server/validation-receipt-issuer.js";
import {
  assertCanonicalGeneratedSql,
  assertSafeDbtProject,
  canonicalValidationChecks,
  createSealedValidationBundle,
  dbtContainerCommand,
  endPgClient,
  executeBoundedServerSql,
  executeEightChecks,
  executeValidationInOwnedDatabase,
  postgresContainerCreateArgs,
  postgresInternalNetworkConnectArgs,
  postgresLeastPrivilegePlan,
  removeOwnedDockerObject,
  sanitizeValidationDiagnostic,
  sqlDriverCommand,
  validationContainerCreateArgs,
} from "./validator.js";

const canonicalMigrationSql =
  "alter table commerce.orders add column buyer_id bigint;\nupdate commerce.orders set buyer_id = customer_id;\ncreate function commerce.sync_order_customer_buyer() returns trigger language plpgsql as $$\nbegin\n  if tg_op = 'INSERT' then\n    if new.buyer_id is null and new.customer_id is not null then\n      new.buyer_id := new.customer_id;\n    elsif new.customer_id is null and new.buyer_id is not null then\n      new.customer_id := new.buyer_id;\n    elsif new.customer_id is null and new.buyer_id is null then\n      raise exception 'at least one identifier must be provided';\n    elsif new.customer_id is distinct from new.buyer_id then\n      raise exception 'customer_id and buyer_id must match during compatibility window';\n    end if;\n  elsif tg_op = 'UPDATE' then\n    if new.customer_id is distinct from old.customer_id and new.buyer_id is not distinct from old.buyer_id then\n      new.buyer_id := new.customer_id;\n    elsif new.buyer_id is distinct from old.buyer_id and new.customer_id is not distinct from old.customer_id then\n      new.customer_id := new.buyer_id;\n    elsif new.customer_id is distinct from old.customer_id and new.buyer_id is distinct from old.buyer_id then\n      if new.customer_id is distinct from new.buyer_id then\n        raise exception 'customer_id and buyer_id must match during compatibility window';\n      end if;\n    end if;\n  end if;\n  return new;\nend $$;\ncreate trigger orders_customer_buyer_compat\n  before insert or update on commerce.orders\n  for each row execute function commerce.sync_order_customer_buyer();\nalter table commerce.orders alter column buyer_id set not null;\n";
const canonicalRollbackSql =
  "drop trigger orders_customer_buyer_compat on commerce.orders;\ndrop function commerce.sync_order_customer_buyer();\nalter table commerce.orders drop column buyer_id;\n";

afterEach(() => vi.unstubAllEnvs());

const executeFile = promisify(execFile);

function candidate(baseSha = "1".repeat(40)): MigrationCandidate {
  const evidence = ["ev_aaaaaaaaaaaaaaaaaaaaaaaa"];
  const artifacts: MigrationCandidate["artifacts"] = [
    {
      kind: "MIGRATION_DOCUMENT",
      operation: "CREATE",
      path: "docs/migrations/customer-id.md",
      content: "# Migration\n",
    },
    {
      kind: "DBT_MODEL",
      operation: "MODIFY",
      path: "walkthrough/models/orders.sql",
      expectedBaseSha: baseSha,
      content: "select customer_id, buyer_id from commerce.orders\n",
    },
    {
      kind: "DBT_TEST",
      operation: "CREATE",
      path: "walkthrough/tests/orders_equality.sql",
      content: "select * from {{ ref('orders') }} where customer_id is distinct from buyer_id\n",
    },
    {
      kind: "ROLLBACK_SQL",
      operation: "CREATE",
      path: "walkthrough/migrations/add-buyer-id-rollback.sql",
      content: "alter table commerce.orders drop column buyer_id;\n",
    },
    {
      kind: "SQL_MIGRATION",
      operation: "CREATE",
      path: "walkthrough/migrations/add-buyer-id.sql",
      content: "alter table commerce.orders add column buyer_id bigint;\n",
    },
  ];
  artifacts.sort((left, right) => left.path.localeCompare(right.path));
  return {
    strategy: "EXPAND_MIGRATE_CONTRACT",
    sourceChangeFingerprint: "a".repeat(64),
    sourcePatchFingerprint: "b".repeat(64),
    sourceImpactContextFingerprint: "c".repeat(64),
    sourceDecision: "BLOCK",
    sourceEvidenceIds: evidence,
    summary: "Backward compatible migration",
    steps: [
      {
        id: "step_expand",
        phase: "EXPAND",
        title: "Expand",
        rationale: "Add and rollback",
        affectedEvidenceIds: evidence,
        artifactTargets: [
          "walkthrough/migrations/add-buyer-id-rollback.sql",
          "walkthrough/migrations/add-buyer-id.sql",
        ],
      },
      {
        id: "step_migrate",
        phase: "MIGRATE",
        title: "Migrate",
        rationale: "Update and test",
        affectedEvidenceIds: evidence,
        artifactTargets: ["walkthrough/models/orders.sql", "walkthrough/tests/orders_equality.sql"],
      },
      {
        id: "step_contract",
        phase: "CONTRACT",
        title: "Contract",
        rationale: "Document gate",
        affectedEvidenceIds: evidence,
        artifactTargets: ["docs/migrations/customer-id.md"],
      },
    ],
    artifacts,
    requiredReviewers: [
      {
        kind: "OWNER",
        ownerUrn: "urn:li:corpuser:finance",
        affectedAssetUrns: ["urn:li:dashboard:finance"],
        reason: "Affected owner",
      },
    ],
    compatibilityWindowDays: 30,
    rollbackPlan: "Run rollback before contract removal.",
  };
}

async function fixture(value = candidate()) {
  const root = await mkdtemp(join(tmpdir(), "lineageguard-validator-test-"));
  const repositoryPath = join(root, "repository");
  const sandboxRoot = join(root, "sandboxes");
  await mkdir(join(repositoryPath, "walkthrough/models"), { recursive: true });
  await mkdir(join(repositoryPath, "walkthrough/profiles"), { recursive: true });
  await mkdir(sandboxRoot);
  await writeFile(
    join(repositoryPath, "walkthrough/models/orders.sql"),
    "select order_id, customer_id from commerce.orders\n",
  );
  await writeFile(join(repositoryPath, "walkthrough/profiles/.keep"), "");
  await executeFile("git", ["init", "-q"], { cwd: repositoryPath });
  await executeFile("git", ["config", "user.name", "LineageGuard Tests"], { cwd: repositoryPath });
  await executeFile("git", ["config", "user.email", "tests@lineageguard.invalid"], {
    cwd: repositoryPath,
  });
  await executeFile("git", ["add", "."], { cwd: repositoryPath });
  await executeFile("git", ["commit", "-qm", "base"], { cwd: repositoryPath });
  const { stdout } = await executeFile("git", ["rev-parse", "HEAD"], { cwd: repositoryPath });
  const baseSha = stdout.trim();
  const rebound = structuredClone(value);
  for (const artifact of rebound.artifacts) {
    if (artifact.operation === "MODIFY") artifact.expectedBaseSha = baseSha;
  }
  const materialized = await materializeCandidate(rebound, {
    repositoryPath,
    sandboxRoot,
    baseSha,
    sandboxId: expected.sandboxId,
    worktreeId: expected.worktreeId,
  });
  const checkoutPath = requireMaterialization(materialized).checkoutPath;
  return { value: rebound, materialized, checkoutPath };
}

class RecordingRunner implements CommandRunner {
  readonly commands: FixedCommand[] = [];
  constructor(readonly fail: (command: FixedCommand) => boolean = () => false) {}

  async run(command: FixedCommand) {
    this.commands.push(command);
    return this.fail(command)
      ? { exitCode: 1, stdout: "", stderr: "bounded failure" }
      : { exitCode: 0, stdout: "bounded success", stderr: "" };
  }
}

const runtime = {
  database: {
    host: "127.0.0.1",
    port: "5432",
    user: "validator",
    password: "secret",
    database: "lineageguard",
  },
  dbtProfilesDirectory: "",
  timeoutMs: 120_000,
  maxOutputBytes: 512_000,
};
const expected = {
  schemaVersion: 1 as const,
  purpose: "LINEAGEGUARD_EXPECTED_VALIDATION_EXECUTION" as const,
  runId: `run_${"a".repeat(24)}`,
  sandboxId: "sandbox-canonical",
  worktreeId: "worktree-canonical",
  leaseId: `lease_${"b".repeat(24)}`,
  workerId: "worker-validation-1",
  generation: 1,
  validators: canonicalValidationChecks.map((check) => ({
    check,
    commandId: {
      SQL_MIGRATION: "VALIDATE_SQL_MIGRATION_V1",
      BACKFILL_EQUALITY: "VALIDATE_BACKFILL_EQUALITY_V1",
      DBT_PARSE: "VALIDATE_DBT_PARSE_V1",
      DBT_COMPILE: "VALIDATE_DBT_COMPILE_V1",
      DBT_TEST: "VALIDATE_DBT_TEST_V1",
      OLD_CONSUMER_COMPATIBILITY: "VALIDATE_OLD_CONSUMER_V1",
      NEW_CONSUMER_COMPATIBILITY: "VALIDATE_NEW_CONSUMER_V1",
      ROLLBACK: "VALIDATE_ROLLBACK_V1",
    }[check] as
      | "VALIDATE_SQL_MIGRATION_V1"
      | "VALIDATE_BACKFILL_EQUALITY_V1"
      | "VALIDATE_DBT_PARSE_V1"
      | "VALIDATE_DBT_COMPILE_V1"
      | "VALIDATE_DBT_TEST_V1"
      | "VALIDATE_OLD_CONSUMER_V1"
      | "VALIDATE_NEW_CONSUMER_V1"
      | "VALIDATE_ROLLBACK_V1",
    implementationId: check.startsWith("DBT") ? "lineageguard-dbt" : "lineageguard-psql",
    version: check.startsWith("DBT") ? "dbt-core 1.10.8" : "PostgreSQL 17.6",
    digest: sha256({ implementation: check }),
  })),
};

describe("eight-check validation orchestration", () => {
  it("runs only the canonical eight fixed shell-free commands and binds every artifact", async () => {
    const { value, materialized, checkoutPath } = await fixture();
    const runner = new RecordingRunner();
    const result = await executeEightChecks(
      value,
      materialized,
      { ...runtime, dbtProfilesDirectory: join(checkoutPath, "walkthrough/profiles") },
      expected,
      runner,
    );
    expect(result.checks.map((check) => check.check)).toEqual(canonicalValidationChecks);
    expect(result.checks.every((check) => check.status === "PASS")).toBe(true);
    expect(result.artifactObservations).toEqual(
      value.artifacts.map((artifact) => ({
        path: artifact.path,
        candidateArtifactFingerprint: migrationArtifactFingerprint(artifact),
        materializedSha256: sha256(artifact.content),
      })),
    );
    expect(runner.commands).toHaveLength(8);
    expect(
      runner.commands.every(
        (command) =>
          command.executable === sqlDriverCommand || command.executable === dbtContainerCommand,
      ),
    ).toBe(true);
    expect(runner.commands.every((command) => !("shell" in command))).toBe(true);
  });

  it.each([
    [
      "migration",
      (command: FixedCommand) =>
        command.args.includes("walkthrough/migrations/add-buyer-id.sql") &&
        !command.args.includes("walkthrough/migrations/add-buyer-id-rollback.sql"),
      "SQL_MIGRATION",
    ],
    [
      "old consumer",
      (command: FixedCommand) => command.args.some((arg) => arg.includes("old consumer is broken")),
      "OLD_CONSUMER_COMPATIBILITY",
    ],
    [
      "rollback",
      (command: FixedCommand) =>
        command.args.includes("walkthrough/migrations/add-buyer-id-rollback.sql"),
      "ROLLBACK",
    ],
  ] as const)("fails closed for a broken %s", async (_label, predicate, expectedCheck) => {
    const { value, materialized, checkoutPath } = await fixture();
    const result = await executeEightChecks(
      value,
      materialized,
      { ...runtime, dbtProfilesDirectory: join(checkoutPath, "walkthrough/profiles") },
      expected,
      new RecordingRunner(predicate),
    );
    expect(result.checks.find((check) => check.check === expectedCheck)?.status).toBe("FAIL");
    expect(result.checks).toHaveLength(8);
  });
});

describe("owned validation container preflight", () => {
  it("bounds Docker diagnostics and redacts named credentials", () => {
    const diagnostic = sanitizeValidationDiagnostic(
      `POSTGRES_PASSWORD=super-secret token=abc ${"x".repeat(400)}`,
    );
    expect(diagnostic).not.toContain("super-secret");
    expect(diagnostic).not.toContain("token=abc");
    expect(diagnostic.length).toBeLessThanOrEqual(160);
  });

  it("makes the constrained role the database owner and removes PUBLIC database access", () => {
    const plan = postgresLeastPrivilegePlan({
      roleName: `lg_${"a".repeat(24)}`,
      rolePassword: "b".repeat(43),
      databaseName: `lineageguard_${"c".repeat(24)}`,
    }).join(";\n");
    expect(plan).toContain(
      "NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOREPLICATION NOBYPASSRLS",
    );
    expect(plan).toContain(
      `CREATE DATABASE lineageguard_${"c".repeat(24)} OWNER lg_${"a".repeat(24)}`,
    );
    expect(plan).toContain(
      `REVOKE CONNECT,TEMPORARY,CREATE ON DATABASE lineageguard_${"c".repeat(24)} FROM PUBLIC`,
    );
    expect(plan).toContain("REVOKE CONNECT,TEMPORARY ON DATABASE postgres FROM PUBLIC");
  });

  it("seals dbt inputs from descriptor-observed bytes even if the candidate object changes", async () => {
    const current = await fixture();
    const snapshots = await snapshotMaterializedArtifacts(
      current.materialized,
      current.value,
      current.value.artifacts.map((artifact) => artifact.path),
    );
    const model = current.value.artifacts.find((artifact) => artifact.kind === "DBT_MODEL");
    if (!model) throw new Error("model fixture missing");
    const observed = model.content;
    model.content = "select 'mutated-after-observation'\n";
    const first = await mkdtemp(join(current.checkoutPath, ".bundle-test-a-"));
    const second = await mkdtemp(join(current.checkoutPath, ".bundle-test-b-"));
    const sealedA = await createSealedValidationBundle(first, current.value, snapshots);
    const sealedB = await createSealedValidationBundle(second, current.value, snapshots);
    expect(await readFile(join(first, "project/models/orders.sql"), "utf8")).toBe(observed);
    expect(sealedA.fingerprint).toBe(sealedB.fingerprint);
    expect(await readFile(join(first, "manifest.json"), "utf8")).toBe(
      await readFile(join(second, "manifest.json"), "utf8"),
    );
    await chmod(first, 0o700);
    await chmod(second, 0o700);
    await current.materialized.cleanup();
  });

  it("fails closed before validation when content-addressed images are not locally verified", async () => {
    const current = await fixture();
    const runner = new RecordingRunner();
    await expect(
      executeValidationInOwnedDatabase(
        current.value,
        current.materialized,
        expected,
        {
          baseFixtureSql: "select 1;",
          dockerExecutable: "/usr/bin/true",
          validationRunnerImageId: `sha256:${"a".repeat(64)}`,
          postgresImageId: `sha256:${"b".repeat(64)}`,
          sqlDriverImplementationId: "lineageguard-postgres-driver",
          sqlDriverVersion: "pg 8.16.3",
          dbtImplementationId: "lineageguard-dbt-container",
          dbtVersion: "dbt-core 1.12.0/dbt-postgres 1.11.0",
          timeoutMs: 1_000,
          maxOutputBytes: 4_096,
        },
        runner,
      ),
    ).rejects.toMatchObject({ code: "MISSING_TOOL" });
    expect(runner.commands.every((command) => command.args[0] === "image")).toBe(true);
    await current.materialized.cleanup();
  });

  it("builds a no-mount, no-pull, internal-network container plan without host secrets", () => {
    process.env.POISON_PROVIDER_SECRET = "must-not-escape";
    const common = {
      name: "lineageguard-test",
      owner: "a".repeat(48),
      networkName: "lineageguard-private",
      imageId: `sha256:${"b".repeat(64)}`,
      adminPassword: "ephemeral-admin-only",
    };
    const postgres = postgresContainerCreateArgs(common);
    const validator = validationContainerCreateArgs(common);
    for (const args of [postgres, validator]) {
      expect(args).toContain("never");
      expect(args).toContain("--read-only");
      expect(args).toContain("--cap-drop");
      expect(args).toContain("no-new-privileges");
      expect(args).not.toContain("--volume");
      expect(args).not.toContain("--mount");
      expect(args.join("\0")).not.toContain("must-not-escape");
      expect(args.at(-1)?.includes(common.imageId) || args.includes(common.imageId)).toBe(true);
    }
    expect(validator).not.toContain("--publish");
    expect(validator.join("\0")).not.toContain(common.adminPassword);
    delete process.env.POISON_PROVIDER_SECRET;
  });

  it("dual-homes only PostgreSQL while keeping the validation runner on the internal network", () => {
    const internalNetworkId = "a".repeat(64);
    const postgresContainerId = "b".repeat(64);
    expect(postgresInternalNetworkConnectArgs(internalNetworkId, postgresContainerId)).toEqual([
      "network",
      "connect",
      "--alias",
      "validation-db",
      internalNetworkId,
      postgresContainerId,
    ]);
    expect(
      validationContainerCreateArgs({
        name: "runner",
        owner: "c".repeat(48),
        networkName: internalNetworkId,
        imageId: `sha256:${"d".repeat(64)}`,
      }),
    ).not.toContain("--publish");
  });

  it("never removes a Docker object when the ownership label is ambiguous", async () => {
    const commands: FixedCommand[] = [];
    const runner: CommandRunner = {
      async run(command) {
        commands.push(command);
        return { exitCode: 0, stdout: "different-owner\n", stderr: "" };
      },
    };
    await expect(
      removeOwnedDockerObject(
        runner,
        { path: "/usr/bin/true", digest: "a".repeat(64) },
        "/tmp",
        "container",
        "lineageguard-owned",
        "expected-owner",
        {
          baseFixtureSql: "select 1;",
          dockerExecutable: "/usr/bin/true",
          validationRunnerImageId: `sha256:${"a".repeat(64)}`,
          postgresImageId: `sha256:${"b".repeat(64)}`,
          sqlDriverImplementationId: "lineageguard-postgres-driver",
          sqlDriverVersion: "pg 8.16.3",
          dbtImplementationId: "lineageguard-dbt-container",
          dbtVersion: "dbt-core 1.12.0/dbt-postgres 1.11.0",
          timeoutMs: 1_000,
          maxOutputBytes: 4_096,
        },
      ),
    ).rejects.toMatchObject({ code: "CLEANUP_FAILED" });
    expect(commands).toHaveLength(1);
  });

  it("removes only the persisted Docker ID and requires a proven not-found result", async () => {
    const id = "a".repeat(64);
    const commands: FixedCommand[] = [];
    const responses = [
      { exitCode: 0, stdout: `${id}\texpected-owner\n`, stderr: "" },
      { exitCode: 0, stdout: id, stderr: "" },
      { exitCode: 1, stdout: "", stderr: `Error: No such container: ${id}` },
    ];
    await removeOwnedDockerObject(
      {
        async run(command) {
          commands.push(command);
          const response = responses.shift();
          if (!response) throw new Error("unexpected command");
          return response;
        },
      },
      { path: "/usr/bin/true", digest: "b".repeat(64) },
      "/tmp",
      "container",
      "mutable-name",
      "expected-owner",
      {
        baseFixtureSql: "create schema fixture",
        dockerExecutable: "/usr/bin/true",
        validationRunnerImageId: `sha256:${"a".repeat(64)}`,
        postgresImageId: `sha256:${"b".repeat(64)}`,
        sqlDriverImplementationId: "lineageguard-postgres-driver",
        sqlDriverVersion: "pg 8.16.3",
        dbtImplementationId: "lineageguard-dbt-container",
        dbtVersion: "dbt-core 1.12.0/dbt-postgres 1.11.0",
        timeoutMs: 1_000,
        maxOutputBytes: 4_096,
      },
      id,
    );
    expect(commands[0]?.args.at(-1)).toBe(id);
    expect(commands[1]?.args).toEqual(["rm", "--force", id]);
    expect(commands[2]?.args.at(-1)).toBe(id);
  });

  it("fails closed when Docker inspection errors are not proven absence", async () => {
    await expect(
      removeOwnedDockerObject(
        {
          async run() {
            return { exitCode: 1, stdout: "", stderr: "Cannot connect to the Docker daemon" };
          },
        },
        { path: "/usr/bin/true", digest: "a".repeat(64) },
        "/tmp",
        "network",
        "lineageguard-owned",
        "expected-owner",
        {
          baseFixtureSql: "create schema fixture",
          dockerExecutable: "/usr/bin/true",
          validationRunnerImageId: `sha256:${"a".repeat(64)}`,
          postgresImageId: `sha256:${"b".repeat(64)}`,
          sqlDriverImplementationId: "lineageguard-postgres-driver",
          sqlDriverVersion: "pg 8.16.3",
          dbtImplementationId: "lineageguard-dbt-container",
          dbtVersion: "dbt-core 1.12.0/dbt-postgres 1.11.0",
          timeoutMs: 1_000,
          maxOutputBytes: 4_096,
        },
      ),
    ).rejects.toMatchObject({ code: "CLEANUP_FAILED" });
  });
});

describe("untrusted SQL and dbt capability denial", () => {
  it("accepts only the exact canonical expand and rollback programs", () => {
    expect(() =>
      assertCanonicalGeneratedSql(canonicalMigrationSql, "EXPAND_MIGRATION"),
    ).not.toThrow();
    expect(() => assertCanonicalGeneratedSql(canonicalRollbackSql, "ROLLBACK")).not.toThrow();
  });

  it.each([
    "\\! touch /tmp/pwned",
    "\\connect postgres",
    "COPY commerce.orders TO PROGRAM 'sh -c id'",
    "CREATE/**/DATABASE escaped",
    "ALTER ROLE validator SUPERUSER",
    "select dblink('host=outside', 'select 1')",
    "ALTER EXTENSION plpgsql UPDATE",
    "DROP EXTENSION plpgsql",
    "CREATE SERVER escaped FOREIGN DATA WRAPPER postgres_fdw",
    "ALTER FOREIGN DATA WRAPPER postgres_fdw OPTIONS (ADD x 'y')",
    "DROP USER MAPPING FOR validator SERVER escaped",
    "select dblink_connect('outside')",
    "select dblink_exec('outside', 'drop table x')",
    "select lo_open(1, 0)",
    "select loread(lo_open(1, 0), 1024)",
    "GRANT postgres TO validator",
    "REVOKE ALL ON DATABASE postgres FROM postgres",
    "alter table commerce.orders owner to postgres",
    "select * from commerce.orders",
    "(select repeat('x', 1000000))",
    "update commerce.orders set customer_id=1 returning *",
    "do $$ begin execute 'create ' || 'extension dblink'; end $$",
    "create procedure commerce.escape(inout payload text) language sql as $$ select repeat('x', 10000000) $$; call commerce.escape(null);",
    "call commerce.materialize_large_output(null)",
    "with payload as (select repeat('x', 10000000)) update commerce.orders set buyer_id=1 from payload",
    "create function commerce.escape() returns text language sql as $$ select repeat('x', 10000000) $$",
    "copy commerce.orders to stdout",
  ])("rejects non-canonical generated SQL: %s", (sql) => {
    expect(() => assertCanonicalGeneratedSql(sql, "EXPAND_MIGRATION")).toThrowError(
      expect.objectContaining({ code: "COMMAND_FAILED" }),
    );
  });

  it("enforces the remaining global deadline on every server query", async () => {
    let cancelled = false;
    let calls = 0;
    const client = {
      async query() {
        calls += 1;
        if (calls === 1) return { rows: [], fields: [] };
        return new Promise<never>(() => undefined);
      },
      async end() {
        return undefined;
      },
      connection: { stream: { destroy: () => (cancelled = true) } },
    };
    await expect(
      executeBoundedServerSql(
        client as never,
        canonicalMigrationSql,
        Date.now() + 20,
        "EXPAND_MIGRATION",
      ),
    ).rejects.toMatchObject({ code: "COMMAND_TIMEOUT" });
    expect(cancelled).toBe(true);
  });

  it("fails closed if the driver reports rows for generated SQL", async () => {
    let calls = 0;
    const client = {
      async query() {
        calls += 1;
        return calls === 1
          ? { rows: [], fields: [] }
          : { rows: Array.from({ length: 10_000 }, () => ({ poison: true })), fields: [] };
      },
      async end() {},
    };
    await expect(
      executeBoundedServerSql(
        client as never,
        canonicalMigrationSql,
        Date.now() + 1_000,
        "EXPAND_MIGRATION",
      ),
    ).rejects.toMatchObject({ code: "COMMAND_FAILED" });
  });

  it("bounds client shutdown and destroys an ambiguous connection", async () => {
    let destroyed = false;
    const client = {
      async query() {
        return { rows: [], fields: [] };
      },
      async end() {
        return new Promise<never>(() => undefined);
      },
      connection: { stream: { destroy: () => (destroyed = true) } },
    };
    await expect(endPgClient(client as never, Date.now() + 20)).rejects.toMatchObject({
      code: "COMMAND_TIMEOUT",
    });
    expect(destroyed).toBe(true);
  });

  it.each([
    "select {{ run_query('create database escaped') }}",
    "{% call statement('escape') %} select 1 {% endcall %}",
    "select {{ modules.os.environ }}",
    "{% do adapter.execute('copy x to program y') %}",
  ])("rejects non-allowlisted dbt Jinja: %s", (content) => {
    const value = candidate();
    const model = value.artifacts.find((artifact) => artifact.kind === "DBT_MODEL");
    if (!model) throw new Error("model fixture missing");
    model.content = content;
    expect(() => assertSafeDbtProject(value)).toThrowError(
      expect.objectContaining({ code: "COMMAND_FAILED" }),
    );
  });
});

describe("runtime validation capability accessors", () => {
  it("rejects forged live and replay objects even through any/JS shapes", () => {
    expect(() => readRuntimeVerifiedLiveReceipt({ receipt: {} } as unknown)).toThrowError(
      expect.objectContaining({ code: "ATTESTATION_INVALID" }),
    );
    expect(() =>
      readRuntimeVerifiedReplayPresentation({ presentation: {} } as unknown),
    ).toThrowError(expect.objectContaining({ code: "ATTESTATION_INVALID" }));
  });

  it("rejects signer composition in a generic worker or mixed-credential process", () => {
    vi.stubEnv("LINEAGEGUARD_PROCESS_ROLE", "VALIDATION_AUTHORITY");
    vi.stubEnv("LINEAGEGUARD_EFFECT_AUTHORITY_DATABASE_URL", "postgresql://poison");
    expect(() =>
      startValidationReceiptIssuerProcess({
        trustedPublicKeys: [],
        runtimePolicy: {} as never,
        createStore: () => ({}) as never,
        async resolveMaterialization() {
          return {} as never;
        },
      }),
    ).toThrowError(expect.objectContaining({ code: "ATTESTATION_INVALID" }));
  });

  it("starts a signer-only IPC surface from validation-process credentials", () => {
    const { privateKey, publicKey } = generateKeyPairSync("ed25519");
    const keys = [
      {
        algorithm: "ED25519" as const,
        issuer: "lineageguard-test",
        keyId: "test-key",
        publicKeySpkiPem: publicKey.export({ type: "spki", format: "pem" }).toString(),
      },
    ];
    vi.stubEnv("LINEAGEGUARD_PROCESS_ROLE", "VALIDATION_AUTHORITY");
    vi.stubEnv("LINEAGEGUARD_VALIDATION_SIGNER_DATABASE_URL", "postgresql://signer-only");
    vi.stubEnv(
      "VALIDATION_ATTESTATION_PRIVATE_KEY_PKCS8_PEM",
      privateKey.export({ type: "pkcs8", format: "pem" }).toString(),
    );
    vi.stubEnv("VALIDATION_ATTESTATION_ISSUER", "lineageguard-test");
    vi.stubEnv("VALIDATION_ATTESTATION_KEY_ID", "test-key");
    const client = startValidationReceiptIssuerProcess({
      trustedPublicKeys: keys,
      runtimePolicy: {} as never,
      createStore: (databaseUrl) => {
        expect(databaseUrl).toBe("postgresql://signer-only");
        return {} as never;
      },
      async resolveMaterialization() {
        return {} as never;
      },
    });
    expect(Object.keys(client)).toEqual(["issueValidationReceipt"]);
    expect("reserveCurrentEffect" in client).toBe(false);
  });

  it("starts an effect-only IPC surface without signer credentials", () => {
    vi.stubEnv("LINEAGEGUARD_PROCESS_ROLE", "EFFECT_AUTHORITY");
    vi.stubEnv("LINEAGEGUARD_EFFECT_AUTHORITY_DATABASE_URL", "postgresql://effect-only");
    const client = startEffectAuthorizationProcess({
      trustedPublicKeys: [],
      createStore: (databaseUrl) => {
        expect(databaseUrl).toBe("postgresql://effect-only");
        return {} as never;
      },
    });
    expect(Object.keys(client).sort()).toEqual([
      "cancelCurrentEffectBeforeSend",
      "consumeCurrentEffect",
      "reserveCurrentEffect",
      "verifyCurrentEffectReservation",
    ]);
    expect("issueValidationReceipt" in client).toBe(false);
  });

  it("rejects a private signer key in the effect authority process", () => {
    vi.stubEnv("LINEAGEGUARD_PROCESS_ROLE", "EFFECT_AUTHORITY");
    vi.stubEnv("VALIDATION_ATTESTATION_PRIVATE_KEY_PKCS8_PEM", "poison");
    expect(() =>
      startEffectAuthorizationProcess({ trustedPublicKeys: [], createStore: () => ({}) as never }),
    ).toThrowError(expect.objectContaining({ code: "ATTESTATION_INVALID" }));
  });
});

describe("validation runtime configuration", () => {
  it("requires explicit server-only runtime policy without defaults", () => {
    expect(() => loadValidationRuntimePolicy({})).toThrowError(
      expect.objectContaining({ code: "INVALID_PATH" }),
    );
  });
});
