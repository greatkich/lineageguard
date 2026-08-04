# LineageGuard F0-F10 Feature Specifications

**Date:** 2026-08-03
**Status:** Approved on 2026-08-04
**Language:** English
**Implementation authorization:** F0 only; stop after F0 verification/review and do not begin F1 automatically

## Shared specification rules

Every feature below is independently reviewable and has its own observable acceptance boundary. A feature is complete only after:

- specification review against this document;
- red-green TDD for deterministic behavior;
- failure-path coverage;
- code-quality review in a fresh context;
- touched-package format, lint, type, unit, and integration checks;
- documentation and checked example updates;
- `superpowers:verification-before-completion` with current-worktree command output.

Cross-feature contracts live in `packages/domain` and are versioned through TypeScript types plus Zod schemas at untrusted boundaries. No UI component, MCP payload, database row, model response, or external API response is the domain source of truth.

The canonical scenario is the only polished demo scenario:

```text
commerce.orders.customer_id -> commerce.orders.buyer_id
```

The accepted judge-facing impact count is four:

1. `analytics.customer_revenue`;
2. Finance Revenue Dashboard;
3. Fraud Model v3;
4. unmanaged query `finance-monthly-close.sql`.

`analytics.stg_orders` and `fraud.customer_features` are visible lineage intermediates, not additional impact cards. The user accepted this convention on 2026-08-04; F1's checked expectation fixture is its single source of truth.

---

## F0 — Repository foundation and engineering gates

### User-visible outcome

A contributor can clone the repository, install pinned Node/Python dependencies, start the minimum local services, and run honest quality gates. No product capability is claimed.

### In scope

- pnpm workspace and Corepack pin;
- Node 24.18.0 and Python 3.12 policy;
- strict TypeScript base configuration;
- Biome formatting/linting;
- Vitest workspace;
- Playwright browser smoke configuration;
- explicit local Chromium provisioning through the pinned workspace Playwright CLI and Linux CI provisioning with browser system dependencies;
- `tools/datahub` uv project and locked Python toolchain;
- Compose layers for application PostgreSQL, validation PostgreSQL, and pinned DataHub 1.6 Quickstart integration;
- CI skeleton and environment preflight;
- documented task commands and secret names;
- approved ADR-003, ADR-004, and ADR-005 directions recorded as accepted decisions before dependent work.

### Out of scope

- canonical metadata;
- risk decisions;
- model calls;
- real GitHub/DataHub mutations;
- Mission Control behavior.

### Planned files and contracts

```text
package.json
pnpm-workspace.yaml
pnpm-lock.yaml
.node-version
.python-version
.npmrc
tsconfig.base.json
biome.jsonc
vitest.workspace.ts
playwright.config.ts
Makefile
README.md
compose.yaml
compose.datahub.yaml
.github/workflows/ci.yml
scripts/check-environment.sh
scripts/check-boundaries.mjs
scripts/verify-foundation.sh
scripts/verify-agent-skills.mjs
scripts/verify-agent-skills.test.mjs
skills-lock.json
docs/THIRD_PARTY_SKILLS.md
tests/foundation/package-boundaries.test.ts
tests/foundation/tooling-contracts.test.ts
tests/foundation/fixtures/implicit-any/tsconfig.json
tests/foundation/fixtures/implicit-any/index.ts
apps/web/package.json
apps/worker/package.json
packages/{domain,agent,datahub,github,validation,db,ui}/package.json
tools/datahub/pyproject.toml
tools/datahub/uv.lock
tools/datahub/tests/test_smoke.py
docs/DECISIONS/ADR-003-datahub-mcp-capability-boundaries.md
docs/DECISIONS/ADR-004-durable-workflow-and-idempotency.md
docs/DECISIONS/ADR-005-demo-deployment-and-exposure.md
```

The root `package.json` exposes exactly these repository gates plus the explicit browser setup command, even when a later feature initially has no tests:

```text
format:check
lint
typecheck
test
build
test:e2e
browser:install       # setup command, not a gate
demo:verify
env:check
boundaries:check
db:test:up
```

No empty gate may print a false success claim. A not-yet-applicable gate must run a documented smoke assertion or fail with a clear “feature not installed” state until its owning feature lands.

`browser:install` resolves the pinned workspace Playwright 1.62.1 CLI and installs Chromium. Local clean-clone setup owns `pnpm exec playwright install chromium`; Linux CI owns `pnpm exec playwright install --with-deps chromium` after the frozen pnpm install and before `scripts/verify-foundation.sh`. Browser provisioning is a setup prerequisite, never a test stub or a false-success branch inside `test:e2e`.

F0's sole `boundaries:check` gate uses this deny-by-default internal dependency matrix. A row is the importer; its set contains every internal owner it may import:

| Importer | Allowed internal imports |
|---|---|
| `packages/domain` | none |
| `packages/agent` | `packages/domain` |
| `packages/datahub` | `packages/domain` |
| `packages/github` | `packages/domain` |
| `packages/validation` | `packages/domain` |
| `packages/db` | `packages/domain` |
| `packages/ui` | `packages/domain` |
| `apps/worker` | `packages/domain`, `packages/agent`, `packages/datahub`, `packages/github`, `packages/validation`, `packages/db` |
| `apps/web` | `packages/domain`, `packages/db`, `packages/ui` |

Every unlisted cross-owner edge is forbidden, including every package-to-app edge. The gate inspects both workspace manifest dependencies and normalized source imports, rejects raw MCP modules/fixture shapes outside `packages/datahub`, and rejects every internal owner cycle with a stable cycle path. The matrix has 15 allowed and 57 forbidden off-diagonal edges. Tests generate one fixture for each of those 57 forbidden edges, exercise all 15 allowed edges in a fixture-only acyclic graph, assert package-to-app denial and raw MCP containment explicitly, and include a cycle fixture. Allowed edges are permissions, not required runtime coupling; a future package need changes the reviewed matrix and its table-driven tests before adding an import.

### Acceptance examples

- Fresh install with the pinned runtimes and lockfiles exits zero.
- A minimal `apps/web` route, worker process smoke, pure domain test, and Python test pass.
- A clean local setup provisions the pinned Chromium binary before the Playwright smoke; clean Linux CI provisions Chromium plus required system dependencies before the verification script.
- An executable TypeScript fixture extending the real shared configuration fails `tsc --noEmit` with a nonzero exit and diagnostic `TS7006` for an implicit parameter type.
- A deliberately malformed environment fails `pnpm env:check` with all missing requirements listed and no secret values.
- CI uses frozen/locked dependency installation and never generates a changed lockfile.
- Structured contract tests parse the effective Codex TOML and CI YAML, execute Make targets through controlled command shims, and prove the pinned MCP command, read-only mutation flag, and install/provision/verify ordering from behavior rather than source substrings.
- The agent-skill gate rejects missing, extra, tampered, symlinked, or non-regular vendored files, mutable or missing provenance, and inconsistent local-patch hashes; its bootstrap succeeds without any network-capable installer.
- The boundary fixture suite rejects every forbidden matrix edge and a cycle, while the complete allowed-edge fixture remains acyclic and passes.

### Feature verification

```bash
corepack pnpm install --frozen-lockfile
pnpm exec playwright install chromium
uv sync --project tools/datahub --locked
node --test scripts/verify-agent-skills.test.mjs
bash scripts/bootstrap-agent-tooling.sh
pnpm env:check
pnpm format:check
pnpm lint
pnpm boundaries:check
pnpm typecheck
pnpm test
pnpm build
pnpm test:e2e
pnpm demo:verify
uv run --project tools/datahub --locked pytest
git diff --exit-code -- pnpm-lock.yaml tools/datahub/uv.lock
```

Expected: zero exits, unchanged lockfiles, and no canonical product-success claim.

### Dependencies and release gate

Depends only on approved planning and E0 environment readiness. F1-F10 may not merge before F0.

---

## F1 — Canonical demo data and DataHub graph

### User-visible outcome

A human can open pinned DataHub OSS and see the complete canonical graph, query evidence, ownership, glossary meaning, and criticality. A machine verifier proves the same facts.

### In scope

- deterministic PostgreSQL commerce, analytics, and fraud schemas/data;
- dbt models for `analytics.stg_orders`, `analytics.customer_revenue`, and `fraud.customer_features`;
- Finance Revenue Dashboard and Fraud Model v3 entities;
- Finance Analytics and Risk ML owners;
- `Customer Identifier` glossary term on `commerce.orders.customer_id`;
- criticality/governance markers defined in a checked expectation fixture;
- exact Dataset-to-Dataset column mappings;
- entity-level edges to dashboard/model;
- committed unmanaged query `finance-monthly-close.sql` collected through `pg_stat_statements`;
- one existing DataHub document parent so MCP document tooling is available later;
- reset, seed, ingest, and verify commands.

### Out of scope

- proposed-change parsing;
- risk decisions;
- generated migration;
- application runtime dependence on Python.

### Planned files and contracts

```text
demo/warehouse/init/001-schemas.sql
demo/warehouse/init/002-tables.sql
demo/warehouse/init/003-seed.sql
demo/warehouse/queries/finance-monthly-close.sql
demo/dbt/dbt_project.yml
demo/dbt/profiles.yml
demo/dbt/models/staging/stg_orders.sql
demo/dbt/models/staging/stg_orders.yml
demo/dbt/models/analytics/customer_revenue.sql
demo/dbt/models/analytics/customer_revenue.yml
demo/dbt/models/fraud/customer_features.sql
demo/dbt/models/fraud/customer_features.yml
demo/metadata/postgres-ingestion.yml
demo/scenarios/canonical/expected-datahub-graph.json
tools/datahub/src/lineageguard_datahub/config.py
tools/datahub/src/lineageguard_datahub/reset.py
tools/datahub/src/lineageguard_datahub/seed.py
tools/datahub/src/lineageguard_datahub/ingest.py
tools/datahub/src/lineageguard_datahub/verify.py
tools/datahub/tests/test_expected_graph.py
tools/datahub/tests/test_secret_redaction.py
```

`expected-datahub-graph.json` is the single source for visible counts and stable logical fixture keys. It records URNs, entity types, owner URNs, field paths, edge granularity, query fingerprint, glossary term, criticality, and which nodes count as judge-facing impacts.

Python seeding code may use the official DataHub SDK/ingestion utilities, but it must not become an application backend. The runtime reads the resulting graph through MCP in F3.

### Acceptance examples

- Reset followed by seed and ingestion produces byte-for-byte-equivalent expectation output after volatile timestamps are normalized.
- `commerce.orders.customer_id` has column paths to `analytics.stg_orders.customer_id`, `analytics.customer_revenue.customer_id`, and `fraud.customer_features.customer_id` as applicable.
- Finance Revenue Dashboard and Fraud Model v3 are reachable downstream by entity-level lineage.
- MCP/query verification returns the canonical Finance query and its field reference.
- Owner and glossary assertions match the fixture.
- Running the seed twice does not duplicate entities or edges.

### Failure behavior

- Missing `pg_stat_statements`, insufficient `pg_read_all_stats`, absent query evidence, unresolved URNs, duplicate logical entities, missing ownership, or unexpected edge granularity fails verification with a typed diagnostic.
- The verifier distinguishes “MCP unavailable,” “entity absent,” and “graph differs.”
- Credentials and raw tokens are redacted from recipes, logs, pytest output, and fixtures.

### Feature verification

```bash
pnpm demo:data:reset
pnpm demo:data:seed
pnpm demo:data:ingest
pnpm demo:data:verify
uv run --project tools/datahub --locked pytest
```

Expected: all canonical expectations pass; a human review checklist links directly to each DataHub entity. This is Gate A.

### Dependencies and release gate

Depends on F0 and a reachable DataHub 1.6.0 instance. No downstream feature may claim real DataHub grounding until Gate A passes.

---

## F2 — Proposed change domain and parser

### User-visible outcome

LineageGuard deterministically recognizes the supported `customer_id -> buyer_id` rename from a committed Git diff and rejects unsupported or ambiguous SQL/dbt changes explicitly.

### In scope

- pure proposed-change types and Zod boundary schemas;
- canonical Git patch fixture;
- supported rename parser for the canonical SQL/dbt shape;
- repository-only context bundle from allowed paths and committed dbt manifest data;
- typed unsupported/ambiguous errors;
- fixture fingerprints for replay provenance.

### Planned files and contracts

```text
packages/domain/src/change.ts
packages/domain/src/repository-context.ts
packages/domain/src/errors.ts
packages/domain/src/index.ts
packages/domain/test/change.test.ts
packages/domain/test/repository-context.test.ts
apps/worker/src/change/git-diff-source.ts
apps/worker/src/change/parse-proposed-change.ts
apps/worker/test/change/parse-proposed-change.test.ts
demo/scenarios/canonical/unsafe-rename.patch
demo/scenarios/canonical/repository-context.json
demo/scenarios/unsupported/{multi-rename,type-change,dynamic-sql}.patch
```

Required public contract:

```ts
type ChangeOperation = "RENAME_FIELD";

interface ProposedChange {
  id: string;
  operation: ChangeOperation;
  dataset: DatasetRef;
  before: { fieldPath: string; nativeType: string | null };
  after: { fieldPath: string; nativeType: string | null };
  source: { repository: string; baseSha: string; headSha: string; patchSha256: string };
}

interface ProposedChangeParser {
  parse(input: RepositoryChangeInput): Result<ProposedChange, ChangeParseError>;
}

interface RepositoryChangeSource {
  load(input: ProposedChangeLocator, options: { signal: AbortSignal }): Promise<RepositoryChangeInput>;
}
```

### Acceptance examples

- Parsing the canonical patch returns exactly one `RENAME_FIELD` for `commerce.orders.customer_id -> buyer_id` with stable source fingerprint.
- Whitespace-only and comment-only changes do not alter the result.
- Multiple candidate renames, dynamic SQL, missing dataset qualification, and an unsupported type change return distinct error codes.
- Parser output is deterministic across process restarts and has no network dependency.
- Repository context contains only allowlisted files; attempts to traverse outside the checkout fail.
- The F4 step signal reaches Git and filesystem I/O; abort terminates the Git child and produces no parser receipt or stale transition.

### Feature verification

```bash
pnpm --filter @lineageguard/domain test -- change
pnpm --filter @lineageguard/worker test -- parse-proposed-change
pnpm --filter @lineageguard/domain typecheck
```

Expected: canonical green; all unsupported fixtures fail closed with asserted codes.

### Dependencies and release gate

Depends on F0. May be developed in parallel with F1 only with disjoint file ownership.

---

## F3 — DataHub context collector

### User-visible outcome

Given the parsed field rename, the worker resolves the unique DataHub field and returns normalized evidence for schemas, downstream lineage, exact paths, queries, owners, glossary meaning, and criticality. Raw MCP payloads never leave the adapter.

### In scope

- separate read and write port types, with F3 implementing only read;
- pinned official MCP stdio adapter and recorded adapter;
- read-phase tool allowlist and inventory validation;
- deterministic worker application service over `DataHubReadPort`; no model role is added for context collection;
- deterministic field resolution and ambiguity handling;
- normalized evidence with stable IDs/fingerprints/provenance;
- official MCP-shaped fixture contract tests;
- live integration test against F1.

### Planned files and contracts

```text
packages/datahub/src/ports.ts
packages/datahub/src/mcp/mcp-process.ts
packages/datahub/src/mcp/read-tool-policy.ts
packages/datahub/src/mcp/live-read-adapter.ts
packages/datahub/src/replay/recorded-read-adapter.ts
packages/datahub/src/context-collector.ts
packages/datahub/src/normalizers/{entities,lineage,paths,queries,governance}.ts
packages/datahub/src/stable-evidence-id.ts
packages/datahub/test/contract/datahub-read.contract.ts
packages/datahub/test/fixtures/canonical/*.json
packages/datahub/test/live/canonical-context.test.ts
apps/worker/src/context/collect-datahub-context.ts
apps/worker/test/context/collect-datahub-context.test.ts
```

Required public contracts:

```ts
interface DataHubReadPort {
  resolveField(ref: DatasetFieldRef, options: { signal: AbortSignal }): Promise<ResolvedField>;
  collectImpact(input: ImpactRequest, options: { signal: AbortSignal }): Promise<ImpactContext>;
}

interface EvidenceItem {
  id: EvidenceId;
  kind: EvidenceKind;
  subjectUrn: string;
  fieldPath?: string;
  source: "DATAHUB_MCP" | "RECORDED_DATAHUB_MCP";
  sourceTool: string;
  sourceFingerprint: string;
  criticality: "LOW" | "MEDIUM" | "HIGH" | "CRITICAL";
  payload: DomainEvidencePayload;
}

interface QueryEvidencePayload {
  type: "QUERY";
  queryFingerprint: string;
  querySource: "POSTGRES_QUERY_LOG" | "SQL_QUERIES_INGESTION";
  management: "UNMANAGED" | "MANAGED";
  lastSeenAt: string;
  referencedFieldPaths: readonly string[];
}
```

Deterministic adapter/application code selects the fixed tool sequence, verifies that all required evidence classes were collected, and owns resolution, normalization, deduplication, IDs, timeouts, and completeness. Model text is never evidence. LG003 uses a persisted assessment time and a 30-day inclusive recency window; exact time equality is valid, any future `lastSeenAt` is invalid, exactly 30 days is recent, and one millisecond beyond is stale.

### Acceptance examples

- Live and recorded adapters satisfy the same contract and produce the same normalized canonical evidence after volatile fields are removed.
- Canonical impact contains the accepted four judge-facing items and both visible lineage intermediates with distinct granularity.
- Every evidence-backed reason candidate has at least one stable evidence ID.
- Tool startup fails if any mutation tool is visible to the read adapter/client.
- A missing field, two matching dataset URNs, an empty required lineage set, a truncated path set, missing required query evidence, or a tool timeout fails with a distinct visible code.
- Raw MCP fields cannot be imported by packages other than `packages/datahub` (enforced by tests/lint boundary rule).
- The worker passes its active step signal through the application service, both adapters, every MCP request, and the stdio child; lease loss aborts them and permits no stale context persistence.

### Feature verification

```bash
pnpm --filter @lineageguard/datahub test
pnpm --filter @lineageguard/worker test -- collect-datahub-context
DATAHUB_TEST_MODE=live pnpm --filter @lineageguard/datahub test:integration
pnpm demo:data:verify
```

Expected: contract and live canonical evidence pass; read tool inventory contains no mutation tools.

### Dependencies and release gate

Depends on F1 and F2. Provides the grounded evidence input to F4.

---

## F4 — Deterministic risk engine and baseline comparison

### User-visible outcome

The same pure policy engine evaluates two evidence bundles. Repository-only evidence returns `ALLOW`; adding normalized DataHub evidence returns `BLOCK`. Each reason cites evidence IDs and the change in decision is explainable without model authority.

### In scope

- LG001-LG007 rule implementations with precedence;
- repository baseline evidence adapter;
- deterministic assessment function;
- explicit decision-delta object;
- complete persisted `RunStatus`/`RunEvent` contract, transactional queue claiming, step registry, retry/lease policy, and failure mapping;
- worker application steps for F2 parse, F3 context, baseline, and grounded decision, with extension points owned by F5-F8;
- persisted baseline/final assessments and immutable run events; canonical P0 uses deterministic message keys/templates and adds no baseline model role.

### Planned files and contracts

```text
packages/domain/src/decision.ts
packages/domain/src/policy/evaluate.ts
packages/domain/src/policy/precedence.ts
packages/domain/src/policy/rules/LG001.ts
packages/domain/src/policy/rules/LG002.ts
packages/domain/src/policy/rules/LG003.ts
packages/domain/src/policy/rules/LG004.ts
packages/domain/src/policy/rules/LG005.ts
packages/domain/src/policy/rules/LG006.ts
packages/domain/src/policy/rules/LG007.ts
packages/domain/src/decision-delta.ts
packages/domain/test/policy/*.test.ts
packages/db/src/schema/runs.ts
packages/db/src/schema/run-events.ts
packages/db/src/repositories/run-repository.ts
packages/db/test/run-state.integration.test.ts
apps/worker/src/orchestration/run-engine.ts
apps/worker/src/orchestration/step-registry.ts
apps/worker/src/orchestration/retry-policy.ts
apps/worker/src/worker.ts
apps/worker/src/orchestration/steps/parse-change.ts
apps/worker/src/orchestration/steps/assess-baseline.ts
apps/worker/src/orchestration/steps/collect-context.ts
apps/worker/src/orchestration/steps/decide-risk.ts
apps/worker/test/worker-loop.integration.test.ts
apps/worker/test/canonical-state-machine.integration.test.ts
```

Required public contracts:

```ts
type RiskDecision = "ALLOW" | "REVIEW" | "BLOCK";

type RunStatus =
  | "CREATED" | "CHANGE_PARSED" | "BASELINE_ASSESSED"
  | "CONTEXT_COLLECTING" | "CONTEXT_COLLECTED" | "RISK_DECIDED"
  | "MIGRATION_PLANNED" | "PATCH_GENERATED" | "VALIDATING" | "VALIDATED"
  | "REVIEW_ARTIFACT_CREATED" | "WRITEBACK_PENDING" | "COMPLETED"
  | "FAILED_CONTEXT" | "FAILED_GENERATION" | "FAILED_VALIDATION"
  | "FAILED_GITHUB" | "FAILED_WRITEBACK" | "CANCELLED";

interface RunEvent {
  id: string;
  runId: string;
  sequence: number;
  type: "STATE_TRANSITION" | "STEP_RETRY_SCHEDULED" | "LEASE_ACQUIRED";
  fromStatus: RunStatus;
  toStatus?: RunStatus;
  step: RunStepName;
  inputFingerprint?: string;
  payload: RunEventPayload;
  occurredAt: string;
}

interface RiskReason {
  ruleId: `LG${string}`;
  messageKey: string;
  evidenceIds: readonly EvidenceId[];
}

interface RiskAssessment {
  decision: RiskDecision;
  riskLevel: "LOW" | "MEDIUM" | "HIGH" | "CRITICAL";
  reasons: readonly RiskReason[];
  evaluatedRuleIds: readonly string[];
  inputFingerprint: string;
}

function assessRisk(input: RiskInput): RiskAssessment;
function compareAssessments(baseline: RiskAssessment, grounded: RiskAssessment): DecisionDelta;

interface RunRepository {
  claimNextRunnable(input: ClaimRunInput): Promise<ClaimedRun | null>;
  renewLease(input: RenewLeaseInput): Promise<ActiveLease>;
  commitTransitionAndRelease(
    input: CommitClaimedTransitionInput,
    persistDomainData?: (transaction: DbTransaction) => Promise<void>,
  ): Promise<RunSnapshot>;
  commitTransitionAndWait(input: CommitClaimedWaitInput): Promise<RunSnapshot>;
  parkClaimAndRelease(input: ParkClaimedRunInput): Promise<RunSnapshot>;
  scheduleRetryAndRelease(input: ScheduleClaimedRetryInput): Promise<RunSnapshot>;
  releaseLease(input: ReleaseLeaseInput): Promise<void>;
}

interface WorkerStepExecutionContext {
  claim: ClaimedRun;
  signal: AbortSignal;
}

type WorkerStepHandler = (
  context: WorkerStepExecutionContext,
) => Promise<WorkerStepOutcome>;
```

`ClaimedRun` carries run ID, snapshot/version, worker ID, opaque lease token, and expiry. Renewal, transition commit, wait commit, parking, retry scheduling, and release require the same unexpired token. SQL verifies token/owner/expiry under row lock; a stale worker cannot persist state after reclaim. `commitTransitionAndRelease` invokes any transaction-aware domain writer inside the same database transaction as the event, projection/version update, and lease release. `commitTransitionAndWait` additionally stores a typed wait reason with `nextAttemptAt=null`; `parkClaimAndRelease` applies the same wait fields, increments the optimistic version, and releases without a status transition or retry increment when a previously woken condition is no longer satisfied. `claimNextRunnable` excludes every row with a wait reason. Retry event/attempt/`nextAttemptAt` plus lease release are one transaction. The worker aborts the active step if 20-second renewal fails.

Every step receives the same `AbortSignal`. Adapters and validators must propagate it to I/O and child processes. On abort, process runners send `SIGTERM`, wait at most five seconds, then send `SIGKILL`; sandbox cleanup gets a separate bounded 15-second cleanup signal. Lease loss produces no validation/external receipt and no transition/retry commit from the stale worker; a later owner reclaims the persisted status and reconciles/restarts idempotently.

The transition table is exactly the accepted architecture sequence. Unsupported F2 changes and deterministic invariant violations terminate as `CANCELLED` with a typed stage/code; context/generation/validation/GitHub/write-back failures map to their corresponding explicit failure status. A worker lease lasts 60 seconds and heartbeats every 20 seconds. Retryable operational failures receive an initial attempt plus delays of 1, 5, and 30 seconds; exhausted or non-retryable failures transition once to the mapped terminal status.

### Acceptance examples

- Canonical repository-only bundle returns `ALLOW`/`LOW`.
- Canonical grounded bundle returns `BLOCK` with LG001 plus the applicable ML/query/dashboard rules and valid evidence references.
- Each LG rule has positive, negative, and boundary cases.
- Permuting evidence order does not change output.
- Unknown evidence kinds and dangling evidence IDs fail schema/domain validation.
- `SAFE_WITH_MIGRATION` cannot parse as a risk decision.
- Database transition tests reject skipped, duplicate, or backward state transitions.
- Two concurrent workers cannot claim the same run; an expired lease can be reclaimed and resumes from the last committed transition without repeating a completed side effect; the stale worker's renewal and commit both fail.
- Renewal loss during a real long-running validation operation terminates its child process, cleans the sandbox, persists no receipt/transition from the stale worker, and is safely reclaimed from `VALIDATING`.
- A fake full-registry test traverses the exact canonical status sequence, while F8 owns the full replay-adapter integration test using real feature step implementations.

### Feature verification

```bash
pnpm --filter @lineageguard/domain test -- policy
pnpm --filter @lineageguard/db test:integration
pnpm --filter @lineageguard/worker test -- worker-loop canonical-state-machine
pnpm demo:decision:verify
```

Expected canonical output:

```text
baseline=ALLOW
grounded=BLOCK
all_reasons_have_evidence=true
```

This is Gate B.

### Dependencies and release gate

Depends on F2 and F3. F5 cannot consume a canonical plan request until Gate B passes.

---

## F5 — Migration planner and artifact generator

### User-visible outcome

A bounded model interaction converts the blocked canonical assessment into a typed expand-migrate-contract plan and patch bundle. The model cannot change the risk decision, invent evidence, execute commands, or apply files outside an isolated worktree.

### In scope

- one combined OpenAI Agents SDK TypeScript migration planner/generator role, as required by ADR-002;
- Zod `outputType` for the plan and generated artifact manifest;
- normalized evidence-only input;
- prompt-injection delimiters and adversarial fixtures;
- approved strategy primitives;
- SQL, dbt, tests, migration document, rollback, owner-review, and compatibility-window artifacts;
- isolated generated-patch worktree and path allowlist;
- deterministic/template-constrained fallback;
- trace metadata without raw secrets or untrusted full payload logging.

### Planned files and contracts

```text
packages/domain/src/migration.ts
packages/domain/src/artifacts.ts
packages/agent/src/migration-agent.ts
packages/agent/src/model-config.ts
packages/agent/src/strategy-primitives.ts
packages/agent/src/prompts/migration-agent.md
packages/agent/src/schemas/migration-plan.ts
packages/agent/src/schemas/artifact-manifest.ts
packages/agent/src/schemas/migration-candidate.ts
packages/agent/src/security/untrusted-context.ts
packages/agent/test/migration-agent.test.ts
packages/agent/test/prompt-injection.test.ts
packages/agent/test/malformed-output.test.ts
packages/validation/src/worktree/generated-patch-worktree.ts
apps/worker/src/orchestration/steps/plan-migration.ts
apps/worker/src/orchestration/steps/materialize-patch.ts
demo/scenarios/canonical/expected-migration-plan.json
```

Required plan contract includes ordered phases, compatibility window, owner reviews, source evidence IDs, artifact intents, and a mandatory `RollbackPlan` referencing one hashed `demo/db/migrations/*.rollback.sql` file in the matching `PatchBundle`. `PatchBundle` contains normalized relative paths, text content, and a discriminated `CREATE` or `MODIFY` operation; `MODIFY` carries the exact expected base-file SHA-256. It never contains a shell command or a delete operation.

### Acceptance examples

- Canonical input yields add `buyer_id`, backfill equality, retain `customer_id`, controlled dbt updates, equality/non-null tests, deprecation plan, Finance/Risk review, and a hashed executable SQL rollback that restores legacy compatibility.
- Every plan rationale references only supplied evidence IDs.
- An attempted instruction embedded in SQL, query history, metadata description, or Git diff is treated as data.
- Malformed JSON/Zod output, unknown strategy, invented evidence ID, absolute path, parent traversal, binary patch, or change outside the canonical project fails closed.
- Replacing model output with a forged `ALLOW`/“safe” field cannot alter F4 state.
- The deterministic fallback can emit the canonical patch from validated targets if model variability exceeds the budget.
- One model call returns the combined candidate; persisted `RISK_DECIDED -> MIGRATION_PLANNED -> PATCH_GENERATED` transitions resume after a crash without a second call.
- Materialization creates absent files exclusively, but modifies an existing controlled dbt file only when its regular-file base hash matches `expectedBaseSha256`; it atomically replaces that file inside the isolated worktree and rejects stale/colliding content.
- The worker signal reaches the model request, Git worktree child processes, and file materializer; abort cleans the isolated worktree and permits no stale candidate/materialization transition.

### Feature verification

```bash
pnpm --filter @lineageguard/agent test
pnpm --filter @lineageguard/validation test -- generated-patch-worktree
OPENAI_TEST_MODE=live pnpm --filter @lineageguard/agent test:integration -- canonical
```

Expected: schema-valid canonical plan/patch; adversarial cases rejected; live model run recorded only after redaction checks.

### Dependencies and release gate

Depends on Gate B. It produces untrusted candidates; only F6 may establish safety.

---

## F6 — Executable validation

### User-visible outcome

LineageGuard applies the generated patch only inside isolated resources, runs allowlisted SQL/dbt/compatibility checks, and produces a structured receipt. The canonical safe migration passes; an intentionally broken artifact fails with an actionable typed reason.

### In scope

- dedicated validation PostgreSQL service;
- distinct per-run primary and rollback database lifecycles;
- schema/migration application;
- backfill equality and non-null checks;
- dbt parse/compile/build/test for selected models;
- old Finance consumer compatibility and new-field checks;
- structured command receipts, durations, redacted logs, artifact hashes, and cleanup state;
- timeouts, output limits, allowlisted commands/paths, and failure classification.

### Planned files and contracts

```text
packages/domain/src/validation.ts
packages/validation/src/validator.ts
packages/validation/src/sandbox/validation-database.ts
packages/validation/src/sandbox/command-policy.ts
packages/validation/src/sql-validator.ts
packages/validation/src/dbt-validator.ts
packages/validation/src/compatibility-validator.ts
packages/validation/src/post-migration-setup.ts
packages/validation/src/rollback-validator.ts
packages/validation/src/log-redaction.ts
packages/validation/test/sql-validator.integration.test.ts
packages/validation/test/dbt-validator.integration.test.ts
packages/validation/test/compatibility-validator.integration.test.ts
packages/validation/test/rollback-validator.integration.test.ts
packages/validation/test/command-policy.test.ts
apps/worker/src/orchestration/steps/validate-migration.ts
demo/scenarios/canonical/validation-expectations.json
demo/scenarios/broken/missing-compatibility-column.patch
demo/scenarios/broken/invalid-rollback.patch
```

Required public contract:

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

### Acceptance examples

- Canonical patch passes SQL apply, equality, non-null, dbt, old-query compatibility, and rollback syntax/apply/legacy-restoration checks. Primary and rollback databases independently load the same canonical seed, apply the same exact hash-checked forward artifacts, build the same patched dbt selector, and prove equal post-migration schema/data/model fingerprints before rollback runs only on the rollback database.
- Primary and rollback names are `lgv_<p|r>_<12 hex run hash>_<12 hex input hash>`; two concurrent runs with the same input fingerprint receive four distinct databases.
- The broken fixture fails the compatibility check and is never labeled safe.
- A timeout, command not on the allowlist, path escape, SQL connection failure, dbt compile error, assertion mismatch, rollback syntax/semantics failure, and cleanup failure have distinct statuses/codes.
- Skipped forward setup, a changed/missing forward artifact, unequal post-migration state, or an idempotent no-op rollback against an unprepared database fails `ROLLBACK_SETUP_MISMATCH` before rollback can be accepted.
- Logs redact credentials and cap output while preserving useful error context.
- Retrying the same validated fingerprint returns/reconciles the prior receipt rather than creating inconsistent results.
- The completed receipt is inserted through the transaction-aware validation repository inside `commitTransitionAndRelease`; receipt, run event, status/version, and lease release all commit or all roll back.

### Feature verification

```bash
pnpm --filter @lineageguard/validation test
pnpm demo:migration:generate
pnpm demo:migration:validate
pnpm demo:migration:validate --scenario broken
pnpm demo:migration:validate --scenario broken-rollback
```

Expected: canonical exits zero with `PASS`; compatibility and rollback broken scenarios exit non-zero with their asserted failure codes. This is Gate C.

### Dependencies and release gate

Depends on F5. F7/F8 reject any run without a `PASS` receipt whose input fingerprint matches the published artifacts.

---

## F7 — GitHub review integration

### User-visible outcome

A validated canonical migration is published as a real deterministic branch and draft pull request containing the decision, evidence references, patch, validation receipt, and requested Finance/Risk review context. Replay renders a committed real receipt.

### In scope

- narrow GitHub port with live and replay adapters;
- read the proposed diff/PR where applicable;
- create/reconcile a deterministic generated branch and draft PR targeting a demo base branch, never `main`;
- PR body and optional comment with evidence/validation links;
- fine-grained PAT with Metadata read, Contents read/write, Pull requests read/write;
- idempotency/retry and external reconciliation;
- owner mapping to display names/team context without requiring automatic reviewer assignment.

### Out of scope

- GitHub Check Run (requires a GitHub App and is P2);
- autonomous merge;
- workflow-file mutation;
- production repository mutation.

### Planned files and contracts

```text
packages/github/src/port.ts
packages/github/src/live-adapter.ts
packages/github/src/replay-adapter.ts
packages/github/src/github-client.ts
packages/github/src/pr-body.ts
packages/github/src/idempotency.ts
packages/github/test/contract/github.contract.ts
packages/github/test/live/canonical-pr.test.ts
packages/github/test/retry.test.ts
packages/db/src/schema/external-effect-receipts.ts
apps/worker/src/orchestration/steps/create-review-artifact.ts
examples/replay/github-review-receipt.json
```

Required public contract:

```ts
interface GitHubPort {
  getProposedChange(input: ProposedChangeLocator, options: { signal: AbortSignal }): Promise<RepositoryChangeInput>;
  createMigrationReview(input: CreateMigrationReviewInput, options: { signal: AbortSignal }): Promise<GitHubReviewReceipt>;
  findMigrationReview(idempotencyKey: string, options: { signal: AbortSignal }): Promise<GitHubReviewReceipt | null>;
}
```

### Acceptance examples

- A real draft PR contains stable markers, exact artifact hashes, F4 assessment, evidence IDs, F6 receipt, and no secret/raw MCP payload.
- A second identical call returns the same branch/PR receipt.
- A retry after “branch created, PR response lost” reconciles the branch and creates/finds exactly one PR.
- Missing validation, changed artifact hash, insufficient permission, branch collision with different content, rate limit, and closed prior PR fail with distinct behavior.
- Replay receipt references a real public artifact and matches the live adapter schema.
- Public PR input contains only a public evidence projection: DataHub URNs, evidence IDs, and fingerprints. It contains no private DataHub origin/UI URL; a DataHub hyperlink is allowed only under a separately approved genuinely public HTTPS origin, which the canonical deployment does not configure.
- Lease loss aborts all GitHub fetches through the same step signal and cannot persist a stale external receipt or transition.

### Feature verification

```bash
pnpm --filter @lineageguard/github test
GITHUB_TEST_MODE=live pnpm --filter @lineageguard/github test:integration -- canonical
pnpm demo:github:verify
```

Expected: one real draft PR and idempotent receipt; no Check Run requirement.

### Dependencies and release gate

Depends on Gate C and approved least-privilege GitHub credential. Contributes to Gate D.

---

## F8 — Controlled DataHub write-back

### User-visible outcome

After validation and policy approval, LineageGuard writes a searchable migration decision document plus the minimum verified metadata marker to DataHub. Context collection cannot access these mutation capabilities.

### In scope

- separate mutation-enabled MCP configuration/process;
- `DataHubWritebackPort` and explicit `WritebackPolicy`;
- required F4/F6/F7 receipts and matching fingerprints;
- production human-approval state;
- `save_document` decision record under the seeded parent;
- one deprecation/tag/structured property marker if verified against OSS;
- deterministic idempotency and reconciliation;
- live and replay receipts.

### Planned files and contracts

```text
packages/datahub/src/writeback/writeback-port.ts
packages/datahub/src/writeback/write-tool-policy.ts
packages/datahub/src/writeback/writeback-verifier-port.ts
packages/datahub/src/writeback/writeback-verification-process.ts
packages/datahub/src/writeback/live-writeback-adapter.ts
packages/datahub/src/writeback/replay-writeback-adapter.ts
packages/datahub/src/writeback/writeback-policy.ts
packages/datahub/src/writeback/decision-document.ts
packages/datahub/src/writeback/idempotency.ts
packages/datahub/test/writeback/tool-isolation.test.ts
packages/datahub/test/writeback/policy.test.ts
packages/datahub/test/live/canonical-writeback.test.ts
packages/db/src/schema/external-approvals.ts
packages/db/src/schema/external-approval-events.ts
packages/db/src/repositories/approval-repository.ts
apps/worker/src/orchestration/steps/request-writeback-approval.ts
apps/worker/src/orchestration/steps/writeback-decision.ts
apps/worker/test/canonical-run.integration.test.ts
examples/replay/datahub-writeback-receipt.json
```

Required public contracts:

```ts
interface DataHubWritebackPort {
  writeMigrationDecision(input: WritebackRequest, options: { signal: AbortSignal }): Promise<WritebackReceipt>;
  findMigrationDecision(idempotencyKey: string, options: { signal: AbortSignal }): Promise<WritebackReceipt | null>;
}

interface DataHubWritebackVerifierPort {
  findDecisionDocument(documentKey: string, options: { signal: AbortSignal }): Promise<VerifiedDecisionDocument | null>;
  getTags(targetUrn: string, options: { signal: AbortSignal }): Promise<readonly string[]>;
}

interface WritebackPolicy {
  evaluate(input: WritebackPolicyInput): WritebackPolicyDecision;
}

interface ApprovalRepository {
  approveAndWake(input: ApproveAndWakeInput): Promise<ApprovalRecord>;
  revokeAndPark(input: RevokeAndParkInput): Promise<ApprovalRevocationRecord>;
  consumeAndCreateIntent(claim: ClaimedRun, binding: ApprovalBinding): Promise<ConsumedApproval>;
}
```

### Acceptance examples

- Canonical write-back document includes change, baseline/final decisions, evidence references, migration/validation/GitHub links, compatibility window, and provenance.
- The internal receipt may retain an operator-only DataHub UI URL, but public replay projects only the document URN, fingerprint, and verified status; it never leaks a private host.
- The document is searchable through DataHub after write-back.
- The context collector's startup inventory contains zero mutation tools; compile-time dependency construction gives it no write port.
- Lost-response reconciliation reads documents/tags through a separate mutation-disabled verifier exposing only `search_documents` and `get_entities`.
- Production mode enters `WRITEBACK_PENDING` with wait reason `WRITEBACK_APPROVAL`, `nextAttemptAt=null`, and no retry consumption. An authorized approval command atomically inserts the immutable approval and wakes the exact run/fingerprint; absence, expiry, or effective revocation parks it again without a retry event.
- Revocation is an immutable record and is effective only before the approval and external-effect intent are atomically consumed. A revocation racing first re-parks the run; once consumption wins, revocation is rejected as `APPROVAL_ALREADY_CONSUMED` and cannot pretend to undo a side effect.
- Approval requests are idempotent by unique audit request ID and monotonic by binding generation. The same request returns the same record; after expiry or effective revocation, a newly authorized request may create exactly the next generation and wake the parked run. Two active generations are impossible.
- Duplicate calls reconcile to one document/marker.
- Missing validation/PR receipt, mismatched hash, unsupported mutation, partial write, and MCP outage are typed failures and never mark the run complete. Missing, expired, or effectively revoked approval is instead a typed non-runnable wait and consumes no retry attempt.
- The full replay-adapter worker integration traverses the exact accepted `CREATED` through `COMPLETED` state sequence and resumes at every persisted boundary without repeating a completed effect.
- The replay branch creates no approval or external-effect intent: it validates the committed replay/provenance fingerprints, invokes only the replay adapter with the active signal, and atomically stores its checked receipt with `WRITEBACK_PENDING -> COMPLETED`.
- The active worker signal reaches mutation and verifier MCP calls/processes; abort or lease loss produces no stale receipt, retry, or transition.

### Feature verification

```bash
pnpm --filter @lineageguard/datahub test -- writeback
DATAHUB_TEST_MODE=live pnpm --filter @lineageguard/datahub test:integration -- writeback
pnpm demo:writeback:verify
```

Expected: searchable real decision, one idempotent receipt, and proven read/write tool isolation. This completes Gate D with F7.

### Dependencies and release gate

Depends on F6, F7 receipt/reference availability, approved mutation credential, and human-approval policy.

---

## F9 — Mission Control UI

### User-visible outcome

At 1440x900, a judge can follow one operational workspace through `ALLOW -> BLOCK -> SAFE WITH MIGRATION`, inspect evidence before prose, see validation/GitHub/write-back receipts, and distinguish loading, failure, and replay states without console errors.

### In scope

- `/` canonical scenario launcher;
- `/runs/[runId]` three-area operational workspace;
- proposed change/diff;
- normalized DataHub impact evidence and lineage paths;
- baseline versus grounded assessment;
- migration artifacts and validation checks;
- GitHub and DataHub receipts;
- persisted timeline;
- one-second polling with ETag/`updatedAt`;
- loading, empty, typed failure, approval-pending, and completed states;
- keyboard/accessibility basics and target viewport screenshots.

### Out of scope

- chat UI;
- generic dashboards/card mosaics;
- multiple polished scenarios;
- decorative terminal animation;
- broad mobile optimization before the target viewport passes.

### Planned files and contracts

```text
apps/web/app/page.tsx
apps/web/app/runs/[runId]/page.tsx
apps/web/app/api/runs/route.ts
apps/web/app/api/runs/[runId]/route.ts
apps/web/app/api/runs/[runId]/approve-writeback/route.ts
apps/web/components/workspace/{proposed-change,impact-evidence,migration-verification}.tsx
apps/web/components/timeline/run-timeline.tsx
apps/web/components/status/decision-transition.tsx
apps/web/components/states/{loading,empty,failure,approval-pending}.tsx
apps/web/lib/run-view-model.ts
apps/web/lib/poll-run.ts
packages/ui/src/tokens.css
packages/ui/src/components/*.tsx
tests/e2e/mission-control.spec.ts
tests/e2e/fixtures/*.json
tests/e2e/screenshots/.gitkeep
```

The API returns a `RunView` assembled from persisted domain state. UI components may format but may not calculate policy, counts, validation status, or external receipt truth.

### Acceptance examples

- The canonical completed state matches `docs/DEMO_STORYBOARD.md` and derives every visible number from `RunView`/checked fixture.
- `SAFE WITH MIGRATION · READY FOR REVIEW` appears immediately after a matching F6 `PASS` and accepted `VALIDATED` state; `riskDecision` remains `BLOCK`. GitHub and DataHub receipt completion are separate later statuses and do not define readiness.
- Evidence paths, entity URNs, query fingerprint/source, owner, and criticality are inspectable before the narrative summary.
- Public replay links the GitHub receipt, but represents private DataHub write-back by document URN/fingerprint rather than an unreachable internal URL.
- Loading, empty, MCP failure, validation failure, approval pending, write-back failure, and completed replay have screenshots.
- No horizontal overflow or clipped critical content at 1440x900.
- Playwright reports no console errors, failed requests, inaccessible button names, or focus traps.

### Feature verification

```bash
pnpm --filter @lineageguard/web test
pnpm build
pnpm test:e2e
pnpm test:e2e -- --update-snapshots=false
```

Expected: storyboard states and committed target screenshots pass without invented data.

### Dependencies and release gate

The shell may start after F4 event/view contracts stabilize. Completion depends on F7 and F8 replay/live receipts.

---

## F10 — Evaluation, replay, deployment, and submission

### User-visible outcome

A judge can open a stable public URL, replay a receipt-bearing canonical run, inspect public code/examples, follow clean-start instructions, and watch an English sub-three-minute video whose claims match verified behavior.

### In scope

- canonical eval plus one compact non-polished negative eval fixture;
- baseline-versus-grounded report;
- `examples/` patch, plan, receipts, screenshots, and provenance manifest;
- replay generated from a real validated run, never hand-authored UI mock data;
- minimal VPS deployment and private DataHub topology;
- public replay/read-only mode and operator-only live mode;
- health/readiness checks, backup/restore evidence, restart policy, and judging-period availability;
- clean-start README and one-command verifier;
- Devpost description, screenshots, video script, recording, and signed-out link check;
- optional upstream contribution only after Gate F.

### Planned files and contracts

```text
evals/canonical.json
evals/negative-missing-owner.json
evals/evaluate.ts
evals/baseline-vs-grounded.json
examples/canonical/migration-plan.json
examples/canonical/generated.patch
examples/canonical/validation-receipt.json
examples/canonical/github-review-receipt.json
examples/canonical/datahub-writeback-receipt.json
examples/canonical/provenance.json
examples/replay/canonical-run.json
scripts/capture-replay.ts
scripts/demo-verify.ts
scripts/clean-start-verify.sh
deploy/compose.demo.yaml
deploy/Caddyfile
deploy/README.md
docs/DEMO_SCRIPT.md
docs/SUBMISSION_CHECKLIST.md
README.md
```

`provenance.json` includes source run ID, source commit, normalized input fingerprint, artifact hashes, the public GitHub receipt URL, the private DataHub receipt identifier/fingerprint without its internal host, capture timestamp, DataHub/MCP/package versions, and redaction confirmation.

### Acceptance examples

- Canonical eval asserts repository-only `ALLOW`, grounded `BLOCK`, complete evidence references, generated plan schema, and validation `PASS`.
- Negative eval checks one policy/failure boundary and never appears as a second polished UI scenario.
- Replay schema is the same `RunView` contract used by live mode and was produced by `scripts/capture-replay.ts` from stored state.
- `pnpm demo:verify` checks fixture hashes, no-secret patterns, replay provenance, UI smoke, external receipt URL shape, and canonical state sequence.
- A clean reviewer environment follows README commands successfully.
- Public URL has read-only replay, `/health/live`, `/health/ready`, TLS, and no exposed DataHub default ports/credentials.
- Signed-out verification confirms repository public, Apache-2.0 visible, hosted URL reachable, examples readable, and video under 3:00.
- System remains budgeted/monitored through 2026-08-31.

### Failure behavior

- Stale replay hashes, missing receipt, secret pattern, version drift, unhealthy dependency, public mutation route, broken link, video over time, or README command mismatch fails the submission checklist.
- The deployment degrades to replay if live DataHub/model services are unavailable; it labels that mode honestly.

### Feature verification

```bash
pnpm format:check
pnpm lint
pnpm typecheck
pnpm test
pnpm build
pnpm test:e2e
pnpm demo:verify
uv run --project tools/datahub --locked pytest
pnpm clean-start:verify
curl --fail --silent --show-error "${LINEAGEGUARD_PUBLIC_BASE_URL}/health/live"
curl --fail --silent --show-error "${LINEAGEGUARD_PUBLIC_BASE_URL}/health/ready"
```

Expected: every repository gate passes from a clean environment; hosted replay is healthy; the recording is under three minutes. This is Gate F and the final submission gate.

### Dependencies and release gate

Depends on F0-F9 and all prior gates. No optional contribution may delay submission.

---

## Specification review checklist

An independent specification reviewer must answer all of these before F0 implementation begins:

- Does every product invariant map to at least one acceptance example?
- Is the canonical visible consumer count approved and sourced from one fixture?
- Are raw MCP and external API payloads contained at adapter boundaries?
- Are baseline and final decisions both deterministic?
- Can no model output or UI label override policy state?
- Are read and mutation MCP capabilities structurally separated?
- Are generated patches and validator commands isolated and allowlisted?
- Are GitHub and DataHub side effects gated, least-privilege, and idempotent?
- Can replay be traced to a real validated run?
- Are all Devpost availability, licensing, language, URL, and video requirements represented?
- Does the scope fit the August 10 critical path and explicit cut order?
