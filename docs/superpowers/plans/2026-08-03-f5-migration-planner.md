# F5 Migration Planner and Artifact Generator Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use `superpowers:subagent-driven-development` (recommended) or `superpowers:executing-plans` to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Convert the canonical grounded `BLOCK` assessment into a typed expand-migrate-contract plan and bounded patch bundle while treating model output as untrusted candidate data.

**Architecture:** Domain schemas define approved migration primitives and artifact manifests. One bounded migration planner/generator Agent, as required by ADR-002, returns one Zod-validated `MigrationCandidate` containing the plan and patch from normalized evidence only. Deterministic validation rejects invented evidence, unsupported strategies, and unsafe paths; a canonical template fallback preserves demo determinism. Generated files are written only to an isolated patch worktree and are not labeled safe.

**Tech Stack:** TypeScript 6.0.3, OpenAI Agents SDK 0.14.2, Zod 4.4.3, model `gpt-5.6`, Vitest 4.1.10, Git isolated worktrees.

## Global Constraints

- Branch `feat/f5-migration-planner` starts from Gate B.
- The persisted F4 decision remains `BLOCK`; neither prompt nor output exposes a decision setter.
- Model input contains the validated change, assessment, and normalized evidence—not raw MCP/API responses.
- Model input also contains the allowlisted controlled-file paths and exact base hashes from the accepted F2 repository context; an output cannot invent or omit a base hash for a modification.
- SQL, diffs, descriptions, query text, and model output are untrusted data.
- A `PatchBundle` contains only discriminated `CREATE`/`MODIFY` text-file entries. `MODIFY` requires the exact expected base-file SHA-256; delete operations and commands are forbidden.
- The allowed strategy is `EXPAND_MIGRATE_CONTRACT` for the canonical slice.
- Only F6 can produce a safety/readiness receipt.
- Do not split planning and patch generation into separate agent roles without a measured evaluation failure and a superseding approved ADR.

---

### Task 1: Define migration plan and patch-bundle contracts

**Files:**
- Create: `packages/domain/src/migration.ts`
- Create: `packages/domain/src/artifacts.ts`
- Create: `packages/domain/test/migration.test.ts`
- Modify: `packages/domain/src/index.ts`
- Create: `packages/agent/src/schemas/migration-plan.ts`
- Create: `packages/agent/src/schemas/artifact-manifest.ts`
- Create: `packages/agent/src/schemas/migration-candidate.ts`

**Interfaces:**

```ts
type MigrationPhase = "EXPAND" | "MIGRATE" | "CONTRACT";

interface MigrationPlan {
  strategy: "EXPAND_MIGRATE_CONTRACT";
  sourceChangeId: string;
  sourceAssessmentFingerprint: string;
  sourceEvidenceIds: readonly EvidenceId[];
  phases: readonly MigrationPlanPhase[];
  compatibilityWindow: CompatibilityWindow;
  requiredOwnerReviews: readonly OwnerReview[];
  rollback: RollbackPlan;
  artifactIntents: readonly ArtifactIntent[];
}

interface RollbackPlan {
  kind: "EXECUTABLE_SQL";
  artifact: {
    path: `demo/db/migrations/${string}.rollback.sql`;
    sha256: string;
  };
  restores: readonly ["LEGACY_CONSUMER_COMPATIBILITY"];
}

type PatchFile =
  | {
      operation: "CREATE";
      path: RelativeArtifactPath;
      content: string;
      sha256: string;
    }
  | {
      operation: "MODIFY";
      path: RelativeArtifactPath;
      expectedBaseSha256: string;
      content: string;
      sha256: string;
    };

interface PatchBundle {
  inputFingerprint: string;
  files: readonly PatchFile[];
}
```

- [ ] **Step 1: Write failing strict-schema and invariant tests**

Cover ordered `EXPAND -> MIGRATE -> CONTRACT`, nonempty compatibility window, Finance/Risk review, mandatory executable rollback, rollback path suffix/root/hash/reference, evidence subset, normalized path, content hash, duplicate path, absolute path, `..`, NUL, binary content, `CREATE` with an expected-base hash, `MODIFY` without a valid expected-base hash, any delete operation, unknown strategy, and any `decision`/`isSafe` field.

- [ ] **Step 2: Run tests and observe missing contracts**

Run: `pnpm --filter @lineageguard/domain vitest run test/migration.test.ts`
Expected: FAIL resolving migration modules.

- [ ] **Step 3: Implement schemas plus cross-field validation**

Allowed output roots are exactly:

```text
demo/db/migrations/
demo/dbt/models/
demo/dbt/tests/
docs/migrations/
```

Reject symlinks, path separators after normalization mismatch, unsupported extensions, content over the configured per-file/total byte cap, unknown evidence IDs, and artifacts not declared by the plan. `CREATE` may target only an absent path; `MODIFY` may target only a controlled regular file whose current SHA-256 matches `expectedBaseSha256`. `RollbackPlan.artifact` must resolve to exactly one `CREATE` text SQL file inside `demo/db/migrations/`, end in `.rollback.sql`, have matching SHA-256 in `PatchBundle`, and declare restoration of legacy consumer compatibility.

- [ ] **Step 4: Run tests and typecheck**

Run: `pnpm --filter @lineageguard/domain test -- migration && pnpm --filter @lineageguard/domain typecheck`
Expected: PASS; contracts contain no command or policy-decision fields.

- [ ] **Step 5: Commit contracts**

```bash
git add packages/domain packages/agent/src/schemas
git commit -m "feat(domain): define bounded migration artifact contracts"
```

---

### Task 2: Define approved strategy primitives and canonical fallback

**Files:**
- Create: `packages/agent/src/strategy-primitives.ts`
- Create: `packages/agent/src/canonical-migration-template.ts`
- Create: `packages/agent/test/strategy-primitives.test.ts`
- Create: `demo/scenarios/canonical/expected-migration-plan.json`
- Create: `demo/scenarios/canonical/expected-artifact-manifest.json`

**Interfaces:** `buildCanonicalMigration(input): { plan: MigrationPlan; patch: PatchBundle }`; primitives are typed builders, not shell/string interpolation helpers.

- [ ] **Step 1: Write the failing canonical artifact assertions**

Assert these semantic outputs:

1. add nullable `buyer_id`;
2. backfill `buyer_id = customer_id` idempotently;
3. retain `customer_id` through the compatibility window;
4. update controlled dbt models without changing unmanaged query text;
5. add equality and non-null/coverage tests;
6. document contract/deprecation phase and Finance/Risk review;
7. emit a hashed allowlisted `.rollback.sql` artifact that reverses only the additive compatibility change and restores the old consumer path.

Also test hostile identifiers, unsupported types, empty owners, absent required evidence, prose-only rollback, missing rollback file, wrong rollback hash, destructive rollback, rollback path escape, a dbt modification with the exact F2 base hash, and a candidate that invents a controlled-file base hash.

- [ ] **Step 2: Run the focused tests and observe missing builders**

Run: `pnpm --filter @lineageguard/agent vitest run test/strategy-primitives.test.ts`
Expected: FAIL resolving strategy modules.

- [ ] **Step 3: Implement typed builders and deterministic template rendering**

Render identifiers from already validated domain atoms and quote PostgreSQL identifiers explicitly. Canonical output is stable byte-for-byte and includes source evidence comments only where safe. Existing F1 dbt models are emitted as `MODIFY` entries carrying their exact supplied base hashes; new migration/test/docs/rollback files are `CREATE`. It always contains a rollback file named from the stable change ID under `demo/db/migrations/` with suffix `.rollback.sql`, referenced by `RollbackPlan`; the rollback drops/reverses only the new compatibility artifact while retaining `customer_id`. The fallback is selected by explicit generation mode or failed model validation, not by swallowing operational errors.

- [ ] **Step 4: Run tests twice and compare fixture hashes**

Run: `pnpm --filter @lineageguard/agent test -- strategy-primitives`
Expected: PASS with identical plan and file hashes on repeated construction.

- [ ] **Step 5: Commit strategy primitives and fixtures**

```bash
git add packages/agent/src/strategy-primitives.ts packages/agent/src/canonical-migration-template.ts packages/agent/test/strategy-primitives.test.ts demo/scenarios/canonical
git commit -m "feat(agent): add deterministic migration strategy primitives"
```

---

### Task 3: Implement one schema-validated migration planner/generator agent

**Files:**
- Create: `packages/agent/src/model-config.ts`
- Create: `packages/agent/src/migration-agent.ts`
- Create: `packages/agent/src/prompts/migration-agent.md`
- Create: `packages/agent/src/security/untrusted-context.ts`
- Create: `packages/agent/src/security/evidence-reference-validator.ts`
- Create: `packages/agent/test/migration-agent.test.ts`
- Modify: `packages/agent/src/index.ts`

**Interfaces:**
- `generateMigrationCandidate(input, mode, options: { signal: AbortSignal }): Promise<MigrationCandidate>` where `MigrationCandidate` contains one `MigrationPlan` and one matching `PatchBundle`.
- `mode` is `LIVE_MODEL | DETERMINISTIC_REPLAY`; default model is exactly `gpt-5.6` and can change only through reviewed config.

- [ ] **Step 1: Write failing agent boundary tests with a fake model**

Test valid output, malformed JSON, Zod-invalid phase, unknown strategy, invented evidence ID, missing rollback, excessive output, decision override field, unexpected tool call, model exception, a pre-aborted signal, and abort of a blocked fake-model call. Assert no candidate mutates persisted F4 state and no aborted candidate is returned.

- [ ] **Step 2: Run the focused tests and observe the missing agent**

Run: `pnpm --filter @lineageguard/agent vitest run test/migration-agent.test.ts`
Expected: FAIL resolving the combined migration agent module.

- [ ] **Step 3: Implement Agents SDK calls with strict structured output**

```ts
const migrationAgent = new Agent({
  name: "LineageGuard migration planner and generator",
  model: "gpt-5.6",
  instructions: MIGRATION_AGENT_PROMPT,
  outputType: MigrationCandidateSchema,
});
```

Provide no MCP server, shell, filesystem, GitHub, or DataHub mutation tools. Pass the caller signal to the Agents SDK run and reject any result observed after abort. After SDK parsing, deterministically revalidate plan invariants, evidence subsets, artifact operations/base hashes, sizes, and hashes. Trace metadata may include run ID and fingerprints; it must exclude credentials and raw untrusted payloads.

- [ ] **Step 4: Run unit tests with network disabled**

Run: `OPENAI_TEST_MODE=fake pnpm --filter @lineageguard/agent test -- migration-agent`
Expected: PASS; tests make no network request.

- [ ] **Step 5: Commit agent integration**

```bash
git add packages/agent/src packages/agent/test
git commit -m "feat(agent): generate schema-validated migration candidates"
```

---

### Task 4: Defend against prompt injection and malicious candidate content

**Files:**
- Create: `packages/agent/test/prompt-injection.test.ts`
- Create: `packages/agent/test/malformed-output.test.ts`
- Create: `packages/agent/test/fixtures/adversarial-context.json`
- Create: `docs/SECURITY_THREAT_MODEL.md`

- [ ] **Step 1: Write red tests for each untrusted channel**

Embed hostile instructions in Git diff, SQL comment, DataHub description, glossary text, owner name, query text, and model candidate. Attempt to add `/tmp/pwned`, `.github/workflows/exfiltrate.yml`, `.env`, `../../`, a shell command, an invented evidence ID, and a false `ALLOW`/safe statement.

- [ ] **Step 2: Run adversarial tests and record the initial failures**

Run: `pnpm --filter @lineageguard/agent vitest run test/prompt-injection.test.ts test/malformed-output.test.ts`
Expected: at least the unimplemented boundary cases FAIL before hardening.

- [ ] **Step 3: Harden delimiters, validation, logging, and error mapping**

Encode untrusted blocks as structured JSON fields with explicit instructions that they are evidence data; do not concatenate them into system instructions. Validate references against supplied sets and redact token/key/email patterns from errors/traces. Fail closed to a typed generation failure or the explicitly reported deterministic fallback.

- [ ] **Step 4: Write the repository-grounded threat model**

Document assets, trust boundaries, attacker capabilities, abuse paths, mitigations, residual risks, and ownership for model input, output, patch materialization, validation, external effects, logs, and replay.

- [ ] **Step 5: Run the adversarial suite**

Run: `pnpm --filter @lineageguard/agent test -- prompt-injection malformed-output`
Expected: PASS; no forbidden path/tool/state change is observed and error messages are redacted.

- [ ] **Step 6: Commit security coverage**

```bash
git add packages/agent/test packages/agent/src/security docs/SECURITY_THREAT_MODEL.md
git commit -m "test(agent): reject injected and malformed migration output"
```

---

### Task 5: Materialize candidates only in an isolated patch worktree

**Files:**
- Create: `packages/validation/src/worktree/generated-patch-worktree.ts`
- Create: `packages/validation/src/worktree/path-policy.ts`
- Create: `packages/validation/test/generated-patch-worktree.test.ts`
- Modify: `packages/validation/src/index.ts`

**Interfaces:**

```ts
interface GeneratedPatchWorktree {
  materialize(bundle: PatchBundle, options: { signal: AbortSignal }): Promise<MaterializedPatch>;
  dispose(options: { signal: AbortSignal }): Promise<CleanupReceipt>;
}
```

The factory receives a fully resolved approved workspace root and creates one dedicated worktree below a task-specific temporary parent. It never resolves from `$HOME`, `~`, or broad environment variables.

- [ ] **Step 1: Write failing filesystem tests**

Cover valid absent-file creation; valid controlled dbt-model modification; unapproved existing-file collision; missing modify target; stale/wrong expected base hash; symlink/non-regular modify target; atomic replacement failure; symlink parent; absolute/traversal path; case collision; unsupported extension; oversized bundle; abort during Git creation/write/replacement; cleanup after partial failure; changed source HEAD; concurrent source change; and no writes in the caller's checkout.

- [ ] **Step 2: Run and observe missing implementation**

Run: `pnpm --filter @lineageguard/validation vitest run test/generated-patch-worktree.test.ts`
Expected: FAIL resolving the worktree module.

- [ ] **Step 3: Implement safe creation, atomic writes, hash verification, and cleanup**

Use argument-array process spawning for allowlisted Git commands; do not invoke a shell. Pass the active signal to every Git child and filesystem phase. Resolve every parent with `realpath` and reject symlinks/cross-root results. For `CREATE`, require absence and use exclusive creation. For `MODIFY`, open only a regular non-symlink file, hash and compare it with `expectedBaseSha256`, write the replacement to an exclusively created sibling temporary file, fsync it, atomically rename it over the checked target, then re-resolve and hash it. Abort removes temporary files and the isolated worktree under a separate bounded cleanup signal. Return paths relative to the isolated root only.

- [ ] **Step 4: Run tests under a temporary Git fixture**

Run: `pnpm --filter @lineageguard/validation test -- generated-patch-worktree`
Expected: PASS and the source fixture remains byte-identical.

- [ ] **Step 5: Commit worktree isolation**

```bash
git add packages/validation/src/worktree packages/validation/test/generated-patch-worktree.test.ts packages/validation/src/index.ts
git commit -m "feat(validation): isolate generated patch materialization"
```

---

### Task 6: Run one live bounded generation and review F5

**Files:**
- Create: `packages/agent/test/live/canonical-generation.test.ts`
- Create: `examples/canonical/model-generation-receipt.json`
- Create: `apps/worker/src/orchestration/steps/plan-migration.ts`
- Create: `apps/worker/src/orchestration/steps/materialize-patch.ts`
- Create: `apps/worker/test/migration-steps.integration.test.ts`
- Modify: `docs/AGENT_HARNESS.md`
- Modify: `docs/SOURCES.md`

- [ ] **Step 1: Write the live integration assertion before using an API key**

Require schema-valid plan/patch, known evidence subset, allowed paths, bounded token/elapsed budget, redaction check, and semantic equivalence to the canonical strategy primitives. Do not require byte-identical model prose.

- [ ] **Step 2: Run without access and observe the explicit credential error**

Run: `OPENAI_TEST_MODE=live pnpm --filter @lineageguard/agent test:integration -- canonical`
Expected: FAIL fast with `OPENAI_API_KEY is required`; ordinary tests remain green.

- [ ] **Step 3: Run one approved live call and store only the redacted receipt**

Run: `OPENAI_TEST_MODE=live pnpm --filter @lineageguard/agent test:integration -- canonical`
Expected: PASS; receipt records model name, fingerprints, token counts, duration, schema result, and redaction result but no prompt payload or secret.

- [ ] **Step 4: Wire the combined candidate into two restart-safe worker transitions**

`plan-migration.ts` invokes the single combined agent once with `context.signal`, persists the entire validated candidate through F4's transaction-aware transition callback, and transitions `RISK_DECIDED -> MIGRATION_PLANNED`. `materialize-patch.ts` reads that persisted candidate without another model call, passes the identical signal through Git/filesystem work, creates/verifies the isolated patch, and transitions `MIGRATION_PLANNED -> PATCH_GENERATED`. A crash after either persistence boundary resumes without regenerating different output; abort/lease loss commits nothing from the stale worker, while typed terminal agent/schema errors transition to `FAILED_GENERATION`.

- [ ] **Step 5: Run worker transition and restart tests**

Run: `pnpm --filter @lineageguard/worker test -- migration-steps`
Expected: PASS for exact state/event order, one model call, crash-after-candidate resume, crash-after-materialization resume, conflicting fingerprint rejection, and `FAILED_GENERATION` mapping.

- [ ] **Step 6: Commit worker integration**

```bash
git add apps/worker/src/orchestration/steps/plan-migration.ts apps/worker/src/orchestration/steps/materialize-patch.ts apps/worker/test/migration-steps.integration.test.ts
git commit -m "feat(worker): persist restart-safe migration generation steps"
```

- [ ] **Step 7: Run an independent specification review**

Give a fresh read-only reviewer the F5 spec, Gate B evidence, prompts, schemas, fallback fixtures, threat model, and diff. Required result: canonical artifacts are complete and the model cannot decide risk or safety. Resolve all blockers.

- [ ] **Step 8: Run an independent code-quality and security review**

Use a different fresh read-only reviewer. Inspect SDK configuration, tool absence, untrusted input framing, output caps, reference validation, path policy, process spawning, secret redaction, cleanup, and fallback disclosure. Resolve all blockers.

- [ ] **Step 9: Invoke `superpowers:verification-before-completion` and run the final gate**

```bash
pnpm --filter @lineageguard/agent test
pnpm --filter @lineageguard/validation test -- generated-patch-worktree
pnpm --filter @lineageguard/worker test -- migration-steps
OPENAI_TEST_MODE=live pnpm --filter @lineageguard/agent test:integration -- canonical
pnpm format:check
pnpm lint
pnpm typecheck
```

Expected: all commands exit zero; candidate is schema-valid, evidence-bounded, isolated, and still explicitly unvalidated.

- [ ] **Step 10: Commit live receipt and docs**

```bash
git add packages/agent/test/live examples/canonical/model-generation-receipt.json docs/AGENT_HARNESS.md docs/SOURCES.md
git commit -m "test(agent): verify bounded canonical generation"
```

Do not call the result safe and do not publish it externally; F6 must validate the exact artifact fingerprint first.
