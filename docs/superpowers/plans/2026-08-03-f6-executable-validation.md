# F6 Executable Validation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use `superpowers:subagent-driven-development` (recommended) or `superpowers:executing-plans` to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Execute the exact generated artifact fingerprint in isolated Git/database resources and return a structured receipt that passes for the canonical migration and fails for a deliberately broken compatibility patch.

**Architecture:** `packages/validation` owns sandbox lifecycle, allowlisted process execution, SQL/dbt/consumer checks, log redaction, and receipt creation. It receives a materialized F5 patch but has no GitHub or DataHub mutation port. Each run gets distinct primary and rollback PostgreSQL databases on the dedicated `validation-postgres` service. Worker state becomes publishable only after a matching transactionally committed `PASS` receipt.

**Tech Stack:** Node.js 24.18.0, TypeScript 6.0.3, PostgreSQL 17.10, dbt Core 1.12.0, dbt-postgres 1.11.0, Python 3.12.13/uv 0.11.32, Vitest 4.1.10.

## Global Constraints

- Branch `feat/f6-executable-validation` starts from accepted F5.
- Never execute a model-provided command; select from typed validator operations only.
- Use the dedicated validation PostgreSQL service, never DataHub's database or the application state database.
- Database names are `lgv_<p|r>_<12 lowercase hex run hash>_<12 lowercase hex input hash>`; `p` and `r` distinguish primary and rollback sandboxes, while the run hash prevents collision between concurrent runs sharing one artifact fingerprint.
- All spawned processes use executable plus argument arrays, fixed working directories, timeouts, output caps, and a minimal environment.
- Receipt hashes must match the exact materialized files; changed files invalidate the run.
- Cleanup failure is visible and prevents a `PASS` status.
- The F4 worker engine passes one `AbortSignal` and renews the active lease every 20 seconds throughout the up-to-eight-minute validation step; renewal loss aborts every validator/child process, performs bounded cleanup under a separate cleanup signal, and forbids the stale worker from committing a receipt, retry, or transition.

---

### Task 1: Define validation receipt and failure contracts

**Files:**
- Create: `packages/domain/src/validation.ts`
- Create: `packages/domain/test/validation.test.ts`
- Modify: `packages/domain/src/index.ts`
- Create: `packages/validation/src/errors.ts`
- Modify: `packages/validation/src/index.ts`

**Interfaces:**

```ts
interface ValidationReceipt {
  id: string;
  runId: string;
  inputFingerprint: string;
  status: "PASS" | "FAIL" | "ERROR";
  checks: readonly ValidationCheckReceipt[];
  artifactHashes: Readonly<Record<string, string>>;
  sandbox: {
    databaseNameHashes: { primary: string; rollback: string };
    cleanedUp: boolean;
  };
  startedAt: string;
  completedAt: string;
}
```

Failure codes are exactly `COMMAND_DENIED`, `PATH_DENIED`, `TIMEOUT`, `DATABASE_UNAVAILABLE`, `SQL_APPLY_FAILED`, `BACKFILL_MISMATCH`, `NULL_COVERAGE_FAILED`, `DBT_PARSE_FAILED`, `DBT_BUILD_FAILED`, `LEGACY_CONSUMER_FAILED`, `NEW_FIELD_CHECK_FAILED`, `ROLLBACK_SETUP_MISMATCH`, `ROLLBACK_SYNTAX_FAILED`, `ROLLBACK_SEMANTICS_FAILED`, `ARTIFACT_HASH_MISMATCH`, `CLEANUP_FAILED`, and `INTERNAL_ERROR`.

The required ordered check registry includes distinct `FORWARD_PRIMARY_PREPARED`, `FORWARD_ROLLBACK_PREPARED`, and `ROLLBACK_SETUP_EQUIVALENT` checks before any rollback syntax/semantics check. `PASS` is impossible if any is absent.

- [ ] **Step 1: Write failing strict-schema and aggregate-status tests**

Cover all-pass, one failed assertion, infrastructure error, missing check (including each forward/setup-equivalence check), duplicate check, changed artifact hash, invalid timing, leaked database name, and cleanup false. Assert `PASS` requires every required check to pass and `cleanedUp=true`.

- [ ] **Step 2: Run and observe missing contracts**

Run: `pnpm --filter @lineageguard/domain vitest run test/validation.test.ts`
Expected: FAIL resolving `validation.js`.

- [ ] **Step 3: Implement schemas, ID/fingerprint construction, and aggregate status**

Receipt ID is derived from run ID, input fingerprint, sorted artifact hashes, and validator-policy version; it excludes durations, timestamps, logs, and observed result ordering so retries address the same validation intent. Persist safe database-name hash, not credentials or full connection strings. Truncate/redact check output before schema validation.

- [ ] **Step 4: Run domain tests and typecheck**

Run: `pnpm --filter @lineageguard/domain test -- validation && pnpm --filter @lineageguard/domain typecheck`
Expected: PASS.

- [ ] **Step 5: Commit validation contracts**

```bash
git add packages/domain packages/validation/src/errors.ts packages/validation/src/index.ts
git commit -m "feat(domain): define executable validation receipts"
```

---

### Task 2: Implement sandbox database lifecycle and command policy

**Files:**
- Create: `packages/validation/src/sandbox/validation-database.ts`
- Create: `packages/validation/src/sandbox/database-name.ts`
- Create: `packages/validation/src/sandbox/command-policy.ts`
- Create: `packages/validation/src/sandbox/process-runner.ts`
- Create: `packages/validation/test/validation-database.integration.test.ts`
- Create: `packages/validation/test/command-policy.test.ts`
- Create: `packages/validation/test/process-runner.test.ts`

**Interfaces:**
- `ValidationDatabase.create(input: { runId: string; inputFingerprint: string; purpose: "PRIMARY" | "ROLLBACK" }, options: { signal: AbortSignal }): Promise<DatabaseLease>`.
- `DatabaseLease.connection(): RedactedDatabaseConnection` and `dispose(options: { signal: AbortSignal }): Promise<CleanupReceipt>`.
- `runValidatorOperation(operation: ValidatorOperation, options: { signal: AbortSignal }): Promise<CommandReceipt>`.

Typed operations are `PSQL_FILE`, `DBT_PARSE`, `DBT_COMPILE`, `DBT_BUILD`, and `DBT_TEST`. No generic command-string operation exists.

- [ ] **Step 1: Write failing lifecycle and deny-by-default tests**

Cover valid create/drop, simultaneous primary/rollback leases for one run/input, two concurrent run IDs with the same input fingerprint yielding four distinct names, same run/purpose collision, unsafe run ID/fingerprint/purpose, server unavailable, partial create, active-connection cleanup, arbitrary binary, extra dbt selector, wrong cwd, symlink path, inherited secret environment, timeout, signal termination, and output cap.

- [ ] **Step 2: Run tests and observe missing implementation**

Run: `pnpm --filter @lineageguard/validation vitest run test/command-policy.test.ts test/process-runner.test.ts`
Expected: FAIL resolving sandbox modules.

- [ ] **Step 3: Implement explicit process descriptors**

```ts
type ValidatorOperation =
  | { kind: "PSQL_FILE"; file: ValidatedSqlPath; database: SafeDatabaseName }
  | { kind: "DBT_PARSE"; projectDir: ValidatedDbtRoot }
  | { kind: "DBT_COMPILE"; projectDir: ValidatedDbtRoot; selector: "lineageguard_canonical" }
  | { kind: "DBT_BUILD"; projectDir: ValidatedDbtRoot; selector: "lineageguard_canonical" }
  | { kind: "DBT_TEST"; projectDir: ValidatedDbtRoot; selector: "lineageguard_canonical" };
```

Map internally to `psql --set=ON_ERROR_STOP=1 --file ...` or `uv run --project tools/datahub dbt ...`. Thread the caller signal into `spawn`; on abort send `SIGTERM`, wait at most five seconds, then `SIGKILL`, drain bounded output, and return an aborted command result that cannot become a receipt. Use 60-second per-operation and 8-minute aggregate defaults, 256 KiB combined output cap, safe cwd roots, and only required database/locale/PATH variables.

`database-name.ts` computes `sha256(runId)` and uses the already validated input fingerprint to render exactly `lgv_p_<run12>_<input12>` or `lgv_r_<run12>_<input12>`. It validates the final PostgreSQL identifier and never persists/logs the raw name; receipts contain separate SHA-256 hashes for the primary and rollback names.

- [ ] **Step 4: Run policy and live database tests**

Run: `pnpm db:test:up && pnpm --filter @lineageguard/validation test -- command-policy process-runner && pnpm --filter @lineageguard/validation test:integration -- validation-database`
Expected: PASS; created test databases are absent after the suite.

- [ ] **Step 5: Commit sandbox controls**

```bash
git add packages/validation/src/sandbox packages/validation/test/command-policy.test.ts packages/validation/test/process-runner.test.ts packages/validation/test/validation-database.integration.test.ts
git commit -m "feat(validation): isolate commands and per-run databases"
```

---

### Task 3: Validate SQL application and backfill invariants

**Files:**
- Create: `packages/validation/src/sql-validator.ts`
- Create: `packages/validation/src/checks/backfill-equality.sql`
- Create: `packages/validation/src/checks/new-field-coverage.sql`
- Create: `packages/validation/test/sql-validator.integration.test.ts`
- Create: `packages/validation/test/fixtures/sql/broken-backfill.sql`
- Create: `packages/validation/test/fixtures/sql/destructive-drop.sql`

**Interfaces:** `validateSql(input: SqlValidationInput, lease, signal: AbortSignal): Promise<readonly ValidationCheckReceipt[]>`; input paths are prevalidated F5 artifacts and expected source/target field atoms.

- [ ] **Step 1: Write failing integration cases**

Test canonical schema load, additive column, idempotent backfill, equality, complete coverage for eligible rows, rerun safety, syntax error, source/target mismatch, destructive source drop, wrong table, and database disconnect.

- [ ] **Step 2: Run tests and observe missing validator**

Run: `pnpm --filter @lineageguard/validation vitest run test/sql-validator.integration.test.ts`
Expected: FAIL resolving `sql-validator.js`.

- [ ] **Step 3: Implement ordered SQL checks**

Load the known canonical seed, apply generated migration through the typed `PSQL_FILE` operation, query catalog state with parameterized driver calls, then execute fixed equality and coverage SQL. Verify `customer_id` still exists and `buyer_id` has compatible type before any success result.

- [ ] **Step 4: Run the full SQL suite**

Run: `pnpm --filter @lineageguard/validation test:integration -- sql-validator`
Expected: canonical PASS; broken backfill and destructive drop FAIL with their asserted codes; every database is cleaned.

- [ ] **Step 5: Commit SQL validators**

```bash
git add packages/validation/src/sql-validator.ts packages/validation/src/checks packages/validation/test/sql-validator.integration.test.ts packages/validation/test/fixtures/sql
git commit -m "feat(validation): verify additive SQL and backfill invariants"
```

---

### Task 4: Validate dbt, consumer compatibility, and rollback

**Files:**
- Create: `packages/validation/src/dbt-validator.ts`
- Create: `packages/validation/src/compatibility-validator.ts`
- Create: `packages/validation/src/post-migration-setup.ts`
- Create: `packages/validation/src/rollback-validator.ts`
- Create: `packages/validation/src/fixtures/legacy-finance-query.sql`
- Create: `packages/validation/src/fixtures/new-field-query.sql`
- Create: `packages/validation/test/dbt-validator.integration.test.ts`
- Create: `packages/validation/test/compatibility-validator.integration.test.ts`
- Create: `packages/validation/test/post-migration-setup.integration.test.ts`
- Create: `packages/validation/test/rollback-validator.integration.test.ts`
- Create: `demo/scenarios/broken/missing-compatibility-column.patch`
- Create: `demo/scenarios/broken/invalid-rollback.patch`
- Modify: `packages/validation/src/sql-validator.ts`

**Interfaces:**
- `validateDbt(input, lease, signal: AbortSignal): Promise<ValidationCheckReceipt[]>`.
- `validateCompatibility(input, lease, signal: AbortSignal): Promise<ValidationCheckReceipt[]>`.
- `preparePostMigrationSandbox(input, lease, signal: AbortSignal): Promise<PostMigrationStateReceipt>` loads the canonical seed, applies the exact hash-checked forward migration artifacts in manifest order, builds the patched canonical dbt selector, asserts additive/backfill invariants, and returns a stable schema/data/model-state fingerprint.
- `validateRollback(input: { rollback: RollbackPlan; bundle: PatchBundle; inputFingerprint: string }, rollbackLease, signal: AbortSignal): Promise<ValidationCheckReceipt[]>`; it resolves the exact referenced `.rollback.sql` file and verifies its hash before execution.

- [ ] **Step 1: Write failing dbt and compatibility tests**

Cover parse/compile/build/test success, compile error, failing data test, selector escape, old Finance query success, new-field query success, missing old column, mismatched values, query timeout, identical post-migration setup/fingerprint on primary and rollback, skipped forward setup, a changed/missing forward artifact only in rollback setup, unequal post-migration fingerprint, valid rollback syntax/application, restored legacy query, invalid rollback syntax, an idempotent no-op rollback against an unprepared database, rollback that drops the source column, rollback mismatch, and both broken patches' expected failures.

- [ ] **Step 2: Run tests and observe missing validators**

Run: `pnpm --filter @lineageguard/validation vitest run test/dbt-validator.integration.test.ts test/compatibility-validator.integration.test.ts test/post-migration-setup.integration.test.ts test/rollback-validator.integration.test.ts`
Expected: FAIL resolving validator modules.

- [ ] **Step 3: Implement fixed dbt selection and compatibility probes**

Use selector `lineageguard_canonical` only. Run parse/compile before build/test. Legacy and new probes are committed fixed SQL, executed through parameterized/allowlisted paths, and assert returned values—not merely exit status. Refactor primary forward setup through `preparePostMigrationSandbox`, then call that same helper independently for `ROLLBACK` on the same run/input pair. Both calls load the same canonical seed, verify and apply the exact same forward artifact hashes/order, build the same patched dbt selector, and pass the same additive/backfill invariants. Compare their stable post-migration schema/data/model fingerprints and fail `ROLLBACK_SETUP_MISMATCH` before reading/executing rollback if setup was skipped, an artifact differs, or state is unequal.

Only after setup equivalence passes, apply the declared SQL rollback to `ROLLBACK`, then assert syntax/application success, `customer_id` preservation, legacy Finance query success, and removal/reversal only of the new compatibility artifact. The setup receipt proves `buyer_id` existed and matched `customer_id` before rollback, so an idempotent no-op rollback cannot pass on an unprepared database. Never test rollback against `PRIMARY`.

- [ ] **Step 4: Run canonical and broken integration cases**

Run: `pnpm --filter @lineageguard/validation test:integration -- dbt-validator compatibility-validator post-migration-setup rollback-validator`
Expected: canonical PASS; missing-compatibility patch fails `LEGACY_CONSUMER_FAILED`; skipped/different forward setup fails `ROLLBACK_SETUP_MISMATCH`; invalid rollback fails `ROLLBACK_SYNTAX_FAILED` or `ROLLBACK_SEMANTICS_FAILED` as asserted.

- [ ] **Step 5: Commit dbt and compatibility validation**

```bash
git add packages/validation/src/dbt-validator.ts packages/validation/src/compatibility-validator.ts packages/validation/src/post-migration-setup.ts packages/validation/src/rollback-validator.ts packages/validation/src/sql-validator.ts packages/validation/src/fixtures packages/validation/test/dbt-validator.integration.test.ts packages/validation/test/compatibility-validator.integration.test.ts packages/validation/test/post-migration-setup.integration.test.ts packages/validation/test/rollback-validator.integration.test.ts demo/scenarios/broken
git commit -m "feat(validation): prove dbt compatibility and rollback"
```

---

### Task 5: Aggregate receipts, redact logs, and persist the worker step

**Files:**
- Create: `packages/validation/src/validator.ts`
- Create: `packages/validation/src/log-redaction.ts`
- Create: `packages/validation/test/validator.integration.test.ts`
- Create: `packages/validation/test/log-redaction.test.ts`
- Create: `packages/validation/test/fixtures/sql/long-running.sql`
- Create: `packages/db/src/schema/validation-receipts.ts`
- Create: `packages/db/src/repositories/validation-repository.ts`
- Create: `packages/db/test/validation-receipt.integration.test.ts`
- Create: `apps/worker/src/orchestration/steps/validate-migration.ts`
- Create: `apps/worker/test/validate-migration.integration.test.ts`
- Create: `demo/scenarios/canonical/validation-expectations.json`

**Interfaces:** `validateMigration(input, context: WorkerStepExecutionContext): Promise<ValidationReceipt>` passes `context.signal` through every validator and process. `ValidationRepository.insert(transaction: DbTransaction, receipt: ValidationReceipt): Promise<void>` is transaction-aware only and has no standalone autocommit save. The step always attempts cleanup of both primary and rollback databases in `finally` using a new 15-second cleanup controller rather than the already-aborted work signal. Worker transitions `PATCH_GENERATED -> VALIDATING` before execution, accepts the receipt only if the signal remains live and run/artifact/input fingerprints all match, then calls F4's `commitTransitionAndRelease` with a domain-writer callback that inserts the receipt in the exact transaction containing the event, `VALIDATED` or terminal `FAILED_VALIDATION` status/version, and lease release. Lease loss is neither: the stale worker persists no receipt/retry/transition.

- [ ] **Step 1: Write failing aggregate, retry, redaction, and persistence tests**

Cover accepted `PATCH_GENERATED -> VALIDATING -> VALIDATED` order, terminal `FAILED_VALIDATION`, all checks including rollback in order, early infrastructure error, later assertion failure, cleanup of both databases after every path, secret patterns, output truncation, same fingerprint retry, conflicting receipt, receipt-insert success followed by event failure, event preparation followed by receipt conflict, transaction rollback, restart after `VALIDATING`, stale artifact hash, two concurrent runs with the same input fingerprint, and renewal loss during a real long-running `psql` fixture. Both transaction-failure orders must leave no receipt/event/status/version/release. The renewal-loss integration must observe abort propagation, `SIGTERM`/bounded `SIGKILL` behavior, child exit, both database/worktree cleanups, no validation receipt, no stale retry/transition, and successful later reclaim from `VALIDATING`.

- [ ] **Step 2: Run and observe missing aggregator/repository**

Run: `pnpm --filter @lineageguard/validation vitest run test/validator.integration.test.ts test/log-redaction.test.ts && pnpm --filter @lineageguard/db test:integration -- validation-receipt`
Expected: FAIL resolving new modules.

- [ ] **Step 3: Implement validation pipeline and idempotent receipt storage**

Recompute hashes immediately before every execution group and once before finalization. Reconcile an already committed receipt by run/input fingerprint; same input returns its existing receipt, different content conflicts. For a new completed outcome, call `commitTransitionAndRelease` and insert bounded redacted outputs plus injected-clock timestamps only through its `DbTransaction`; never save the receipt before or after that transaction independently.

- [ ] **Step 4: Run package and worker integration tests**

Run: `pnpm --filter @lineageguard/validation test && pnpm --filter @lineageguard/db test:integration && pnpm --filter @lineageguard/worker test -- validate-migration`
Expected: PASS with no database/worktree leak.

- [ ] **Step 5: Commit receipt aggregation and orchestration**

```bash
git add packages/validation packages/db apps/worker demo/scenarios/canonical/validation-expectations.json
git commit -m "feat(worker): persist exact executable validation receipts"
```

---

### Task 6: Add canonical and broken CLI gates, review, and close Gate C

**Files:**
- Create: `scripts/demo-migration-generate.ts`
- Create: `scripts/demo-migration-validate.ts`
- Modify: `package.json`
- Modify: `README.md`

- [ ] **Step 1: Write CLI integration tests before wiring scripts**

Assert canonical exit zero/`status=PASS`; compatibility-broken scenario nonzero/`code=LEGACY_CONSUMER_FAILED`; rollback-broken scenario nonzero with the asserted rollback code; unavailable database `ERROR`; changed artifact hash rejected; output contains no credentials.

- [ ] **Step 2: Run the missing commands and observe failure**

Run: `pnpm demo:migration:generate && pnpm demo:migration:validate`
Expected: FAIL because scripts are not wired.

- [ ] **Step 3: Wire deterministic generation and validation commands**

Own `"demo:migration:generate": "node scripts/demo-migration-generate.ts"` and `"demo:migration:validate": "node scripts/demo-migration-validate.ts"` in `package.json`. `demo:migration:validate --scenario canonical` validates exactly the generated manifest. `--scenario broken` applies the committed missing-compatibility patch; `--scenario broken-rollback` applies the committed invalid rollback; each returns a stable nonzero exit with its asserted failure code.

- [ ] **Step 4: Run an independent specification review**

Give a fresh read-only reviewer F6 spec, F5 manifest, validation expectations, broken fixture, and diff. Required result: every required check and named failure path maps to a receipt assertion. Resolve all blockers.

- [ ] **Step 5: Run an independent code-quality and security review**

Use a different fresh read-only reviewer. Inspect command/path allowlists, process APIs, database isolation/cleanup, SQL trust boundary, timeouts, resource limits, log redaction, hashes, retries, and receipt persistence. Resolve all blockers.

- [ ] **Step 6: Invoke `superpowers:verification-before-completion` and run Gate C**

```bash
pnpm --filter @lineageguard/validation test
pnpm demo:migration:generate
pnpm demo:migration:validate
pnpm demo:migration:validate --scenario broken
pnpm demo:migration:validate --scenario broken-rollback
pnpm format:check
pnpm lint
pnpm typecheck
```

Expected: generation and canonical validation exit zero; both broken scenarios exit nonzero with `code=LEGACY_CONSUMER_FAILED` and the asserted rollback code; quality gates exit zero. Capture all expected exit statuses explicitly in the task report.

- [ ] **Step 7: Commit commands and documentation**

```bash
git add scripts/demo-migration-generate.ts scripts/demo-migration-validate.ts package.json README.md
git commit -m "test(validation): prove canonical pass and broken failure"
```

Gate C is complete only when the receipt fingerprint matches the artifacts that F7 and F8 will publish.
