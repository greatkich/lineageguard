# F4 Deterministic Risk Engine Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use `superpowers:subagent-driven-development` (recommended) or `superpowers:executing-plans` to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Evaluate repository-only and DataHub-grounded evidence with one pure policy engine so the canonical rename changes from `ALLOW`/`LOW` to evidence-backed `BLOCK` deterministically.

**Architecture:** Rules, precedence, schemas, fingerprints, decision comparison, and the exact accepted run-state transition table live in `packages/domain`. `packages/db` persists immutable assessments/events and leases queue work with `FOR UPDATE SKIP LOCKED`. A restart-safe worker engine dispatches typed steps; F4 owns F2/F3/baseline/risk orchestration and the extension contract used by F5-F8. Canonical P0 uses deterministic message keys/templates and adds no model role here.

**Tech Stack:** TypeScript 6.0.3 strict mode, Zod 4.4.3, Vitest 4.1.10, PostgreSQL 17.10.

## Global Constraints

- Branch `feat/f4-deterministic-risk-engine` starts from accepted F3.
- `RiskDecision` is exactly `ALLOW | REVIEW | BLOCK`; `SAFE_WITH_MIGRATION` is a readiness label outside policy.
- Every emitted reason has at least one valid evidence ID.
- Identical normalized inputs produce byte-identical assessments regardless of evidence order.
- Baseline and grounded assessments use the same engine and rule registry.
- State transitions are transactional, monotonic, and idempotent.
- Status names match `docs/ARCHITECTURE.md` exactly; implementation-specific effect intent is an event/receipt state, not a new `RunStatus`.
- Worker lease is 60 seconds with a 20-second heartbeat; retry policy is the initial attempt plus delays of 1, 5, and 30 seconds before terminal mapping.

---

### Task 1: Define assessment, rule, and delta contracts

**Files:**
- Create: `packages/domain/src/decision.ts`
- Create: `packages/domain/src/decision-delta.ts`
- Create: `packages/domain/src/policy/types.ts`
- Create: `packages/domain/test/decision.test.ts`
- Modify: `packages/domain/src/index.ts`

**Interfaces:**

```ts
export type RiskDecision = "ALLOW" | "REVIEW" | "BLOCK";

export interface RiskReason {
  ruleId: `LG${string}`;
  messageKey: string;
  evidenceIds: readonly EvidenceId[];
}

export interface RiskAssessment {
  decision: RiskDecision;
  riskLevel: "LOW" | "MEDIUM" | "HIGH" | "CRITICAL";
  reasons: readonly RiskReason[];
  evaluatedRuleIds: readonly string[];
  inputFingerprint: string;
}

export function compareAssessments(
  baseline: RiskAssessment,
  grounded: RiskAssessment,
): DecisionDelta;
```

- [ ] **Step 1: Write failing strict-schema and delta tests**

Test invalid decision `SAFE_WITH_MIGRATION`, duplicate rule IDs, empty evidence IDs on a reason, a dangling evidence reference, strict UTC persisted `assessmentTime`, stable ordering, `ALLOW -> BLOCK`, and unchanged assessment comparison.

- [ ] **Step 2: Run the focused tests and observe missing modules**

Run: `pnpm --filter @lineageguard/domain vitest run test/decision.test.ts`
Expected: FAIL resolving `../src/decision.js`.

- [ ] **Step 3: Implement strict Zod schemas and pure comparison**

Sort reasons by precedence then rule ID; sort/deduplicate evidence IDs; compute input fingerprints from the normalized change plus normalized evidence. Delta carries `from`, `to`, `addedReasonIds`, `removedReasonIds`, and `evidenceAddedIds`, never generated prose.

- [ ] **Step 4: Run tests and typecheck**

Run: `pnpm --filter @lineageguard/domain test -- decision && pnpm --filter @lineageguard/domain typecheck`
Expected: PASS and no implicit `any`.

- [ ] **Step 5: Commit decision contracts**

```bash
git add packages/domain/src/decision.ts packages/domain/src/decision-delta.ts packages/domain/src/policy/types.ts packages/domain/src/index.ts packages/domain/test/decision.test.ts
git commit -m "feat(domain): define risk assessment contracts"
```

---

### Task 2: Implement LG001-LG007 with table-driven red-green tests

**Files:**
- Create: `packages/domain/src/policy/rules/LG001.ts`
- Create: `packages/domain/src/policy/rules/LG002.ts`
- Create: `packages/domain/src/policy/rules/LG003.ts`
- Create: `packages/domain/src/policy/rules/LG004.ts`
- Create: `packages/domain/src/policy/rules/LG005.ts`
- Create: `packages/domain/src/policy/rules/LG006.ts`
- Create: `packages/domain/src/policy/rules/LG007.ts`
- Create: `packages/domain/test/policy/LG001.test.ts`
- Create: `packages/domain/test/policy/LG002.test.ts`
- Create: `packages/domain/test/policy/LG003.test.ts`
- Create: `packages/domain/test/policy/LG004.test.ts`
- Create: `packages/domain/test/policy/LG005.test.ts`
- Create: `packages/domain/test/policy/LG006.test.ts`
- Create: `packages/domain/test/policy/LG007.test.ts`

**Interfaces:** Each rule is a pure `PolicyRule` with fixed ID, evidence-kind requirements, and `evaluate(input): RuleResult | null`.

- [ ] **Step 1: Write positive, negative, and boundary cases for every rule**

Required cases:

- LG001: incompatible rename/type/drop plus downstream field lineage blocks; additive/no lineage does not.
- LG002: production ML model downstream blocks; non-production or absent model does not.
- LG003: an unmanaged query with `0 <= assessmentTime - lastSeenAt <= 30 days` yields at least review and blocks rename/drop; exact time equality is valid, any future timestamp is invalid, exactly 30 days is recent, 30 days plus one millisecond is stale, and managed/no-reference/unknown-source values do not match or fail schema validation as specified.
- LG004: incompatible change with critical dashboard blocks; noncritical/additive does not.
- LG005: missing owner on affected critical asset reviews; present owner/noncritical does not.
- LG006: additive nullable field without semantic conflict allows; rename/non-null/conflict does not.
- LG007: glossary or structured-property conflict reviews/blocks according to explicit severity; matching meaning does not.

- [ ] **Step 2: Run all rule tests and observe failures**

Run: `pnpm --filter @lineageguard/domain vitest run test/policy`
Expected: FAIL because rule modules do not exist.

- [ ] **Step 3: Implement one rule at a time, rerunning its test before continuing**

Run after each rule: `pnpm --filter @lineageguard/domain vitest run test/policy/LG00N.test.ts`
Expected: the named rule file passes before starting the next; reason IDs reference only evidence provided to that rule.

- [ ] **Step 4: Run mutation/order-oriented boundary checks**

Run: `pnpm --filter @lineageguard/domain test -- policy`
Expected: all seven rule suites pass; no branch relies on array position, timestamps, random IDs, or model text.

- [ ] **Step 5: Commit rule implementations**

```bash
git add packages/domain/src/policy/rules packages/domain/test/policy
git commit -m "feat(domain): implement evidence-backed LG001-LG007 rules"
```

---

### Task 3: Implement precedence and the single assessment function

**Files:**
- Create: `packages/domain/src/policy/precedence.ts`
- Create: `packages/domain/src/policy/evaluate.ts`
- Create: `packages/domain/src/policy/registry.ts`
- Create: `packages/domain/test/policy/evaluate.test.ts`
- Create: `demo/scenarios/canonical/repository-evidence.json`
- Create: `demo/scenarios/canonical/grounded-evidence.json`

**Interfaces:** `assessRisk(input: RiskInput): RiskAssessment`; `RiskInput` contains one validated `ProposedChange`, one evidence bundle, and the persisted run `assessmentTime`. Time is data supplied to the pure engine, never a direct system-clock read.

- [ ] **Step 1: Write failing canonical and permutation tests**

Assert repository-only `ALLOW`/`LOW`; grounded `BLOCK`; expected LG001/LG002/LG003/LG004 reasons; all reason evidence IDs exist; LG005/LG007 appear only when their predicates match; `BLOCK > REVIEW > ALLOW`; 100 seeded evidence permutations serialize identically.

- [ ] **Step 2: Run the focused test and observe missing evaluator**

Run: `pnpm --filter @lineageguard/domain vitest run test/policy/evaluate.test.ts`
Expected: FAIL resolving `evaluate.js`.

- [ ] **Step 3: Implement fixed registry, precedence, and validation**

```ts
const DECISION_RANK = { ALLOW: 0, REVIEW: 1, BLOCK: 2 } as const;

export function assessRisk(input: RiskInput): RiskAssessment {
  const validated = RiskInputSchema.parse(input);
  const results = RULES.flatMap((rule) => rule.evaluate(validated) ?? []);
  return finalizeAssessment(validated, results, DECISION_RANK);
}
```

Reject unknown evidence kinds at the input boundary and any rule result with dangling evidence IDs. Do not infer a weighted score.

- [ ] **Step 4: Run policy and fixture tests**

Run: `pnpm --filter @lineageguard/domain test -- policy`
Expected: PASS with exact canonical output and order independence.

- [ ] **Step 5: Commit the evaluator and canonical bundles**

```bash
git add packages/domain/src/policy packages/domain/test/policy demo/scenarios/canonical
git commit -m "feat(domain): evaluate baseline and grounded risk"
```

---

### Task 4: Persist assessments and monotonic run events

**Files:**
- Create: `packages/db/src/schema/runs.ts`
- Create: `packages/db/src/schema/run-events.ts`
- Create: `packages/db/src/repositories/run-repository.ts`
- Create: `packages/db/src/migrations/0001_runs.sql`
- Create: `packages/db/test/run-state.integration.test.ts`
- Create: `packages/domain/src/run-state.ts`
- Create: `packages/domain/test/run-state.test.ts`
- Modify: `packages/domain/src/index.ts`
- Modify: `docs/DECISIONS/ADR-004-durable-workflow-and-idempotency.md`

**Interfaces:**
- `RunRepository.claimNextRunnable(input): Promise<ClaimedRun | null>` where the result includes run ID, snapshot/version, worker ID, opaque lease token, and expiry.
- `RunRepository.renewLease(input: RenewLeaseInput): Promise<ActiveLease>`.
- `RunRepository.commitTransitionAndRelease(input: CommitClaimedTransitionInput, persistDomainData?: (transaction: DbTransaction) => Promise<void>): Promise<RunSnapshot>` atomically verifies the active token, invokes the transaction-aware domain writer, appends the event, updates status/version, and releases the lease.
- `RunRepository.commitTransitionAndWait(input: CommitClaimedWaitInput): Promise<RunSnapshot>` performs the same fenced transition but stores a typed wait reason and `nextAttemptAt=null`; waiting rows are not runnable and waiting does not increment retry attempts.
- `RunRepository.parkClaimAndRelease(input: ParkClaimedRunInput): Promise<RunSnapshot>` fences an already-woken claim, restores its typed wait reason/`nextAttemptAt=null`, increments the optimistic version, and releases it without a status transition or retry increment.
- `RunRepository.scheduleRetryAndRelease(input: ScheduleClaimedRetryInput): Promise<RunSnapshot>` atomically verifies the token, writes retry event/attempt/`nextAttemptAt`, and releases the lease.
- `RunRepository.releaseLease(input: ReleaseLeaseInput): Promise<void>` is only for graceful no-op/cancellation paths and still verifies the active token.
- Unique `(run_id, version)` and `(run_id, assessment_phase)` constraints.

- [ ] **Step 1: Write failing PostgreSQL integration tests**

Cover the complete accepted status/terminal-status schema, every legal edge, every skipped/backward edge, create, concurrent expected-version conflict, duplicate idempotent assessment, different payload under same key, rollback on event failure, two-worker claim race, `SKIP LOCKED`, successful renewal, wrong-token renewal, unexpired denial, expired reclaim, stale-worker commit denial after reclaim, transition+callback-domain-write+release atomicity in both callback/event failure orders, wait transition/release atomicity, claim exclusion for `waitReason != null`, park-after-wake without status/retry change, no retry increment while waiting, retry-schedule+release atomicity, and read-after-write reconstruction.

- [ ] **Step 2: Start the test database and observe missing migration/repository failures**

Run: `pnpm db:test:up && pnpm --filter @lineageguard/db test:integration -- run-state`
Expected: FAIL because schema/repository are absent.

- [ ] **Step 3: Implement transactionally with explicit transition table**

Define `RunStatus` exactly as `CREATED -> CHANGE_PARSED -> BASELINE_ASSESSED -> CONTEXT_COLLECTING -> CONTEXT_COLLECTED -> RISK_DECIDED -> MIGRATION_PLANNED -> PATCH_GENERATED -> VALIDATING -> VALIDATED -> REVIEW_ARTIFACT_CREATED -> WRITEBACK_PENDING -> COMPLETED`, plus `FAILED_CONTEXT`, `FAILED_GENERATION`, `FAILED_VALIDATION`, `FAILED_GITHUB`, `FAILED_WRITEBACK`, and `CANCELLED`. Define immutable `RunEvent` types `STATE_TRANSITION`, `STEP_RETRY_SCHEDULED`, and `LEASE_ACQUIRED` with sequence, from/to status, step, safe typed payload, fingerprint, and timestamp.

Use PostgreSQL transactions and `FOR UPDATE SKIP LOCKED` to claim due nonterminal runs whose `wait_reason IS NULL`. Store lease owner/token/expiry, attempt count, next-attempt time, typed wait reason, and optimistic version. Every renewal/state/domain mutation locks the row and requires matching owner/token plus `lease_expires_at > transaction_timestamp()`; an expired worker cannot commit. `commitTransitionAndRelease` invokes its transaction-aware domain writer only after fencing and inside the same transaction as the immutable event, projection/version update, and lease release; no domain repository used by a step exposes an independent autocommit save path. `commitTransitionAndWait` performs the same atomic work while setting the wait reason and null schedule. `parkClaimAndRelease` restores those wait fields on the same status and never emits a retry event or increments attempts. Retry event, attempt/next-attempt update, and release share one transaction. Persist normalized JSON plus input fingerprint. Record no model narration in policy tables.

- [ ] **Step 4: Run integration tests twice**

Run: `pnpm --filter @lineageguard/db test:integration -- run-state && pnpm --filter @lineageguard/db test:integration -- run-state`
Expected: both runs PASS without leaked state.

- [ ] **Step 5: Record ADR-004 and commit persistence**

ADR-004 records the exact transition/failure table, 60-second lease, 20-second heartbeat, initial attempt plus 1/5/30-second retries, transactional event/version semantics, `FOR UPDATE SKIP LOCKED` claim, idempotency keys, restart boundary, and one-second UI polling contract.

```bash
git add packages/db packages/domain/src/run-state.ts docs/DECISIONS/ADR-004-durable-workflow-and-idempotency.md
git commit -m "feat(db): persist monotonic risk assessment events"
```

---

### Task 5: Implement the restart-safe worker loop and baseline-to-grounded flow

**Files:**
- Create: `apps/worker/src/orchestration/run-engine.ts`
- Create: `apps/worker/src/orchestration/step-registry.ts`
- Create: `apps/worker/src/orchestration/retry-policy.ts`
- Modify: `apps/worker/src/worker.ts`
- Create: `apps/worker/src/orchestration/steps/parse-change.ts`
- Create: `apps/worker/src/orchestration/steps/assess-baseline.ts`
- Create: `apps/worker/src/orchestration/steps/collect-context.ts`
- Create: `apps/worker/src/orchestration/steps/decide-risk.ts`
- Create: `apps/worker/src/orchestration/baseline-evidence.ts`
- Create: `apps/worker/test/assessment-flow.integration.test.ts`
- Create: `apps/worker/test/worker-loop.integration.test.ts`
- Create: `apps/worker/test/canonical-state-machine.integration.test.ts`
- Create: `scripts/demo-decision-verify.ts`
- Modify: `package.json`

**Interfaces:** `WorkerStepHandler(context: { claim: ClaimedRun; signal: AbortSignal }): Promise<WorkerStepOutcome>` is the only registry handler shape. `runOneIteration(workerId, registry, repository, clock): Promise<WorkerIterationResult>` claims at most one run, creates one `AbortController`, and dispatches by persisted status. `runWorker(signal)` replaces F0's heartbeat stub with the long-running loop, uses a 500ms idle delay, renews the 60-second lease every 20 seconds while a step runs, and aborts that controller if renewal fails. Every F2-F8 step must pass the signal through all I/O. Baseline maps only repository evidence from F2; context calls F3's deterministic application service; grounded decision adds normalized evidence. Both assessments call the same pure `assessRisk`. `demo:decision:verify` reads persisted assessments/events and validates references.

- [ ] **Step 1: Write the failing end-to-end worker-step test**

Assert exact `CREATED -> CHANGE_PARSED -> BASELINE_ASSESSED -> CONTEXT_COLLECTING -> CONTEXT_COLLECTED -> RISK_DECIDED` event order, same rule registry/version, baseline `ALLOW`, grounded `BLOCK`, correct delta, persisted fingerprints, retry idempotency, and no DataHub evidence in the baseline input. Worker-loop tests cover two-worker exclusion, 20-second renewal during an eight-minute fake step, propagation of the identical signal to the handler, abort on renewal loss, handler settlement before cleanup, stale commit denial after reclaim, no stale retry scheduling, graceful process stop, crash before/after transition commit, expired reclaim, initial plus 1/5/30-second retries, atomic retry/release, no repeated completed step, unsupported-change `CANCELLED`, context failure `FAILED_CONTEXT`, and safe redacted failure payloads. A fake registry traverses every later canonical status and every explicit terminal mapping so F5-F8 cannot invent statuses.

- [ ] **Step 2: Run and observe missing orchestration**

Run: `pnpm --filter @lineageguard/worker test -- worker-loop canonical-state-machine assessment-flow`
Expected: FAIL resolving step modules.

- [ ] **Step 3: Implement steps and the exact verifier output**

Implement a status-to-step registry with exhaustive TypeScript checking. F2 parse failures with an unsupported semantic change map to `CANCELLED`; F3 failures map to `FAILED_CONTEXT`; F5-F8 later register their accepted transitions/failure states. Retryable operational errors schedule an event without advancing status, and exhausted/non-retryable errors transition once. Own `"demo:decision:verify": "node scripts/demo-decision-verify.ts"` in `package.json`; the command must emit:

```text
baseline=ALLOW
grounded=BLOCK
all_reasons_have_evidence=true
```

and exit nonzero for any other value, missing reason, mismatched fingerprint, or state transition.

- [ ] **Step 4: Run worker and demo verification**

Run: `pnpm --filter @lineageguard/worker test -- worker-loop canonical-state-machine assessment-flow && pnpm demo:decision:verify`
Expected: PASS and the three exact lines above.

- [ ] **Step 5: Commit orchestration**

```bash
git add apps/worker package.json scripts/demo-decision-verify.ts
git commit -m "feat(worker): persist deterministic decision flip"
```

---

### Task 6: Review and close Gate B

- [ ] **Step 1: Run an independent specification review**

Give a fresh read-only reviewer F4's spec, policy table in `docs/ARCHITECTURE.md`, canonical fixtures, ADR-004, and diff. Required result: every rule and product invariant has positive/negative/failure coverage and no model authority. Resolve all blocking findings.

- [ ] **Step 2: Run an independent code-quality review**

Use a different fresh read-only reviewer. Inspect canonicalization, rule precedence, referential integrity, concurrency, SQL transactions, idempotency, state reconstruction, and package boundaries. Resolve all blocking findings.

- [ ] **Step 3: Invoke `superpowers:verification-before-completion` and run the final gate**

```bash
pnpm --filter @lineageguard/domain test -- policy
pnpm --filter @lineageguard/db test:integration
pnpm --filter @lineageguard/worker test -- worker-loop canonical-state-machine assessment-flow
pnpm demo:decision:verify
pnpm format:check
pnpm lint
pnpm typecheck
```

Expected: every command exits zero and the verifier prints exactly `baseline=ALLOW`, `grounded=BLOCK`, and `all_reasons_have_evidence=true`.

- [ ] **Step 4: Commit review fixes and evidence if required**

```bash
git add packages apps/worker scripts docs/DECISIONS/ADR-004-durable-workflow-and-idempotency.md
git commit -m "test(policy): prove the canonical ALLOW to BLOCK transition"
```

Gate B is the no-go boundary for F5: do not begin artifact generation unless this exact evidence passes in the current worktree.
