# Canonical Live Demo Completion — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Integrate unmerged DataHub remediation work (PR #4 + PR #5), eliminate synthetic evidence, prove four live consumer groups via exact DataHub reads, and deliver a repeatable canonical live demo that reaches COMPLETED three consecutive times.

**Architecture:** Monorepo with TypeScript pipeline (worker → agent → datahub/github/validation packages) orchestrated through typed ports. Python tooling handles DataHub bootstrap/verification. The live demo reads real PR #3 via GitHub API, collects live DataHub evidence via MCP stdio adapter, validates in isolated Docker containers, publishes one stable draft PR, and writes back to DataHub.

**Tech Stack:** Node 24+, pnpm 11.20+, TypeScript 5.9, Vitest 4.1, Python 3.12+ (uv), PostgreSQL, Docker, DataHub OSS 0.14+, DataHub MCP 0.6.0, Biome 2.5, Playwright 1.62

## Global Constraints

- Node >=24.0.0 <25.0.0; pnpm >=11.20.0 <12.0.0
- No Co-Authored-By: Claude in commits
- Fail-closed: demo exits 0 only on COMPLETED
- PR #3 (`demo/canonical-customer-id-rename`) must remain open and unmerged
- Zero synthetic live evidence (`syntheticLiveEvidenceCount = 0`)
- Exactly four top-level consumer groups (DATA_MODEL, DASHBOARD, ML_CONSUMER, UNMANAGED_QUERY)
- UUID column types throughout (not bigint)
- No parallel implementations without documented reason
- No broad architecture changes, event-sourcing migration, or new deployment infra
- `LINEAGEGUARD_WALKTHROUGH_ENV=canonical LINEAGEGUARD_SKIP_SERVER_IDENTITY=1 LINEAGEGUARD_POSTGRES_MODE=local`

---

## File Structure Overview

### Modified files (integration from PR #4/PR #5)
- `tools/datahub/src/lineageguard_datahub/seed.py` — duplicate dbt source fix, domain/owner/tags
- `tools/datahub/src/lineageguard_datahub/ingestion.py` — table_pattern fix
- `tools/datahub/src/lineageguard_datahub/lineage.py` — deterministic UpstreamLineage reconciliation
- `tools/datahub/src/lineageguard_datahub/verify.py` — entity_exists, query hash stability
- `tools/datahub/src/lineageguard_datahub/live_query.py` — remove Query ownership, stable hash
- `tools/datahub/src/lineageguard_datahub/expected_graph.py` — remove ownerUrns from QueryEvidence
- `packages/datahub/src/canonical-reader.ts` — ML model TrainingData aspect reader (replaces observePathBetweenOrEmpty)
- `packages/datahub/src/canonical-normalizer.ts` — revenue owner routing, handle ML proof via aspect
- `packages/datahub/src/context-port.ts` — wire TrainingData reader into collection
- `packages/domain/src/evidence.ts` — ML_MODEL evidence now requires aspect-backed proof

### New files
- `packages/datahub/src/aspect-reader.ts` — narrow GMS aspect reader for TrainingData
- `packages/datahub/src/aspect-reader.test.ts` — tests for aspect reader
- `scripts/demo-preflight.ts` — preflight checks
- `scripts/demo-bootstrap.ts` — bootstrap orchestrator
- `scripts/demo-verify.ts` — independent run verification
- `scripts/demo-repeat.ts` — consecutive run prover
- `scripts/demo-reset.ts` — scoped cleanup
- `scripts/demo-golden.ts` — golden evidence capture
- `artifacts/demo-runs/baseline/BRANCH_INTEGRATION_REPORT.md` — integration audit

### Modified for lifecycle
- `package.json` — add demo:preflight/bootstrap/verify/repeat/reset/golden scripts
- `packages/github/src/live-adapter.ts` — stable effect identity (source-scoped, not run-scoped)
- `packages/datahub/src/writeback.ts` — stable decision identity, merge-not-replace
- `apps/worker/src/orchestration.ts` — wire stable identity into ports

---

### Task 1: Reconcile Branch Topology (Phase 0)

**Files:**
- Create: `artifacts/demo-runs/baseline/BRANCH_INTEGRATION_REPORT.md`
- Modify: (conflict resolution across integrated files)

**Interfaces:**
- Consumes: `origin/main` (latest), `origin/fix/data-platform-boundary` (PR #4), `origin/fix/query-ownership-and-lineage-reconciliation` (PR #5)
- Produces: A clean `fix/canonical-live-demo-completion` branch based on latest `origin/main` with PR #4 + PR #5 intent integrated; documented integration report

- [ ] **Step 1: Create the isolated worktree and branch**

```bash
cd /Users/igorgarkusha/Documents/development/lineageguard
git fetch --all --prune
git worktree add .claude/worktrees/canonical-live-demo -b fix/canonical-live-demo-completion origin/main
cd .claude/worktrees/canonical-live-demo
```

- [ ] **Step 2: Record the branch graph baseline**

```bash
mkdir -p artifacts/demo-runs/baseline
cat > artifacts/demo-runs/baseline/BRANCH_INTEGRATION_REPORT.md << 'EOF'
# Branch Integration Report

## Recorded: $(date -u +%Y-%m-%dT%H:%M:%SZ)

### Branch state
- main HEAD: $(git rev-parse origin/main)
- PR #4 (fix/data-platform-boundary): $(git rev-parse origin/fix/data-platform-boundary)
- PR #5 (fix/query-ownership-and-lineage-reconciliation): $(git rev-parse origin/fix/query-ownership-and-lineage-reconciliation)
- PR #3 (demo/canonical-customer-id-rename): $(git rev-parse origin/demo/canonical-customer-id-rename)

### Divergence from main
- PR #4: $(git rev-list --left-right --count origin/main...origin/fix/data-platform-boundary)
- PR #5: $(git rev-list --left-right --count origin/main...origin/fix/query-ownership-and-lineage-reconciliation)

### PR #5 commits to integrate (superset of PR #4)
$(git log --oneline origin/fix/query-ownership-and-lineage-reconciliation ^origin/main)

### Integration decisions
(filled during integration below)
EOF
```

- [ ] **Step 3: Cherry-pick PR #5 commits onto the completion branch**

PR #5 includes all PR #4 commits plus 4 additional. Cherry-pick in order, resolving conflicts against already-merged PR #6 work:

```bash
# PR #5 is stacked on PR #4; cherry-pick the full stack oldest-first
git cherry-pick 44f8916 03c4ba1 567e044 663bdac ff45fe9 213829f fed7ee4 fc6108b 8ed2206
```

For each conflict:
- If the conflict is with PR #6 work already in main, keep main's version for structure but preserve PR #5's semantic intent (e.g., duplicate-source fix, sslmode, query hash stability).
- If the conflict is a formatting change (ff45fe9), accept the Biome-formatted version already in main.
- Document each resolution in the integration report.

- [ ] **Step 4: Immediately identify and remove `observePathBetweenOrEmpty`**

After cherry-pick, check if `observePathBetweenOrEmpty` was introduced:

```bash
grep -rn "observePathBetweenOrEmpty\|synthetic_empty_path\|syntheticInvocation" packages/datahub/src/
```

If found, revert only that function and its call sites. Leave a `// TODO: Task 3 implements truthful ML proof via TrainingData aspect reader` comment at the call site. The fraud entity path observation reverts to the original `observe()` call that will fail — Task 3 replaces it with the aspect reader.

- [ ] **Step 5: Verify the integration compiles and tests pass**

```bash
pnpm install
pnpm build
pnpm typecheck
pnpm test
pnpm format:check
pnpm lint
```

Fix any compilation or test failures caused by the integration. Do NOT skip or waive failures.

- [ ] **Step 6: Update integration report with decisions**

For each cherry-picked commit, record:
- `ACCEPTED_UNCHANGED` — commit applied cleanly
- `ACCEPTED_WITH_CONFLICT_RESOLUTION` — what was resolved and why
- `PARTIALLY_ACCEPTED` — what was kept vs dropped (e.g., observePathBetweenOrEmpty dropped)

- [ ] **Step 7: Verify PR #3 remains untouched**

```bash
git log --oneline origin/demo/canonical-customer-id-rename ^origin/main
# Must show exactly: 1be5ee5 warehouse: rename commerce.orders.customer_id to buyer_id
```

- [ ] **Step 8: Commit**

```bash
git add -A
git commit -m "phase0: integrate PR #4 + PR #5 intent into completion branch

Cherry-picks DataHub remediation stack (duplicate dbt source fix, sslmode,
query-role grants, Query ownership removal, revenue owner routing,
deterministic lineage reconciliation, MCP contract alignment, ingestion
table_pattern fix, seed entity_exists, query hash stability).

Removes observePathBetweenOrEmpty synthetic evidence workaround.
Resolves conflicts against already-merged PR #6 work.

See artifacts/demo-runs/baseline/BRANCH_INTEGRATION_REPORT.md"
```

**Exit gate checklist:**
- [ ] Branch based on latest `origin/main`
- [ ] All PR #4/PR #5 semantic intent present (9 commits integrated)
- [ ] No `observePathBetweenOrEmpty` or synthetic invocation IDs
- [ ] `pnpm build && pnpm typecheck && pnpm test` exits 0
- [ ] PR #3 remains open with exactly its original commit
- [ ] Integration report documents all decisions

---

### Task 2: Establish Genuinely Green Baseline (Phase 1)

**Files:**
- Create: `artifacts/demo-runs/baseline/quality/versions.txt`
- Create: `artifacts/demo-runs/baseline/quality/test-results.txt`
- Create: `artifacts/demo-runs/baseline/quality/python-results.txt`
- Create: `artifacts/demo-runs/baseline/quality/gate-summary.txt`
- Modify: any files with failing tests or lint errors

**Interfaces:**
- Consumes: integrated branch from Task 1
- Produces: zero-failure quality baseline; committed evidence under `artifacts/demo-runs/baseline/quality/`

- [ ] **Step 1: Capture environment versions**

```bash
mkdir -p artifacts/demo-runs/baseline/quality
cat > artifacts/demo-runs/baseline/quality/versions.txt << EOF
node: $(node --version)
pnpm: $(pnpm --version)
python: $(python3 --version 2>&1)
uv: $(uv --version 2>&1)
docker: $(docker --version 2>&1)
docker-compose: $(docker compose version 2>&1)
postgres: $(psql --version 2>&1 || echo "not available locally")
datahub-mcp: $(uvx --version mcp-server-datahub 2>&1 || echo "resolved at runtime")
gh: $(gh --version 2>&1 | head -1)
biome: $(npx biome --version 2>&1)
typescript: $(npx tsc --version 2>&1)
vitest: $(npx vitest --version 2>&1)
EOF
```

- [ ] **Step 2: Run format check**

```bash
pnpm format:check 2>&1 | tee artifacts/demo-runs/baseline/quality/format.log
echo "EXIT: $?" >> artifacts/demo-runs/baseline/quality/format.log
```

If failures: run `pnpm format` and commit the formatting fix.

- [ ] **Step 3: Run lint**

```bash
pnpm lint 2>&1 | tee artifacts/demo-runs/baseline/quality/lint.log
echo "EXIT: $?" >> artifacts/demo-runs/baseline/quality/lint.log
```

Fix any lint errors introduced by the integration.

- [ ] **Step 4: Run typecheck**

```bash
pnpm typecheck 2>&1 | tee artifacts/demo-runs/baseline/quality/typecheck.log
echo "EXIT: $?" >> artifacts/demo-runs/baseline/quality/typecheck.log
```

Fix type errors. Common issues after PR #5 integration:
- Missing imports for new evidence types
- Changed function signatures in canonical-normalizer
- Owner routing type changes

- [ ] **Step 5: Run TypeScript tests**

```bash
pnpm test 2>&1 | tee artifacts/demo-runs/baseline/quality/test-results.txt
echo "EXIT: $?" >> artifacts/demo-runs/baseline/quality/test-results.txt
```

Fix ALL failures. No "pre-existing failure" waivers allowed.

Common integration issues:
- Test fixtures expecting old evidence shape (before revenue owner routing)
- Impact consumer tests expecting 2 owners instead of 3
- Canonical reader tests expecting `observe()` for fraud entity path (now fails without ML proof — temporarily skip with `// BLOCKED: requires Task 3 aspect reader`)

- [ ] **Step 6: Run Python tests**

```bash
cd tools/datahub
uv run pytest -v 2>&1 | tee ../../artifacts/demo-runs/baseline/quality/python-results.txt
echo "EXIT: $?" >> ../../artifacts/demo-runs/baseline/quality/python-results.txt
cd ../..
```

Fix failures. PR #5 changes to `expected_graph.py`, `live_query.py`, and `verify.py` must align with the actual DataHub graph schema.

- [ ] **Step 7: Run build**

```bash
pnpm build 2>&1 | tee artifacts/demo-runs/baseline/quality/build.log
echo "EXIT: $?" >> artifacts/demo-runs/baseline/quality/build.log
```

- [ ] **Step 8: Verify no secrets in logs**

```bash
grep -riE "(ghp_|ghs_|github_pat_|sk-|DATAHUB_TOKEN|password=)" \
  artifacts/demo-runs/baseline/quality/ && echo "SECRET LEAK DETECTED" && exit 1
echo "No secrets found in logs"
```

- [ ] **Step 9: Generate gate summary**

```bash
cat > artifacts/demo-runs/baseline/quality/gate-summary.txt << EOF
format:    $(grep "EXIT:" artifacts/demo-runs/baseline/quality/format.log | tail -1)
lint:      $(grep "EXIT:" artifacts/demo-runs/baseline/quality/lint.log | tail -1)
typecheck: $(grep "EXIT:" artifacts/demo-runs/baseline/quality/typecheck.log | tail -1)
test:      $(grep "EXIT:" artifacts/demo-runs/baseline/quality/test-results.txt | tail -1)
python:    $(grep "EXIT:" artifacts/demo-runs/baseline/quality/python-results.txt | tail -1)
build:     $(grep "EXIT:" artifacts/demo-runs/baseline/quality/build.log | tail -1)
secrets:   PASS
EOF
```

- [ ] **Step 10: Commit**

```bash
git add -A
git commit -m "phase1: establish green baseline — all gates pass

format: PASS, lint: PASS, typecheck: PASS, test: PASS, python: PASS, build: PASS
Zero pre-existing-failure waivers. Evidence in artifacts/demo-runs/baseline/quality/"
```

**Exit gate checklist:**
- [ ] `pnpm format:check` exits 0
- [ ] `pnpm lint` exits 0
- [ ] `pnpm typecheck` exits 0
- [ ] `pnpm test` exits 0 (zero unexplained failures)
- [ ] Python tests exit 0
- [ ] `pnpm build` exits 0
- [ ] No secrets in log output
- [ ] Quality report committed

---

### Task 3: Truthful ML Evidence via TrainingData Aspect Reader (Phase 3)

**Files:**
- Create: `packages/datahub/src/aspect-reader.ts`
- Create: `packages/datahub/src/aspect-reader.test.ts`
- Modify: `packages/datahub/src/canonical-reader.ts`
- Modify: `packages/datahub/src/canonical-normalizer.ts`
- Modify: `packages/datahub/src/context-port.ts`
- Modify: `packages/domain/src/evidence.ts`

**Interfaces:**
- Consumes: DataHub GMS REST API (read credential), `targets.modelUrn`, `targets.fraudFeaturesUrn`
- Produces: `TrainingDataProof` with receipt; `MlModelEvidence` requires `trainingDataReceipt`

- [ ] **Step 1: Write failing test for aspect reader**

Create `packages/datahub/src/aspect-reader.test.ts` with 5 cases: success proof, not-proven (wrong dataset), 404 error, timeout, oversized response. Each uses a `mockFetch` injected via `fetchImpl` parameter.

- [ ] **Step 2: Run test to confirm failure**

Run: `cd packages/datahub && npx vitest run src/aspect-reader.test.ts`
Expected: FAIL (module not found)

- [ ] **Step 3: Implement aspect-reader.ts**

A narrow GMS REST reader that:
- Calls `GET /aspects/{encodedUrn}?aspect=mlModelTrainingData`
- Uses `AbortController` with configurable timeout
- Validates response size before parsing
- Computes SHA-256 of raw response text
- Returns `{ proven: true, proof: TrainingDataProof }` when `trainingData[]` contains the expected dataset URN
- Returns `{ proven: false }` when dataset not referenced
- Throws `TRAINING_DATA_READ_FAILED` on HTTP errors/timeouts
- Throws `TRAINING_DATA_RESPONSE_TOO_LARGE` on oversized responses
- Uses only the READ credential

- [ ] **Step 4: Run test to confirm pass**

Run: `cd packages/datahub && npx vitest run src/aspect-reader.test.ts`
Expected: ALL PASS

- [ ] **Step 5: Replace fraudEntityPath in canonical-reader.ts**

Remove the `get_lineage_paths_between` call for fraud entity path (lines 600-609). Replace with:
1. Import `readTrainingDataAspect` from `./aspect-reader.js`
2. Call it with `targets.gmsBaseUrl`, `targets.readToken`, `targets.modelUrn`, `targets.fraudFeaturesUrn`
3. If `!result.proven`, throw `DataHubAdapterError("TRAINING_DATA_NOT_PROVEN", ...)`
4. Store `result.proof` as `trainingDataProof` in observations

Update `CanonicalCollectionTargets` to add `gmsBaseUrl: string` and `readToken: string`.
Update `CanonicalObservations` to replace `fraudEntityPath` with `trainingDataProof`.

- [ ] **Step 6: Update canonical-normalizer.ts**

ML_MODEL evidence now uses `observations.trainingDataProof` for provenance instead of path observation. Set `origin: "LIVE_DATAHUB"` with `tool: "gms-rest-api"`.

- [ ] **Step 7: Update context-port.ts**

Pass `gmsBaseUrl` and `readToken` from the context port credentials into `collectCanonicalObservations`.

- [ ] **Step 8: Update domain evidence.ts MlModelPayload**

Add `trainingDataReceipt: { aspectName, endpoint, retrievedAt, responseSha256, credentialClass, motivation }` as a required field.

- [ ] **Step 9: Update all test fixtures**

Find all ML_MODEL evidence fixtures in test files and add `trainingDataReceipt`. Key locations:
- `packages/datahub/src/canonical-reader.test.ts`
- `packages/datahub/src/context-port.test.ts`
- `packages/domain/src/evidence.ts` (fixture factory)
- `packages/validation/src/canonical-impact-context.test-support.ts`

- [ ] **Step 10: Full test suite + typecheck**

Run: `pnpm typecheck && pnpm test`
Fix all failures from the evidence shape change.

- [ ] **Step 11: Commit**

```bash
git add -A
git commit -m "phase3: truthful ML proof via TrainingData aspect reader

- Narrow GMS REST reader for mlModel TrainingData aspect
- Replaces unsupported get_lineage_paths_between for mlModel entities
- ML_MODEL evidence requires aspect-backed receipt with SHA-256
- Fail-closed: missing relation stops pipeline (TRAINING_DATA_NOT_PROVEN)
- No synthetic invocations or zero-filled fingerprints"
```

**Exit gate:**
- [ ] No `observePathBetweenOrEmpty` or `synthetic_empty_path` in codebase
- [ ] 5+ aspect reader test cases passing
- [ ] ML_MODEL evidence requires `trainingDataReceipt.responseSha256`
- [ ] Missing TrainingData throws, never produces empty success
- [ ] All tests pass

---

### Task 4: Harden Source PR Binding and Four-Card Derivation (Phase 3 continued + Phase 4)

**Files:**
- Modify: `apps/worker/src/source-pr-reader.ts` — enforce MVP allowlist
- Modify: `apps/worker/src/index.ts` — source drift checks
- Modify: `packages/domain/src/source-change.ts` — SourceChangeEnvelope type
- Modify: `packages/domain/src/impact-consumer.ts` — assertion helpers
- Modify: `packages/domain/src/impact-consumer.test.ts` — four-card tests
- Modify: `packages/datahub/src/canonical-normalizer.ts` — UUID schema evidence

**Interfaces:**
- Consumes: GitHub API (PR #3 data), `deriveImpactConsumers()` from domain
- Produces: Validated `SourceChangeEnvelope` with fingerprint; exactly 4 consumers with deterministic order; UUID-consistent schema evidence

- [ ] **Step 1: Write test for four-card assertion**

In `packages/domain/src/impact-consumer.test.ts`, add:
- Test that canonical fixture produces exactly 4 consumers in order: DATA_MODEL, DASHBOARD, ML_CONSUMER, UNMANAGED_QUERY
- Test that `stg_orders` is excluded as intermediate
- Test that `customer_features` is grouped into ML_CONSUMER, not separate
- Test that 5-card result is a regression failure
- Test that foreign lineage edge fails

- [ ] **Step 2: Run tests to verify new assertions fail or pass baseline**

Run: `cd packages/domain && npx vitest run src/impact-consumer.test.ts`

- [ ] **Step 3: Add `assertExactlyFourConsumers` helper**

```typescript
// packages/domain/src/impact-consumer.ts
export function assertExactlyFourConsumers(consumers: ImpactConsumer[]): void {
  if (consumers.length !== 4) {
    throw new Error(`IMPACT_CARD_COUNT_MISMATCH: expected 4, got ${consumers.length}`);
  }
  const kinds = consumers.map(c => c.kind);
  const expected: ImpactConsumerKind[] = ["DATA_MODEL", "DASHBOARD", "ML_CONSUMER", "UNMANAGED_QUERY"];
  if (JSON.stringify(kinds) !== JSON.stringify(expected)) {
    throw new Error(`IMPACT_CARD_ORDER_MISMATCH: got ${JSON.stringify(kinds)}`);
  }
}
```

- [ ] **Step 4: Ensure UUID schema evidence throughout**

In `canonical-normalizer.ts`, verify that schema evidence for `commerce.orders` columns uses `UUID` type, not `bigint`. Update any fixture or normalizer logic that hardcodes `bigint`.

Grep for `bigint` across:
- `packages/datahub/src/canonical-normalizer.ts`
- `packages/domain/src/evidence.ts`
- `packages/validation/src/` fixtures
- `examples/canonical-run/`

Replace all `customer_id bigint` / `order_id bigint` with `customer_id uuid` / `order_id uuid`.

- [ ] **Step 5: Harden source-pr-reader.ts**

Ensure the existing reader enforces:
- Expected repository match
- PR is open
- Exactly one migration file selected
- Exactly one RENAME_COLUMN statement
- No unrelated executable changes
- `SOURCE_DRIFT` check: re-read before validation and before publication

- [ ] **Step 6: Add source drift detection to worker pipeline**

In `apps/worker/src/index.ts` or orchestration, add re-read checkpoints:
- Before validation: compare current headSha with persisted headSha
- Before GitHub publication: compare again
- Throw typed `SOURCE_DRIFT` error on mismatch

- [ ] **Step 7: Run full test suite**

```bash
pnpm typecheck && pnpm test
```

- [ ] **Step 8: Commit**

```bash
git add -A
git commit -m "phase3-4: harden four-card derivation and source PR binding

- assertExactlyFourConsumers enforces count + order
- UUID schema evidence throughout (no bigint)
- Source drift detection before validation and publication
- stg_orders/customer_features correctly excluded/grouped"
```

**Exit gate:**
- [ ] `deriveImpactConsumers` returns exactly 4 in canonical order
- [ ] 5-card regression test fails appropriately
- [ ] No `bigint` in schema evidence or fixtures
- [ ] Source drift throws `SOURCE_DRIFT`, not silent continuation

---

### Task 5: UUID Candidate and Eight-Check Validator (Phase 5)

**Files:**
- Modify: `packages/validation/src/validator.ts` — UUID fixtures in check commands
- Modify: `packages/validation/src/materializer.ts` — UUID base table
- Modify: `packages/validation/src/validator.test.ts` — UUID test scenarios
- Modify: `packages/domain/src/migration.ts` — UUID migration SQL

**Interfaces:**
- Consumes: `SourceChangeEnvelope`, `ImpactContext` with proven evidence, candidate builder
- Produces: 8/8 PASS validation receipt with candidate/bundle/receipt fingerprints

- [ ] **Step 1: Verify existing validator test structure**

Run: `cd packages/validation && npx vitest run`
Identify which checks use bigint fixtures and which already use UUID.

- [ ] **Step 2: Update migration.ts canonical SQL**

Ensure the generated migration uses UUID:

```sql
ALTER TABLE commerce.orders ADD COLUMN buyer_id uuid;
UPDATE commerce.orders SET buyer_id = customer_id WHERE buyer_id IS NULL;
```

And the compatibility trigger handles UUID values (no casting needed since both are uuid).

- [ ] **Step 3: Update materializer base table to UUID**

In `materializer.ts`, the base table creation for validation must use:

```sql
CREATE TABLE commerce.orders (
  order_id uuid PRIMARY KEY,
  customer_id uuid NOT NULL,
  order_total numeric(12,2),
  ordered_at timestamptz NOT NULL
);
```

With deterministic UUID literals for seed data (no `gen_random_uuid()`).

- [ ] **Step 4: Update validator test fixtures**

All 8 checks must use UUID seed data. Update `validator.test.ts` with proper UUID test values.

- [ ] **Step 5: Run validator tests**

```bash
cd packages/validation && npx vitest run src/validator.test.ts
```

- [ ] **Step 6: Verify candidate fingerprint binding**

The candidate fingerprint must bind: sourceFingerprint, patchSha256, baseSha, headSha, contextFingerprint, decision, evidenceIds, artifactManifest. Verify this in the candidate builder logic.

- [ ] **Step 7: Run full test suite**

```bash
pnpm typecheck && pnpm test
```

- [ ] **Step 8: Commit**

```bash
git add -A
git commit -m "phase5: UUID-safe candidate and validator fixtures

- Migration SQL uses uuid type throughout
- Base table and seed data use deterministic UUID literals
- All 8 validation checks pass with UUID schema
- Candidate fingerprint binds source + context + artifacts"
```

**Exit gate:**
- [ ] No `bigint` in validation fixtures or migration SQL
- [ ] All 8 checks pass in validator.test.ts
- [ ] Candidate fingerprint binds all required fields
- [ ] Deterministic UUID literals (no gen_random_uuid)

---

### Task 6: Stable GitHub Publication Identity (Phase 6)

**Files:**
- Modify: `packages/github/src/live-adapter.ts` — derive branch from source+candidate, not runId
- Modify: `packages/github/src/live-adapter.test.ts` — stable identity tests
- Modify: `packages/github/src/types.ts` — EffectOutcome type

**Interfaces:**
- Consumes: `sourceHeadSha`, `candidateFingerprint`, `prNumber`, validated artifact bytes
- Produces: Stable branch `lineageguard/generated/pr-3-<prefix>`; one draft PR reused across runs; `EffectOutcome: "CREATED" | "UPDATED" | "SKIPPED_EXACT"`

- [ ] **Step 1: Write test for stable branch identity**

```typescript
it("derives deterministic branch name from source + candidate", () => {
  const branch = deriveStableEffectBranch({
    repository: "greatkich/lineageguard",
    prNumber: 3,
    sourceHeadSha: "abc123",
    candidateFingerprint: "def456...",
  });
  expect(branch).toBe("lineageguard/generated/pr-3-def456");
});

it("repeated identical input returns SKIPPED_EXACT", async () => {
  // Mock: branch exists, tree matches validation observations
  // Expect: outcome = "SKIPPED_EXACT", no new commit
});
```

- [ ] **Step 2: Implement stable effect identity**

In `live-adapter.ts`:
1. Replace `lineageguard/run-{runId}` with `lineageguard/generated/pr-{prNumber}-{candidateFingerprintPrefix}`
2. On reconcile: if branch exists AND tree/blob verification matches, return `SKIPPED_EXACT`
3. If branch exists but content differs (new candidate), force-update with `UPDATED`
4. If branch doesn't exist, create with `CREATED`

- [ ] **Step 3: Add exact base binding**

Create the commit from the validated `baseSha`, not current `main` tip. Abort if base is no longer an ancestor of `main`.

- [ ] **Step 4: Add EffectOutcome type**

```typescript
export type EffectOutcome = "CREATED" | "UPDATED" | "SKIPPED_EXACT";
```

- [ ] **Step 5: Run tests**

```bash
cd packages/github && npx vitest run
```

- [ ] **Step 6: Commit**

```bash
git add -A
git commit -m "phase6: stable content-addressed GitHub publication

- Branch identity derived from source PR + candidate fingerprint
- Identical reruns return SKIPPED_EXACT (no duplicate PRs)
- Commit created from exact validated baseSha
- Remote blob/tree verification before success"
```

**Exit gate:**
- [ ] Deterministic branch name from source+candidate
- [ ] Second identical run does not create another PR
- [ ] Changed candidate gets new deterministic identity
- [ ] Exact base SHA binding verified

---

### Task 7: Stable DataHub Write-back Identity (Phase 7)

**Files:**
- Modify: `packages/datahub/src/writeback.ts` — stable decision key, merge not replace
- Modify: `apps/worker/src/orchestration.ts` — wire stable identity
- Create: `packages/datahub/src/writeback.test.ts` (or modify existing)

**Interfaces:**
- Consumes: `repository`, `prNumber`, `sourceHeadSha`, `candidateFingerprint`, mutation credential
- Produces: One stable decision record; idempotent write; exact read-after-write verification

- [ ] **Step 1: Write test for stable decision identity**

Test that the decision key is derived from `repository + prNumber + sourceHeadSha + candidateFingerprint`, not from `runId`.

- [ ] **Step 2: Implement merge-not-replace write-back**

In `writeback.ts`:
1. Read current entity state first
2. Preserve unrelated tags, documents, ownership
3. Merge only the LineageGuard-owned decision element
4. Use stable key for decision identity
5. Store `latestVerifiedRunId` as metadata, not as the primary key

- [ ] **Step 3: Implement read-after-write verification**

After write:
1. Use READ credential to fetch the entity
2. Compare written decision content against expected
3. COMPLETED is forbidden until read-back passes

- [ ] **Step 4: Test idempotency**

Second write with same input must not create duplicate tags/documents.

- [ ] **Step 5: Run tests and commit**

```bash
pnpm typecheck && pnpm test
git add -A
git commit -m "phase7: stable idempotent DataHub write-back

- Decision identity from source+candidate, not runId
- Merge-only write preserves unrelated metadata
- Exact read-after-write verification required for COMPLETED
- Repeated writes are idempotent (no duplicate markers)"
```

**Exit gate:**
- [ ] Write-back key is source-scoped, not run-scoped
- [ ] Read-after-write verification passes
- [ ] Unrelated tags/metadata preserved
- [ ] Duplicate write produces no side effects

---

### Task 8: Demo Lifecycle Commands (Phase 2)

**Files:**
- Create: `scripts/demo-preflight.ts`
- Create: `scripts/demo-bootstrap.ts`
- Create: `scripts/demo-verify.ts`
- Create: `scripts/demo-repeat.ts`
- Create: `scripts/demo-reset.ts`
- Create: `scripts/demo-golden.ts`
- Modify: `package.json` — add script entries

**Interfaces:**
- Consumes: all pipeline components, SimpleRunStore, DataHub Python tooling
- Produces: complete `demo:*` command surface with PASS/FAIL output

- [ ] **Step 1: Add script entries to package.json**

```json
"demo:preflight": "node --import tsx scripts/demo-preflight.ts",
"demo:bootstrap": "node --import tsx scripts/demo-bootstrap.ts",
"demo:run": "pnpm build && node --import tsx scripts/demo.ts",
"demo:verify": "node --import tsx scripts/demo-verify.ts",
"demo:repeat": "node --import tsx scripts/demo-repeat.ts",
"demo:reset": "node --import tsx scripts/demo-reset.ts",
"demo:golden": "node --import tsx scripts/demo-golden.ts"
```

- [ ] **Step 2: Implement demo-preflight.ts**

Non-mutating checks:
- Node/pnpm version match engines
- Docker daemon responds
- PostgreSQL connectivity
- DataHub GMS health (`/config` endpoint)
- GitHub auth (`gh auth status`)
- Source PR #3 is open
- Required env vars present (DATAHUB_*, GITHUB_TOKEN, etc.)
- No skip flags set
- Writable evidence directory

Print PASS/FAIL matrix. Exit non-zero on any mandatory failure.

- [ ] **Step 3: Implement demo-bootstrap.ts**

Orchestrate the DataHub bootstrap chain:
1. Call `warehouse-seed --execute` via Python tooling
2. Call `dbt-build --execute`
3. Call `ingest --execute`
4. Call `metadata-seed --execute`
5. Verify canonical graph (4 consumer groups provable)

Each step checks for existing receipt (idempotent). Second invocation is a no-op.

- [ ] **Step 4: Implement demo-verify.ts**

Accept `--runId` argument. Independently verify:
- Source envelope matches current PR #3 head
- Baseline ALLOW decision recorded
- Grounded BLOCK decision recorded
- Exactly 4 impact cards
- Zero synthetic evidence
- 8/8 validation checks in receipt
- Generated PR exists and artifact fingerprint matches
- DataHub decision read-back matches
- Final state is COMPLETED

- [ ] **Step 5: Implement demo-repeat.ts**

Accept `--count N` (default 3). Run `demo:run` N times sequentially:
- All must reach COMPLETED
- Exactly one stable PR exists
- Exactly one stable DataHub decision
- No duplicate markers
- Collect distinct runIds and stable fingerprints

- [ ] **Step 6: Implement demo-reset.ts**

`--clean` flag for full reset. Default is fast reset:
- Fast: clear `lineageguard.simple_runs` table, remove demo-owned ephemeral effects
- Clean: also reset warehouse seed, re-bootstrap

Scope all deletions by LineageGuard ownership markers.

- [ ] **Step 7: Implement demo-golden.ts**

After a verified run:
1. Copy evidence bundle to `examples/canonical-run/`
2. Generate `manifest.json` with real fingerprints (no placeholders)
3. Capture Mission Control screenshots via Playwright
4. Store in `artifacts/demo-runs/<runId>/`

- [ ] **Step 8: Run all commands with --help**

Verify each script has usage output and handles missing args gracefully.

- [ ] **Step 9: Commit**

```bash
git add -A
git commit -m "phase2: add reproducible demo lifecycle commands

- demo:preflight — non-mutating environment validation
- demo:bootstrap — idempotent DataHub graph setup
- demo:verify — independent run verification
- demo:repeat — consecutive run prover
- demo:reset — scoped cleanup (fast and clean)
- demo:golden — evidence capture and screenshot generation"
```

**Exit gate:**
- [ ] All 7 scripts exist with help output
- [ ] `demo:preflight` reports PASS/FAIL matrix
- [ ] `demo:bootstrap` is idempotent (second run is no-op)
- [ ] Scripts have non-zero exit on failure
- [ ] `package.json` scripts defined

---

### Task 9: Live End-to-End Run and Three-Run Repeatability (Phase 8)

**Files:**
- Modify: `examples/canonical-run/manifest.json` — replace placeholders with live fingerprints
- Create: `artifacts/demo-runs/<runId>/` — live evidence bundle
- Modify: `examples/canonical-run/README.md` — update with real run data

**Interfaces:**
- Consumes: all previous tasks (pipeline, lifecycle commands, live infrastructure)
- Produces: 3 consecutive COMPLETED runs; zero placeholders; golden evidence bundle

**Prerequisites:** Tasks 1-8 complete. Live infrastructure available (DataHub, PostgreSQL, GitHub).

- [ ] **Step 1: Run preflight**

```bash
pnpm demo:preflight
```

Must exit 0. If not, fix the blocking issue before continuing.

- [ ] **Step 2: Run bootstrap**

```bash
pnpm demo:bootstrap
```

Must seed warehouse, run dbt, ingest, seed metadata, and verify graph. Exit 0.

- [ ] **Step 3: Execute first live run**

```bash
pnpm demo:run
```

Must reach COMPLETED. Record the runId.

- [ ] **Step 4: Verify the first run independently**

```bash
pnpm demo:verify --runId <runId>
```

Check all verification points pass.

- [ ] **Step 5: Execute three consecutive runs**

```bash
pnpm demo:repeat --count 3
```

Must prove:
- All 3 reach COMPLETED
- One stable PR
- One stable DataHub decision
- No duplicates
- Distinct runIds

- [ ] **Step 6: Capture golden evidence**

```bash
pnpm demo:golden --runId <lastRunId>
```

Updates `examples/canonical-run/` with real data. Captures screenshots.

- [ ] **Step 7: Verify no placeholders remain**

```bash
grep -r "PLACEHOLDER\|TODO\|TBD" examples/canonical-run/
```

Must return empty.

- [ ] **Step 8: Commit golden evidence**

```bash
git add -A
git commit -m "phase8: live golden run — 3 consecutive COMPLETED

- Real fingerprints in examples/canonical-run/manifest.json
- Live evidence bundle in artifacts/demo-runs/
- Mission Control screenshots from verified run
- Zero placeholders, zero synthetic evidence"
```

**Exit gate:**
- [ ] 3 consecutive identical-input runs reach COMPLETED
- [ ] Exactly one stable draft PR exists
- [ ] Exactly one stable DataHub decision
- [ ] `syntheticLiveEvidenceCount = 0`
- [ ] `examples/canonical-run/` has no placeholders
- [ ] Screenshots captured from live Mission Control

---

### Task 10: Final Documentation and PR (Phase 9)

**Files:**
- Modify: `README.md` — update with demo instructions
- Create: `docs/demo-walkthrough.md`
- Create: `docs/troubleshooting.md`
- Create: `artifacts/demo-runs/FINAL_EXECUTION_REPORT.md`

**Interfaces:**
- Consumes: all evidence from Tasks 1-9
- Produces: review-ready PR with complete documentation

- [ ] **Step 1: Write final execution report**

Document:
- Commands run and their exit codes
- All fingerprints (source, candidate, validation receipt, artifact, decision)
- URLs (source PR, generated PR, DataHub entity)
- Environment versions
- Run IDs from the three consecutive runs
- Remaining known limitations

- [ ] **Step 2: Update README with demo quick-start**

Add a section showing:
```bash
pnpm demo:preflight
pnpm demo:bootstrap
pnpm demo:run
pnpm demo:verify --runId <id>
```

- [ ] **Step 3: Create demo-walkthrough.md**

Step-by-step guide for the canonical demo with expected outputs.

- [ ] **Step 4: Create troubleshooting.md**

Common issues: DataHub not running, missing tokens, disk space, port conflicts.

- [ ] **Step 5: Run final quality gate**

```bash
pnpm format:check && pnpm lint && pnpm typecheck && pnpm test && pnpm build
```

Must all exit 0.

- [ ] **Step 6: Push and open PR**

```bash
git push -u origin fix/canonical-live-demo-completion
gh pr create --base main --title "feat: canonical live demo completion" \
  --body "## Summary
Integrates PR #4 + PR #5 DataHub remediation, implements truthful ML evidence
via TrainingData aspect reader, adds reproducible demo lifecycle, proves three
consecutive COMPLETED runs.

## Evidence
- 3 consecutive COMPLETED runs with identical input
- 4 live DataHub-backed consumer groups (zero synthetic)
- 8/8 validation checks with UUID schema
- One stable generated draft PR
- Exact DataHub write-back/read-back verified
- Golden evidence in artifacts/demo-runs/

## Closes
Supersedes PR #4 and PR #5 (may be closed after this merges).

---
See artifacts/demo-runs/FINAL_EXECUTION_REPORT.md for full details."
```

- [ ] **Step 7: Do NOT auto-merge**

Leave PR open for review.

**Exit gate:**
- [ ] All quality gates green
- [ ] PR opened with complete description
- [ ] Final execution report committed
- [ ] PR NOT auto-merged

---

## Component Reuse Attestation

| Component | Status |
|-----------|--------|
| GitHub source PR reader + SourceChange | REUSED_AND_HARDENED (source drift detection added) |
| SimpleRunStore persistence | REUSED_UNCHANGED |
| Impact consumer derivation (`deriveImpactConsumers`) | REUSED_AND_HARDENED (assertion helper added) |
| Eight-check validator | REUSED_AND_HARDENED (UUID fixtures) |
| Sealed validation bundle | REUSED_UNCHANGED |
| Docker isolation model | REUSED_UNCHANGED |
| Mission Control rendering | REUSED_UNCHANGED |
| Evidence export tooling | REUSED_AND_HARDENED (golden command) |
| DataHub read/mutation credential separation | REUSED_UNCHANGED |
| GitHub live-adapter (PR creation) | REUSED_AND_HARDENED (stable identity) |
| DataHub write-back | REUSED_AND_HARDENED (stable key, merge, read-back) |
| Playwright E2E fixtures | REUSED_UNCHANGED |

New component: `aspect-reader.ts` — ADDED_WITH_REASON: Official MCP adapter does not expose `TrainingData` in `get_entities` responses; mlModel entities use TrainingData instead of UpstreamLineage, making `get_lineage_paths_between` unsupported for this edge.

---

## Stop Conditions

Stop and report immediately if:

1. DataHub GMS is unreachable and cannot be started
2. PR #3 has been merged or closed
3. `mcp-server-datahub` does not expose required read-only tools
4. TrainingData aspect cannot be read via GMS REST (endpoint not available)
5. Docker cannot run isolated validation containers
6. GitHub token lacks required permissions
7. Any phase exit gate remains red after reasonable debugging (3+ attempts)
