# F10 Evaluation, Replay, Deployment, and Submission Readiness Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use `superpowers:subagent-driven-development` (recommended) or `superpowers:executing-plans` to implement this plan task-by-task. Invoke the project `lineageguard-demo-verification` and `lineageguard-submission-readiness` skills for the final pass. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Deliver a reproducible, receipt-backed canonical evaluation, public read-only replay, healthy hosted URL, clean-start proof, English submission package, and sub-three-minute video before the 2026-08-10 deadline.

**Architecture:** Evaluation consumes the same domain inputs and engine as production. Replay is captured from persisted live state only after F6-F8 receipts and validates through the same `RunView` schema as the UI. Deployment separates public replay from a private operator-live profile; only Caddy/web are public. One verifier checks hashes, provenance, state sequence, secrets, browser smoke, and external receipt shapes.

**Tech Stack:** Node.js 24.18.0, pnpm 11.20.0, TypeScript 6.0.3, Python 3.12.13/uv 0.11.32, Docker Compose v2 or v5 via `docker compose`, Caddy, Playwright 1.62.1, `ffprobe`.

## Global Constraints

- Branch `feat/f10-submission-readiness` starts from accepted F9 and all Gates A-D.
- The canonical rename is the only polished UI scenario; the negative eval is command-line/test evidence only.
- Replay cannot be hand-authored and cannot omit receipt/provenance failures.
- Public mode is read-only and works without exposing OpenAI, GitHub, DataHub, PostgreSQL, worker, or approval capabilities.
- Operator live mode is reachable only through an approved private access path; no DataHub default port is public.
- Repository, public URL, examples, and video remain reachable through the judging window ending 2026-08-31.
- Stop feature growth at noon Europe/Madrid on 2026-08-09; after that, only acceptance blockers may change.

---

### Task 1: Implement canonical and compact negative evaluations

**Files:**
- Create: `evals/schema.ts`
- Create: `evals/canonical.json`
- Create: `evals/negative-missing-owner.json`
- Create: `evals/evaluate.ts`
- Create: `evals/evaluate.test.ts`
- Create: `evals/baseline-vs-grounded.json`
- Modify: `package.json`

**Interfaces:** `EvaluationCase` contains checked change/evidence fixture paths and exact assertions; `EvaluationResult` records engine/package versions, input hashes, observed assessments, evidence-reference completeness, plan schema result, and validation receipt result.

- [ ] **Step 1: Write failing evaluation-runner tests**

Require canonical baseline `ALLOW`/`LOW`, grounded `BLOCK`, valid evidence references, schema-valid plan, exact validation `PASS`, and deterministic output. Negative case removes critical-asset owner and asserts LG005 `REVIEW` where no blocking evidence is present. Test stale hash, unknown assertion, model call attempt, missing fixture, and result drift.

- [ ] **Step 2: Run and observe missing evaluator**

Run: `pnpm vitest run evals/evaluate.test.ts`
Expected: FAIL resolving `evaluate.ts` dependencies/fixtures.

- [ ] **Step 3: Implement the runner against imported production functions**

Do not duplicate policy or validation logic. Canonical evaluation may consume the stored F6 receipt after verifying its artifact/input hashes. Emit a stable JSON report; exclude wall-clock values from comparison or inject a fixed evaluation clock. Own `"eval": "node evals/evaluate.ts"` in `package.json`.

- [ ] **Step 4: Run evaluations twice and compare output**

Run: `pnpm eval && pnpm eval`
Expected: both exit zero and leave byte-identical `evals/baseline-vs-grounded.json`.

- [ ] **Step 5: Commit evaluation evidence**

```bash
git add evals package.json
git commit -m "test(evals): prove grounded canonical risk delta"
```

---

### Task 2: Capture a provenance-complete replay from the real run

**Files:**
- Create: `scripts/capture-replay.ts`
- Create: `scripts/capture-replay.test.ts`
- Create: `examples/canonical/migration-plan.json`
- Create: `examples/canonical/generated.patch`
- Create: `examples/canonical/validation-receipt.json`
- Create: `examples/canonical/github-review-receipt.json`
- Create: `examples/canonical/datahub-writeback-receipt.json`
- Create: `examples/canonical/provenance.json`
- Create: `examples/replay/canonical-run.json`
- Create: `examples/README.md`
- Modify: `package.json`

**Interfaces:** `captureReplay(runId, sourceCommit): Promise<{ runView; provenance }>` loads a transactionally consistent completed run and validates every receipt/hash before writing via explicit output paths.

`provenance.json` records source run ID/commit, normalized input fingerprint, artifact hashes, the public GitHub receipt URL, the DataHub document URN/fingerprint without its private UI host, capture timestamp, DataHub/MCP/package versions, schema versions, mode, and redaction confirmation.

- [ ] **Step 1: Write failing capture and tamper tests**

Cover valid completed run, missing F6/F7/F8 receipt, non-PASS validation, mismatched fingerprint/hash, stale source commit, uncommitted product diff, secret/token pattern, private URL in public replay, nonterminal event sequence, raw MCP payload, output outside `examples/`, and root-script ownership/argument rejection for `replay:capture`.

- [ ] **Step 2: Run and observe missing capture script**

Run: `pnpm vitest run scripts/capture-replay.test.ts`
Expected: FAIL resolving the capture module.

- [ ] **Step 3: Implement capture, canonical serialization, and redaction gate**

Write through Node filesystem APIs only after validating an explicit repository-relative allowlist; use atomic temporary files under `examples/` then rename. Recompute hashes after write and parse replay through the production `RunViewSchema`. Never synthesize an absent receipt. Own `"replay:capture": "node scripts/capture-replay.ts"` in `package.json`; the CLI accepts exactly `--run-id <validated-id>` and rejects unknown arguments.

- [ ] **Step 4: Capture the approved real run**

Run: `pnpm replay:capture --run-id "$LINEAGEGUARD_CANONICAL_RUN_ID"`
Expected: exit zero, print source run/fingerprint, and produce schema-valid examples whose receipt URLs/IDs match F7/F8.

- [ ] **Step 5: Run tamper tests and inspect the diff**

Run: `pnpm vitest run scripts/capture-replay.test.ts && git diff --check -- examples`
Expected: PASS; generated example diff contains no secrets or raw service payloads.

- [ ] **Step 6: Commit the replay as evidence**

```bash
git add package.json scripts/capture-replay.ts scripts/capture-replay.test.ts examples
git commit -m "docs(examples): capture receipt-backed canonical replay"
```

---

### Task 3: Build the one-command deterministic demo verifier

**Files:**
- Create: `scripts/demo-verify.ts`
- Create: `scripts/demo-verify.test.ts`
- Create: `scripts/check-secrets.ts`
- Create: `scripts/check-public-receipts.ts`
- Create: `scripts/check-canonical-sequence.ts`
- Modify: `package.json`
- Modify: `pnpm-workspace.yaml`

**Interfaces:** `pnpm demo:verify` is non-mutating and checks schema versions, fixture/provenance hashes, secret patterns, the exact accepted canonical state sequence, evidence references, safe readiness from matching F6 `PASS` at `VALIDATED` independent of later receipts, external receipt URL shape, and a replay UI smoke test.

- [ ] **Step 1: Write failing verifier tests for each sabotage fixture**

Create temporary test copies with stale hash, missing receipt, altered decision, dangling evidence, absent intermediate, invented count, secret-like token, private/public URL mismatch, unvalidated safe label, reordered invalid state, and schema drift. Each must exit nonzero with one stable code.

- [ ] **Step 2: Run and observe missing verifier**

Run: `pnpm vitest run scripts/demo-verify.test.ts`
Expected: FAIL resolving verifier modules.

- [ ] **Step 3: Implement composable read-only checks**

The secret scanner covers known token/key/private-key/credential URL patterns with a documented allowlist for obvious test strings. Public receipt checker allows only HTTPS and approved origins. Browser smoke starts the replay app on a reserved local port, waits for readiness, opens the canonical run, and asserts the completed status without updating screenshots.

- [ ] **Step 4: Run verifier and sabotage suite**

Run: `pnpm vitest run scripts/demo-verify.test.ts && pnpm demo:verify`
Expected: PASS for committed evidence; every sabotage case fails with its asserted code.

- [ ] **Step 5: Commit one-command verification**

```bash
git add scripts/demo-verify.ts scripts/demo-verify.test.ts scripts/check-secrets.ts scripts/check-public-receipts.ts scripts/check-canonical-sequence.ts package.json pnpm-workspace.yaml
git commit -m "test(demo): add deterministic replay verification gate"
```

---

### Task 4: Prove clean-start reproducibility

**Files:**
- Create: `scripts/clean-start-verify.sh`
- Create: `tests/foundation/clean-start.test.ts`
- Modify: `README.md`
- Modify: `CODEX_START_PROMPT.md`
- Modify: `package.json`

**Interfaces:** `pnpm clean-start:verify` creates a task-specific temporary clone at the current commit, installs with locked files, runs environment checks plus repository gates, and removes only its validated temporary directory on success/failure.

- [ ] **Step 1: Write failing test for clean-tree and lock enforcement**

Cover missing lockfile, dirty committed-generation dependency, wrong Node/Python, Docker unavailable, insufficient disk, package install drift, missing README command, and a failure that preserves the temp path in output for debugging while never touching the source checkout.

- [ ] **Step 2: Run and observe missing command**

Run: `pnpm vitest run tests/foundation/clean-start.test.ts`
Expected: FAIL because `clean-start-verify.sh` is absent.

- [ ] **Step 3: Implement a safe temporary-clone verifier**

Use `mktemp -d`, resolve and validate the returned path, clone from the current repository/commit, run `corepack pnpm install --frozen-lockfile`, `uv sync --project tools/datahub --locked`, and the documented gates. Never delete a workspace root, `$HOME`, `~`, or an unresolved variable. Own `"clean-start:verify": "bash scripts/clean-start-verify.sh"` in `package.json`.

- [ ] **Step 4: Run clean-start on the approved host**

Run: `pnpm clean-start:verify`
Expected: exit zero from a fresh clone, with exact commit and tool versions printed and no source-worktree changes.

- [ ] **Step 5: Commit reproducibility instructions**

```bash
git add scripts/clean-start-verify.sh tests/foundation/clean-start.test.ts README.md CODEX_START_PROMPT.md package.json
git commit -m "docs: prove clean-start demo reproducibility"
```

---

### Task 5: Deploy separate public replay and private operator modes

**Files:**
- Create: `deploy/compose.demo.yaml`
- Create: `deploy/Caddyfile`
- Create: `deploy/README.md`
- Create: `deploy/backup.sh`
- Create: `deploy/restore-verify.sh`
- Create: `tests/deploy/compose-policy.test.ts`
- Create: `tests/deploy/health.test.ts`
- Create: `apps/web/app/health/live/route.ts`
- Create: `apps/web/app/health/ready/route.ts`
- Modify: `docs/DECISIONS/ADR-005-demo-deployment-and-exposure.md`

**Interfaces:** Compose profiles are `public-replay` and `operator-live`. Public ingress exposes only 80/443 to Caddy and web on a private network. Operator/DataHub/PostgreSQL/worker ports bind to loopback/private network only. `/health/live` checks web process; `/health/ready` validates replay/schema/provenance in public mode and required private dependencies in operator mode.

- [ ] **Step 1: Write failing rendered-compose and route tests**

Assert immutable/pinned images, restart policy, health checks, named volumes, no public DataHub/GMS/PostgreSQL/worker port, no secret literal, public replay env lacks all mutation/API credentials, mutation route returns 404 in public mode, operator profile requires secrets, and unhealthy/stale replay makes readiness fail.

- [ ] **Step 2: Run and observe missing deployment files**

Run: `pnpm vitest run tests/deploy/compose-policy.test.ts tests/deploy/health.test.ts`
Expected: FAIL because deployment/health files are absent.

- [ ] **Step 3: Implement profiles and ADR-005**

Use an approved Linux host meeting E0 (at least 30 GB free; recommended contingency 4 vCPU, 16 GiB RAM, 80 GB disk). Caddy terminates TLS for `LINEAGEGUARD_PUBLIC_HOST`. Public web loads committed replay and has no write ports. Operator live mode is reached through SSH tunnel/private access, uses server-established operator identity, and keeps DataHub private. Document backup location/retention, restore drill, credential rotation, and replay degradation.

- [ ] **Step 4: Run local rendered-config tests**

Run: `docker compose -f deploy/compose.demo.yaml --profile public-replay config --quiet && pnpm vitest run tests/deploy`
Expected: PASS with no forbidden published port or secret value.

- [ ] **Step 5: Deploy only after the host/DNS/TLS target is approved**

Run: `docker compose -f deploy/compose.demo.yaml --profile public-replay up -d --wait`
Expected: all public-replay services healthy; `docker compose ... ps` shows only Caddy ports publicly bound.

- [ ] **Step 6: Verify health, exposure, restart, backup, and restore**

```bash
curl --fail --silent --show-error "${LINEAGEGUARD_PUBLIC_BASE_URL}/health/live"
curl --fail --silent --show-error "${LINEAGEGUARD_PUBLIC_BASE_URL}/health/ready"
docker compose -f deploy/compose.demo.yaml --profile public-replay restart web
curl --fail --silent --show-error "${LINEAGEGUARD_PUBLIC_BASE_URL}/health/ready"
bash deploy/backup.sh
bash deploy/restore-verify.sh
```

Expected: both health endpoints return success before/after restart; backup/restore verification exits zero; an external port scan finds only approved ingress/SSH.

- [ ] **Step 7: Run an independent architecture/security review**

Give a fresh read-only reviewer ADR-005, rendered Compose, Caddy, routes, secret inventory names, network exposure evidence, backup/restore output, and diff. Resolve every blocking finding before public launch.

- [ ] **Step 8: Commit deployment definition and evidence documentation**

```bash
git add deploy tests/deploy apps/web/app/health docs/DECISIONS/ADR-005-demo-deployment-and-exposure.md
git commit -m "ops: define replay-only public demo deployment"
```

---

### Task 6: Prepare the English README, Devpost package, and video

**Files:**
- Modify: `README.md`
- Create: `docs/DEMO_SCRIPT.md`
- Create: `docs/SUBMISSION_CHECKLIST.md`
- Create: `docs/DEVPOST_SUBMISSION.md`
- Modify: `docs/DEMO_STORYBOARD.md`
- Modify: `docs/SOURCES.md`
- Create: `docs/submission-links.json`
- Create: `examples/canonical/screenshots/.gitkeep`
- Create: `scripts/verify-submission-links.ts`
- Create: `scripts/verify-submission-links.test.ts`
- Modify: `package.json`

- [ ] **Step 1: Write the content checklist and failing link-verifier tests**

Require English project description, DataHub usage, architecture diagram, canonical flow, clean-start command, demo verifier, public URL, video URL, public Apache-2.0 license, examples, limitations, replay disclosure, security model, current versions/sources, and no unmeasured benchmark claim.

Define a strict `docs/submission-links.json` inventory for repository, license, replay, examples, real PR receipt, hosted video, and submitted Devpost page. With fake fetch, test expected content markers, bounded redirects, timeout, DNS/private/loopback/link-local hosts, authentication challenge, 404/5xx, oversized body, wrong MIME/content, and a redirect from an allowed public URL to a private origin.

- [ ] **Step 2: Run the verifier test and observe the missing module**

Run: `pnpm vitest run scripts/verify-submission-links.test.ts`
Expected: FAIL resolving `scripts/verify-submission-links.ts`.

- [ ] **Step 3: Implement and own `submission:links:verify`**

Implement the verifier as an erasable-syntax-only Node 24 CLI with native `fetch`, strict Zod input, DNS/IP public-address checks before each request and redirect, HTTPS-only URLs, a five-second timeout, 256 KiB body cap, no cookies/authorization headers, and per-kind marker assertions. Add `"submission:links:verify": "node scripts/verify-submission-links.ts docs/submission-links.json"` to `package.json`; do not add a second TypeScript runner. Tests inject fetch/resolution adapters and perform no network access.

Run: `pnpm vitest run scripts/verify-submission-links.test.ts`
Expected: PASS for the fake signed-out public matrix and all unsafe cases denied.

- [ ] **Step 4: Draft and review the judge path**

README first viewport must state the problem, `ALLOW -> BLOCK -> SAFE WITH MIGRATION`, DataHub-specific evidence, public demo, video, and verifier. Devpost text explicitly addresses equally weighted DataHub usage, technical implementation, originality, usefulness, and submission quality; target categories are Agents That Do Real Work and Metadata-Aware Code Generation.

- [ ] **Step 5: Produce the timed video script and recording**

Target 2:35–2:50, English narration, one continuous canonical story, readable 1440x900 capture, no fake terminal animation, no secret/private tab. Show repo baseline, real DataHub evidence/lineage/query, deterministic block, safe artifacts, executable checks, GitHub receipt, DataHub write-back, and replay provenance.

- [ ] **Step 6: Verify local video duration and visual redaction**

Run: `ffprobe -v error -show_entries format=duration -of default=noprint_wrappers=1:nokey=1 "$LINEAGEGUARD_DEMO_VIDEO_FILE"`
Expected: numeric duration greater than 150 and less than 180 seconds. Review every frame transition for credentials, notifications, private URLs, and unreadable critical text before upload.

- [ ] **Step 7: Verify all links signed out**

Run: `pnpm submission:links:verify`
Expected: public repository, Apache-2.0 license, public replay, examples, real PR receipt, hosted video, and Devpost draft links all return expected content without authentication.

- [ ] **Step 8: Run an independent submission/specification review**

Give a fresh read-only reviewer the official rules snapshot, README, Devpost draft, script, video metadata, screenshots, public links, examples, and claim-to-evidence map. Required result: no rule gap, unsupported claim, hidden authentication dependency, or storyboard mismatch.

- [ ] **Step 9: Commit submission materials before feature freeze**

```bash
git add package.json scripts/verify-submission-links.ts scripts/verify-submission-links.test.ts README.md docs/DEMO_SCRIPT.md docs/SUBMISSION_CHECKLIST.md docs/DEVPOST_SUBMISSION.md docs/DEMO_STORYBOARD.md docs/SOURCES.md docs/submission-links.json examples/canonical/screenshots
git commit -m "docs: prepare and verify LineageGuard submission package"
```

---

### Task 7: Run final independent reviews, Gate F, and judging-period handoff

- [ ] **Step 1: Run a fresh independent specification review across F0-F10**

Provide all approved specs/plans, source-of-truth docs, ADRs, canonical evidence, live receipts, eval report, replay provenance, screenshots, README, and submission draft. Required result: every product invariant and judging requirement has observed evidence; resolve all blockers without adding scope.

- [ ] **Step 2: Run a different independent code-quality/security review**

Review the full diff for package boundaries, deterministic control, schema validation, untrusted inputs, command/path isolation, secret handling, external-effect gates/idempotency, public exposure, cleanup, logs, replay integrity, failure tests, and generated junk. Resolve all blocking findings.

- [ ] **Step 3: Invoke `superpowers:verification-before-completion` and run the repository gate**

```bash
pnpm format:check
pnpm lint
pnpm typecheck
pnpm test
pnpm build
pnpm test:e2e
pnpm demo:verify
uv run --project tools/datahub --locked pytest
pnpm clean-start:verify
```

Expected: every command exits zero in the current accepted worktree; Playwright screenshots match; no secret/generated junk is present.

- [ ] **Step 4: Run public production checks**

```bash
curl --fail --silent --show-error "${LINEAGEGUARD_PUBLIC_BASE_URL}/health/live"
curl --fail --silent --show-error "${LINEAGEGUARD_PUBLIC_BASE_URL}/health/ready"
pnpm submission:links:verify
```

Expected: all exit zero from a network outside the host and public mode remains read-only.

- [ ] **Step 5: Submit before the internal deadline and verify the confirmation**

Target submission: 2026-08-10 20:00 Europe/Madrid, three hours before the official 23:00 local cutoff. Save the submission confirmation URL/time in `docs/SUBMISSION_CHECKLIST.md`; do not change product behavior afterward unless the public demo is broken.

- [ ] **Step 6: Establish availability through 2026-08-31**

Record host billing/expiry, disk alert threshold, daily public health/link check owner, backup location, recovery command, replay fallback, and credentials rotation date. Perform and record signed-out checks on August 10, 17, 24, and 31.

- [ ] **Step 7: Commit only final evidence/document corrections**

```bash
git add docs/SUBMISSION_CHECKLIST.md README.md examples evals
git commit -m "docs: record final verified submission evidence"
```

Gate F is complete only after repository, clean-start, public URL, replay provenance, video duration, and signed-out submission checks are all observed—not inferred.
