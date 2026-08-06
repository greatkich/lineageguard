# Phases B–F: Production-Grade Integration

**Date:** 2026-08-06  
**Status:** Draft  
**Scope:** Replace all stubs in the agent pipeline with real production adapters from packages/*

---

## 1. Goal

Transform the working MVP pipeline (which uses simplified REST port, hardcoded risk logic, no validation, no GitHub, no writeback) into a production-grade system where every phase uses the real, already-implemented adapters from packages/.

**End state:** `pnpm demo` runs the canonical scenario through:
1. Real DataHub MCP stdio adapter → full `ImpactContext`
2. Real 5-rule risk engine → deterministic BLOCK with evidence binding
3. Real Docker-based validation → 8 checks in ephemeral containers
4. Real GitHub PR creation → draft PR with migration artifacts
5. Real DataHub writeback → decision document + Reviewed tag

---

## 2. Current State vs Target

| Phase | Current (stub) | Target (production) |
|-------|---------------|-------------------|
| B: DataHub context | `datahub-rest-port.ts` → flat `{evidence: Consumer[]}` | `createOfficialLiveDataHubContextPort()` → full `ImpactCollectionResult` with `ImpactContext` |
| C: Risk engine | `consumersFound > 0 ? "BLOCK" : "ALLOW"` | `evaluateGroundedRisk()` / `compareAuthoritativeRisk()` with LG001–LG005 |
| D: Validation | Skipped (notify VALIDATED directly) | `executeValidationInOwnedDatabase()` — 8 checks in Docker |
| E: GitHub PR | Skipped | `LiveGitHubPort.createMigrationReview()` — real draft PR |
| F: DataHub writeback | Skipped | `LiveDataHubWritebackPort.write()` — decision doc + tag |

---

## 3. Phase B: Real DataHub MCP Adapter

### What changes

Replace `apps/worker/src/datahub-rest-port.ts` usage in `orchestration.ts` with `createOfficialLiveDataHubContextPort()` from `packages/datahub/src/context-port.ts`.

### How it works

1. `createOfficialLiveDataHubContextPort(credentials)` creates a `DataHubContextPort`
2. On `.collect({changeId, request})`:
   - Spawns MCP server via stdio (`mcp-server-datahub` binary, using `uvx`)
   - Creates read-only tool client
   - Calls canonical reader: `get_entities`, `get_lineage`, `get_glossary_terms`, etc.
   - Normalizes observations into domain `ImpactContext` (evidence items with IDs, provenance, fingerprints)
   - Returns `ImpactCollectionResult` with `outcome: "COLLECTED"` or `"FAILED"`
3. Pipeline step `collectContext(ctx, changeId)` already expects this interface (see `packages/agent/src/steps/collect-context.ts`)

### Wire-up

```typescript
// apps/worker/src/orchestration.ts
import { createOfficialLiveDataHubContextPort } from "@lineageguard/datahub";

const datahub = createOfficialLiveDataHubContextPort({
  dataHubGmsUrl: process.env.DATAHUB_GMS_URL ?? "http://127.0.0.1:8080",
  readToken: process.env.DATAHUB_READ_TOKEN ?? "",
  uvxPath: process.env.UVX_PATH ?? "uvx",
  uvCacheDir: process.env.UV_CACHE_DIR ?? "/tmp/uv-cache",
});
```

### Pipeline change

Replace the inline `ctx.datahub.collect()` + flat evidence handling with the proper `collectContext()` step that already handles the full `ImpactCollectionResult`.

### Dependencies

- `mcp-server-datahub` package installed (via uvx or pip)
- DataHub GMS running at configured URL
- `DATAHUB_READ_TOKEN` set in .env

---

## 4. Phase C: Real Risk Engine (5 Rules)

### What changes

Replace the inline `consumersFound > 0 ? "BLOCK" : "ALLOW"` with the real `decideRisk()` step that calls `compareAuthoritativeRisk()`.

### The 5 rules (from `packages/domain/src/risk.ts`)

| Rule | Severity | Trigger |
|------|----------|---------|
| LG001 | CRITICAL | Downstream field-level lineage paths exist |
| LG002 | CRITICAL | Production ML model depends on renamed field |
| LG003 | HIGH | Observed system query references renamed field |
| LG004 | CRITICAL | Critical dashboard depends on field change |
| LG005 | HIGH | Affected critical asset has no recorded owner |

### How it works

1. `decideRisk(ctx, {change, context, baseline})` calls `compareAuthoritativeRisk(change, context, timestamps)`
2. This evaluates `evaluateRepositoryBaseline()` (ALLOW) and `evaluateGroundedRisk()` (uses evidence)
3. Returns `RiskComparison` with `transition: "ALLOW→BLOCK"`, `triggeredRuleIds`, `changedBecauseEvidenceIds`

### Pipeline change

```typescript
// After collectContext returns ImpactContext:
const { comparison } = await decideRisk(ctx, {
  change,
  context: collectResult.context,
  baseline,
});
// comparison.grounded.decision === "BLOCK"
// comparison.triggeredRuleIds === ["LG001", "LG002", "LG003", "LG004"]
```

### Dependencies

- Full `ImpactContext` from Phase B (requires evidence items with correct IDs, field paths, provenance)

---

## 5. Phase D: Validation Executor

### What changes

Insert real validation between patch generation and GitHub PR. Currently the pipeline skips validation entirely.

### How it works

`executeValidationInOwnedDatabase()` from `packages/validation/src/validator.ts`:

1. Validates the `MigrationCandidate` against canonical SQL grammar
2. Creates ephemeral Docker infrastructure:
   - Internal network (no external access)
   - PostgreSQL container (read-only rootfs, tmpfs for data)
   - dbt runner container (read-only rootfs, sealed bundle)
3. Bootstraps least-privilege PostgreSQL (dedicated role, dedicated database)
4. Applies base fixture SQL (creates schema, table, initial data)
5. Runs 8 checks sequentially:
   - `SQL_MIGRATION` — applies expand migration SQL
   - `BACKFILL_EQUALITY` — verifies customer_id ↔ buyer_id sync
   - `DBT_PARSE` — dbt parse succeeds
   - `DBT_COMPILE` — dbt compile succeeds
   - `DBT_TEST` — dbt build (model + tests) passes
   - `OLD_CONSUMER_COMPATIBILITY` — old column still accessible
   - `NEW_CONSUMER_COMPATIBILITY` — new column matches old
   - `ROLLBACK` — rollback SQL restores original state
6. Cleans up all Docker resources (ownership-fenced)
7. Returns `ValidationExecutionEvidence` with check results

### Pipeline integration

```typescript
// After generatePatch produces MigrationCandidate:
const materialized = await materializeCandidate(candidate, checkoutPath);
const validationEvidence = await executeValidationInOwnedDatabase(
  candidate, materialized, expectedExecution, policy, runner
);
// All 8 checks must PASS to proceed
const allPass = validationEvidence.checks.every(c => c.status === "PASS");
```

### Dependencies

- Docker daemon running
- Validation runner image pulled: `sha256:<validationRunnerImageId>`
- PostgreSQL image pulled: `sha256:<postgresImageId>`
- Base fixture SQL configured in policy

---

## 6. Phase E: GitHub PR Creation

### What changes

Insert real GitHub PR creation after validation passes. Uses `LiveGitHubPort` from `packages/github/src/live-adapter.ts`.

### How it works

`LiveGitHubPort.createMigrationReview(request)`:

1. Verifies repository identity and permissions (push=true, pull=true, admin=false)
2. Verifies base branch still points to expected SHA
3. Checks for existing deterministic branch (reconciliation)
4. If not found:
   - Consumes effect authorization
   - Creates blobs for each artifact
   - Creates tree with artifact entries
   - Creates commit with deterministic message
   - Creates branch `lineageguard/run-<runId>`
   - Creates draft PR
5. Returns `GitHubReviewReceipt` with PR URL, number, head SHA

### Request shape

```typescript
const request: GitHubReviewRequest = {
  effectReservationId: reservationId,
  runId,
  effectKind: "GITHUB_WRITE",
  target: canonicalDatasetUrn,
  idempotencyKey: `lineageguard-${runId}`,
  intentFingerprint,
  inputFingerprint,
  repository: "owner/repo",
  baseBranch: "main",
  baseSha,
  candidateFingerprint,
  artifactSetFingerprint,
  validationReceiptFingerprint,
  approvalFingerprint,
  validation: { runId, candidateFingerprint, artifactSetFingerprint, receiptFingerprint, artifacts },
  artifacts: candidate.artifacts.map(a => ({
    path: a.path, content: a.content, operation: "CREATE",
    candidateArtifactFingerprint: sha256(a),
  })),
  title: `LineageGuard: safe migration for customer_id rename`,
  body: { summary, reasonEvidenceIds, rolloutSteps, rollbackSteps },
};
```

### Dependencies

- `GITHUB_TOKEN` with repo push permissions (not admin)
- Target repository exists on GitHub
- Base branch and SHA are current

---

## 7. Phase F: DataHub Writeback

### What changes

After GitHub PR is created, write the migration decision back to DataHub.

### How it works

`LiveDataHubWritebackPort.write(request)`:

1. Validates request against canonical scenario marker
2. Derives deterministic payloads (document + tag)
3. Verifies effect authority reservation
4. Reads current entity state (pre-write snapshot)
5. Validates metadata hasn't changed
6. Consumes effect authorization
7. Writes decision document via mutation MCP:
   - Content: marker, decision, run ID, evidence IDs, candidate fingerprint, validation receipt, GitHub PR URL, rollback ref
8. Adds Reviewed tag to source dataset
9. Reads post-write snapshot to verify
10. Returns `DataHubWritebackReceipt` with proof state

### Request shape

```typescript
const writebackRequest: DataHubWritebackRequest = {
  artifactFingerprint,
  approvalFingerprint,
  candidateFingerprint,
  decision: "BLOCK",
  documentPayloadHash,
  expectedMetadataFingerprint,
  expectedMetadataVersion,
  expectedReviewTagDefinitionFingerprint,
  githubPrUrl: receipt.prUrl,
  githubReceiptFingerprint: sha256(receipt),
  idempotencyKey: `lineageguard-${runId}`,
  intentId: `lineageguard-decision-${runId}`,
  reasonEvidenceIds: comparison.changedBecauseEvidenceIds,
  rollbackRef: "walkthrough/migrations/rollback.sql",
  runId,
  scenarioMarker: "canonical-customer-id-rename",
  sourceCollectionFingerprint: context.impactContextFingerprint,
  sourceUrn: canonicalDatasetUrn,
  tagPayloadHash,
  targetInstanceFingerprint,
  validationReceiptFingerprint,
};
```

### Dependencies

- `DATAHUB_MUTATION_TOKEN` (separate from read token)
- DataHub MCP mutation server accessible
- Reviewed tag definition exists in DataHub
- Effect authority wired (for consumption tracking)

---

## 8. Pipeline Rewrite Strategy

The current `pipeline.ts` (139 lines) does everything inline with direct LLM calls. The target uses the proper step functions from `packages/agent/src/steps/`.

### New pipeline flow

```typescript
async execute(input: RunInput): Promise<PipelineResult> {
  // 1. Parse change
  const { change } = await parseChange(ctx, parseInput);
  await notify(runId, "CHANGE_PARSED");

  // 2. Baseline assess
  const { baseline } = await baselineAssess(ctx, change);
  await notify(runId, "BASELINE_ASSESSED");

  // 3. Collect DataHub context (REAL MCP)
  const { context } = await collectContext(ctx, change.id);
  await notify(runId, "CONTEXT_COLLECTED");

  // 4. Decide risk (REAL 5-rule engine)
  const { comparison } = await decideRisk(ctx, { change, context, baseline });
  await notify(runId, "RISK_DECIDED");

  if (comparison.grounded.decision === "ALLOW") {
    await notify(runId, "COMPLETED");
    return result;
  }

  // 5. Plan migration (LLM)
  const { plan } = await planMigration(ctx, { context, table, field, newName });
  await notify(runId, "MIGRATION_PLANNED");

  // 6. Generate patch (LLM)
  const { candidate } = await generatePatch(ctx, { plan, table, field, newName });
  await notify(runId, "PATCH_GENERATED");

  // 7. Validate (REAL Docker containers)
  const evidence = await executeValidation(candidate, policy);
  await notify(runId, "VALIDATED");

  // 8. GitHub PR (REAL)
  const receipt = await githubPort.createMigrationReview(request);
  await notify(runId, "REVIEW_ARTIFACT_CREATED");

  // 9. DataHub writeback (REAL)
  const writebackReceipt = await writebackPort.write(writebackRequest);
  await notify(runId, "COMPLETED");

  return result;
}
```

### Key architectural decisions

1. **StepContext gets new ports:** Add `github: GitHubPort` and `writeback: DataHubWritebackPort` to pipeline config
2. **Effect authority:** Both GitHub and DataHub writeback require effect authorization. For MVP, use a simple in-memory authority that auto-approves.
3. **Validation policy:** Configure via env vars (Docker executable path, image IDs, timeout, base fixture SQL)
4. **Error states:** Each phase can fail independently → `FAILED_CONTEXT`, `FAILED_GENERATION`, `FAILED_VALIDATION`, `FAILED_GITHUB`, `FAILED_WRITEBACK`
5. **Existing step functions:** `parseChange`, `baselineAssess`, `collectContext`, `decideRisk`, `planMigration`, `generatePatch` are already implemented — just wire them

---

## 9. Effect Authority (simplified for MVP)

Both GitHub and DataHub writeback require an "effect authority" — a mechanism to ensure exactly-once execution of side effects. For full production this would be a durable store with leases.

For MVP, implement `SimpleEffectAuthority`:

```typescript
class SimpleEffectAuthority implements GitHubEffectAuthorityPort, TrustedDataHubEffectAuthority {
  private consumed = new Map<string, { invokeBy: string; attemptFence: string }>();

  async verifyCurrentEffectReservation(input) {
    const existing = this.consumed.get(input.canonicalEffectFingerprint);
    if (existing) return { state: "CONSUMED", ...existing };
    return {
      state: "RESERVED",
      reservationId: `res_${randomBytes(12).toString("hex")}`,
      canonicalEffectFingerprint: input.canonicalEffectFingerprint,
      invokeBy: new Date(Date.now() + 60_000).toISOString(),
    };
  }

  async consumeCurrentEffect(input) {
    const attemptFence = randomBytes(24).toString("base64url");
    const invokeBy = new Date(Date.now() + 60_000).toISOString();
    this.consumed.set(input.canonicalEffectFingerprint, { invokeBy, attemptFence });
    return { canonicalEffectFingerprint: input.canonicalEffectFingerprint, invokeBy, attemptFence };
  }
}
```

---

## 10. Environment Requirements

```bash
# .env additions needed
GITHUB_TOKEN=ghp_...           # repo push permissions, not admin
GITHUB_OWNER=<owner>
GITHUB_REPO=<repo>
GITHUB_BASE_BRANCH=main
GITHUB_BASE_SHA=<current main SHA>

# Docker
DOCKER_EXECUTABLE=/usr/local/bin/docker
VALIDATION_RUNNER_IMAGE=sha256:<id>     # dbt runner image
POSTGRES_IMAGE=sha256:<id>              # postgres image for validation

# DataHub MCP
UVX_PATH=uvx                            # or full path
UV_CACHE_DIR=/tmp/uv-cache

# Already in .env:
DATAHUB_GMS_URL=http://127.0.0.1:8080
DATAHUB_READ_TOKEN=...
DATAHUB_MUTATION_TOKEN=...
```

---

## 11. Files Modified

```
apps/worker/src/
  orchestration.ts          — wire all production ports
  datahub-rest-port.ts      — DELETE (replaced by packages/datahub)

packages/agent/src/
  pipeline.ts               — REWRITE: use all step functions + new ports
  steps/index.ts            — add ValidationPort, GitHubPort, WritebackPort to StepContext
  config.ts                 — add GitHub, validation, writeback config from env

apps/worker/src/
  simple-store.ts           — add new status states for DB updates
```

---

## 12. Verification

After each phase:
- Phase B: `pnpm demo` → console shows full ImpactContext with 4+ evidence items, provenance timestamps
- Phase C: `pnpm demo` → risk comparison shows `ALLOW→BLOCK`, rules LG001–LG004 triggered
- Phase D: `pnpm demo` → Docker containers created, 8 checks run, all PASS
- Phase E: `pnpm demo` → draft PR visible on GitHub with migration files
- Phase F: `pnpm demo` → DataHub entity has Reviewed tag + decision document

Final E2E: all of the above in one `pnpm demo` run.

---

## 13. Risks

| Risk | Mitigation |
|------|-----------|
| MCP server not installed | Check at startup, clear error message |
| Docker not running | Check before validation, skip with warning in dev |
| GitHub token missing/expired | Validate at wire-up, fail fast |
| DataHub metadata changed | Snapshot before write, validate version |
| LLM generates non-canonical SQL | `assertCanonicalGeneratedSql()` rejects at validation |
| Effect authority race conditions | SimpleEffectAuthority is single-process, sufficient for MVP |
