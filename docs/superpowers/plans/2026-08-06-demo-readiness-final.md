# Demo Readiness Final — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the existing canonical LineageGuard scenario work end-to-end with fresh, inspectable evidence and prepare for independent review and hackathon demo recording.

**Architecture:** Fix identified gaps in the existing pipeline (shared impact-card type, source PR transport contract, UI deduplication) without adding new features or migrating to the full RunStore. All work targets a `fix/demo-readiness-final` branch in an isolated worktree.

**Tech Stack:** TypeScript (Node 24), pnpm 11, Vitest, Playwright, PostgreSQL, Docker, DataHub MCP, GitHub REST API

## Global Constraints

- Node 24+, pnpm 11.20+, TypeScript strict
- Do NOT use the full event-sourced `RunStore` — keep `SimpleRunStore`
- Do NOT fake strict effect-authority contracts (no synthetic reservations/approvals)
- Do NOT add new schema operations, libraries, or features beyond what removes a P0 risk
- Do NOT weaken safety contracts (SQL allowlist, deterministic policy, sealed validation)
- Single canonical scenario only: `customer_id -> buyer_id`
- `pnpm demo` must exit 0 only on full COMPLETED
- Evidence determines completion — no claims without execution proof

## Current State Assessment

### What works:
- `@lineageguard/db` SimpleRunStore extracted and shared
- Deterministic policy engine (ALLOW->BLOCK)
- 8 canonical validation checks defined in `@lineageguard/validation`
- DataHub MCP context port (no fixture fallback)
- GitHub PR creation (raw fetch, MVP adapter)
- DataHub writeback (read-before/write/read-after)
- Source PR reader fetches real PR metadata
- `pnpm typecheck` passes cleanly

### Identified gaps (P0 blockers):
1. No shared `ImpactConsumer` domain type — impact cards only in `@lineageguard/agent`
2. Web impact-card derivation broken — wrong field names (`downstreamUrn` vs `nodes`)
3. Source PR ingestion uses `source: "FIXTURE"` in LIVE mode
4. Dead code — `generate-patch.ts` still exported
5. E2E test only covers steps 1-4
6. `examples/canonical-run/` is a stub with placeholders
7. CI has no LIVE verification workflow
8. No `SourceChange` transport type in domain
9. Impact card kinds mismatch spec (`DOWNSTREAM_MODEL` vs `DATA_MODEL`)

---

### Task 1: Establish Current Reality (P0-1)

**Files:**
- Create: `artifacts/demo-readiness/commit-sha.txt`
- Create: `artifacts/demo-readiness/environment.txt`
- Create: `artifacts/demo-readiness/quality-gates.log`

**Interfaces:**
- Consumes: nothing (first task)
- Produces: recorded baseline state — branch, HEAD SHA, CI status, quality gate results, demo attempt result

This task is pure observation. No code changes. Record the exact state of HEAD before any modifications.

- [ ] **Step 1: Record git state**

```bash
mkdir -p artifacts/demo-readiness
git rev-parse HEAD > artifacts/demo-readiness/commit-sha.txt
echo "Branch: $(git branch --show-current)" >> artifacts/demo-readiness/environment.txt
echo "HEAD: $(git rev-parse HEAD)" >> artifacts/demo-readiness/environment.txt
git status --short >> artifacts/demo-readiness/environment.txt
git log --oneline --decorate -20 >> artifacts/demo-readiness/environment.txt
```

- [ ] **Step 2: Record environment versions**

```bash
echo "---" >> artifacts/demo-readiness/environment.txt
node --version >> artifacts/demo-readiness/environment.txt
pnpm --version >> artifacts/demo-readiness/environment.txt
python3 --version >> artifacts/demo-readiness/environment.txt
docker --version >> artifacts/demo-readiness/environment.txt
docker compose version >> artifacts/demo-readiness/environment.txt
```

- [ ] **Step 3: Check GitHub Actions CI**

```bash
gh run list --workflow CI --limit 5
```

Record output. If any recent run failed:
```bash
gh run view <run-id> --log-failed
```

- [ ] **Step 4: Run quality gates**

```bash
corepack enable
pnpm install --frozen-lockfile
pnpm format:check 2>&1 | tee -a artifacts/demo-readiness/quality-gates.log
pnpm lint 2>&1 | tee -a artifacts/demo-readiness/quality-gates.log
pnpm typecheck 2>&1 | tee -a artifacts/demo-readiness/quality-gates.log
pnpm test 2>&1 | tee -a artifacts/demo-readiness/quality-gates.log
pnpm build 2>&1 | tee -a artifacts/demo-readiness/quality-gates.log
```

Record exit codes for each. If any fail, note the root cause but do NOT fix yet.

- [ ] **Step 5: Attempt demo run**

```bash
pnpm demo 2>&1 | tee artifacts/demo-readiness/demo-live.log
echo "Exit code: $?" >> artifacts/demo-readiness/demo-live.log
```

Record: exact command, exit code, failing stage, exception/error, responsible file, whether LIVE/fixture/replay was used.

- [ ] **Step 6: Create worktree and branch**

```bash
git worktree add .claude/worktrees/demo-readiness -b fix/demo-readiness-final
cd .claude/worktrees/demo-readiness
```

All subsequent tasks execute from this worktree.

- [ ] **Step 7: Commit baseline evidence**

```bash
git add artifacts/demo-readiness/
git commit -m "chore: record baseline state before demo-readiness work"
```

---

### Task 2: Shared ImpactConsumer Domain Type (P0-4)

**Files:**
- Create: `packages/domain/src/impact-consumer.ts`
- Modify: `packages/domain/src/index.ts`
- Create: `packages/domain/src/impact-consumer.test.ts`
- Modify: `packages/agent/src/steps/derive-impact-cards.ts`
- Modify: `apps/web/app/runs/[runId]/page.tsx`

**Interfaces:**
- Consumes: `ImpactContext` from `packages/domain/src/evidence.ts`
- Produces: `ImpactConsumer` union type, `deriveImpactConsumers(context: ImpactContext): ImpactConsumer[]` function — used by both backend pipeline and web UI

The spec requires exactly four consumer kinds with specific names. Current code uses `DOWNSTREAM_MODEL`/`ML_MODEL`/`QUERY` — these must become `DATA_MODEL`/`ML_CONSUMER`/`UNMANAGED_QUERY`.

- [ ] **Step 1: Write the failing test for ImpactConsumer derivation**

Create `packages/domain/src/impact-consumer.test.ts`:

```typescript
import { describe, it, expect } from "vitest";
import { deriveImpactConsumers } from "./impact-consumer.js";
import type { ImpactContext } from "./evidence.js";

describe("deriveImpactConsumers", () => {
  const canonicalContext: ImpactContext = {
    sourceUrn: "urn:li:dataset:(urn:li:dataPlatform:postgres,commerce.orders,PROD)",
    fieldPath: "customer_id",
    collectedAt: "2026-08-06T00:00:00Z",
    evidence: [
      {
        id: "ev-lineage-1",
        kind: "LINEAGE_PATH",
        provenance: { source: "DATAHUB_MCP", responseFingerprint: "fp1" },
        payload: {
          nodes: [
            "urn:li:dataset:(urn:li:dataPlatform:postgres,commerce.orders,PROD)",
            "urn:li:dataset:(urn:li:dataPlatform:dbt,analytics.stg_orders,PROD)",
            "urn:li:dataset:(urn:li:dataPlatform:dbt,analytics.customer_revenue,PROD)",
          ],
        },
      },
      {
        id: "ev-dashboard-1",
        kind: "DASHBOARD",
        provenance: { source: "DATAHUB_MCP", responseFingerprint: "fp2" },
        payload: {
          dashboardUrn: "urn:li:dashboard:(looker,finance_revenue)",
          title: "Finance Revenue Dashboard",
          owners: ["finance-team@company.com"],
        },
      },
      {
        id: "ev-ml-1",
        kind: "ML_MODEL",
        provenance: { source: "DATAHUB_MCP", responseFingerprint: "fp3" },
        payload: {
          modelUrn: "urn:li:mlModel:(urn:li:dataPlatform:sagemaker,fraud_model_v3,PROD)",
          title: "Fraud Model v3",
          featureDataset: "urn:li:dataset:(urn:li:dataPlatform:dbt,fraud.customer_features,PROD)",
          owners: ["ml-team@company.com"],
        },
      },
      {
        id: "ev-query-1",
        kind: "QUERY_USAGE",
        provenance: { source: "DATAHUB_MCP", responseFingerprint: "fp4" },
        payload: {
          queryUrn: "urn:li:query:finance-monthly-close",
          title: "Finance monthly-close query",
          sql: "SELECT customer_id, SUM(amount) FROM commerce.orders GROUP BY 1",
        },
      },
    ],
  };

  it("produces exactly 4 consumers in canonical order", () => {
    const consumers = deriveImpactConsumers(canonicalContext);
    expect(consumers).toHaveLength(4);
    expect(consumers.map((c) => c.kind)).toEqual([
      "DATA_MODEL",
      "DASHBOARD",
      "ML_CONSUMER",
      "UNMANAGED_QUERY",
    ]);
  });

  it("excludes staging nodes from consumer list", () => {
    const consumers = deriveImpactConsumers(canonicalContext);
    const urns = consumers.map((c) => c.entityUrn);
    expect(urns).not.toContain(
      "urn:li:dataset:(urn:li:dataPlatform:dbt,analytics.stg_orders,PROD)"
    );
  });

  it("has no duplicate URNs", () => {
    const consumers = deriveImpactConsumers(canonicalContext);
    const urns = consumers.map((c) => c.entityUrn);
    expect(new Set(urns).size).toBe(urns.length);
  });

  it("all URNs are non-empty strings", () => {
    const consumers = deriveImpactConsumers(canonicalContext);
    for (const c of consumers) {
      expect(c.entityUrn).toBeTruthy();
      expect(typeof c.entityUrn).toBe("string");
    }
  });

  it("all evidence IDs are non-empty", () => {
    const consumers = deriveImpactConsumers(canonicalContext);
    for (const c of consumers) {
      expect(c.evidenceIds.length).toBeGreaterThan(0);
      for (const id of c.evidenceIds) {
        expect(id).toBeTruthy();
      }
    }
  });

  it("ML_CONSUMER groups feature dataset with model", () => {
    const consumers = deriveImpactConsumers(canonicalContext);
    const ml = consumers.find((c) => c.kind === "ML_CONSUMER");
    expect(ml).toBeDefined();
    expect(ml!.title).toContain("Fraud Model v3");
    expect(ml!.entityUrn).toContain("fraud_model_v3");
  });

  it("owners are correctly joined where available", () => {
    const consumers = deriveImpactConsumers(canonicalContext);
    const dashboard = consumers.find((c) => c.kind === "DASHBOARD");
    expect(dashboard!.owners).toContain("finance-team@company.com");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

```bash
pnpm --filter @lineageguard/domain test -- --run impact-consumer
```

Expected: FAIL — module `./impact-consumer.js` does not exist.

- [ ] **Step 3: Implement the ImpactConsumer type and derivation**

Create `packages/domain/src/impact-consumer.ts`:

```typescript
import type { ImpactContext, EvidenceItem } from "./evidence.js";

export type ImpactConsumerKind =
  | "DATA_MODEL"
  | "DASHBOARD"
  | "ML_CONSUMER"
  | "UNMANAGED_QUERY";

interface BaseConsumer {
  kind: ImpactConsumerKind;
  title: string;
  entityUrn: string;
  evidenceIds: string[];
  owners: string[];
}

export interface DataModelConsumer extends BaseConsumer {
  kind: "DATA_MODEL";
  lineagePath: string[];
}

export interface DashboardConsumer extends BaseConsumer {
  kind: "DASHBOARD";
}

export interface MlConsumer extends BaseConsumer {
  kind: "ML_CONSUMER";
  featureDatasetUrn: string;
}

export interface UnmanagedQueryConsumer extends BaseConsumer {
  kind: "UNMANAGED_QUERY";
}

export type ImpactConsumer =
  | DataModelConsumer
  | DashboardConsumer
  | MlConsumer
  | UnmanagedQueryConsumer;

/**
 * Derives exactly the canonical impact consumer groups from DataHub evidence.
 * Single source of truth — used by both backend pipeline and web UI.
 *
 * Canonical order: DATA_MODEL, DASHBOARD, ML_CONSUMER, UNMANAGED_QUERY
 */
export function deriveImpactConsumers(context: ImpactContext): ImpactConsumer[] {
  const consumers: ImpactConsumer[] = [];
  const seenUrns = new Set<string>();

  // First: collect LINEAGE_PATH terminal dataset nodes as DATA_MODEL
  for (const item of context.evidence) {
    if (item.kind !== "LINEAGE_PATH") continue;
    const nodes: string[] = item.payload.nodes ?? [];
    // Skip first node (source dataset itself)
    for (let i = 1; i < nodes.length; i++) {
      const urn = nodes[i];
      if (!urn.includes("urn:li:dataset:")) continue;
      if (seenUrns.has(urn)) continue;
      // Skip staging/intermediate views
      if (isIntermediateNode(urn)) continue;
      // Skip source dataset
      if (urn === context.sourceUrn) continue;
      seenUrns.add(urn);
      consumers.push({
        kind: "DATA_MODEL",
        title: extractDatasetName(urn),
        entityUrn: urn,
        evidenceIds: [item.id],
        owners: item.payload.owners ?? [],
        lineagePath: nodes,
      });
    }
  }

  // Second: DASHBOARD
  for (const item of context.evidence) {
    if (item.kind !== "DASHBOARD") continue;
    const urn = item.payload.dashboardUrn;
    if (!urn || seenUrns.has(urn)) continue;
    seenUrns.add(urn);
    consumers.push({
      kind: "DASHBOARD",
      title: item.payload.title ?? extractName(urn),
      entityUrn: urn,
      evidenceIds: [item.id],
      owners: item.payload.owners ?? [],
    });
  }

  // Third: ML_MODEL -> ML_CONSUMER (grouped with feature dataset)
  for (const item of context.evidence) {
    if (item.kind !== "ML_MODEL") continue;
    const urn = item.payload.modelUrn;
    if (!urn || seenUrns.has(urn)) continue;
    seenUrns.add(urn);
    // Also mark feature dataset as seen to avoid double-counting
    if (item.payload.featureDataset) {
      seenUrns.add(item.payload.featureDataset);
    }
    consumers.push({
      kind: "ML_CONSUMER",
      title: item.payload.title ?? extractName(urn),
      entityUrn: urn,
      evidenceIds: [item.id],
      owners: item.payload.owners ?? [],
      featureDatasetUrn: item.payload.featureDataset ?? "",
    });
  }

  // Fourth: QUERY_USAGE -> UNMANAGED_QUERY
  for (const item of context.evidence) {
    if (item.kind !== "QUERY_USAGE") continue;
    const urn = item.payload.queryUrn;
    if (!urn || seenUrns.has(urn)) continue;
    seenUrns.add(urn);
    consumers.push({
      kind: "UNMANAGED_QUERY",
      title: item.payload.title ?? "Observed query",
      entityUrn: urn,
      evidenceIds: [item.id],
      owners: item.payload.owners ?? [],
    });
  }

  return consumers;
}

function isIntermediateNode(urn: string): boolean {
  // Staging views are intermediate, not user-facing consumers
  return urn.includes("stg_orders") || urn.includes(".stg_");
}

function extractDatasetName(urn: string): string {
  // "urn:li:dataset:(urn:li:dataPlatform:dbt,analytics.customer_revenue,PROD)"
  const match = urn.match(/,([^,]+),\w+\)$/);
  return match ? match[1] : urn;
}

function extractName(urn: string): string {
  const match = urn.match(/[,:]([^,:]+)[,)]*$/);
  return match ? match[1] : urn;
}
```

- [ ] **Step 4: Export from domain package**

Add to `packages/domain/src/index.ts`:

```typescript
export type {
  ImpactConsumer,
  ImpactConsumerKind,
  DataModelConsumer,
  DashboardConsumer,
  MlConsumer,
  UnmanagedQueryConsumer,
} from "./impact-consumer.js";
export { deriveImpactConsumers } from "./impact-consumer.js";
```

- [ ] **Step 5: Run test to verify it passes**

```bash
pnpm --filter @lineageguard/domain test -- --run impact-consumer
```

Expected: all 7 tests PASS.

- [ ] **Step 6: Update `derive-impact-cards.ts` to delegate to domain**

Replace the body of `packages/agent/src/steps/derive-impact-cards.ts` to import and re-export from domain:

```typescript
import { deriveImpactConsumers } from "@lineageguard/domain";
import type { ImpactConsumer } from "@lineageguard/domain";
import type { ImpactContext } from "@lineageguard/domain";

// Re-export for backward compatibility
export type ImpactCard = ImpactConsumer;

export function deriveImpactCards(context: ImpactContext): ImpactConsumer[] {
  return deriveImpactConsumers(context);
}
```

- [ ] **Step 7: Fix web page to use shared derivation**

Replace the inline impact-card derivation in `apps/web/app/runs/[runId]/page.tsx` (lines 66-91) with:

```typescript
import { deriveImpactConsumers } from "@lineageguard/domain";

// In the component:
const impactConsumers = run.contextJson
  ? deriveImpactConsumers(run.contextJson as ImpactContext)
  : [];
```

Remove all inline dedup/card-building code.

- [ ] **Step 8: Run full test suite**

```bash
pnpm typecheck
pnpm test
```

Expected: all pass.

- [ ] **Step 9: Commit**

```bash
git add packages/domain/src/impact-consumer.ts packages/domain/src/impact-consumer.test.ts packages/domain/src/index.ts packages/agent/src/steps/derive-impact-cards.ts apps/web/app/runs/\[runId\]/page.tsx
git commit -m "feat(domain): add shared ImpactConsumer type with canonical derivation

- DATA_MODEL, DASHBOARD, ML_CONSUMER, UNMANAGED_QUERY
- Single derivation function used by backend and web
- Removes broken inline derivation from web page
- Staging nodes excluded from consumer list"
```

---

### Task 3: SourceChange Transport Type (P0-2)

**Files:**
- Create: `packages/domain/src/source-change.ts`
- Create: `packages/domain/src/source-change.test.ts`
- Modify: `packages/domain/src/index.ts`
- Modify: `apps/worker/src/source-pr-reader.ts`
- Modify: `apps/worker/src/index.ts` (the runWorker entry point)
- Modify: `packages/domain/src/change.ts` (accept SourceChange as input)

**Interfaces:**
- Consumes: `readSourcePR()` from `apps/worker/src/source-pr-reader.ts`
- Produces: `SourceChange` type, updated `parseProposedChange` that accepts `SourceChange` input directly in LIVE mode

The spec requires a typed transport-level object separating GitHub reading from domain parsing. Currently `readSourcePR` returns `SourcePRInfo` and the worker hardcodes canonical SQL with `source: "FIXTURE"`. This must change so LIVE mode feeds the real PR diff through the parser with `source: "GITHUB"`.

- [ ] **Step 1: Write the failing test for SourceChange validation**

Create `packages/domain/src/source-change.test.ts`:

```typescript
import { describe, it, expect } from "vitest";
import { validateSourceChange, type SourceChange } from "./source-change.js";

describe("validateSourceChange", () => {
  const validChange: SourceChange = {
    source: "GITHUB",
    repository: "org/lineageguard-walkthrough",
    pullRequestNumber: 42,
    pullRequestUrl: "https://github.com/org/lineageguard-walkthrough/pull/42",
    baseSha: "abc123def456abc123def456abc123def456abc1",
    headSha: "def456abc123def456abc123def456abc123def4",
    filePath: "migrations/001_rename_customer_id.sql",
    unifiedDiff: [
      "--- a/migrations/001_rename_customer_id.sql",
      "+++ b/migrations/001_rename_customer_id.sql",
      "@@ -0,0 +1,2 @@",
      "+ALTER TABLE commerce.orders",
      "+RENAME COLUMN customer_id TO buyer_id;",
    ].join("\n"),
    diffFingerprint: "sha256:abcdef1234567890abcdef1234567890abcdef1234567890abcdef1234567890",
  };

  it("accepts a valid SourceChange", () => {
    const result = validateSourceChange(validChange);
    expect(result.success).toBe(true);
  });

  it("rejects missing source field", () => {
    const bad = { ...validChange, source: undefined };
    const result = validateSourceChange(bad as any);
    expect(result.success).toBe(false);
  });

  it("rejects non-GITHUB source", () => {
    const bad = { ...validChange, source: "FIXTURE" };
    const result = validateSourceChange(bad as any);
    expect(result.success).toBe(false);
  });

  it("rejects empty unifiedDiff", () => {
    const bad = { ...validChange, unifiedDiff: "" };
    const result = validateSourceChange(bad as any);
    expect(result.success).toBe(false);
  });

  it("rejects missing diffFingerprint", () => {
    const bad = { ...validChange, diffFingerprint: "" };
    const result = validateSourceChange(bad as any);
    expect(result.success).toBe(false);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

```bash
pnpm --filter @lineageguard/domain test -- --run source-change
```

Expected: FAIL — module does not exist.

- [ ] **Step 3: Implement SourceChange type**

Create `packages/domain/src/source-change.ts`:

```typescript
import { z } from "zod";

export const sourceChangeSchema = z.object({
  source: z.literal("GITHUB"),
  repository: z.string().min(1),
  pullRequestNumber: z.number().int().positive(),
  pullRequestUrl: z.string().url(),
  baseSha: z.string().regex(/^[0-9a-f]{40}$/),
  headSha: z.string().regex(/^[0-9a-f]{40}$/),
  filePath: z.string().min(1),
  unifiedDiff: z.string().min(1),
  diffFingerprint: z.string().min(1),
});

export type SourceChange = z.infer<typeof sourceChangeSchema>;

export function validateSourceChange(
  input: unknown
): { success: true; data: SourceChange } | { success: false; error: string } {
  const result = sourceChangeSchema.safeParse(input);
  if (result.success) {
    return { success: true, data: result.data };
  }
  return { success: false, error: result.error.message };
}
```

- [ ] **Step 4: Export from domain index**

Add to `packages/domain/src/index.ts`:

```typescript
export type { SourceChange } from "./source-change.js";
export { sourceChangeSchema, validateSourceChange } from "./source-change.js";
```

- [ ] **Step 5: Run test to verify it passes**

```bash
pnpm --filter @lineageguard/domain test -- --run source-change
```

Expected: all 5 tests PASS.

- [ ] **Step 6: Update source-pr-reader to return SourceChange**

Modify `apps/worker/src/source-pr-reader.ts` to return a `SourceChange` when exactly one supported SQL file is found:

```typescript
import type { SourceChange } from "@lineageguard/domain";
import { createHash } from "node:crypto";

export interface SourcePRInfo {
  prNumber: number;
  prUrl: string;
  repository: string;
  baseSha: string;
  headSha: string;
  changedFiles: string[];
  patches: Array<{ filename: string; patch: string }>;
  diffFingerprint: string;
}

/**
 * Reads the source PR from GitHub and returns the raw PR info.
 * Caller is responsible for selecting the relevant file and building SourceChange.
 */
export async function readSourcePR(opts: {
  owner: string;
  repo: string;
  token: string;
  prNumber: number;
}): Promise<SourcePRInfo> {
  // ... existing fetch logic unchanged ...
}

/**
 * Converts raw PR info into a typed SourceChange for the canonical scenario.
 * Finds the single SQL migration file containing the supported change.
 */
export function buildSourceChange(info: SourcePRInfo): SourceChange | null {
  // Find the SQL file with canonical rename
  const sqlPatches = info.patches.filter(
    (p) => p.filename.endsWith(".sql") && p.patch.includes("customer_id")
  );
  if (sqlPatches.length !== 1) return null;

  const patch = sqlPatches[0];
  const fingerprint = createHash("sha256")
    .update(patch.patch)
    .digest("hex");

  return {
    source: "GITHUB",
    repository: `${info.repository}`,
    pullRequestNumber: info.prNumber,
    pullRequestUrl: info.prUrl,
    baseSha: info.baseSha,
    headSha: info.headSha,
    filePath: patch.filename,
    unifiedDiff: patch.patch,
    diffFingerprint: `sha256:${fingerprint}`,
  };
}
```

- [ ] **Step 7: Update worker index to use source=GITHUB in LIVE mode**

In `apps/worker/src/index.ts`, replace the hardcoded canonical SQL injection with:

```typescript
import { buildSourceChange } from "./source-pr-reader.js";

// After readSourcePR:
const sourceChange = buildSourceChange(prInfo);
if (!sourceChange) {
  throw new Error(
    `Source PR #${prNumber} does not contain exactly one canonical schema change`
  );
}

// Pass to pipeline with source: "GITHUB" and the actual diff
const pipelineInput = {
  source: sourceChange.source,
  repository: sourceChange.repository,
  filePath: sourceChange.filePath,
  sql: sourceChange.unifiedDiff, // parser handles unified diff format
  baseSha: sourceChange.baseSha,
  headSha: sourceChange.headSha,
  diffFingerprint: sourceChange.diffFingerprint,
  prUrl: sourceChange.pullRequestUrl,
  prNumber: sourceChange.pullRequestNumber,
};
```

Ensure the domain parser's `classifyGitDiff` path is invoked (already handles `source: "GITHUB"`).

- [ ] **Step 8: Add negative tests for source PR rejection**

Add to `packages/domain/src/change.test.ts`:

```typescript
describe("parseProposedChange with SourceChange input", () => {
  it("rejects README-only PR (no SQL files)", () => {
    // SourceChange with non-SQL content
    const result = parseProposedChange({
      source: "GITHUB",
      // diff of a README file - no ALTER TABLE
      diff: "--- a/README.md\n+++ b/README.md\n@@ -1 +1 @@\n-old\n+new",
      baseSha: "a".repeat(40),
      headSha: "b".repeat(40),
    });
    expect(result.error?.code).toBe("NO_SUPPORTED_CHANGE");
  });
});
```

(Existing tests in `change.test.ts` already cover most negative cases; verify they still pass.)

- [ ] **Step 9: Run full verification**

```bash
pnpm typecheck
pnpm test
```

Expected: all pass.

- [ ] **Step 10: Commit**

```bash
git add packages/domain/src/source-change.ts packages/domain/src/source-change.test.ts packages/domain/src/index.ts apps/worker/src/source-pr-reader.ts apps/worker/src/index.ts
git commit -m "feat(domain): add SourceChange transport type, use source=GITHUB in LIVE

- Typed SourceChange schema (zod-validated)
- source-pr-reader now builds SourceChange from real PR diff
- Worker LIVE mode feeds actual diff to parser (not hardcoded SQL)
- classifyGitDiff path handles unified diffs from GitHub"
```

---

### Task 4: Remove Dead Code and Fix Exports (Cleanup)

**Files:**
- Delete: `packages/agent/src/steps/generate-patch.ts`
- Modify: `packages/agent/src/steps/index.ts` (remove generate-patch export)

**Interfaces:**
- Consumes: nothing from generate-patch (it's unused by pipeline.ts)
- Produces: cleaner export surface, no `as any` cast code in the tree

The LLM-driven `generatePatch` step (with loose schema and `as any` cast) is no longer called by `pipeline.ts` — it was replaced by `buildCanonicalCandidate`. Leaving it in the tree risks accidental re-wiring and fails the code quality review criteria ("unnecessary `as any` on safety boundaries").

- [ ] **Step 1: Verify generate-patch is truly unused**

```bash
cd packages/agent
grep -r "generate-patch\|generatePatch" src/ --include="*.ts" | grep -v "generate-patch.ts" | grep -v "index.ts"
```

Expected: zero matches (only the file itself and the barrel export reference it).

- [ ] **Step 2: Remove the file**

```bash
rm packages/agent/src/steps/generate-patch.ts
```

- [ ] **Step 3: Remove from barrel export**

In `packages/agent/src/steps/index.ts`, remove the line:

```typescript
export { generatePatch } from "./generate-patch.js";
```

- [ ] **Step 4: Run typecheck and tests**

```bash
pnpm typecheck
pnpm test
```

Expected: all pass (nothing depends on this export).

- [ ] **Step 5: Commit**

```bash
git add -A
git commit -m "chore(agent): remove dead generate-patch.ts (unused LLM path with as-any)"
```

---

### Task 5: Persist SourceChange Data in SimpleRunStore (P0-10)

**Files:**
- Modify: `packages/db/src/simple-runs.ts` (add `source_pr_number`, `source_base_sha`, `source_head_sha`, `source_diff_fingerprint`, `source_file_path` columns)
- Modify: `packages/db/src/simple-runs.test.ts` (if exists, add coverage)
- Modify: `apps/worker/src/orchestration.ts` (persist source fields on run creation)

**Interfaces:**
- Consumes: `SourceChange` from Task 3, `SimpleRunStore.createRun` / `SimpleRunStore.updateRun`
- Produces: persisted source PR metadata fields readable by Mission Control

The spec requires persisting: PR number, PR URL, repository, base SHA, head SHA, diff fingerprint, file path. Currently `simple_runs` has `source_pr_url` and `repository` but lacks the SHA/fingerprint/number fields.

- [ ] **Step 1: Write failing integration test**

Add to the existing SimpleRunStore test file (or create one):

```typescript
it("persists source change metadata", async () => {
  const run = await store.createRun({
    id: "test-source-fields",
    status: "RUNNING",
    repository: "org/walkthrough",
    field: "customer_id",
    patch: "RENAME COLUMN customer_id TO buyer_id",
    executionMode: "LIVE",
    sourcePrUrl: "https://github.com/org/walkthrough/pull/42",
    sourcePrNumber: 42,
    sourceBaseSha: "a".repeat(40),
    sourceHeadSha: "b".repeat(40),
    sourceDiffFingerprint: "sha256:abc123",
    sourceFilePath: "migrations/001.sql",
  });

  const fetched = await store.getRun("test-source-fields");
  expect(fetched?.sourcePrNumber).toBe(42);
  expect(fetched?.sourceBaseSha).toBe("a".repeat(40));
  expect(fetched?.sourceHeadSha).toBe("b".repeat(40));
  expect(fetched?.sourceDiffFingerprint).toBe("sha256:abc123");
  expect(fetched?.sourceFilePath).toBe("migrations/001.sql");
});
```

- [ ] **Step 2: Run test to verify it fails**

```bash
pnpm --filter @lineageguard/db test -- --run source
```

Expected: FAIL — columns/fields don't exist yet.

- [ ] **Step 3: Add columns to SimpleRunStore schema**

In `packages/db/src/simple-runs.ts`, update the `ensureSchema()` CREATE TABLE to include:

```sql
source_pr_number INTEGER,
source_base_sha TEXT,
source_head_sha TEXT,
source_diff_fingerprint TEXT,
source_file_path TEXT,
```

Update the `CreateSimpleRunInput` type, row mapper, and INSERT/SELECT queries to include these fields.

- [ ] **Step 4: Run test to verify it passes**

```bash
pnpm --filter @lineageguard/db test -- --run source
```

Expected: PASS.

- [ ] **Step 5: Wire into worker orchestration**

In `apps/worker/src/orchestration.ts` (or wherever the run is created), pass the source change fields:

```typescript
await store.createRun({
  id: runId,
  status: "RUNNING",
  repository: sourceChange.repository,
  field: "customer_id",
  patch: sourceChange.unifiedDiff,
  executionMode: "LIVE",
  sourcePrUrl: sourceChange.pullRequestUrl,
  sourcePrNumber: sourceChange.pullRequestNumber,
  sourceBaseSha: sourceChange.baseSha,
  sourceHeadSha: sourceChange.headSha,
  sourceDiffFingerprint: sourceChange.diffFingerprint,
  sourceFilePath: sourceChange.filePath,
});
```

- [ ] **Step 6: Run full verification**

```bash
pnpm typecheck
pnpm test
```

- [ ] **Step 7: Commit**

```bash
git add packages/db/src/simple-runs.ts apps/worker/src/orchestration.ts
git commit -m "feat(db): persist source PR metadata (sha, fingerprint, number, path)

Adds source_pr_number, source_base_sha, source_head_sha,
source_diff_fingerprint, source_file_path to simple_runs table."
```

---

### Task 6: Mission Control UI — Use Shared ImpactConsumer (P0-11)

**Files:**
- Modify: `apps/web/app/runs/[runId]/page.tsx`
- Modify: `apps/web/package.json` (add `@lineageguard/domain` dependency if not present)

**Interfaces:**
- Consumes: `deriveImpactConsumers` and `ImpactConsumer` from `@lineageguard/domain` (Task 2)
- Produces: UI rendering impact cards from the same derivation as backend; no duplicated logic

This task ensures the web UI displays exactly the same 4 consumer groups the pipeline computed, using the shared domain function rather than reimplementing inline.

- [ ] **Step 1: Check if `@lineageguard/domain` is already a dependency of web**

```bash
grep "lineageguard/domain" apps/web/package.json
```

If not found, add it:
```bash
cd apps/web && pnpm add @lineageguard/domain --workspace
```

- [ ] **Step 2: Replace inline derivation in run detail page**

In `apps/web/app/runs/[runId]/page.tsx`, find the section (approx lines 66-91) that builds `impactConsumers` inline. Replace with:

```typescript
import { deriveImpactConsumers, type ImpactConsumer } from "@lineageguard/domain";

// Inside the component, replace the inline derivation block:
const impactConsumers: ImpactConsumer[] = run.contextJson
  ? deriveImpactConsumers(JSON.parse(run.contextJson))
  : [];
```

Remove all the inline `if (item.kind === "DASHBOARD")` / `if (item.kind === "ML_MODEL")` logic that was previously duplicated here.

- [ ] **Step 3: Update the rendering to use ImpactConsumer fields**

The card rendering section should reference `consumer.kind`, `consumer.title`, `consumer.entityUrn`, `consumer.owners`, `consumer.evidenceIds` — matching the shared type's field names exactly.

Map kind to display labels:
```typescript
const kindLabels: Record<ImpactConsumer["kind"], string> = {
  DATA_MODEL: "Data Model",
  DASHBOARD: "Dashboard",
  ML_CONSUMER: "ML Consumer",
  UNMANAGED_QUERY: "Unmanaged Query",
};
```

- [ ] **Step 4: Verify Playwright tests still pass**

```bash
pnpm --filter @lineageguard/web build
pnpm test:e2e
```

If Playwright tests reference specific card text or structure, update assertions to match new kind labels.

- [ ] **Step 5: Run full verification**

```bash
pnpm typecheck
pnpm test
pnpm build
```

- [ ] **Step 6: Commit**

```bash
git add apps/web/
git commit -m "fix(web): use shared deriveImpactConsumers from domain

Removes broken inline derivation that used wrong field names
(downstreamUrn/targetUrn instead of nodes). Now both backend
and UI produce identical impact consumer lists."
```

---

### Task 7: E2E Pipeline Test to COMPLETED (P0-1 verification)

**Files:**
- Modify: `tests/e2e/canonical-scenario.vitest.ts`
- Create: `tests/e2e/pipeline-completed.vitest.ts`

**Interfaces:**
- Consumes: `executePipeline` from `@lineageguard/agent`, mock ports for validation/github/writeback
- Produces: test proving the full pipeline reaches COMPLETED with all 8 validation checks, PR creation, and writeback — or correctly reaches FAILED_* states

The current E2E test only verifies steps 1-4 (parse through risk decision). It doesn't configure validation/github/writeback ports, so it can never reach COMPLETED. A real E2E test must prove the full path.

- [ ] **Step 1: Write the full-pipeline E2E test**

Create `tests/e2e/pipeline-completed.vitest.ts`:

```typescript
import { describe, it, expect } from "vitest";
import { executePipeline } from "@lineageguard/agent";
import type { ImpactContext } from "@lineageguard/domain";

describe("Full pipeline to COMPLETED", () => {
  const mockEvidence: ImpactContext = {
    sourceUrn: "urn:li:dataset:(urn:li:dataPlatform:postgres,commerce.orders,PROD)",
    fieldPath: "customer_id",
    collectedAt: new Date().toISOString(),
    evidence: [
      {
        id: "ev-lineage-1",
        kind: "LINEAGE_PATH",
        provenance: { source: "DATAHUB_MCP", responseFingerprint: "fp1" },
        payload: {
          nodes: [
            "urn:li:dataset:(urn:li:dataPlatform:postgres,commerce.orders,PROD)",
            "urn:li:dataset:(urn:li:dataPlatform:dbt,analytics.stg_orders,PROD)",
            "urn:li:dataset:(urn:li:dataPlatform:dbt,analytics.customer_revenue,PROD)",
          ],
        },
      },
      {
        id: "ev-dashboard-1",
        kind: "DASHBOARD",
        provenance: { source: "DATAHUB_MCP", responseFingerprint: "fp2" },
        payload: {
          dashboardUrn: "urn:li:dashboard:(looker,finance_revenue)",
          title: "Finance Revenue Dashboard",
          owners: ["finance-team@company.com"],
        },
      },
      {
        id: "ev-ml-1",
        kind: "ML_MODEL",
        provenance: { source: "DATAHUB_MCP", responseFingerprint: "fp3" },
        payload: {
          modelUrn: "urn:li:mlModel:(urn:li:dataPlatform:sagemaker,fraud_model_v3,PROD)",
          title: "Fraud Model v3",
          featureDataset: "urn:li:dataset:(urn:li:dataPlatform:dbt,fraud.customer_features,PROD)",
          owners: ["ml-team@company.com"],
        },
      },
      {
        id: "ev-query-1",
        kind: "QUERY_USAGE",
        provenance: { source: "DATAHUB_MCP", responseFingerprint: "fp4" },
        payload: {
          queryUrn: "urn:li:query:finance-monthly-close",
          title: "Finance monthly-close query",
          sql: "SELECT customer_id, SUM(amount) FROM commerce.orders GROUP BY 1",
        },
      },
    ],
  };

  it("reaches COMPLETED with mocked external ports", async () => {
    const result = await executePipeline({
      input: {
        source: "GITHUB",
        repository: "org/walkthrough",
        filePath: "migrations/001.sql",
        diff: "--- a/migrations/001.sql\n+++ b/migrations/001.sql\n@@ -0,0 +1,2 @@\n+ALTER TABLE commerce.orders\n+RENAME COLUMN customer_id TO buyer_id;",
        baseSha: "a".repeat(40),
        headSha: "b".repeat(40),
        diffFingerprint: "sha256:test",
        prUrl: "https://github.com/org/walkthrough/pull/42",
        prNumber: 42,
      },
      ports: {
        datahub: {
          collect: async () => mockEvidence,
        },
        validation: {
          validate: async (candidate) => ({
            passed: true,
            checks: [
              { check: "SQL_MIGRATION", status: "PASS", exitCode: 0 },
              { check: "BACKFILL_EQUALITY", status: "PASS", exitCode: 0 },
              { check: "DBT_PARSE", status: "PASS", exitCode: 0 },
              { check: "DBT_COMPILE", status: "PASS", exitCode: 0 },
              { check: "DBT_TEST", status: "PASS", exitCode: 0 },
              { check: "OLD_CONSUMER_COMPATIBILITY", status: "PASS", exitCode: 0 },
              { check: "NEW_CONSUMER_COMPATIBILITY", status: "PASS", exitCode: 0 },
              { check: "ROLLBACK", status: "PASS", exitCode: 0 },
            ],
            receiptFingerprint: "sha256:val-receipt",
            imageIdentity: "sha256:image-id",
          }),
        },
        github: {
          createPR: async (artifacts) => ({
            prUrl: "https://github.com/org/walkthrough/pull/99",
            prNumber: 99,
            headSha: "c".repeat(40),
            receiptFingerprint: "sha256:gh-receipt",
          }),
        },
        writeback: {
          write: async (context) => ({
            status: "VERIFIED",
            receiptFingerprint: "sha256:wb-receipt",
          }),
        },
        llm: {
          plan: async () => ({ rationale: "Test migration plan" }),
        },
        onStatusChange: async () => {},
      },
    });

    expect(result.finalStatus).toBe("COMPLETED");
    expect(result.baselineDecision).toBe("ALLOW");
    expect(result.groundedDecision).toBe("BLOCK");
    expect(result.consumersFound).toBe(4);
    expect(result.validationPassed).toBe(true);
    expect(result.generatedPrUrl).toBe("https://github.com/org/walkthrough/pull/99");
    expect(result.writebackStatus).toBe("VERIFIED");
  });

  it("returns FAILED_CONTEXT when DataHub port throws", async () => {
    const result = await executePipeline({
      input: { /* same canonical input */ },
      ports: {
        datahub: {
          collect: async () => { throw new Error("DataHub unavailable"); },
        },
        onStatusChange: async () => {},
      },
    });

    expect(result.finalStatus).toBe("FAILED_CONTEXT");
  });

  it("returns FAILED_VALIDATION when checks fail", async () => {
    const result = await executePipeline({
      input: { /* same canonical input */ },
      ports: {
        datahub: { collect: async () => mockEvidence },
        validation: {
          validate: async () => ({
            passed: false,
            checks: [
              { check: "SQL_MIGRATION", status: "FAIL", exitCode: 1 },
            ],
            receiptFingerprint: "sha256:failed",
            imageIdentity: "sha256:image-id",
          }),
        },
        llm: { plan: async () => ({ rationale: "Test" }) },
        onStatusChange: async () => {},
      },
    });

    expect(result.finalStatus).toBe("FAILED_VALIDATION");
  });
});
```

NOTE: The exact port interface shapes above are illustrative. Adapt to match the actual `executePipeline` config type in `packages/agent/src/pipeline.ts`. Read the file first and match its real type signatures.

- [ ] **Step 2: Run the test**

```bash
pnpm test -- --run pipeline-completed
```

Expected: may need adjustments to match real pipeline API, but the structure is correct.

- [ ] **Step 3: Fix any type mismatches and re-run**

Match the test's port mocks to the real `PipelineConfig` / `PipelinePorts` types.

- [ ] **Step 4: Commit**

```bash
git add tests/e2e/pipeline-completed.vitest.ts
git commit -m "test(e2e): add full-pipeline-to-COMPLETED test with mock ports

Verifies COMPLETED, FAILED_CONTEXT, FAILED_VALIDATION states.
Replaces partial E2E that only tested steps 1-4."
```

---

### Task 8: Negative Validation Tests (P0-7, P0-20)

**Files:**
- Create: `packages/validation/src/negative-scenarios.test.ts`

**Interfaces:**
- Consumes: `materializeCandidate`, `executeValidationInOwnedDatabase` from `@lineageguard/validation`, `buildCanonicalCandidate` from `@lineageguard/agent`
- Produces: test coverage proving validation correctly rejects broken artifacts at the right boundary

The spec requires 13+ negative validation scenarios. These must fail at the correct check, not silently pass.

- [ ] **Step 1: Write negative validation tests**

Create `packages/validation/src/negative-scenarios.test.ts`:

```typescript
import { describe, it, expect } from "vitest";
import { assertCanonicalGeneratedSql } from "./validator.js";

describe("Validation negative scenarios", () => {
  describe("SQL allowlist", () => {
    it("rejects DROP TABLE", () => {
      expect(() =>
        assertCanonicalGeneratedSql("DROP TABLE commerce.orders;")
      ).toThrow();
    });

    it("rejects TRUNCATE", () => {
      expect(() =>
        assertCanonicalGeneratedSql("TRUNCATE commerce.orders;")
      ).toThrow();
    });

    it("rejects arbitrary ALTER (non-canonical)", () => {
      expect(() =>
        assertCanonicalGeneratedSql(
          "ALTER TABLE commerce.orders DROP COLUMN customer_id;"
        )
      ).toThrow();
    });

    it("accepts canonical expand migration SQL", () => {
      // This should NOT throw — it's the allowed canonical SQL
      expect(() =>
        assertCanonicalGeneratedSql(getCanonicalExpandSql())
      ).not.toThrow();
    });

    it("accepts canonical rollback SQL", () => {
      expect(() =>
        assertCanonicalGeneratedSql(getCanonicalRollbackSql())
      ).not.toThrow();
    });
  });

  describe("Bundle integrity", () => {
    it("rejects modified materialized bytes", () => {
      // A bundle where the recorded SHA-256 doesn't match the actual content
      const bundle = createTestBundle();
      bundle.files[0].sha256 = "sha256:wrong_hash";
      expect(() => validateBundleIntegrity(bundle)).toThrow(/integrity/i);
    });

    it("rejects missing required files (sources.yml)", () => {
      const bundle = createTestBundle();
      bundle.files = bundle.files.filter(
        (f) => !f.path.includes("sources.yml")
      );
      expect(() => validateBundleCompleteness(bundle)).toThrow(/sources/i);
    });
  });

  describe("Image identity", () => {
    it("rejects missing Docker image", () => {
      // When the configured image doesn't exist locally
      // This test may need to be conditional on Docker availability
    });

    it("rejects wrong image identity/digest", () => {
      // When the resolved image digest doesn't match expected
    });
  });

  describe("Base SHA binding", () => {
    it("rejects candidate bound to wrong baseSha", () => {
      // MigrationCandidate.binding.baseSha doesn't match source
    });
  });
});

// Helper functions — adapt to real validator exports
function getCanonicalExpandSql(): string {
  // Read from buildCanonicalCandidate output or hardcoded constant
  return ""; // Fill from actual validator.ts EXPAND_MIGRATION constant
}

function getCanonicalRollbackSql(): string {
  return ""; // Fill from actual validator.ts ROLLBACK constant
}
```

NOTE: Adapt these to the real exported functions. The key contract is: each scenario must fail at the correct validation boundary, not silently pass.

- [ ] **Step 2: Run tests**

```bash
pnpm --filter @lineageguard/validation test -- --run negative
```

- [ ] **Step 3: Fix any implementation gaps exposed by the tests**

If `assertCanonicalGeneratedSql` doesn't reject some dangerous SQL that should be blocked, fix the allowlist in `validator.ts`.

- [ ] **Step 4: Commit**

```bash
git add packages/validation/src/negative-scenarios.test.ts
git commit -m "test(validation): add negative scenario coverage

SQL allowlist, bundle integrity, image identity, base SHA binding.
Each scenario fails at the correct validation boundary."
```

---

### Task 9: GitHub PR Negative Tests and Idempotency (P0-8)

**Files:**
- Create: `apps/worker/src/orchestration.test.ts` (or extend existing)
- Modify: `apps/worker/src/orchestration.ts` (fix any idempotency gaps found)

**Interfaces:**
- Consumes: `createGitHubPort` from `apps/worker/src/orchestration.ts`
- Produces: test coverage for stale base, artifact mismatch, duplicate PR prevention

- [ ] **Step 1: Write negative tests for GitHub PR creation**

```typescript
import { describe, it, expect, vi } from "vitest";

describe("GitHub PR port", () => {
  it("fails FAILED_GITHUB when remote base diverges from validated base", async () => {
    // Mock fetch to return a different base SHA than what was validated
    // Expect the port to throw/return FAILED_GITHUB rather than creating PR
  });

  it("does not create duplicate PR on retry", async () => {
    // First call: creates PR successfully
    // Second call with same parameters: finds existing PR, returns it
    // Verify only 1 POST to /pulls was made
  });

  it("fails FAILED_GITHUB when artifact bytes differ from validated", async () => {
    // Candidate fingerprint doesn't match what validation recorded
    // Port should refuse to create PR
  });
});
```

- [ ] **Step 2: Run tests and verify behavior**

```bash
pnpm --filter @lineageguard/worker test -- --run orchestration
```

- [ ] **Step 3: Fix idempotency if test reveals gaps**

The current implementation catches PR-creation failure and searches for existing PR. Verify this works when the PR already exists BEFORE the first attempt (not just on retry failure).

- [ ] **Step 4: Commit**

```bash
git add apps/worker/src/orchestration.test.ts apps/worker/src/orchestration.ts
git commit -m "test(worker): GitHub PR negative tests — stale base, duplicates, mismatch"
```

---

### Task 10: DataHub Writeback Negative Tests (P0-9)

**Files:**
- Create: `apps/worker/src/writeback.test.ts`
- Modify: `apps/worker/src/orchestration.ts` (fix any gaps found)

**Interfaces:**
- Consumes: `createWritebackPort` from `apps/worker/src/orchestration.ts`
- Produces: test coverage for read failure, read-after-write mismatch, duplicate prevention, metadata preservation

- [ ] **Step 1: Write negative tests for DataHub writeback**

```typescript
import { describe, it, expect, vi } from "vitest";

describe("DataHub writeback port", () => {
  it("fails when read-before returns error", async () => {
    // Mock fetch to return 500 on initial globalTags read
    // Expect FAILED_WRITEBACK, not empty-context fallback
  });

  it("fails when read-after-write shows mismatch", async () => {
    // Mock: write succeeds, but read-after shows the tag is missing
    // Expect FAILED_WRITEBACK
  });

  it("preserves unrelated tags on write", async () => {
    // Mock: existing entity has tags ["team:finance", "priority:high"]
    // After writeback, verify those tags still present alongside LineageGuard tags
  });

  it("does not create duplicate document on retry", async () => {
    // Mock: idempotency marker already exists in institutionalMemory
    // Expect the port to skip writing (or return success without mutation)
  });

  it("requires separate read token (not mutation token)", async () => {
    // If DATAHUB_READ_TOKEN is missing, port should fail at configuration
    // Not silently use DATAHUB_MUTATION_TOKEN for reads
  });
});
```

- [ ] **Step 2: Run tests**

```bash
pnpm --filter @lineageguard/worker test -- --run writeback
```

- [ ] **Step 3: Verify credential separation**

Check that `createWritebackPort` in `orchestration.ts` uses `DATAHUB_READ_TOKEN` for reads and `DATAHUB_MUTATION_TOKEN` for writes. If it falls back to a single token, add the separation:

```typescript
const readToken = process.env.DATAHUB_READ_TOKEN;
const mutationToken = process.env.DATAHUB_MUTATION_TOKEN;
if (!readToken) throw new Error("DATAHUB_READ_TOKEN required for writeback");
if (!mutationToken) throw new Error("DATAHUB_MUTATION_TOKEN required for writeback");
```

- [ ] **Step 4: Commit**

```bash
git add apps/worker/src/writeback.test.ts apps/worker/src/orchestration.ts
git commit -m "test(worker): DataHub writeback negative tests

Read failure, read-after-write mismatch, metadata preservation,
idempotency, credential separation."
```

---

### Task 11: CI — Add LIVE Integration Verification Workflow (P0-19)

**Files:**
- Create: `.github/workflows/live-verification.yml`
- Modify: `.github/workflows/ci.yml` (ensure no `continue-on-error` on quality gates)

**Interfaces:**
- Consumes: `pnpm demo`, `pnpm test:e2e`, secrets (GITHUB_TOKEN, DATAHUB_READ_TOKEN, DATAHUB_MUTATION_TOKEN, LLM API key, Docker)
- Produces: a manual/release workflow that runs the full LIVE verification on demand

The spec separates deterministic CI (always runs) from LIVE integration (manual, requires secrets). The existing CI only runs lint/typecheck/test/build. We need a separate workflow for the full demo run.

- [ ] **Step 1: Verify existing CI has no `continue-on-error`**

```bash
grep -n "continue-on-error" .github/workflows/ci.yml
```

If found on quality gate steps, remove it.

- [ ] **Step 2: Create LIVE verification workflow**

Create `.github/workflows/live-verification.yml`:

```yaml
name: LIVE Integration Verification

on:
  workflow_dispatch:
    inputs:
      commit_sha:
        description: "Exact commit SHA to verify (default: HEAD)"
        required: false

jobs:
  live-verification:
    runs-on: ubuntu-latest
    timeout-minutes: 30
    environment: live-demo
    steps:
      - uses: actions/checkout@v4
        with:
          ref: ${{ github.event.inputs.commit_sha || github.sha }}

      - uses: pnpm/action-setup@v4

      - uses: actions/setup-node@v4
        with:
          node-version: "24"
          cache: "pnpm"

      - run: pnpm install --frozen-lockfile

      - name: Quality gates
        run: |
          pnpm format:check
          pnpm lint
          pnpm typecheck
          pnpm test
          pnpm build

      - name: LIVE demo run
        env:
          GITHUB_TOKEN: ${{ secrets.LINEAGEGUARD_GITHUB_TOKEN }}
          DATAHUB_READ_TOKEN: ${{ secrets.DATAHUB_READ_TOKEN }}
          DATAHUB_MUTATION_TOKEN: ${{ secrets.DATAHUB_MUTATION_TOKEN }}
          ANTHROPIC_API_KEY: ${{ secrets.ANTHROPIC_API_KEY }}
          SOURCE_PR_NUMBER: ${{ secrets.SOURCE_PR_NUMBER }}
          DATAHUB_URL: ${{ secrets.DATAHUB_URL }}
        run: pnpm demo

      - name: Upload evidence
        if: always()
        uses: actions/upload-artifact@v4
        with:
          name: live-verification-evidence
          path: artifacts/demo-readiness/
```

- [ ] **Step 3: Run CI lint on the workflow file**

```bash
# Validate YAML syntax
python3 -c "import yaml; yaml.safe_load(open('.github/workflows/live-verification.yml'))"
```

- [ ] **Step 4: Commit**

```bash
git add .github/workflows/live-verification.yml .github/workflows/ci.yml
git commit -m "ci: add LIVE integration verification workflow (manual dispatch)

Separates deterministic CI from LIVE demo verification.
LIVE workflow requires secrets for GitHub/DataHub/LLM/Docker."
```

---

### Task 12: Examples Bundle and Replay Manifest (P0-12, P0-13)

**Files:**
- Modify: `examples/canonical-run/manifest.json`
- Create: `scripts/export-evidence.ts`

**Interfaces:**
- Consumes: successful LIVE run result from `pnpm demo`, `SimpleRunStore.getRun()`
- Produces: populated `examples/canonical-run/` with real fingerprints; `artifacts/demo-readiness/replay-manifest.json`

This task creates a script that exports evidence from a successful LIVE run into the examples bundle and replay manifest. The script only runs AFTER a successful `pnpm demo` — it reads from the database and writes redacted versions to disk.

- [ ] **Step 1: Create the evidence export script**

Create `scripts/export-evidence.ts`:

```typescript
import { createSimpleRunStore } from "@lineageguard/db";
import pg from "pg";
import { writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";

async function main() {
  const runId = process.argv[2];
  if (!runId) {
    console.error("Usage: tsx scripts/export-evidence.ts <run-id>");
    process.exit(1);
  }

  const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL });
  const store = createSimpleRunStore(pool);
  const run = await store.getRun(runId);

  if (!run) {
    console.error(`Run ${runId} not found`);
    process.exit(1);
  }

  if (run.status !== "COMPLETED") {
    console.error(`Run ${runId} status is ${run.status}, not COMPLETED`);
    process.exit(1);
  }

  const examplesDir = join(process.cwd(), "examples/canonical-run");
  const artifactsDir = join(process.cwd(), "artifacts/demo-readiness");
  mkdirSync(examplesDir, { recursive: true });
  mkdirSync(artifactsDir, { recursive: true });

  // Export manifest
  const manifest = {
    runId: run.id,
    status: run.status,
    executionMode: run.executionMode,
    repository: run.repository,
    sourcePrUrl: run.sourcePrUrl,
    sourceBaseSha: run.sourceBaseSha,
    sourceHeadSha: run.sourceHeadSha,
    sourceDiffFingerprint: run.sourceDiffFingerprint,
    baselineDecision: run.baselineDecision,
    groundedDecision: run.groundedDecision,
    consumersFound: run.consumersFound,
    validationReceiptFingerprint: run.validationReceiptFingerprint,
    githubReceiptFingerprint: run.githubReceiptFingerprint,
    writebackReceiptFingerprint: run.writebackReceiptFingerprint,
    prUrl: run.prUrl,
    createdAt: run.createdAt,
  };

  writeFileSync(
    join(examplesDir, "manifest.json"),
    JSON.stringify(manifest, null, 2)
  );

  // Export context (redact tokens)
  if (run.contextJson) {
    writeFileSync(
      join(examplesDir, "impact-context.json"),
      JSON.stringify(JSON.parse(run.contextJson), null, 2)
    );
    writeFileSync(
      join(artifactsDir, "datahub-impact-context.json"),
      JSON.stringify(JSON.parse(run.contextJson), null, 2)
    );
  }

  // Export comparison
  if (run.comparisonJson) {
    writeFileSync(
      join(examplesDir, "risk-comparison.json"),
      JSON.stringify(JSON.parse(run.comparisonJson), null, 2)
    );
    writeFileSync(
      join(artifactsDir, "risk-comparison.json"),
      JSON.stringify(JSON.parse(run.comparisonJson), null, 2)
    );
  }

  // Export candidate
  if (run.candidateJson) {
    writeFileSync(
      join(examplesDir, "migration-candidate.json"),
      JSON.stringify(JSON.parse(run.candidateJson), null, 2)
    );
    writeFileSync(
      join(artifactsDir, "migration-candidate.json"),
      JSON.stringify(JSON.parse(run.candidateJson), null, 2)
    );
  }

  // Export replay manifest
  const replayManifest = {
    sourceRunId: run.id,
    sourceCommitSha: run.sourceHeadSha,
    sourceChangeFingerprint: run.sourceDiffFingerprint,
    impactContextFingerprint: computeFingerprint(run.contextJson),
    riskComparisonFingerprint: computeFingerprint(run.comparisonJson),
    candidateFingerprint: computeFingerprint(run.candidateJson),
    validationReceiptFingerprint: run.validationReceiptFingerprint,
    githubReceiptFingerprint: run.githubReceiptFingerprint,
    writebackReceiptFingerprint: run.writebackReceiptFingerprint,
    exportedAt: new Date().toISOString(),
  };

  writeFileSync(
    join(artifactsDir, "replay-manifest.json"),
    JSON.stringify(replayManifest, null, 2)
  );

  console.log("Evidence exported successfully for run:", runId);
  await pool.end();
}

function computeFingerprint(json: string | null): string {
  if (!json) return "";
  const { createHash } = await import("node:crypto");
  return `sha256:${createHash("sha256").update(json).digest("hex")}`;
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
```

- [ ] **Step 2: Add npm script**

In root `package.json`, add:
```json
"export-evidence": "node --import tsx scripts/export-evidence.ts"
```

- [ ] **Step 3: Remove PLACEHOLDER values from examples manifest**

Update `examples/canonical-run/manifest.json` to document it's auto-generated:

```json
{
  "_comment": "Auto-generated by: pnpm export-evidence <run-id>. Do not hand-edit.",
  "runId": null,
  "status": null
}
```

- [ ] **Step 4: Commit**

```bash
git add scripts/export-evidence.ts examples/canonical-run/manifest.json package.json
git commit -m "feat: add evidence export script for examples/replay bundle

Run after successful pnpm demo to populate examples/canonical-run/
and artifacts/demo-readiness/ from the database."
```

---

### Task 13: LIVE Demo Run and Evidence Capture (P0-1, P0-6 through P0-13)

**Files:**
- Modify: `artifacts/demo-readiness/*` (populated by run)
- Modify: `examples/canonical-run/*` (populated by export script)

**Interfaces:**
- Consumes: all previous tasks complete, working `pnpm demo`, `pnpm export-evidence`
- Produces: one successful LIVE run with exit code 0, populated evidence bundle, populated examples

This is the integration gate. All prior tasks must pass before attempting this. If `pnpm demo` fails, diagnose with systematic-debugging — do NOT patch symptoms.

- [ ] **Step 1: Pre-flight environment check**

```bash
pnpm check:environment
```

Verify all required env vars are set:
- `SOURCE_PR_NUMBER` — the canonical PR number
- `GITHUB_TOKEN` — for PR reading and creation
- `DATAHUB_URL` — DataHub GMS endpoint
- `DATAHUB_READ_TOKEN` — for context collection
- `DATAHUB_MUTATION_TOKEN` — for writeback
- `ANTHROPIC_API_KEY` — for LLM migration planning
- `DATABASE_URL` — PostgreSQL connection
- Docker running with validation image available

- [ ] **Step 2: Run quality gates**

```bash
pnpm format:check
pnpm lint
pnpm typecheck
pnpm test
pnpm build
```

All must pass. If any fail, fix before proceeding.

- [ ] **Step 3: Execute LIVE demo**

```bash
pnpm demo 2>&1 | tee artifacts/demo-readiness/demo-live.log
echo "EXIT_CODE=$?" >> artifacts/demo-readiness/demo-live.log
```

Expected: exit code 0, `finalStatus: COMPLETED`.

If it fails:
1. Record exact error, stage, file, function
2. Use systematic-debugging to isolate root cause
3. Fix the root cause (not the symptom)
4. Re-run from Step 2

- [ ] **Step 4: Record the run ID**

From the demo output, extract the run ID:
```bash
grep "runId" artifacts/demo-readiness/demo-live.log
```

- [ ] **Step 5: Export evidence**

```bash
pnpm export-evidence <run-id>
```

Verify populated files:
```bash
ls -la examples/canonical-run/
ls -la artifacts/demo-readiness/
```

All fingerprints in manifest.json must be non-null, non-placeholder strings.

- [ ] **Step 6: Verify idempotency — run demo again**

```bash
pnpm demo 2>&1 | tee artifacts/demo-readiness/demo-retry.log
```

Verify:
- No duplicate GitHub PR created (same PR URL returned)
- No duplicate DataHub document (idempotency marker detected)
- Exit code 0

- [ ] **Step 7: Record final evidence**

```bash
git rev-parse HEAD > artifacts/demo-readiness/commit-sha.txt
```

- [ ] **Step 8: Commit evidence**

```bash
git add artifacts/demo-readiness/ examples/canonical-run/
git commit -m "evidence: LIVE demo run — COMPLETED with full evidence chain

Run ID: <run-id>
Source PR: <pr-url>
Generated PR: <pr-url>
Baseline: ALLOW
Grounded: BLOCK
Consumers: 4
Validation: 8/8 PASS
Writeback: VERIFIED"
```

---

### Task 14: Playwright E2E and Screenshots (P0-11)

**Files:**
- Modify: `tests/e2e/mission-control.spec.ts`
- Create: `artifacts/demo-readiness/screenshots/`

**Interfaces:**
- Consumes: successful LIVE run persisted in database, running web app
- Produces: Playwright passing at 1440x900, screenshots of all required states

- [ ] **Step 1: Verify Playwright config uses 1440x900 viewport**

Check `playwright.config.ts` for viewport settings. If not set:

```typescript
use: {
  viewport: { width: 1440, height: 900 },
}
```

- [ ] **Step 2: Run existing Playwright tests**

```bash
pnpm test:e2e
```

If they fail, diagnose. The tests in `mission-control.spec.ts` assert real data from Postgres — they should pass if a LIVE run exists in the DB.

- [ ] **Step 3: Add screenshot capture to Playwright**

In `tests/e2e/mission-control.spec.ts`, add screenshot steps:

```typescript
test("captures demo screenshots at 1440x900", async ({ page }) => {
  // Dashboard view
  await page.goto("/");
  await page.waitForSelector("[data-testid='run-list']");
  await page.screenshot({
    path: "artifacts/demo-readiness/screenshots/01-dashboard.png",
  });

  // Click into the COMPLETED run
  await page.click("[data-testid='run-row']:first-child");
  await page.waitForSelector("[data-testid='run-detail']");

  // Source PR / baseline ALLOW
  await page.screenshot({
    path: "artifacts/demo-readiness/screenshots/02-source-pr-allow.png",
  });

  // Impact consumers (BLOCK + 4 cards)
  await page.screenshot({
    path: "artifacts/demo-readiness/screenshots/03-block-consumers.png",
  });

  // Validation results
  await page.screenshot({
    path: "artifacts/demo-readiness/screenshots/04-validation-results.png",
  });

  // Generated PR
  await page.screenshot({
    path: "artifacts/demo-readiness/screenshots/05-generated-pr.png",
  });

  // DataHub writeback
  await page.screenshot({
    path: "artifacts/demo-readiness/screenshots/06-datahub-writeback.png",
  });
});
```

Adapt selectors to match actual DOM structure in `apps/web`.

- [ ] **Step 4: Run Playwright with screenshots**

```bash
pnpm test:e2e
```

- [ ] **Step 5: Verify screenshots show real data**

Visually inspect screenshots. They must show:
- Real run ID (not placeholder)
- Real PR URL
- Real consumer names (analytics.customer_revenue, Finance Revenue Dashboard, etc.)
- Real validation check results (8 checks)
- Real DataHub receipt

- [ ] **Step 6: Commit**

```bash
git add tests/e2e/ artifacts/demo-readiness/screenshots/
git commit -m "test(e2e): Playwright screenshots at 1440x900 with real LIVE data"
```

---

### Task 15: Final Verification and Review Preparation

**Files:**
- Create: `artifacts/demo-readiness/run-summary.json`
- Modify: `artifacts/demo-readiness/quality-gates.log` (refreshed)

**Interfaces:**
- Consumes: all prior tasks complete, LIVE evidence captured
- Produces: final verification run from clean state, review-ready branch

This is the final gate before requesting code review. Run everything from scratch in the worktree.

- [ ] **Step 1: Clean state verification**

```bash
git status --short
git branch --show-current
git log --oneline --decorate -20
git diff --check
```

No untracked files except `artifacts/` and `examples/`. Branch is `fix/demo-readiness-final`.

- [ ] **Step 2: Full quality gate re-run**

```bash
pnpm install --frozen-lockfile
pnpm format:check 2>&1 | tee artifacts/demo-readiness/quality-gates.log
pnpm lint 2>&1 | tee -a artifacts/demo-readiness/quality-gates.log
pnpm typecheck 2>&1 | tee -a artifacts/demo-readiness/quality-gates.log
pnpm test 2>&1 | tee -a artifacts/demo-readiness/quality-gates.log
pnpm build 2>&1 | tee -a artifacts/demo-readiness/quality-gates.log
```

All must exit 0.

- [ ] **Step 3: Database integration tests**

```bash
pnpm --filter @lineageguard/db test:integration 2>&1 | tee -a artifacts/demo-readiness/quality-gates.log
```

- [ ] **Step 4: Validation package tests**

```bash
pnpm --filter @lineageguard/validation test 2>&1 | tee -a artifacts/demo-readiness/quality-gates.log
```

- [ ] **Step 5: Python/DataHub tests (if applicable)**

```bash
# Discover the real test commands first
ls tools/datahub/pyproject.toml && uv sync --project tools/datahub --all-groups && uv run --project tools/datahub pytest
```

- [ ] **Step 6: Create run summary**

Create `artifacts/demo-readiness/run-summary.json` with the acceptance gate checklist:

```json
{
  "commitSha": "<HEAD>",
  "branch": "fix/demo-readiness-final",
  "runId": "<from demo>",
  "gates": {
    "sourcePrRead": true,
    "sourcePrPersisted": true,
    "baselineAllow": true,
    "liveDataHubContext": true,
    "fourConsumerGroups": true,
    "deterministicBlock": true,
    "migrationGenerated": true,
    "eightChecksPass": true,
    "githubPrCreated": true,
    "writebackVerified": true,
    "completedStatus": true,
    "demoExitZero": true,
    "idempotentRetry": true,
    "ciGreen": true,
    "playwrightPasses": true,
    "noPlaceholders": true
  },
  "artifacts": {
    "sourceChange": "examples/canonical-run/manifest.json",
    "impactContext": "examples/canonical-run/impact-context.json",
    "riskComparison": "examples/canonical-run/risk-comparison.json",
    "migrationCandidate": "examples/canonical-run/migration-candidate.json",
    "validationReceipt": "artifacts/demo-readiness/validation-receipt.json",
    "githubReceipt": "artifacts/demo-readiness/github-pr-receipt.json",
    "replayManifest": "artifacts/demo-readiness/replay-manifest.json",
    "screenshots": "artifacts/demo-readiness/screenshots/"
  }
}
```

- [ ] **Step 7: Final commit**

```bash
git add artifacts/demo-readiness/
git commit -m "evidence: final verification pass — all gates green"
```

- [ ] **Step 8: Push branch for review**

```bash
git push -u origin fix/demo-readiness-final
```

- [ ] **Step 9: Create PR for review**

```bash
gh pr create \
  --title "fix: demo readiness final — end-to-end LIVE evidence" \
  --body "## Summary

Addresses all P0 blockers for hackathon demo readiness.

## Changes
- Shared ImpactConsumer domain type (DATA_MODEL, DASHBOARD, ML_CONSUMER, UNMANAGED_QUERY)
- SourceChange transport type with source=GITHUB in LIVE mode
- Web UI uses shared derivation (removes broken inline logic)
- Negative validation/GitHub/writeback test coverage
- LIVE integration verification CI workflow
- Evidence export script
- Dead code removal (generate-patch.ts)
- Source PR metadata persistence (SHA, fingerprint, number)

## Evidence
- LIVE demo run: COMPLETED (exit 0)
- 8/8 validation checks PASS
- Idempotent retry verified
- Playwright screenshots at 1440x900
- All quality gates green

## Review checklist
- [ ] Spec compliance review (Section 24.1)
- [ ] Code quality review (Section 24.2)
- [ ] Fresh verification run (Section 24.3)" \
  --base main
```

---


## Task Dependency Order

```
Task 1 (Establish Reality)
  → Task 2 (Shared ImpactConsumer Type)
  → Task 3 (SourceChange Transport Type)
  → Task 4 (Remove Dead Code)
  → Task 5 (Persist Source Fields)
  → Task 6 (Web UI Shared Derivation)   [depends on Task 2]
  → Task 7 (E2E Pipeline Test)          [depends on Tasks 2, 3]
  → Task 8 (Negative Validation Tests)
  → Task 9 (GitHub PR Negative Tests)
  → Task 10 (DataHub Writeback Negative Tests)
  → Task 11 (CI LIVE Workflow)
  → Task 12 (Evidence Export Script)
  → Task 13 (LIVE Demo Run)             [depends on ALL above]
  → Task 14 (Playwright Screenshots)    [depends on Task 13]
  → Task 15 (Final Verification)        [depends on Task 14]
```

Tasks 2-5 can execute in parallel (independent code areas).
Tasks 8-11 can execute in parallel (independent test files).
Tasks 13-15 are strictly sequential.

## Risk Mitigation

| Risk | Mitigation |
|------|-----------|
| `classifyGitDiff` rejects real GitHub unified diff format | Task 3 Step 8 tests the real diff format; if it fails, adapt the parser's hunk regex without weakening the safety contract |
| DataHub MCP unavailable during LIVE run | Pre-flight check in Task 13 Step 1; if unavailable, the run correctly produces FAILED_CONTEXT |
| Docker validation image missing | `pnpm check:environment` (worker's preflight) should detect this; if not, add the check |
| LLM rate limits during migration planning | The `plan` step is the only LLM-dependent stage; if rate-limited, retry with backoff (already handled in agent package) |
| Source PR doesn't exist or was closed | `readSourcePR` will get a 404/422; ensure error surfaces as descriptive failure, not silent |

## Out of Scope (per spec Section 25)

- Full event-sourced RunStore migration
- Strict effect-authority adoption
- Multiple SQL dialects or schema operations
- Authentication, multi-tenancy, AWS deployment
- New UI design system or navigation
- Additional agents, Slack, workflow editor
