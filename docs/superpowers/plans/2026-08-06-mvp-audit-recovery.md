# MVP Audit Recovery — 5-Task Corrective Wave

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make LineageGuard demo-ready by fixing the canonical candidate to target real dbt consumers, wiring real validation, using durable persistence, creating real GitHub PRs with verified DataHub write-back, making the UI evidence-backed, and packaging for submission.

**Architecture:** The worker orchestration layer bridges the agent pipeline (packages/agent) with strict domain packages (packages/domain, packages/db, packages/validation, packages/github, packages/datahub). Currently the worker uses a simplified `simple-store.ts` and structural validation. We wire the existing strict packages incrementally — each task makes one layer honest.

**Tech Stack:** TypeScript (Node 24), pnpm 11.20, Zod schemas, PostgreSQL, Docker (validation), Next.js (web), Playwright (e2e), Vitest (unit), Biome (format/lint)

## Global Constraints

- One canonical scenario only: `ALTER TABLE commerce.orders RENAME COLUMN customer_id TO buyer_id`
- Real DataHub OSS via official MCP adapter in LIVE mode
- Never import test fixtures into LIVE runtime
- Deterministic/template-constrained renderer is acceptable (not LLM-arbitrary)
- Policy code owns ALLOW | REVIEW | BLOCK decisions
- Use existing strict packages — do not build parallel replacements
- No structural or presence-only PASS statuses
- No write-back success without exact read-back
- No UI values without persisted run evidence
- No fake Git SHAs in LIVE mode
- Branch: `fix/mvp-audit-recovery` — do not merge into main
- Node >=24.0.0, pnpm >=11.20.0

---

### Task 1: Fix Canonical Candidate and Wire Real Validation

**Files:**
- Modify: `packages/agent/src/steps/build-canonical-candidate.ts`
- Modify: `packages/domain/src/migration.ts` (expand `dbtModelPathSchema` regex)
- Modify: `apps/worker/src/orchestration.ts` (replace structural validation)
- Modify: `apps/worker/package.json` (add `@lineageguard/validation` dependency)
- Create: `packages/agent/src/steps/build-canonical-candidate.test.ts`
- Modify: `packages/agent/src/pipeline.ts` (pass `validationReceiptFingerprint` to writeback)

**Interfaces:**
- Consumes: `ImpactContext`, `ProposedChange`, `RiskComparison` from `@lineageguard/domain`
- Produces: `MigrationCandidate` that passes `migrationCandidateSchema.parse()` AND `bindMigrationCandidate()`, targeting real dbt paths

#### Step 1: Fix dbtModelPathSchema to allow subdirectories

- [ ] **1.1: Expand dbt model path regex in domain**

The current `dbtModelPathSchema` is:
```
/^walkthrough\/models\/[A-Za-z0-9_./-]+\.sql$/
```
This already allows subdirectories. Verify it accepts:
- `walkthrough/models/staging/stg_orders.sql`  
- `walkthrough/models/analytics/customer_revenue.sql`
- `walkthrough/models/fraud/customer_features.sql`

No change needed — the regex already allows these paths.

#### Step 2: Rewrite `buildCanonicalCandidate` to target real consumers

- [ ] **2.1: Write failing test**

Create `packages/agent/src/steps/build-canonical-candidate.test.ts`:

```typescript
import { describe, expect, it } from "vitest";
import { migrationCandidateSchema, bindMigrationCandidate } from "@lineageguard/domain";
import { buildCanonicalCandidate } from "./build-canonical-candidate.js";
import { createCanonicalTestInputs } from "./build-canonical-candidate.test-support.js";

describe("buildCanonicalCandidate", () => {
  it("targets the real walkthrough dbt consumers", () => {
    const inputs = createCanonicalTestInputs();
    const candidate = buildCanonicalCandidate(inputs);

    // Must target real dbt files, not walkthrough/models/orders.sql
    const dbtModelPaths = candidate.artifacts
      .filter((a) => a.kind === "DBT_MODEL")
      .map((a) => a.path)
      .sort();

    expect(dbtModelPaths).toEqual([
      "walkthrough/models/analytics/customer_revenue.sql",
      "walkthrough/models/fraud/customer_features.sql",
      "walkthrough/models/staging/stg_orders.sql",
    ]);
  });

  it("uses ordered_at not created_at in stg_orders", () => {
    const inputs = createCanonicalTestInputs();
    const candidate = buildCanonicalCandidate(inputs);
    const stgOrders = candidate.artifacts.find(
      (a) => a.path === "walkthrough/models/staging/stg_orders.sql"
    );
    expect(stgOrders?.content).toContain("ordered_at");
    expect(stgOrders?.content).not.toContain("created_at");
  });

  it("does not contain self-referencing ref('orders') in orders.sql", () => {
    const inputs = createCanonicalTestInputs();
    const candidate = buildCanonicalCandidate(inputs);
    // Should not have a walkthrough/models/orders.sql at all
    const ordersModel = candidate.artifacts.find(
      (a) => a.path === "walkthrough/models/orders.sql"
    );
    expect(ordersModel).toBeUndefined();
  });

  it("includes a not-null dbt test", () => {
    const inputs = createCanonicalTestInputs();
    const candidate = buildCanonicalCandidate(inputs);
    const tests = candidate.artifacts.filter((a) => a.kind === "DBT_TEST");
    expect(tests.length).toBeGreaterThanOrEqual(2);
    const notNullTest = tests.find((t) => t.content.includes("buyer_id is null"));
    expect(notNullTest).toBeDefined();
  });

  it("passes migrationCandidateSchema", () => {
    const inputs = createCanonicalTestInputs();
    const candidate = buildCanonicalCandidate(inputs);
    expect(() => migrationCandidateSchema.parse(candidate)).not.toThrow();
  });

  it("passes bindMigrationCandidate", () => {
    const inputs = createCanonicalTestInputs();
    const candidate = buildCanonicalCandidate(inputs);
    expect(() =>
      bindMigrationCandidate(candidate, inputs.change, inputs.context, inputs.comparison.grounded)
    ).not.toThrow();
  });
});
```

- [ ] **2.2: Create test support file**

Create `packages/agent/src/steps/build-canonical-candidate.test-support.ts` with a factory that produces valid `ProposedChange`, `ImpactContext`, and `RiskComparison` matching the canonical scenario's evidence structure. Use the same evidence IDs and structures as the canonical DataHub graph produces.

- [ ] **2.3: Run tests — verify they fail**

Run: `pnpm --filter @lineageguard/agent test`
Expected: FAIL — current candidate produces `walkthrough/models/orders.sql`

- [ ] **2.4: Rewrite buildCanonicalCandidate**

Replace `packages/agent/src/steps/build-canonical-candidate.ts`:

Key changes:
1. Generate 3 `DBT_MODEL` artifacts with operation `MODIFY` targeting:
   - `walkthrough/models/staging/stg_orders.sql` — adds `buyer_id` column, keeps `ordered_at`
   - `walkthrough/models/analytics/customer_revenue.sql` — changes `customer_id` → `buyer_id`  
   - `walkthrough/models/fraud/customer_features.sql` — changes `customer_id` → `buyer_id`
2. Generate 2 `DBT_TEST` artifacts:
   - `walkthrough/tests/orders_compat.sql` — equality test (customer_id = buyer_id)
   - `walkthrough/tests/orders_buyer_id_not_null.sql` — not-null test
3. Use `ordered_at` in stg_orders (matching the real file)
4. Remove the old `walkthrough/models/orders.sql` artifact
5. Adjust step artifact targets to match new paths
6. Ensure artifacts array is sorted by path (schema requirement)

The dbt model content for stg_orders:
```sql
SELECT
    order_id,
    customer_id,
    buyer_id,
    order_total,
    ordered_at
FROM {{ source('commerce', 'orders') }}
```

For customer_revenue:
```sql
SELECT
    buyer_id,
    SUM(order_total) AS lifetime_revenue
FROM {{ ref('stg_orders') }}
GROUP BY buyer_id
```

For customer_features:
```sql
SELECT
    buyer_id,
    COUNT(*) AS order_count,
    MAX(order_total) AS max_order_total
FROM {{ ref('stg_orders') }}
GROUP BY buyer_id
```

- [ ] **2.5: Run tests — verify they pass**

Run: `pnpm --filter @lineageguard/agent test`
Expected: ALL PASS

- [ ] **2.6: Commit**

```bash
git add packages/agent/src/steps/build-canonical-candidate.ts packages/agent/src/steps/build-canonical-candidate.test.ts packages/agent/src/steps/build-canonical-candidate.test-support.ts
git commit -m "fix: canonical candidate targets real dbt consumers

- stg_orders, customer_revenue, customer_features (not orders.sql)
- Uses ordered_at, not created_at
- Adds not-null assertion test
- No self-referencing ref('orders') in orders.sql
- Passes migrationCandidateSchema and bindMigrationCandidate"
```

#### Step 3: Replace structural validation with real validator in orchestration

- [ ] **3.1: Add @lineageguard/validation dependency to worker**

In `apps/worker/package.json`, add:
```json
"@lineageguard/validation": "workspace:*"
```

- [ ] **3.2: Rewrite createValidationPort in orchestration.ts**

Replace the structural `createValidationPort()` with one that:
1. Checks for Docker availability (`VALIDATION_DOCKER_EXECUTABLE` env var or `/usr/bin/docker`)
2. Checks for required image IDs (`VALIDATION_RUNNER_IMAGE_ID`, `VALIDATION_POSTGRES_IMAGE_ID`)
3. Reads base fixture SQL from `VALIDATION_BASE_FIXTURE_PATH` or bundled default
4. Calls `materializeCandidate()` then `executeValidationInOwnedDatabase()`
5. Returns proper `ValidationOutput` with real check results and receipt fingerprint
6. On missing Docker/images, throws (causing FAILED_VALIDATION in pipeline)

```typescript
function createValidationPort(): AgentValidationPort | undefined {
  const validationEnabled = process.env.VALIDATION_ENABLED !== "false";
  if (!validationEnabled) return undefined;

  const dockerExecutable = process.env.VALIDATION_DOCKER_EXECUTABLE ?? "/usr/bin/docker";
  const runnerImageId = process.env.VALIDATION_RUNNER_IMAGE_ID;
  const postgresImageId = process.env.VALIDATION_POSTGRES_IMAGE_ID;

  if (!runnerImageId || !postgresImageId) {
    console.warn("[orchestration] Validation images not configured — validation will fail at runtime");
  }

  return {
    async validate(candidate: MigrationCandidate): Promise<ValidationOutput> {
      const { materializeCandidate } = await import("@lineageguard/validation");
      const { executeValidationInOwnedDatabase } = await import("@lineageguard/validation");
      // ... full implementation using real validator
    },
  };
}
```

- [ ] **3.3: Pass real validationReceiptFingerprint to writeback**

In `packages/agent/src/pipeline.ts`, store the validation receipt fingerprint from step 7 and pass it to writeback in step 9 (currently hardcoded as `""`).

- [ ] **3.4: Run typecheck and existing tests**

```bash
pnpm typecheck
pnpm test
```

- [ ] **3.5: Commit**

```bash
git add apps/worker/src/orchestration.ts apps/worker/package.json packages/agent/src/pipeline.ts
git commit -m "fix: wire real validation package, remove structural PASS

- Uses materializeCandidate + executeValidationInOwnedDatabase
- Missing Docker/images → FAILED_VALIDATION
- Passes real validationReceiptFingerprint to writeback"
```

---

### Task 2: Durable Run State and Fail-Closed Demo

**Files:**
- Modify: `apps/worker/src/index.ts`
- Modify: `apps/worker/src/simple-store.ts` (expand to persist full context)
- Modify: `scripts/demo.ts` (exit non-zero on failure)
- Create: `apps/worker/src/run-store-adapter.ts` (bridge simple-store → richer persistence)
- Modify: `packages/agent/src/pipeline.ts` (return terminal result properly)

**Interfaces:**
- Consumes: `PipelineResult` from pipeline, `RunStatus` from domain
- Produces: Persisted run with full context; `pnpm demo` exits 0 only on COMPLETED

#### Step 1: Expand simple-store to persist full evidence

- [ ] **1.1: Add columns to simple_runs for full context**

Modify `ensureRunsTable()` in `apps/worker/src/simple-store.ts` to add:
```sql
ALTER TABLE lineageguard.simple_runs ADD COLUMN IF NOT EXISTS source_pr_url TEXT;
ALTER TABLE lineageguard.simple_runs ADD COLUMN IF NOT EXISTS impact_consumers INTEGER DEFAULT 0;
ALTER TABLE lineageguard.simple_runs ADD COLUMN IF NOT EXISTS evidence_items INTEGER DEFAULT 0;
ALTER TABLE lineageguard.simple_runs ADD COLUMN IF NOT EXISTS validation_checks_passed INTEGER DEFAULT 0;
ALTER TABLE lineageguard.simple_runs ADD COLUMN IF NOT EXISTS validation_checks_total INTEGER DEFAULT 0;
ALTER TABLE lineageguard.simple_runs ADD COLUMN IF NOT EXISTS validation_receipt_fingerprint TEXT;
ALTER TABLE lineageguard.simple_runs ADD COLUMN IF NOT EXISTS github_receipt_fingerprint TEXT;
ALTER TABLE lineageguard.simple_runs ADD COLUMN IF NOT EXISTS writeback_receipt_fingerprint TEXT;
ALTER TABLE lineageguard.simple_runs ADD COLUMN IF NOT EXISTS context_json JSONB;
ALTER TABLE lineageguard.simple_runs ADD COLUMN IF NOT EXISTS candidate_json JSONB;
ALTER TABLE lineageguard.simple_runs ADD COLUMN IF NOT EXISTS comparison_json JSONB;
ALTER TABLE lineageguard.simple_runs ADD COLUMN IF NOT EXISTS execution_mode TEXT DEFAULT 'LIVE';
```

- [ ] **1.2: Expand updateRunStatus to accept new fields**

Add parameters for all new columns to the `updateRunStatus` function.

- [ ] **1.3: Compute impact consumers separately from evidence count**

In `packages/agent/src/pipeline.ts`, after context collection:
```typescript
const consumerKinds = new Set(["LINEAGE_PATH", "DASHBOARD", "ML_MODEL", "QUERY_USAGE"]);
const impactConsumers = context.evidence.filter((e) => consumerKinds.has(e.kind)).length;
result.consumersFound = impactConsumers; // Not context.evidence.length
```

#### Step 2: Make demo exit non-zero on failure

- [ ] **2.1: Modify scripts/demo.ts**

```typescript
async function main() {
  // ... existing setup ...
  const { runWorker } = await import("../apps/worker/src/index.js");
  const result = await runWorker({ once: true, workerId: "demo" });
  
  if (!result || result.finalStatus !== "COMPLETED") {
    console.error(`\n=== Demo FAILED: ${result?.finalStatus ?? "unknown"} ===`);
    process.exit(1);
  }
  console.log("\n=== Demo Complete ===");
  process.exit(0);
}
```

- [ ] **2.2: Make runWorker return PipelineResult**

In `apps/worker/src/index.ts`, change `runWorker` to return `PipelineResult | null`:

```typescript
export async function runWorker(options: WorkerOptions = {}): Promise<PipelineResult | null> {
  // ... in --once mode:
  const result = await orchestrator.execute({...});
  return result;
}
```

- [ ] **2.3: Persist full context in onStatusChange**

In orchestration.ts, expand the `onStatusChange` callback to persist context/candidate/comparison when transitioning to relevant states.

- [ ] **2.4: Run tests**

```bash
pnpm typecheck
pnpm test
```

- [ ] **2.5: Commit**

```bash
git add apps/worker/src/index.ts apps/worker/src/simple-store.ts scripts/demo.ts packages/agent/src/pipeline.ts apps/worker/src/orchestration.ts
git commit -m "fix: durable run state + demo exits non-zero on failure

- Persist full context, candidate, comparison in simple_runs
- Compute impact consumers separately from total evidence
- runWorker returns PipelineResult
- pnpm demo exits 1 on any FAILED_* status"
```

---

### Task 3: Real Source PR, Strict Generated PR, Verified DataHub Write-back

**Files:**
- Modify: `apps/worker/src/index.ts` (read SOURCE_PR_NUMBER)
- Modify: `apps/worker/src/orchestration.ts` (source PR reader + write-back read-back)
- Modify: `.env.example` (add SOURCE_PR_NUMBER, fix naming)
- Create: `apps/worker/src/source-pr-reader.ts`

**Interfaces:**
- Consumes: GitHub API, DataHub GMS API
- Produces: Real base/head SHAs from source PR; write-back with read-back verification

#### Step 1: Read real source PR

- [ ] **1.1: Create source-pr-reader.ts**

```typescript
export interface SourcePRInfo {
  prNumber: number;
  prUrl: string;
  baseSha: string;
  headSha: string;
  baseBranch: string;
  headBranch: string;
  diffFingerprint: string;
  changedFiles: string[];
}

export async function readSourcePR(options: {
  owner: string;
  repo: string;
  token: string;
  prNumber: number;
}): Promise<SourcePRInfo> {
  // Fetch PR from GitHub API
  // Extract real base/head SHAs
  // Compute diff fingerprint
}
```

- [ ] **1.2: Wire into worker --once mode**

When `SOURCE_PR_NUMBER` is set, read the real PR and use its base/head SHAs. When not set, fall back to environment variables `LINEAGEGUARD_BASE_SHA` / `LINEAGEGUARD_HEAD_SHA` (which should be real SHAs, not "a".repeat(40)).

- [ ] **1.3: Remove hardcoded fake SHAs**

In `apps/worker/src/index.ts`, replace:
```typescript
baseSha: process.env.LINEAGEGUARD_BASE_SHA ?? "a".repeat(40),
headSha: process.env.LINEAGEGUARD_HEAD_SHA ?? "b".repeat(40),
```
with:
```typescript
baseSha: sourcePR?.baseSha ?? process.env.LINEAGEGUARD_BASE_SHA ?? (() => { throw new Error("LINEAGEGUARD_BASE_SHA required when SOURCE_PR_NUMBER not set"); })(),
headSha: sourcePR?.headSha ?? process.env.LINEAGEGUARD_HEAD_SHA ?? (() => { throw new Error("LINEAGEGUARD_HEAD_SHA required when SOURCE_PR_NUMBER not set"); })(),
```

#### Step 2: Add DataHub write-back read-back verification

- [ ] **2.1: Add read-back after write in createWritebackPort**

After each POST to DataHub GMS, read back the entity to verify:
1. The decision document element exists with correct content
2. The `Reviewed` tag is present
3. Existing tags are preserved (read before write, verify after)

```typescript
// After tag POST:
const tagReadback = await fetch(`${gmsUrl}/aspects/${encodeURIComponent(datasetUrn)}?aspect=globalTags`, {
  headers: { Authorization: `Bearer ${mutationToken}` },
});
const tags = await tagReadback.json();
// Verify 'Reviewed' tag exists in response

// After document POST:
const docReadback = await fetch(`${gmsUrl}/aspects/${encodeURIComponent(datasetUrn)}?aspect=institutionalMemory`, {
  headers: { Authorization: `Bearer ${mutationToken}` },
});
// Verify decision document exists
```

If read-back fails, throw (causing FAILED_WRITEBACK).

- [ ] **2.2: Fix .env.example to match runtime**

Update `.env.example`:
- Add `SOURCE_PR_NUMBER=` 
- Add `LINEAGEGUARD_BASE_SHA=`
- Add `LINEAGEGUARD_HEAD_SHA=`
- Add `VALIDATION_DOCKER_EXECUTABLE=/usr/bin/docker`
- Add `VALIDATION_RUNNER_IMAGE_ID=`
- Add `VALIDATION_POSTGRES_IMAGE_ID=`
- Add `VALIDATION_BASE_FIXTURE_PATH=`
- Remove `OPENAI_API_KEY` / `OPENAI_MODEL` (replaced by OMNIROUTE)
- Add `OMNIROUTE_BASE_URL=`
- Add `OMNIROUTE_MODEL=`
- Add `OMNIROUTE_API_KEY=`
- Change `WRITEBACK_ENABLED=false` → `WRITEBACK_ENABLED=true` with comment

- [ ] **2.3: Run typecheck**

```bash
pnpm typecheck
```

- [ ] **2.4: Commit**

```bash
git add apps/worker/src/source-pr-reader.ts apps/worker/src/index.ts apps/worker/src/orchestration.ts .env.example
git commit -m "fix: real source PR + DataHub write-back with read-back

- SOURCE_PR_NUMBER reads real base/head SHAs from GitHub
- No more fake 'a'.repeat(40) SHAs in LIVE mode
- Write-back verifies tag and document via read-back
- .env.example matches actual runtime env names"
```

---

### Task 4: Evidence-Backed Mission Control

**Files:**
- Modify: `apps/web/app/runs/[runId]/page.tsx`
- Modify: `apps/web/app/page.tsx`
- Modify: `apps/web/lib/db.ts`
- Modify: `apps/web/app/api/runs/[runId]/route.ts`
- Modify: `tests/e2e/mission-control.spec.ts`

**Interfaces:**
- Consumes: `simple_runs` table with full context JSON columns
- Produces: UI that displays only persisted evidence, no hardcoded values

#### Step 1: Update data layer to expose full context

- [ ] **1.1: Expand fetchRun in lib/db.ts**

Return the full context_json, candidate_json, comparison_json, and all receipt fingerprints from the expanded simple_runs table.

- [ ] **1.2: Update API route to serve full run data**

The `apps/web/app/api/runs/[runId]/route.ts` should return all persisted fields.

#### Step 2: Remove all hardcoded values from run detail page

- [ ] **2.1: Audit and remove hardcoded claims**

In `apps/web/app/runs/[runId]/page.tsx`:
- Remove any hardcoded "ALLOW" text — use `run.baselineDecision`
- Remove hardcoded "8/8" — use `run.validation_checks_passed`/`run.validation_checks_total`
- Remove "validated against Docker Postgres" — show actual check names and results from persisted data
- Remove hardcoded strategy text — derive from `run.candidate_json?.strategy`
- Remove hardcoded consumer count — use `run.impact_consumers`
- Show "NOT EXECUTED" for any value that is null in the DB

- [ ] **2.2: Add LIVE vs VERIFIED_REPLAY badge**

Display `run.execution_mode` as a badge in the header.

- [ ] **2.3: Show real evidence**

When `run.context_json` is available, render:
- Four impact consumer cards (filter by LINEAGE_PATH, DASHBOARD, ML_MODEL, QUERY_USAGE)
- Entity URNs
- Owners
- Evidence IDs
- Triggered rules with descriptions

When `run.candidate_json` is available, render:
- Generated artifact paths and diffs
- Strategy name

When validation/GitHub/writeback receipts are present, show fingerprints.

#### Step 3: Fix Playwright tests

- [ ] **3.1: Make Playwright self-contained**

Modify `tests/e2e/mission-control.spec.ts`:
- Use `beforeAll` to insert a test run directly into the database (or call the API)
- Don't depend on pre-existing COMPLETED runs
- Assert no console errors
- Assert no network failures
- Capture screenshots for the 8 required states

- [ ] **3.2: Run e2e tests**

```bash
pnpm test:e2e
```

- [ ] **3.3: Commit**

```bash
git add apps/web/ tests/e2e/mission-control.spec.ts
git commit -m "fix: Mission Control shows only persisted evidence

- No hardcoded ALLOW, 8/8, Docker, or strategy claims
- Shows real impact consumers, evidence IDs, triggered rules
- LIVE/VERIFIED_REPLAY badge
- Playwright creates own test data
- Console/network error assertions"
```

---

### Task 5: Release and Submission Package

**Files:**
- Modify: `package.json` (scripts)
- Modify: `.env.example` (final)
- Create: `scripts/check-environment.sh` (expand preflight)
- Create: `examples/canonical-run/manifest.json`
- Create: `examples/canonical-run/` (redacted artifacts from successful run)
- Modify: `README.md`
- Create: `.github/workflows/ci.yml`

**Interfaces:**
- Consumes: All previous tasks complete
- Produces: CI green, clean README, examples bundle, documented clean-start

#### Step 1: Preflight script

- [ ] **1.1: Expand check-environment.sh**

Add checks for:
- Node version >=24
- pnpm version >=11.20
- Required env vars present
- Docker available (for validation)
- PostgreSQL reachable
- DataHub reachable

Exit with clear error messages on failure.

#### Step 2: walkthrough:verify script

- [ ] **2.1: Expand walkthrough:verify in package.json**

```json
"walkthrough:verify": "pnpm format:check && pnpm lint && pnpm typecheck && pnpm test && pnpm build && pnpm test:e2e"
```

This is already defined. Add `pnpm check:environment` at the start.

#### Step 3: GitHub Actions CI

- [ ] **3.1: Create .github/workflows/ci.yml**

```yaml
name: CI
on: [push, pull_request]
jobs:
  check:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: pnpm/action-setup@v4
      - uses: actions/setup-node@v4
        with:
          node-version: 24
          cache: pnpm
      - run: pnpm install --frozen-lockfile
      - run: pnpm format:check
      - run: pnpm lint
      - run: pnpm typecheck
      - run: pnpm test
      - run: pnpm build
```

#### Step 4: Examples bundle

- [ ] **4.1: Create examples/canonical-run/ directory structure**

After a successful live run, capture (redacted) artifacts:
```
examples/canonical-run/
  manifest.json          — ties all fingerprints together
  source-change.sql      — the ALTER TABLE statement  
  impact-context.json    — redacted ImpactContext
  risk-comparison.json   — RiskComparison showing ALLOW→BLOCK
  generated-artifacts/   — the 8+ generated files
  validation-receipt.json — redacted receipt
  github-receipt.json    — PR URL + fingerprint
  datahub-receipt.json   — write-back read-back proof
```

- [ ] **4.2: Create manifest.json**

```json
{
  "schemaVersion": 1,
  "scenario": "canonical-customer-id-rename",
  "executionMode": "LIVE",
  "runId": "run_example_placeholder",
  "fingerprints": {
    "change": "...",
    "impactContext": "...",
    "candidate": "...",
    "validation": "...",
    "github": "...",
    "writeback": "..."
  }
}
```

Note: Actual fingerprints get filled after a real successful run.

#### Step 5: README update

- [ ] **5.1: Rewrite README.md**

Structure:
1. One-line description (first 15 seconds)
2. Problem statement (why repository-only is blind)
3. How it works (architecture diagram)
4. Quick start (clean-start instructions)
5. Live vs Verified Replay
6. Example output
7. Limitations
8. License (Apache-2.0)

- [ ] **5.2: Commit**

```bash
git add .github/workflows/ci.yml examples/ README.md scripts/check-environment.sh package.json .env.example
git commit -m "feat: release package — CI, examples, README, preflight

- GitHub Actions CI for deterministic gates
- examples/canonical-run/ bundle structure
- README with clean-start guide
- Expanded preflight checks"
```

---

## Verification Checklist (Post-Implementation)

After all tasks, run:

```bash
git status --short
pnpm install --frozen-lockfile
pnpm format:check
pnpm lint
pnpm typecheck
pnpm test
pnpm build
```

And verify these negative cases work:
1. Missing DataHub token → FAILED_CONTEXT, demo exits non-zero
2. Wrong backfill → FAILED_VALIDATION (when Docker available)
3. Missing Docker → FAILED_VALIDATION
4. Missing GitHub token → FAILED_GITHUB
5. Write-back without read-back confirmation → FAILED_WRITEBACK
6. Any FAILED_* → `pnpm demo` exits non-zero
