# F8 Controlled DataHub Write-Back Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use `superpowers:subagent-driven-development` (recommended) or `superpowers:executing-plans` to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** After matching policy, validation, and GitHub receipts plus explicit production approval, write one searchable migration decision document and one verified tag marker to DataHub through an isolated mutation-enabled MCP process.

**Architecture:** `DataHubWritebackPort` is separate from `DataHubReadPort`, dependency construction, process configuration, credential, and tool inventory. A pure `WritebackPolicy` fails closed before side effects. The live adapter may call only official `save_document` and `add_tags`; intent-first receipts make retries reconcilable. Worker state pauses at `WRITEBACK_PENDING` until an authorized approval exists.

**Tech Stack:** Node.js 24.18.0, TypeScript 6.0.3, OpenAI Agents SDK 0.14.2 MCP stdio client, official `mcp-server-datahub` 0.6.0 via `uvx`, Zod 4.4.3, PostgreSQL 17.10, Vitest 4.1.10.

## Global Constraints

- Branch `feat/f8-datahub-writeback` starts from accepted F7 and Gate C.
- Use a separate `DATAHUB_WRITE_TOKEN`; never reuse or expose `DATAHUB_READ_TOKEN` through the write process.
- Write process sets `TOOLS_IS_MUTATION_ENABLED=true`; adapter-visible allowlist is exactly `save_document` and `add_tags`.
- Lost-response reconciliation uses a separate mutation-disabled verifier with the read credential and exact allowlist `search_documents`, `get_entities`; it has no context-collection or write method.
- Read collector construction cannot accept/import `DataHubWritebackPort` and must still prove zero mutation tools.
- Production mode requires an unexpired approval tied to run, fingerprint, effect, approver, and policy version.
- Write only the seeded `LineageGuard Migration Decisions` document hierarchy and `urn:li:tag:LineageGuardValidated` on the canonical source dataset.
- Partial success never marks a run complete; retry reconciles both document and tag.
- Production `WRITEBACK_PENDING` is a non-runnable wait, not a short retry loop: approval absence/expiry/effective revocation consumes no retry attempt. Only failures after an approval is atomically consumed into an external-effect intent use the 1/5/30-second retry budget.
- The active F4 signal is mandatory for mutation and verifier calls/processes; abort/lease loss cannot persist a stale external receipt, retry, or transition.

---

### Task 1: Define write-back, approval, and policy contracts

**Files:**
- Create: `packages/datahub/src/writeback/writeback-port.ts`
- Create: `packages/datahub/src/writeback/writeback-policy.ts`
- Create: `packages/datahub/src/writeback/schemas.ts`
- Create: `packages/datahub/src/writeback/errors.ts`
- Create: `packages/datahub/test/writeback/policy.test.ts`
- Modify: `packages/datahub/src/index.ts`

**Interfaces:**

```ts
interface DataHubWritebackPort {
  writeMigrationDecision(input: WritebackRequest, options: { signal: AbortSignal }): Promise<WritebackReceipt>;
  findMigrationDecision(idempotencyKey: string, options: { signal: AbortSignal }): Promise<WritebackReceipt | null>;
}

interface WritebackPolicy {
  evaluate(input: WritebackPolicyInput): WritebackPolicyDecision;
}

type WritebackPolicyDecision =
  | { allowed: true; policyVersion: string }
  | { allowed: false; code: WritebackDenialCode; reasons: readonly string[] };
```

- [ ] **Step 1: Write failing policy matrix tests**

Cover replay versus production, F4 grounded `BLOCK` retained, F6 exact `PASS`, F7 exact receipt, matching hashes/fingerprints, approval present/absent/expired/revoked/consumed/wrong run/wrong effect/wrong fingerprint, unsupported target/tool, duplicate effect, and production caller lacking authorization. Test denial before adapter invocation. A consumed approval remains authorization for reconciliation of its exact already-started effect even if its wall-clock expiry later passes; it cannot authorize a different intent.

- [ ] **Step 2: Run and observe missing policy**

Run: `pnpm --filter @lineageguard/datahub vitest run test/writeback/policy.test.ts`
Expected: FAIL resolving writeback modules.

- [ ] **Step 3: Implement a pure fail-closed policy**

Policy version is an explicit constant recorded in the decision and receipt. Approval validity uses an injected clock and a 30-minute maximum window. Authorization accepts only server-side operator identities mapped from configured IDs; no client-supplied role/identity is trusted.

- [ ] **Step 4: Run the policy matrix and typecheck**

Run: `pnpm --filter @lineageguard/datahub test -- writeback-policy && pnpm --filter @lineageguard/datahub typecheck`
Expected: PASS and denied cases report no adapter calls.

- [ ] **Step 5: Commit policy and contracts**

```bash
git add packages/datahub/src/writeback packages/datahub/test/writeback/policy.test.ts packages/datahub/src/index.ts
git commit -m "feat(datahub): define fail-closed writeback policy"
```

---

### Task 2: Build a separately credentialed mutation MCP process

**Files:**
- Create: `packages/datahub/src/writeback/write-mcp-process.ts`
- Create: `packages/datahub/src/writeback/write-tool-policy.ts`
- Create: `packages/datahub/src/writeback/writeback-verifier-port.ts`
- Create: `packages/datahub/src/writeback/writeback-verification-process.ts`
- Create: `packages/datahub/test/writeback/tool-isolation.test.ts`
- Modify: `packages/datahub/src/mcp/read-tool-policy.ts`
- Modify: `packages/datahub/test/mcp/read-tool-policy.test.ts`

**Interfaces:**
- `createWriteMcpServer(config: DataHubWriteMcpConfig): MCPServer`.
- `assertWriteToolInventory(tools): void` accepts exactly `save_document` and `add_tags` after filtering.
- `createWritebackVerificationMcpServer(config: DataHubReadMcpConfig): MCPServer` exposes exactly `search_documents` and `get_entities` with mutations disabled.
- `DataHubWritebackVerifierPort` methods accept `{ signal: AbortSignal }`; write and verifier sessions are owned by the claimed step and close their stdio children on abort.

- [ ] **Step 1: Write failing structural-isolation tests**

Assert distinct read/write config types and token variable names, write env enables mutations, both read environments omit the mutation flag, context read rejects both write tools, write list rejects every other mutation/read tool, verifier accepts exactly `search_documents` and `get_entities`, adapter constructors require separate write and verifier wrappers, missing document parent/tool fails startup, and pre-abort/blocked-call abort terminates each step-owned stdio process.

- [ ] **Step 2: Run and observe missing process/policy**

Run: `pnpm --filter @lineageguard/datahub vitest run test/writeback/tool-isolation.test.ts`
Expected: FAIL resolving the write process.

- [ ] **Step 3: Implement the pinned process with exact tool filter**

```ts
return new MCPServerStdio({
  name: "datahub-writeback",
  command: "uvx",
  args: ["--from", "mcp-server-datahub==0.6.0", "mcp-server-datahub"],
  env: {
    DATAHUB_GMS_URL: config.gmsUrl,
    DATAHUB_GMS_TOKEN: config.writeToken,
    TOOLS_IS_MUTATION_ENABLED: "true",
    SAVE_DOCUMENT_TOOL_ENABLED: "true",
    SAVE_DOCUMENT_PARENT_TITLE: "LineageGuard Migration Decisions",
    SAVE_DOCUMENT_ORGANIZE_BY_USER: "false",
    SAVE_DOCUMENT_RESTRICT_UPDATES: "true",
  },
  toolFilter: { allowedToolNames: ["save_document", "add_tags"] },
});
```

Supply only required environment variables plus resolved safe `PATH`; do not copy process environment or expose either write-back server to any agent. Define `DataHubWritebackVerifierPort` with only `findDecisionDocument(documentKey, { signal })` and `getTags(targetUrn, { signal })` so reconciliation cannot invoke context collection. Thread the exact signal through connect/list/call operations; abort closes the child with the shared bounded `SIGTERM`/`SIGKILL` policy and discards late results.

- [ ] **Step 4: Run both read and write isolation tests**

Run: `pnpm --filter @lineageguard/datahub test -- read-tool-policy tool-isolation`
Expected: PASS; a mutation tool cannot appear in the read adapter dependency graph.

- [ ] **Step 5: Commit process isolation**

```bash
git add packages/datahub/src/writeback/write-mcp-process.ts packages/datahub/src/writeback/write-tool-policy.ts packages/datahub/src/writeback/writeback-verifier-port.ts packages/datahub/src/writeback/writeback-verification-process.ts packages/datahub/src/mcp/read-tool-policy.ts packages/datahub/test/writeback/tool-isolation.test.ts packages/datahub/test/mcp/read-tool-policy.test.ts
git commit -m "feat(datahub): isolate mutation MCP process and credential"
```

---

### Task 3: Render the deterministic decision document and marker

**Files:**
- Create: `packages/datahub/src/writeback/decision-document.ts`
- Create: `packages/datahub/src/writeback/marker.ts`
- Create: `packages/datahub/test/writeback/decision-document.test.ts`
- Create: `packages/datahub/test/writeback/__snapshots__/decision-document.test.ts.snap`

**Interfaces:**
- `buildDecisionDocument(input): DataHubDecisionDocument`.
- `buildValidatedTagRequest(input): DataHubTagRequest`.

- [ ] **Step 1: Write failing snapshot, provenance, and injection tests**

Require deterministic title/key, proposed change, baseline/final decisions, all reason/evidence references, migration phases/window/rollback, validation checks/hash, GitHub public URL, policy/approval provenance, and mode. Test Markdown/HTML injection, overlong untrusted text, token patterns, invented evidence, mismatched hash, noncanonical target, and arbitrary tag.

- [ ] **Step 2: Run and observe missing renderers**

Run: `pnpm --filter @lineageguard/datahub vitest run test/writeback/decision-document.test.ts`
Expected: FAIL resolving renderer modules.

- [ ] **Step 3: Implement bounded normalized rendering**

Document key is `lineageguard-<first 24 input fingerprint hex>` and title is `LineageGuard migration decision <short change ID>`. Render only validated domain data, escape markup, cap content, and include stable receipt IDs. Tag request targets only the canonical source dataset and exact seeded tag URN.

- [ ] **Step 4: Accept the deterministic snapshot after evidence review**

Run: `pnpm --filter @lineageguard/datahub test -- decision-document`
Expected: PASS; output is byte-identical across input permutations and contains no secret/raw MCP payload.

- [ ] **Step 5: Commit document and marker rendering**

```bash
git add packages/datahub/src/writeback/decision-document.ts packages/datahub/src/writeback/marker.ts packages/datahub/test/writeback/decision-document.test.ts packages/datahub/test/writeback/__snapshots__
git commit -m "feat(datahub): render verified migration decision metadata"
```

---

### Task 4: Implement live/replay adapters with effect reconciliation

**Files:**
- Create: `packages/datahub/src/writeback/idempotency.ts`
- Create: `packages/datahub/src/writeback/live-writeback-adapter.ts`
- Create: `packages/datahub/src/writeback/replay-writeback-adapter.ts`
- Create: `packages/datahub/test/writeback/writeback.contract.ts`
- Create: `packages/datahub/test/writeback/idempotency.test.ts`
- Create: `packages/datahub/test/writeback/replay-writeback-adapter.test.ts`
- Modify: `packages/db/src/schema/external-effect-receipts.ts`
- Modify: `packages/db/src/repositories/external-effect-repository.ts`
- Modify: `packages/db/test/external-effect-repository.integration.test.ts`

**Interfaces:** Idempotency key is SHA-256 over run ID, effect kind `DATAHUB_WRITEBACK`, canonical target, and input fingerprint. `WritebackRequest` is discriminated: `LIVE` carries the exact pre-persisted external-effect intent ID and the adapter cannot create or substitute it; `REPLAY` carries a checked receipt/provenance fingerprint and creates no intent or effect. Persisted records are also discriminated with a database check: `LIVE` requires `intent_id` and forbids replay provenance; `REPLAY` requires provenance and `intent_id IS NULL`. Internal receipt records document URN, operator-only UI URL, fingerprint, tag target/URN, and per-effect status; the replay/public projection omits the private UI URL.

- [ ] **Step 1: Write failing shared contract and partial-effect tests**

Cover missing/conflicting pre-persisted live intent, database rejection of a live receipt without intent, database rejection of a replay receipt with intent/missing provenance, new document+tag, identical retry, document saved/response lost, document saved/tag failed, tag applied/response lost, existing exact document, existing conflicting document, unsupported tool response, MCP outage, timeout, auth denial, malformed response, replay, and abort at every mutation/verifier boundary. Assert partial success remains incomplete and retry reaches exactly one logical document/tag; aborted calls cannot return a success receipt to a stale worker.

- [ ] **Step 2: Run and observe missing adapters**

Run: `pnpm --filter @lineageguard/datahub vitest run test/writeback/writeback.contract.ts test/writeback/idempotency.test.ts`
Expected: FAIL resolving adapter modules.

- [ ] **Step 3: Implement intent-first two-effect reconciliation**

Require and load the exact existing intent before `save_document`; Task 5 atomically creates that intent when it consumes approval. After any uncertain result, use the injected signal-aware `DataHubWritebackVerifierPort` to find the deterministic document, compare the embedded fingerprint, then verify the tag on the target entity. Pass the identical worker signal to every write/verifier call. Reuse only exact matches; conflicts fail closed. The write adapter calls no model and accepts no free-form tool name.

- [ ] **Step 4: Run adapter and receipt-repository tests**

Run: `pnpm --filter @lineageguard/datahub test -- writeback && pnpm --filter @lineageguard/db test:integration -- external-effect`
Expected: PASS, including every partial boundary and exact replay schema.

- [ ] **Step 5: Commit adapters and reconciliation**

```bash
git add packages/datahub/src/writeback packages/datahub/test/writeback packages/db/src packages/db/test/external-effect-repository.integration.test.ts
git commit -m "feat(datahub): reconcile idempotent decision writeback"
```

---

### Task 5: Persist approval and wire the worker state machine

**Files:**
- Create: `packages/db/src/schema/external-approvals.ts`
- Create: `packages/db/src/schema/external-approval-events.ts`
- Create: `packages/db/src/repositories/approval-repository.ts`
- Create: `packages/db/src/migrations/0003_external_approvals.sql`
- Create: `packages/db/test/approval-repository.integration.test.ts`
- Create: `apps/worker/src/orchestration/steps/request-writeback-approval.ts`
- Create: `apps/worker/src/orchestration/steps/writeback-decision.ts`
- Create: `apps/worker/test/writeback-decision.integration.test.ts`
- Modify: `packages/db/src/repositories/run-repository.ts`
- Modify: `packages/db/test/run-state.integration.test.ts`

**Interfaces:** `ApprovalRecord` is immutable and binds `runId`, `effectKind=DATAHUB_WRITEBACK`, input fingerprint, policy version, approver ID, approved/expiry timestamps, audit request ID, and a monotonic approval generation. Separate immutable `ApprovalRevocationRecord` and `ApprovalConsumptionRecord` rows reference the exact approval ID/generation. `auditRequestId` is globally unique: repeating it returns the same record, while a new authorized request after expiry or effective revocation creates the next generation for the same binding. A row lock permits at most one active unconsumed generation. Only a server-side operator command/API can call:

- `ApprovalRepository.approveAndWake(input): Promise<ApprovalRecord>`, which locks the exact `WRITEBACK_PENDING` run, inserts approval, clears `WRITEBACK_APPROVAL`, sets `nextAttemptAt=now`, increments the run version, and leaves retry attempts unchanged in one transaction;
- `ApprovalRepository.revokeAndPark(input): Promise<ApprovalRevocationRecord>`, which wins only before consumption/effect intent, inserts revocation, restores the wait reason, clears any active lease so its next renewal/commit fails, increments the run version, and leaves retries unchanged atomically, or returns `APPROVAL_ALREADY_CONSUMED`;
- `ApprovalRepository.consumeAndCreateIntent(claim, binding): Promise<ConsumedApproval>`, which requires the active lease token and atomically records consumption plus the exact DataHub external-effect intent before any MCP mutation.

- [ ] **Step 1: Write failing approval and worker transition tests**

Cover initial pending wait, claim exclusion while waiting, authorized approve-and-wake, absent approval, approval expiring between wake and claim, replay bypass disclosure, replay receipt/provenance mismatch, replay abort, replay atomic receipt+completion, anonymous/client-forged identity, wrong fingerprint, same-request idempotency, rejection of a second simultaneously active generation, fresh generation after expiry, fresh generation after effective revocation, revocation-before-consumption winning and re-parking, revocation clearing an in-flight unconsumed lease so renewal/commit fail and its signal aborts, consumption-before-revocation winning with `APPROVAL_ALREADY_CONSUMED`, simultaneous revoke/consume race, no retry increment for absent/expired/revoked approval, adapter failure only after consumption, partial receipt, exact success, reconciliation after consumed approval expiry, and retry after restart. Assert `COMPLETED` is impossible without both complete F7 and F8 receipts.

- [ ] **Step 2: Run and observe missing schema/steps**

Run: `pnpm --filter @lineageguard/db test:integration -- approval && pnpm --filter @lineageguard/worker vitest run test/writeback-decision.integration.test.ts`
Expected: FAIL resolving new modules.

- [ ] **Step 3: Implement immutable approvals and guarded transitions**

In production, `request-writeback-approval.ts` calls `commitTransitionAndWait` to enter `WRITEBACK_PENDING` with `waitReason=WRITEBACK_APPROVAL`, `nextAttemptAt=null`, and a released lease. In replay it records the disclosed bypass and enters `WRITEBACK_PENDING` runnable without creating an external effect. The server-side approval command uses `approveAndWake`; ordinary worker polling cannot wake a run. After expiry or effective revocation, a new authorized command with a new `auditRequestId` may create and wake the next generation; retrying the old request ID is idempotent and cannot create one.

For replay, `writeback-decision.ts` loads the committed replay record and its provenance fingerprint, constructs `{ mode: "REPLAY", ... }`, invokes only `ReplayWritebackAdapter` with `context.signal`, and strictly validates run/input/F4/F6/F7/source-receipt fingerprints. It then inserts the checked replay receipt through `commitTransitionAndRelease`'s transaction-aware callback while atomically transitioning `WRITEBACK_PENDING -> COMPLETED`. Missing/tampered provenance, abort, or receipt mismatch creates no intent, live MCP call, receipt, retry, or completion.

After a production wake, `writeback-decision.ts` re-evaluates stored policy data. If approval is absent, expired, or effectively revoked, call `parkClaimAndRelease` on the same status with no denial/retry event or attempt consumption. Otherwise call `consumeAndCreateIntent` under the active claim; this transaction is the linearization point against revocation. Invoke the live write port outside the transaction with `context.signal`, reconcile the receipt, and perform `WRITEBACK_PENDING -> COMPLETED` only with matching complete evidence. Retryable failures after intent consumption schedule the 1/5/30-second retries; exhausted or non-retryable post-intent errors transition to `FAILED_WRITEBACK`. Abort/lease loss is neither and commits no stale receipt/retry/transition.

- [ ] **Step 4: Run integration tests twice**

Run: `pnpm --filter @lineageguard/db test:integration -- approval external-effect && pnpm --filter @lineageguard/worker test -- writeback-decision`
Expected: PASS with restart/idempotency cases and no live network dependency.

- [ ] **Step 5: Commit approvals and orchestration**

```bash
git add packages/db apps/worker
git commit -m "feat(worker): gate DataHub writeback on explicit approval"
```

---

### Task 6: Prove one real searchable write-back and complete Gate D

**Files:**
- Create: `packages/datahub/test/live/canonical-writeback.test.ts`
- Create: `apps/worker/test/canonical-run.integration.test.ts`
- Create: `scripts/demo-writeback-verify.ts`
- Create: `examples/replay/datahub-writeback-receipt.json`
- Modify: `package.json`
- Modify: `docs/ARCHITECTURE.md`
- Modify: `docs/AGENT_HARNESS.md`
- Modify: `docs/SOURCES.md`

- [ ] **Step 1: Write the live test and read-only verification assertions first**

Require explicit approval fixture, exact F4/F6/F7 fingerprints, one document, one tag, searchable document title/body, matching embedded provenance, second-call idempotency, and read-process mutation isolation. The worker integration test uses the real F2 parser, recorded F3 adapter, F4 engine/loop, deterministic F5 candidate, executable F6 validator, and F7/F8 replay adapters to assert exactly `CREATED -> CHANGE_PARSED -> BASELINE_ASSESSED -> CONTEXT_COLLECTING -> CONTEXT_COLLECTED -> RISK_DECIDED -> MIGRATION_PLANNED -> PATCH_GENERATED -> VALIDATING -> VALIDATED -> REVIEW_ARTIFACT_CREATED -> WRITEBACK_PENDING -> COMPLETED`, then repeats after injected crashes at every persisted boundary.

- [ ] **Step 2: Run without write access and observe explicit failure**

Run: `DATAHUB_TEST_MODE=live pnpm --filter @lineageguard/datahub test:integration -- writeback`
Expected: FAIL fast with `DATAHUB_WRITE_TOKEN is required`; ordinary tests remain green.

- [ ] **Step 3: With explicit authorization, execute live write-back twice**

Run: `DATAHUB_TEST_MODE=live pnpm --filter @lineageguard/datahub test:integration -- writeback && DATAHUB_TEST_MODE=live pnpm --filter @lineageguard/datahub test:integration -- writeback`
Expected: both PASS and reconcile to the same document/tag receipt.

- [ ] **Step 4: Verify through read-only DataHub calls and UI**

Own `"demo:writeback:verify": "node scripts/demo-writeback-verify.ts"` in `package.json` before running it.

Run: `pnpm demo:writeback:verify`
Expected: exit zero and print `datahub_writeback=verified`; manually confirm the document is searchable and the target displays the exact tag.

- [ ] **Step 5: Run the full worker transition and restart integration**

Run: `pnpm --filter @lineageguard/worker test -- canonical-run`
Expected: PASS with the exact accepted status/event sequence, no repeated completed side effect, safe restart at every boundary, and exact failure mappings for context, generation, validation, GitHub, and write-back.

- [ ] **Step 6: Run an independent specification review**

Give a fresh read-only reviewer F8 spec, F4/F6/F7 receipts, policy, document/tag, approval, ADR-003, and diff. Required result: content matches the accepted behavior and no write can occur before the gate. Resolve all blockers.

- [ ] **Step 7: Run an independent code-quality and security review**

Use a different fresh read-only reviewer. Inspect credential/process separation, tool allowlists, authorization source, approval expiry/binding, injection/escaping, partial effects, idempotency, audit events, secret logging, and replay receipt. Resolve all blockers.

- [ ] **Step 8: Invoke `superpowers:verification-before-completion` and run Gate D**

```bash
pnpm --filter @lineageguard/datahub test -- writeback
pnpm --filter @lineageguard/db test:integration -- approval external-effect
pnpm --filter @lineageguard/worker test -- writeback-decision
pnpm --filter @lineageguard/worker test -- canonical-run
DATAHUB_TEST_MODE=live pnpm --filter @lineageguard/datahub test:integration -- writeback
pnpm demo:writeback:verify
pnpm demo:github:verify
pnpm format:check
pnpm lint
pnpm typecheck
```

Expected: every command exits zero; one real GitHub receipt plus one real searchable DataHub document/tag receipt match Gate C; read/write tool isolation remains proven.

- [ ] **Step 9: Commit live receipt and docs**

```bash
git add packages/datahub/test/live apps/worker/test/canonical-run.integration.test.ts scripts/demo-writeback-verify.ts examples/replay/datahub-writeback-receipt.json package.json docs/ARCHITECTURE.md docs/AGENT_HARNESS.md docs/SOURCES.md
git commit -m "test(datahub): capture approved canonical writeback"
```

Gate D is complete only when the live external receipts share the exact validated artifact fingerprint.
