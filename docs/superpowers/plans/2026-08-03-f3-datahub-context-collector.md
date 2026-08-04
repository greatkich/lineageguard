# F3 DataHub Context Collector Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use `superpowers:subagent-driven-development` (recommended) or `superpowers:executing-plans` to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Resolve the canonical renamed field through the official DataHub MCP Server and return complete, normalized, evidence-addressable impact context without exposing mutation tools or raw MCP payloads.

**Architecture:** `packages/datahub` owns MCP transport, raw schemas, normalization, provenance, and live/replay adapters. A deterministic worker application service invokes `DataHubReadPort`; no model role receives MCP tools or raw payloads. Deterministic code selects the fixed read sequence, resolves identities, validates completeness, deduplicates evidence, and assigns IDs. `packages/domain` receives normalized contracts only.

**Tech Stack:** Node.js 24.18.0, TypeScript 6.0.3, OpenAI Agents SDK 0.14.2 MCP client, Zod 4.4.3, official `mcp-server-datahub` 0.6.0 launched with `uvx`, Vitest 4.1.10.

## Global Constraints

- Branch `feat/f3-datahub-context-collector` starts from accepted F1 and F2.
- The read process starts without `TOOLS_IS_MUTATION_ENABLED`; startup fails if a mutation tool is visible.
- Pin `mcp-server-datahub==0.6.0`; do not use the obsolete npm package.
- Raw MCP types and payloads remain under `packages/datahub`.
- Stable evidence IDs and fingerprints use canonical normalized values; they exclude transport/capture timestamps but include semantic query `lastSeenAt` needed by LG003.
- Model prose is not evidence; F3 performs no model-driven tool selection.
- ADR-002 remains unchanged: F3 adds no agent role; the SDK is used only as the MCP client/transport boundary.
- Live contract evidence comes from the F1 canonical graph; recorded fixtures must have the same normalized result.
- The F4 worker signal is mandatory at every application/port/MCP call; lease loss aborts requests and the step-owned stdio process and cannot yield persisted evidence.

---

### Task 1: Define normalized evidence and read-port contracts

**Files:**
- Create: `packages/domain/src/evidence.ts`
- Create: `packages/domain/src/impact-context.ts`
- Create: `packages/domain/test/evidence.test.ts`
- Modify: `packages/domain/src/index.ts`
- Create: `packages/datahub/src/ports.ts`
- Create: `packages/datahub/src/index.ts`

**Interfaces:**
- Consumes: `DatasetFieldRef`, `ImpactRequest`.
- Produces: `ResolvedField`, `EvidenceItem`, `LineagePath`, `ImpactContext`, and `DataHubReadPort`.

- [ ] **Step 1: Write failing strict-schema, canonicalization, and dangling-reference tests**

```ts
import { describe, expect, it } from "vitest";
import { ImpactContextSchema, stableEvidenceId } from "../src/evidence.js";

it("assigns the same ID after input reordering", () => {
  const a = { kind: "QUERY", subjectUrn: "urn:li:dataset:(urn:li:dataPlatform:postgres,finance.monthly_close,PROD)", sourceTool: "get_dataset_queries", payload: { fingerprint: "q1" } };
  expect(stableEvidenceId(a)).toBe(stableEvidenceId({ ...a, payload: { fingerprint: "q1" } }));
});

it("rejects a path that cites an absent evidence item", () => {
  expect(() => ImpactContextSchema.parse({ evidence: [], paths: [{ evidenceIds: ["ev_missing"] }] })).toThrow();
});
```

- [ ] **Step 2: Run the focused tests and observe missing modules**

Run: `pnpm --filter @lineageguard/domain vitest run test/evidence.test.ts`
Expected: FAIL resolving `../src/evidence.js`.

- [ ] **Step 3: Implement strict contracts and deterministic cross-reference validation**

```ts
export interface DataHubReadPort {
  resolveField(ref: DatasetFieldRef, options: { signal: AbortSignal }): Promise<ResolvedField>;
  collectImpact(input: ImpactRequest, options: { signal: AbortSignal }): Promise<ImpactContext>;
}

export type EvidenceItem = {
  id: EvidenceId;
  kind: EvidenceKind;
  subjectUrn: string;
  fieldPath?: string;
  source: "DATAHUB_MCP" | "RECORDED_DATAHUB_MCP";
  sourceTool: string;
  sourceFingerprint: string;
  criticality: "LOW" | "MEDIUM" | "HIGH" | "CRITICAL";
  payload: DomainEvidencePayload;
};

export interface QueryEvidencePayload {
  type: "QUERY";
  queryFingerprint: string;
  querySource: "POSTGRES_QUERY_LOG" | "SQL_QUERIES_INGESTION";
  management: "UNMANAGED" | "MANAGED";
  lastSeenAt: string;
  referencedFieldPaths: readonly string[];
}
```

Implement canonical JSON sorting for IDs, unique IDs, referential integrity, distinct judge-facing impact items versus intermediate lineage nodes, and no unknown keys. Query time parsing is strict UTC; LG003 receives the persisted assessment time and treats `0 <= assessmentTime - lastSeenAt <= 30 days` as recent, age greater than 30 days as stale, and any future `lastSeenAt` as invalid.

- [ ] **Step 4: Run tests, typecheck, and dependency-boundary checks**

Run: `pnpm --filter @lineageguard/domain test && pnpm --filter @lineageguard/domain typecheck && pnpm boundaries:check`
Expected: PASS; `packages/domain` imports no MCP or Agents SDK modules.

- [ ] **Step 5: Commit normalized contracts**

```bash
git add packages/domain packages/datahub/src/ports.ts packages/datahub/src/index.ts
git commit -m "feat(domain): define normalized DataHub evidence contracts"
```

---

### Task 2: Enforce the read-only MCP process boundary

**Files:**
- Create: `packages/datahub/src/mcp/mcp-process.ts`
- Create: `packages/datahub/src/mcp/read-tool-policy.ts`
- Create: `packages/datahub/src/mcp/raw-tool-types.ts`
- Create: `packages/datahub/test/mcp/read-tool-policy.test.ts`
- Modify: `packages/datahub/src/index.ts`

**Interfaces:**
- `createReadMcpServer(config: DataHubMcpConfig): MCPServer`
- `assertReadToolInventory(tools: readonly MCPToolSummary[]): void`
- Exact allowlist: `search`, `list_schema_fields`, `get_entities`, `get_lineage`, `get_lineage_paths_between`, `get_dataset_queries`.

- [ ] **Step 1: Write failing allowlist, startup-inventory, and cancellation tests**

Cover the exact six read tools, an unknown tool, `save_document`, `add_tags`, a missing required tool, duplicate names, absent URL/token, pre-aborted startup, and abort of a blocked stdio fixture. The latter must observe bounded process termination and no reusable response/session.

- [ ] **Step 2: Run the focused tests and confirm failure**

Run: `pnpm --filter @lineageguard/datahub vitest run test/mcp/read-tool-policy.test.ts`
Expected: FAIL because the policy and process factory do not exist.

- [ ] **Step 3: Implement the pinned stdio server and independent inventory assertion**

```ts
import { MCPServerStdio } from "@openai/agents";

const READ_TOOLS = [
  "search",
  "list_schema_fields",
  "get_entities",
  "get_lineage",
  "get_lineage_paths_between",
  "get_dataset_queries",
] as const;

export function createReadMcpServer(config: DataHubMcpConfig): MCPServerStdio {
  return new MCPServerStdio({
    name: "datahub-read",
    command: "uvx",
    args: ["--from", "mcp-server-datahub==0.6.0", "mcp-server-datahub"],
    env: {
      DATAHUB_GMS_URL: config.gmsUrl,
      DATAHUB_GMS_TOKEN: config.token,
    },
    toolFilter: { allowedToolNames: [...READ_TOOLS] },
    cacheToolsList: true,
  });
}
```

After `connect()`, call `listTools()` and fail startup unless every returned name is allowed and all required canonical tools are present. A read MCP session belongs to one claimed step, accepts that step's signal for connect/list/call operations, and closes the stdio child on abort using the shared bounded `SIGTERM`/`SIGKILL` policy. Never copy the parent environment wholesale; pass only required process variables plus a resolved safe `PATH` supplied by process bootstrap.

- [ ] **Step 4: Run tests and prove mutation names are rejected**

Run: `pnpm --filter @lineageguard/datahub test -- read-tool-policy`
Expected: PASS, including `save_document` and `add_tags` rejection.

- [ ] **Step 5: Commit the read-only process boundary**

```bash
git add packages/datahub/src/mcp packages/datahub/test/mcp
git commit -m "feat(datahub): isolate read-only MCP capabilities"
```

---

### Task 3: Normalize official MCP-shaped responses

**Files:**
- Create: `packages/datahub/src/mcp/raw-schemas.ts`
- Create: `packages/datahub/src/normalizers/entities.ts`
- Create: `packages/datahub/src/normalizers/lineage.ts`
- Create: `packages/datahub/src/normalizers/paths.ts`
- Create: `packages/datahub/src/normalizers/queries.ts`
- Create: `packages/datahub/src/normalizers/governance.ts`
- Create: `packages/datahub/src/stable-evidence-id.ts`
- Create: `packages/datahub/test/fixtures/canonical/search.json`
- Create: `packages/datahub/test/fixtures/canonical/schema-fields.json`
- Create: `packages/datahub/test/fixtures/canonical/entities.json`
- Create: `packages/datahub/test/fixtures/canonical/lineage.json`
- Create: `packages/datahub/test/fixtures/canonical/paths.json`
- Create: `packages/datahub/test/fixtures/canonical/queries.json`
- Create: `packages/datahub/test/contract/datahub-normalizers.contract.test.ts`

**Interfaces:** Each normalizer accepts `unknown`, parses a local strict/forward-compatible raw boundary schema, and returns only domain evidence. Fixture metadata records MCP server version and capture command.

- [ ] **Step 1: Capture redacted F1 responses and write failing contract assertions**

Assert exact canonical URNs/field paths, two dataset-field paths, the approval-gated proposed four judge-facing impact items, two intermediates, Finance/Risk ownership, criticality, glossary term, and unmanaged query fingerprint/source/management/last-seen fields. Assert that response scores, pagination tokens, descriptions with instructions, and unknown raw keys do not affect evidence IDs; semantic query timestamps do affect the query evidence fingerprint.

- [ ] **Step 2: Run contract tests and observe missing normalizers**

Run: `pnpm --filter @lineageguard/datahub vitest run test/contract/datahub-normalizers.contract.test.ts`
Expected: FAIL resolving normalizer modules.

- [ ] **Step 3: Implement parse-normalize-deduplicate functions**

Use one normalizer per tool family. Resolve dataset and field URNs exactly, preserve source tool and SHA-256 fingerprint, sort paths deterministically, and keep descriptions/query text as bounded untrusted payload fields. Do not export raw schemas from `packages/datahub/src/index.ts`.

- [ ] **Step 4: Run contracts twice with permuted fixture arrays**

Run: `pnpm --filter @lineageguard/datahub test -- datahub-normalizers.contract`
Expected: PASS with byte-identical normalized snapshots for both orders.

- [ ] **Step 5: Commit fixture contracts and normalizers**

```bash
git add packages/datahub/src/normalizers packages/datahub/src/stable-evidence-id.ts packages/datahub/src/mcp/raw-schemas.ts packages/datahub/test/fixtures packages/datahub/test/contract
git commit -m "feat(datahub): normalize MCP impact evidence"
```

---

### Task 4: Implement live and recorded read adapters

**Files:**
- Create: `packages/datahub/src/mcp/live-read-adapter.ts`
- Create: `packages/datahub/src/replay/recorded-read-adapter.ts`
- Create: `packages/datahub/src/context-collector.ts`
- Create: `packages/datahub/test/contract/datahub-read.contract.ts`
- Create: `packages/datahub/test/context-collector.test.ts`
- Modify: `packages/datahub/src/index.ts`

**Interfaces:** Both adapters implement the signal-aware `DataHubReadPort`. `collectCanonicalContext(port, request, options: { signal: AbortSignal })` owns exact field resolution, required query/path pagination, completeness, and stable ordering.

- [ ] **Step 1: Write one shared contract suite against an adapter factory**

The suite covers exact canonical output plus missing field, ambiguous dataset, empty required lineage, duplicate page, truncated cursor/path set, missing query evidence, managed-versus-unmanaged query, exact assessment-time equality, one-millisecond future rejection, exact 30-day/stale boundary, tool timeout, MCP error, malformed result, a pre-aborted signal, and abort between pagination calls. Recorded adapter tests run by default; live adapter plugs into the same suite under `DATAHUB_TEST_MODE=live`.

- [ ] **Step 2: Run the shared suite and observe failure**

Run: `pnpm --filter @lineageguard/datahub vitest run test/contract/datahub-read.contract.ts`
Expected: FAIL because adapter factories do not exist.

- [ ] **Step 3: Implement adapters and deterministic completeness verifier**

The live adapter calls only methods represented by the validated tool inventory and passes the exact signal to every SDK MCP call; the recorded adapter checks the same signal between bounded fixture reads and parses through the same raw schemas. `collectCanonicalContext` refuses partial/aborted success and returns typed errors with safe detail.

- [ ] **Step 4: Run recorded contracts and boundary checks**

Run: `pnpm --filter @lineageguard/datahub test && pnpm boundaries:check`
Expected: PASS; a repository search finds no raw fixture/MCP types imported outside `packages/datahub` tests.

- [ ] **Step 5: Commit read adapters**

```bash
git add packages/datahub/src packages/datahub/test
git commit -m "feat(datahub): add live and replay impact adapters"
```

---

### Task 5: Add the deterministic worker context application service

**Files:**
- Create: `apps/worker/src/context/collect-datahub-context.ts`
- Create: `apps/worker/src/context/context-errors.ts`
- Create: `apps/worker/test/context/collect-datahub-context.test.ts`

**Interfaces:** `collectDataHubContext(input, port, options: { clock: Clock; timeout: Duration; signal: AbortSignal }): Promise<ImpactContext>` resolves the field, executes the fixed collection sequence through `DataHubReadPort`, and validates completeness. It has no MCP server, model, write port, or raw payload type.

- [ ] **Step 1: Write failing application-service tests**

Cover exact call order, unique field, complete context, missing/ambiguous field, empty required lineage, truncated evidence, missing unmanaged query, timeout/abort, port error mapping, retry classification, and proof that only normalized `ImpactContext` crosses into the worker.

- [ ] **Step 2: Run focused tests and observe the missing service**

Run: `pnpm --filter @lineageguard/worker vitest run test/context/collect-datahub-context.test.ts`
Expected: FAIL resolving the context service.

- [ ] **Step 3: Implement the deterministic sequence and typed failure mapping**

```ts
export async function collectDataHubContext(
  input: ImpactRequest,
  port: DataHubReadPort,
  options: { clock: Clock; timeout: Duration; signal: AbortSignal },
): Promise<ImpactContext> {
  const field = await withTimeout(
    port.resolveField(input.field, { signal: options.signal }),
    options.timeout,
    options.signal,
  );
  const context = await withTimeout(
    port.collectImpact({ ...input, field }, { signal: options.signal }),
    options.timeout,
    options.signal,
  );
  return assertCompleteImpactContext(context, options.clock.now());
}
```

Map empty lineage, incomplete pagination, missing query, timeout, unavailable MCP, aborted claim, and malformed adapter output to distinct typed codes. Preserve retryability separately from terminal semantic failures. The F4 step passes `context.signal` unchanged; after abort it persists neither context nor retry/transition under the stale token.

- [ ] **Step 4: Run service and package-boundary tests**

Run: `pnpm --filter @lineageguard/worker test -- collect-datahub-context && pnpm boundaries:check`
Expected: PASS; no `@openai/agents`, MCP raw type, or `DataHubWritebackPort` import appears under `apps/worker/src/context`.

- [ ] **Step 5: Commit the deterministic context service**

```bash
git add apps/worker/src/context apps/worker/test/context
git commit -m "feat(worker): collect normalized DataHub context deterministically"
```

---

### Task 6: Prove live canonical parity and complete Gate A

**Files:**
- Create: `packages/datahub/test/live/canonical-context.test.ts`
- Modify: `docs/ARCHITECTURE.md`
- Modify: `docs/SOURCES.md`
- Modify: `docs/DECISIONS/ADR-003-datahub-mcp-capability-boundaries.md`

- [ ] **Step 1: Write the live parity test before connecting**

After the count approval gate is resolved, assert the checked source field, the two dataset-field paths, the accepted impact-card count, two intermediate nodes, unmanaged query evidence with last-seen time, ownership, glossary/criticality, stable evidence references, and zero visible mutation tools.

- [ ] **Step 2: Run without credentials and observe a clear skip/fail contract**

Run: `DATAHUB_TEST_MODE=live pnpm --filter @lineageguard/datahub test:integration`
Expected: FAIL fast with `DATAHUB_GMS_URL and DATAHUB_GMS_TOKEN are required`; CI without live mode remains green.

- [ ] **Step 3: Run against the F1 DataHub instance and record redacted parity evidence**

Run: `DATAHUB_TEST_MODE=live pnpm --filter @lineageguard/datahub test:integration && pnpm demo:data:verify`
Expected: PASS; normalized live output equals the recorded canonical context after documented volatile-field removal.

- [ ] **Step 4: Update ADR-003 and sources**

Record `uvx` pinning, separate read/write processes and credentials, exact tool inventories, fixture provenance, and the rule that the tool filter is defense-in-depth rather than the sole isolation mechanism.

- [ ] **Step 5: Run an independent specification review**

Give a fresh read-only reviewer the F3 specification, ADR-003, plan, and diff. Required result: no blocking mismatch in tool scope, normalization, visible count convention, or failure behavior. Resolve and rerun focused tests before proceeding.

- [ ] **Step 6: Run an independent code-quality and security review**

Use a different fresh read-only reviewer. Inspect process environment, secret/log handling, raw-payload boundaries, pagination, timeouts, fingerprints, and injection surfaces. Resolve all blocking findings.

- [ ] **Step 7: Invoke `superpowers:verification-before-completion` and run the final gate**

```bash
pnpm --filter @lineageguard/datahub test
pnpm --filter @lineageguard/worker test -- collect-datahub-context
DATAHUB_TEST_MODE=live pnpm --filter @lineageguard/datahub test:integration
pnpm demo:data:verify
pnpm format:check
pnpm lint
pnpm typecheck
```

Expected: all commands exit zero; live/recorded normalized evidence matches; inventory has no mutation tools; no secrets occur in fixtures/logs.

- [ ] **Step 8: Commit verification documents**

```bash
git add docs/ARCHITECTURE.md docs/SOURCES.md docs/DECISIONS/ADR-003-datahub-mcp-capability-boundaries.md packages/datahub/test/live
git commit -m "test(datahub): verify canonical live impact context"
```

Gate A is complete only after the checked graph is also visibly inspectable in the DataHub UI.
