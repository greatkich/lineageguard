# MVP Audit Recovery Wave 2 — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Achieve one real end-to-end live run: real source PR → DataHub BLOCK → backward-compatible migration → 8/8 Docker validation → generated GitHub PR → exact DataHub write-back → verified replay.

**Architecture:** Fix the candidate to preserve both fields during compatibility window. Wire validation with correct policy/bundle structure. Parse the actual source PR diff. Bind generated PR and write-back to the validation chain. Persist full evidence and render exactly 4 impact cards.

**Tech Stack:** TypeScript (Node 24), pnpm 11.20, Zod, PostgreSQL, Docker (validation), dbt, Next.js, Playwright, Vitest, Biome

## Global Constraints

- One canonical scenario: `ALTER TABLE commerce.orders RENAME COLUMN customer_id TO buyer_id`
- Policy code owns ALLOW | REVIEW | BLOCK
- No fixture presented as LIVE
- No structural or presence-only validation PASS
- No external mutation before executable validation
- No write-back success without exact read-back
- No UI claim without persisted evidence
- Do not weaken strict domain schemas
- Do not leave placeholder evidence
- Do NOT add Co-Authored-By to commits
- Push to main directly

---

### Task 1: Backward-Compatible Migration + Real Validation 8/8

**Files:**
- Modify: `packages/agent/src/steps/build-canonical-candidate.ts`
- Modify: `packages/validation/src/validator.ts` (Jinja allowlist)
- Create: `packages/validation/src/expected-execution-factory.ts`
- Modify: `apps/worker/src/orchestration.ts` (validation adapter)
- Create: `walkthrough/dbt/models/staging/sources.yml`
- Create: `docker/validation/Dockerfile`
- Create: `scripts/build-validation-images.sh`
- Modify: `walkthrough/warehouse/init/003-seed.sql` (ensure existing rows)
- Create: `packages/agent/src/steps/build-canonical-candidate.test.ts`

**Interfaces:**
- Consumes: `migrationCandidateSchema`, `bindMigrationCandidate`, `materializeCandidate`, `executeValidationInOwnedDatabase` from existing packages
- Produces: `MigrationCandidate` that passes schema + binding + validation with 8/8 PASS

- [ ] **Step 1: Fix candidate to preserve both fields in downstream models**

In `build-canonical-candidate.ts`, change the three dbt model contents:

`stg_orders.sql`:
```sql
SELECT
    order_id,
    customer_id,
    buyer_id,
    order_total,
    ordered_at
FROM {{ source('commerce', 'orders') }}
```

`customer_revenue.sql` — keep customer_id, add buyer_id:
```sql
SELECT
    customer_id,
    buyer_id,
    SUM(order_total) AS lifetime_revenue
FROM {{ ref('stg_orders') }}
GROUP BY customer_id, buyer_id
```

`customer_features.sql` — keep customer_id, add buyer_id:
```sql
SELECT
    customer_id,
    buyer_id,
    COUNT(*) AS order_count,
    MAX(order_total) AS max_order_total
FROM {{ ref('stg_orders') }}
GROUP BY customer_id, buyer_id
```

- [ ] **Step 2: Fix the sync trigger to handle old-only and new-only updates**

In `build-canonical-candidate.ts`, replace the expand SQL trigger with:
```sql
create function commerce.sync_order_customer_buyer() returns trigger language plpgsql as $$
begin
  if tg_op = 'INSERT' then
    if new.buyer_id is null and new.customer_id is not null then
      new.buyer_id := new.customer_id;
    elsif new.customer_id is null and new.buyer_id is not null then
      new.customer_id := new.buyer_id;
    elsif new.customer_id is null and new.buyer_id is null then
      raise exception 'at least one identifier must be provided';
    elsif new.customer_id is distinct from new.buyer_id then
      raise exception 'customer_id and buyer_id must match during compatibility window';
    end if;
  elsif tg_op = 'UPDATE' then
    if new.customer_id is distinct from old.customer_id and new.buyer_id is not distinct from old.buyer_id then
      new.buyer_id := new.customer_id;
    elsif new.buyer_id is distinct from old.buyer_id and new.customer_id is not distinct from old.customer_id then
      new.customer_id := new.buyer_id;
    elsif new.customer_id is distinct from old.customer_id and new.buyer_id is distinct from old.buyer_id then
      if new.customer_id is distinct from new.buyer_id then
        raise exception 'customer_id and buyer_id must match during compatibility window';
      end if;
    end if;
  end if;
  return new;
end $$;
```

- [ ] **Step 3: Add `bindMigrationCandidate` call before validation**

In the pipeline, after building the candidate, call:
```typescript
import { bindMigrationCandidate } from "@lineageguard/domain";
const bound = bindMigrationCandidate(candidate, change, context, comparison.grounded);
```

- [ ] **Step 4: Fix Jinja allowlist in validator**

In `packages/validation/src/validator.ts`, change `assertSafeDbtProject` to allow:
- `{{ source('commerce', 'orders') }}`
- `{{ ref('stg_orders') }}`

Replace the current allowlist regex.

- [ ] **Step 5: Create `sources.yml` for sealed bundle**

Create `walkthrough/dbt/models/staging/sources.yml`:
```yaml
version: 2
sources:
  - name: commerce
    schema: commerce
    tables:
      - name: orders
```

- [ ] **Step 6: Fix sealed bundle structure**

In the validation sealed-bundle builder, map:
- `walkthrough/dbt/models/...` → `project/models/...`
- `walkthrough/dbt/tests/...` → `project/tests/...`
- Include `sources.yml` in `project/models/staging/sources.yml`
- Fix dbt_project.yml `model-paths` to `['models']`
- Run dbt for `stg_orders`, `customer_revenue`, `customer_features` (not `--select orders`)

- [ ] **Step 7: Create ExpectedValidationExecution factory**

Create `packages/validation/src/expected-execution-factory.ts` that constructs the correct object using real run/lease IDs and policy-derived versions/digests.

- [ ] **Step 8: Fix orchestration validation adapter**

Replace the manual ExpectedValidationExecution construction in `apps/worker/src/orchestration.ts` with the factory. Use real `runId`, `leaseId`, `workerId`, `generation`.

- [ ] **Step 9: Create validation runner Dockerfile and build script**

Create `docker/validation/Dockerfile` with dbt-core + dbt-postgres pinned.
Create `scripts/build-validation-images.sh` that builds and prints the sha256 digest.

- [ ] **Step 10: Write tests**

Test backward-compatibility: both `customer_id` and `buyer_id` present in all downstream models. Test trigger: old-only update syncs, new-only update syncs, conflicting rejects. Test `bindMigrationCandidate` passes.

- [ ] **Step 11: Run tests and commit**

```bash
pnpm typecheck && pnpm test
git add -A && git commit -m "fix: backward-compatible migration + real validation wiring"
git push origin main
```

---

### Task 2: Analyse Actual Source PR + Bind Generated PR

**Files:**
- Modify: `apps/worker/src/source-pr-reader.ts` (return actual patches)
- Modify: `apps/worker/src/index.ts` (pass patch to pipeline)
- Modify: `packages/agent/src/steps/parse-change.ts` (source: GITHUB)
- Modify: `apps/worker/src/orchestration.ts` (GitHub adapter binding)
- Create: a real unsafe source PR in the repository

**Interfaces:**
- Consumes: `SourcePRInfo` with patches, `ProposedChange` with `source: "GITHUB"`
- Produces: Generated draft PR bound to validated base SHA and artifact bytes

- [ ] **Step 1: Extend source-pr-reader to return actual patch content**

Add `patches: Array<{ filename: string; patch: string }>` to `SourcePRInfo`.
Return the full patch text from GitHub API.

- [ ] **Step 2: Use source PR patch in worker instead of hardcoded SQL**

In `apps/worker/src/index.ts`, when `SOURCE_PR_NUMBER` is set:
- Extract the migration SQL from the PR patch
- Validate it matches the canonical rename pattern
- Reject unrelated PRs with a clear error

- [ ] **Step 3: Set source to GITHUB in live parse**

In `packages/agent/src/steps/parse-change.ts`, when the input contains real PR metadata, use `source: "GITHUB"` instead of `"FIXTURE"`.

- [ ] **Step 4: Bind generated PR to validated base**

In the GitHub adapter:
- Use the validated `change.baseSha` as the PR base (not current main HEAD)
- Verify modified file base blobs match `expectedBaseSha`
- Include validation receipt fingerprint, evidence IDs, and owner targets in PR body

- [ ] **Step 5: Create a real unsafe source PR**

Create a branch with:
```sql
ALTER TABLE commerce.orders RENAME COLUMN customer_id TO buyer_id;
```
in `walkthrough/migrations/unsafe-rename.sql`. Open a draft PR.

- [ ] **Step 6: Test and commit**

```bash
pnpm typecheck && pnpm test
git add -A && git commit -m "fix: real source PR analysis + generated PR binding"
git push origin main
```

---

### Task 3: DataHub Write-back Exact, Preserving, Idempotent

**Files:**
- Modify: `apps/worker/src/orchestration.ts` (writeback adapter)
- Modify: `.env.example` (separate read/mutation tokens documented)

**Interfaces:**
- Consumes: Validated candidate, GitHub receipt, validation receipt fingerprint
- Produces: Write-back receipt with before/after snapshots, exact content verification

- [ ] **Step 1: Separate read and mutation credentials**

Use `DATAHUB_READ_TOKEN` for all GET operations.
Use `DATAHUB_MUTATION_TOKEN` only for POST mutations.

- [ ] **Step 2: Read existing state before writing**

Before any mutation:
```typescript
const beforeTags = await gmsGet(`/aspects/${urn}?aspect=globalTags`);
const beforeMemory = await gmsGet(`/aspects/${urn}?aspect=institutionalMemory`);
```

- [ ] **Step 3: Preserve unrelated metadata**

When writing tags, merge LineageGuard tags with existing unrelated tags.
When writing institutional memory, append to existing elements rather than replacing.

- [ ] **Step 4: Include full decision context in document**

The written document must contain:
- Source and replacement field names
- Decision and evidence IDs
- Compatibility window
- Candidate fingerprint
- Validation receipt fingerprint
- Generated PR URL
- Correct rollback path (`walkthrough/migrations/001_rollback.sql`)
- Run ID

- [ ] **Step 5: Verify exact content after write**

After mutation, read back and compare exact content hash — not just marker substring presence.

- [ ] **Step 6: Implement idempotency**

If the exact same document/tag already exists on retry, return success without duplicate mutation.

- [ ] **Step 7: Test and commit**

```bash
pnpm typecheck && pnpm test
git add -A && git commit -m "fix: DataHub write-back preserving, exact, idempotent"
git push origin main
```

---

### Task 4: Evidence Persistence + 4 Impact Cards + UI + Replay

**Files:**
- Modify: `apps/worker/src/simple-store.ts` (full receipts)
- Create: `packages/agent/src/steps/derive-impact-cards.ts`
- Modify: `packages/agent/src/pipeline.ts` (use deriveImpactCards)
- Modify: `apps/web/lib/db.ts` (expose full evidence)
- Modify: `apps/web/app/runs/[runId]/page.tsx` (4 cards, 8 checks, URNs)
- Modify: `tests/e2e/mission-control.spec.ts` (self-contained)

**Interfaces:**
- Consumes: Full `ImpactContext`, `ValidationExecutionEvidence`, receipts
- Produces: Exactly 4 impact cards in UI, 8 validation checks displayed, VERIFIED_REPLAY

- [ ] **Step 1: Create `deriveImpactCards` function**

```typescript
export interface ImpactCard {
  id: string;
  title: string;
  kind: "DOWNSTREAM_MODEL" | "DASHBOARD" | "ML_MODEL" | "QUERY";
  entityUrn: string;
  owner?: string;
}

export function deriveImpactCards(context: ImpactContext): ImpactCard[] {
  // Return exactly 4 cards:
  // 1. analytics.customer_revenue (from LINEAGE_PATH or dbt evidence)
  // 2. Finance Revenue Dashboard (from DASHBOARD evidence)
  // 3. Fraud Model v3 (from ML_MODEL evidence)
  // 4. Finance query (from QUERY_USAGE evidence)
  // Do NOT count LINEAGE_PATH as independent consumers
}
```

- [ ] **Step 2: Use deriveImpactCards in pipeline**

Replace `context.evidence.filter(...)` with `deriveImpactCards(context)`.
Store `impactCards` count (always 4 for canonical) separately from total evidence items.

- [ ] **Step 3: Persist full validation evidence and receipts**

Add columns/JSON fields to `simple_runs` for:
- `validation_evidence_json` — full 8 check records
- `github_receipt_json` — full receipt
- `writeback_before_json` / `writeback_after_json`

- [ ] **Step 4: Update UI to show 4 cards, 8 checks, URNs**

In the run detail page:
- Show exactly 4 impact cards with entity URNs and owners
- Show 8 individual validation checks with status/summary
- Show generated PR binding (validation fingerprint)
- Show write-back before/after proof

- [ ] **Step 5: Add page refresh via polling**

Add a `useEffect` with `setInterval` that re-fetches run data every 3 seconds while status is non-terminal.

- [ ] **Step 6: Fix Playwright to be self-contained**

Create a test run via API or direct DB insert in `beforeAll`. Check console/network errors.

- [ ] **Step 7: Test and commit**

```bash
pnpm typecheck && pnpm test
git add -A && git commit -m "fix: 4 impact cards, 8 checks, full evidence persistence"
git push origin main
```

---

### Task 5: Clean Release Evidence

**Files:**
- Modify: `scripts/build-validation-images.sh`
- Modify: `.env.example`
- Modify: `README.md`
- Modify: `examples/canonical-run/manifest.json` (real fingerprints after live run)
- Modify: `.github/workflows/ci.yml`
- Modify: `package.json` (scripts)

**Interfaces:**
- Consumes: Successful live run output
- Produces: Complete examples bundle, CI, README with exact reproduction steps

- [ ] **Step 1: Execute the full live run**

```bash
pnpm demo
```

Capture all output, extract fingerprints.

- [ ] **Step 2: Populate examples/canonical-run with real data**

Replace all `PLACEHOLDER_AFTER_LIVE_RUN` with actual fingerprints from the successful run.
Add redacted context, comparison, generated artifacts.

- [ ] **Step 3: Update README**

- Remove "6 validations" → say "8 executable checks"
- Add exact image build/digest instructions
- Add full live demo command sequence
- Document limitations honestly

- [ ] **Step 4: Extend CI**

Add to CI workflow:
- Python tests: `uv run --project tools/datahub pytest`
- DataHub verify (if available)

- [ ] **Step 5: Final verification**

```bash
pnpm install --frozen-lockfile
pnpm format:check
pnpm lint
pnpm typecheck
pnpm test
pnpm build
pnpm demo
```

All must pass with exit 0 for demo.

- [ ] **Step 6: Commit and push**

```bash
git add -A && git commit -m "feat: complete release evidence from live run"
git push origin main
```

---

## Verification Checklist

After all tasks, the following must hold:

1. `pnpm demo` exits 0 with full COMPLETED status
2. Generated downstream models contain both `customer_id` and `buyer_id`
3. Old-only UPDATE on `commerce.orders` synchronizes `buyer_id`
4. All 8 validation checks show PASS with real exit codes
5. Source PR is a real GitHub PR with the canonical rename
6. Generated PR is bound to validated base SHA
7. DataHub write-back preserves existing metadata
8. UI shows exactly 4 impact cards
9. UI shows 8 individual validation check results
10. Examples manifest contains real fingerprints
11. Replay (if implemented) verifies source live fingerprints
