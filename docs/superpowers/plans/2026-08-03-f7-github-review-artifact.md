# F7 GitHub Review Artifact Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use `superpowers:subagent-driven-development` (recommended) or `superpowers:executing-plans` to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Publish the exact Gate C artifacts to one deterministic branch and real draft pull request with evidence and validation receipts, then capture an idempotent replay receipt.

**Architecture:** `packages/github` exposes a narrow port with live and replay implementations. The live adapter uses GitHub REST endpoints through a bounded native-fetch client and a repository-scoped fine-grained PAT. External effect intent and receipts are persisted before/after calls so retries reconcile partial success. The P0 artifact is a branch plus draft PR; Check Runs are excluded because they require a GitHub App.

**Tech Stack:** Node.js 24.18.0 native `fetch`, TypeScript 6.0.3, Zod 4.4.3, PostgreSQL 17.10, Vitest 4.1.10, GitHub REST API version `2022-11-28`.

## Global Constraints

- Branch `feat/f7-github-review-artifact` starts from Gate C.
- Live integration requires an explicitly approved fine-grained token with only Metadata read, Contents read/write, and Pull requests read/write on `greatkich/lineageguard`.
- Generated PR base is exactly `demo/canonical-base`, never `main`.
- The demo base ref must point to the exact approved `CreateMigrationReviewInput.baseSha`; one-time creation is disabled by default and requires explicit operator configuration, while any existing mismatch fails closed.
- Generated head is `lineageguard/run-<first 16 fingerprint hex>`.
- Missing or mismatched F6 `PASS` receipt rejects before any network request.
- No autonomous merge, reviewer assignment, workflow-file changes, force push, issue creation, or Check Run.
- Replay is captured from the real public PR receipt and uses the same schema as live.
- The canonical public PR contains DataHub URNs, evidence IDs, and fingerprints only—never the private DataHub UI/GMS origin. A clickable DataHub link requires a separately approved genuinely public HTTPS origin; canonical deployment leaves that option disabled.
- Every port/client method accepts the active F4 signal; lease loss aborts fetches and cannot persist a stale receipt or transition.

---

### Task 1: Define the GitHub port and receipt schemas

**Files:**
- Create: `packages/github/src/port.ts`
- Create: `packages/github/src/schemas.ts`
- Create: `packages/github/src/errors.ts`
- Create: `packages/github/test/port.test.ts`
- Modify: `packages/github/src/index.ts`

**Interfaces:**

```ts
interface GitHubPort {
  getProposedChange(input: ProposedChangeLocator, options: { signal: AbortSignal }): Promise<RepositoryChangeInput>;
  createMigrationReview(input: CreateMigrationReviewInput, options: { signal: AbortSignal }): Promise<GitHubReviewReceipt>;
  findMigrationReview(idempotencyKey: string, options: { signal: AbortSignal }): Promise<GitHubReviewReceipt | null>;
}
```

`CreateMigrationReviewInput` includes repository, exact base/head SHAs, deterministic branch, patch bundle/hashes, F4 assessment, normalized evidence IDs, matching F6 receipt, and idempotency key. `GitHubReviewReceipt` includes repository, branch/ref SHA, PR number/URL/state/draft flag, base/head, input fingerprint, artifact hashes, and observed timestamp.

- [ ] **Step 1: Write failing strict-schema and precondition tests**

Cover canonical input, non-draft receipt, `main` base, branch outside prefix, mismatched validation fingerprint/hash, validation not `PASS`, foreign repository, malformed public URL, unknown receipt field, token-shaped value in persisted receipt, private DataHub URL/origin in public input, and pre-aborted signal.

- [ ] **Step 2: Run and observe missing contracts**

Run: `pnpm --filter @lineageguard/github vitest run test/port.test.ts`
Expected: FAIL resolving port/schema modules.

- [ ] **Step 3: Implement strict schemas and pure publication preflight**

Preflight recomputes all file hashes, validates the target repository/base/head names, derives branch and idempotency key, and returns typed `PUBLICATION_NOT_VALIDATED`, `ARTIFACT_HASH_MISMATCH`, or `TARGET_DENIED` before adapter selection.

- [ ] **Step 4: Run tests and typecheck**

Run: `pnpm --filter @lineageguard/github test -- port && pnpm --filter @lineageguard/github typecheck`
Expected: PASS.

- [ ] **Step 5: Commit the port contract**

```bash
git add packages/github/src/port.ts packages/github/src/schemas.ts packages/github/src/errors.ts packages/github/src/index.ts packages/github/test/port.test.ts
git commit -m "feat(github): define validated review artifact port"
```

---

### Task 2: Render deterministic branch content and PR body

**Files:**
- Create: `packages/github/src/pr-body.ts`
- Create: `packages/github/src/branch-manifest.ts`
- Create: `packages/github/test/pr-body.test.ts`
- Create: `packages/github/test/__snapshots__/pr-body.test.ts.snap`

**Interfaces:**
- `renderPullRequestBody(input): string`.
- `buildBranchManifest(input): readonly GitHubTreeEntry[]`.

- [ ] **Step 1: Write failing snapshot and escaping tests**

Require stable markers `<!-- lineageguard:<idempotency-key> -->`, baseline/final decision, rule/evidence references, compatibility window, owner review context, artifact table/hashes, validation receipt/checks, rollback summary, and provenance. Test Markdown/HTML injection, overlong untrusted values, links with disallowed hosts/schemes, raw MCP fields, token patterns, localhost/RFC1918/private DataHub origins, and an internal DataHub UI URL embedded in evidence.

- [ ] **Step 2: Run and observe missing renderers**

Run: `pnpm --filter @lineageguard/github vitest run test/pr-body.test.ts`
Expected: FAIL resolving renderer modules.

- [ ] **Step 3: Implement bounded escaped rendering**

Render only normalized public-domain fields; escape HTML and table delimiters; link only approved `https://github.com/greatkich/lineageguard/` URLs in the canonical configuration. Render DataHub evidence as URN/evidence ID/fingerprint text, never a private origin or UI URL. A future DataHub hyperlink is accepted only behind `EXPOSE_PUBLIC_DATAHUB_LINKS=true` plus a separately reviewed public-origin allowlist; that flag is absent/false for the canonical deployment. Cap the body below GitHub limits. Branch manifest includes generated artifacts and `docs/migrations/lineageguard-receipt.md`, never `.github/`, secrets, symlinks, or binaries.

- [ ] **Step 4: Review and accept the deterministic snapshot**

Run: `pnpm --filter @lineageguard/github test -- pr-body`
Expected: PASS; repeated rendering is byte-identical and redaction tests pass.

- [ ] **Step 5: Commit rendering**

```bash
git add packages/github/src/pr-body.ts packages/github/src/branch-manifest.ts packages/github/test/pr-body.test.ts packages/github/test/__snapshots__
git commit -m "feat(github): render evidence-rich migration pull request"
```

---

### Task 3: Implement a narrow GitHub REST client

**Files:**
- Create: `packages/github/src/github-client.ts`
- Create: `packages/github/src/http.ts`
- Create: `packages/github/test/github-client.test.ts`
- Create: `packages/github/test/fixtures/api/*.json`

**Interfaces:** Internal client methods are limited to:

- get repository/base ref and source contents;
- create blobs/tree/commit/ref for the deterministic branch;
- get an existing ref/tree;
- list/get/create/update draft pull requests;
- create/update one PR comment only if the body is intentionally split.

- [ ] **Step 1: Write failing HTTP contract tests with a fake fetch**

Assert `Accept: application/vnd.github+json`, `X-GitHub-Api-Version: 2022-11-28`, bearer header redaction, propagation of the exact caller signal, pre-abort, abort during fetch, timeout composition, pagination bounds, typed 401/403/404/409/422/429/5xx behavior, retry-after parsing, response size cap, schema validation, and denial of an unlisted endpoint/method.

- [ ] **Step 2: Run and observe missing client**

Run: `pnpm --filter @lineageguard/github vitest run test/github-client.test.ts`
Expected: FAIL resolving `github-client.js`.

- [ ] **Step 3: Implement endpoint-specific request functions**

Use `https://api.github.com` exactly, encode owner/repository/ref segments, pass the caller signal to every `fetch`, compose it with bounded timeouts, validate every response with local Zod schemas, allow at most three retry attempts for idempotent reads and explicit reconciled writes, and never log request headers/body content. Abort stops retries and discards any late response. Do not expose a generic request method from the package.

- [ ] **Step 4: Run client tests including rate-limit and lost-response cases**

Run: `pnpm --filter @lineageguard/github test -- github-client`
Expected: PASS with no real network calls.

- [ ] **Step 5: Commit the bounded REST client**

```bash
git add packages/github/src/github-client.ts packages/github/src/http.ts packages/github/test/github-client.test.ts packages/github/test/fixtures/api
git commit -m "feat(github): add narrow validated REST client"
```

---

### Task 4: Implement live/replay adapters and partial-effect reconciliation

**Files:**
- Create: `packages/github/src/idempotency.ts`
- Create: `packages/github/src/live-adapter.ts`
- Create: `packages/github/src/replay-adapter.ts`
- Create: `packages/github/test/contract/github.contract.ts`
- Create: `packages/github/test/retry.test.ts`
- Create: `packages/github/test/replay-adapter.test.ts`
- Create: `packages/db/src/schema/external-effect-receipts.ts`
- Create: `packages/db/src/repositories/external-effect-repository.ts`
- Create: `packages/db/src/migrations/0002_external_effect_receipts.sql`
- Create: `packages/db/test/external-effect-repository.integration.test.ts`

**Interfaces:** Idempotency key is SHA-256 over run ID, effect kind `GITHUB_REVIEW`, canonical target, and input fingerprint. Receipt storage has unique `(effect_kind, idempotency_key)` plus intent/started/succeeded/failed states.

- [ ] **Step 1: Write shared contract and reconciliation tests**

Cover absent demo base with initialization disabled, one-time exact demo-base initialization, existing demo-base SHA mismatch, new generated branch/PR, identical retry, receipt replay, branch-created/response-lost, commit-created/ref-lost, PR-created/response-lost, conflicting branch content, closed matching PR, multiple marker PRs, insufficient permission, rate limit, network outage, and abort at each remote boundary. Assert exactly one base ref, one generated branch, and one open draft PR after recoverable retries; abort persists no success receipt under a stale claim.

- [ ] **Step 2: Run and observe missing adapters/repository**

Run: `pnpm --filter @lineageguard/github vitest run test/contract/github.contract.ts test/retry.test.ts && pnpm --filter @lineageguard/db test:integration -- external-effect`
Expected: FAIL resolving new modules.

- [ ] **Step 3: Implement intent-first state and reconciliation algorithm**

Persist effect intent before network mutation. Verify `demo/canonical-base` equals the approved base SHA; only an explicitly enabled operator setup may create that ref when absent. On retry, inspect local receipt, deterministic generated ref, commit tree hashes, and PR marker. Reuse only exact matches; conflicting remote state is a typed `REMOTE_CONFLICT` requiring human resolution. The replay adapter parses a committed receipt and performs no network calls.

- [ ] **Step 4: Run contract, retry, and database tests**

Run: `pnpm --filter @lineageguard/github test && pnpm --filter @lineageguard/db test:integration -- external-effect`
Expected: PASS, including every lost-response boundary.

- [ ] **Step 5: Commit adapters and effect persistence**

```bash
git add packages/github packages/db
git commit -m "feat(github): reconcile idempotent draft PR effects"
```

---

### Task 5: Wire the worker publication step

**Files:**
- Create: `apps/worker/src/orchestration/steps/create-review-artifact.ts`
- Create: `apps/worker/test/create-review-artifact.integration.test.ts`
- Create: `scripts/demo-github-verify.ts`
- Modify: `package.json`

**Interfaces:** Worker step loads F4/F6 receipts transactionally and rechecks fingerprints. It records external-effect intent without inventing a run status, invokes the injected `GitHubPort` with `context.signal`, stores the receipt, then performs the accepted `VALIDATED -> REVIEW_ARTIFACT_CREATED` transition. Exhausted/non-retryable failures transition to `FAILED_GITHUB`; abort/lease loss is neither and commits no stale receipt/retry/transition.

- [ ] **Step 1: Write failing worker state/precondition tests**

Cover missing Gate C, stale patch, no token in live mode, replay mode, retryable adapter failure, exhausted/non-retryable adapter failure, retry from pending effect intent, receipt mismatch, and success. Assert retryable failure schedules a retry and remains `VALIDATED`; terminal publication failure transitions to `FAILED_GITHUB`; neither failure can transition to `REVIEW_ARTIFACT_CREATED`.

- [ ] **Step 2: Run and observe missing step**

Run: `pnpm --filter @lineageguard/worker vitest run test/create-review-artifact.integration.test.ts`
Expected: FAIL resolving worker step.

- [ ] **Step 3: Implement the step and verifier**

Own `"demo:github:verify": "node scripts/demo-github-verify.ts"` in `package.json`. The command validates marker, branch/tree hashes, draft/open state, base branch, receipt fingerprint, and public URL. It performs read-only verification and prints `github_review=verified` only on exact match.

- [ ] **Step 4: Run worker tests in replay mode**

Run: `GITHUB_MODE=replay pnpm --filter @lineageguard/worker test -- create-review-artifact`
Expected: PASS with no network access.

- [ ] **Step 5: Commit orchestration**

```bash
git add apps/worker scripts/demo-github-verify.ts package.json
git commit -m "feat(worker): publish validated GitHub review artifacts"
```

---

### Task 6: Create one approved real draft PR and close the F7 gate

**Files:**
- Create: `packages/github/test/live/canonical-pr.test.ts`
- Create: `examples/replay/github-review-receipt.json`
- Modify: `README.md`
- Modify: `docs/DEMO_STORYBOARD.md`
- Modify: `docs/SOURCES.md`

- [ ] **Step 1: Write the live assertion before using credentials**

Require exact repository/base/head prefix, open draft status, marker, tree hashes, validation receipt, evidence IDs, no secret patterns, public signed-out visibility, and second-call idempotency.

- [ ] **Step 2: Run without the token and observe the explicit error**

Run: `GITHUB_TEST_MODE=live pnpm --filter @lineageguard/github test:integration -- canonical`
Expected: FAIL fast with `LINEAGEGUARD_GITHUB_TOKEN is required`; ordinary tests remain green.

- [ ] **Step 3: With explicit authorization, run live creation twice and capture the redacted receipt**

Run: `GITHUB_TEST_MODE=live pnpm --filter @lineageguard/github test:integration -- canonical && GITHUB_TEST_MODE=live pnpm --filter @lineageguard/github test:integration -- canonical`
Expected: both PASS and return the same branch/PR receipt; no duplicate PR exists.

- [ ] **Step 4: Verify signed-out visibility and receipt**

Run: `pnpm demo:github:verify`
Expected: exit zero and print `github_review=verified`.

- [ ] **Step 5: Run an independent specification review**

Give a fresh read-only reviewer F7 spec, Gate C receipt, PR/tree/receipt, plan, and diff. Required result: the real artifact communicates exactly the accepted evidence and never targets `main`. Resolve blockers without creating extra PRs.

- [ ] **Step 6: Run an independent code-quality and security review**

Use a different fresh read-only reviewer. Inspect permissions, endpoint allowlist, input/output schemas, Markdown escaping, token handling, idempotency, partial effects, conflicts, target protections, and replay provenance. Resolve blockers.

- [ ] **Step 7: Invoke `superpowers:verification-before-completion` and run the final gate**

```bash
pnpm --filter @lineageguard/github test
pnpm --filter @lineageguard/db test:integration -- external-effect
GITHUB_TEST_MODE=live pnpm --filter @lineageguard/github test:integration -- canonical
pnpm demo:github:verify
pnpm format:check
pnpm lint
pnpm typecheck
```

Expected: all commands exit zero, one public draft PR is reconciled, and no Check Run is required.

- [ ] **Step 8: Commit replay receipt and documentation**

```bash
git add packages/github/test/live examples/replay/github-review-receipt.json README.md docs/DEMO_STORYBOARD.md docs/SOURCES.md
git commit -m "test(github): capture verified canonical review artifact"
```

F7 is complete only when the committed replay receipt refers to the same validated artifact hashes as Gate C.
