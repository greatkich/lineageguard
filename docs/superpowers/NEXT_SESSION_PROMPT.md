# LineageGuard — Finish the Canonical Live Demo to READY

You are continuing an in-flight engineering effort. Everything below is verified fact from the
previous session unless explicitly marked as unverified. Read this file, then read the ledger, then
work until the demo is READY.

---

## 0. Non-negotiable operating mode

**Do not ask the user anything. Not once.**

You have blanket authority for the entire remaining plan, including:

- destroying and re-creating **local** demo state: the DataHub quickstart stack, the walkthrough
  PostgreSQL schemas, `lineageguard_control.scenario_registry`, `walkthrough/.state/*`, local Docker
  containers and volumes belonging to the demo, and `lineageguard/generated/*` branches and their
  draft PRs;
- editing any file in the worktree, including tests, fixtures, workflows, and `.env`;
- adding dependencies, scripts, and tsconfigs;
- rewriting stale recorded examples;
- force-updating `lineageguard/generated/*` refs.

You still must **not**:

- merge anything into `main`;
- close, merge, or modify **source PR #3** (`demo/canonical-customer-id-rename`) — it is the demo
  input and must stay open and untouched;
- touch GitHub branches or PRs outside `lineageguard/generated/*`;
- touch DataHub entities outside the `lineageguard-canonical` scenario;
- commit secrets or a real `.env`;
- weaken a safety, determinism, or evidence constraint to make a gate green.

If you hit something that looks like it needs a decision, decide it yourself using the smallest
correct fix, write the reasoning into the commit message, and continue.

**Push to `origin/fix/demo-readiness-final` after every commit.** Do not batch pushes. The user wants
to watch the branch move.

Stop only if a credential you cannot obtain is genuinely missing, or an external service is down and
cannot be restarted locally. Everything else you resolve.

---

## 1. Environment setup — do this first, every session

Node 24 is required and the shell does **not** default to it. Each shell invocation needs:

```bash
export PATH="$HOME/.nvm/versions/node/v24.18.0/bin:$PATH"
cd /Users/igorgarkusha/Documents/development/lineageguard/.claude/worktrees/fix+demo-readiness-final
```

Verify with `node --version` → must print `v24.18.0`. `.node-version` pins `24.18.0`;
`scripts/environment-policy.mjs` enforces `/^v24\./`; `package.json` engines require
`>=24.0.0 <25.0.0`. All three already agree — do not relax any of them.

The worktree `.env` exists and is gitignored. It was assembled last session and contains DataHub
tokens copied from the main checkout plus these added keys:

```
GITHUB_TOKEN (from `gh auth token`), GITHUB_OWNER=greatkich, GITHUB_REPO=lineageguard,
GITHUB_BASE_BRANCH=main, LINEAGEGUARD_REPOSITORY=greatkich/lineageguard, SOURCE_PR_NUMBER=3,
LINEAGEGUARD_DATABASE_URL=postgresql://lineageguard:lineageguard@127.0.0.1:5432/lineageguard,
LINEAGEGUARD_VALIDATION_RUNNER_IMAGE_ID=sha256:d560978d9201cc93c5ac84c203897fe4b1a02d59dcf53e02d6c31fe43a3eb46f,
LINEAGEGUARD_VALIDATION_POSTGRES_IMAGE_ID=sha256:b9982e1879d4dbe29a6dbf7d4f86289bfb29df08f741e2f2167e2e128b95ed27,
LINEAGEGUARD_DOCKER_EXECUTABLE=/usr/local/bin/docker,
LINEAGEGUARD_EXECUTABLE_INTEGRATION=1,
WALKTHROUGH_{ADMIN,QUERY,INGEST,DBT}_POSTGRES_USER/PASSWORD, WALKTHROUGH_POSTGRES_USER=lineageguard_seed
```

If `.env` is gone, rebuild it the same way. The four walkthrough role principals are **fixed names**
enforced by `tools/datahub/src/lineageguard_datahub/config.py`: `lineageguard_query`,
`lineageguard_ingest`, `lineageguard_dbt`, `lineageguard_seed`. They must be distinct principals.
That is a least-privilege constraint — do not point them all at the superuser.

Python tooling always needs:

```bash
LINEAGEGUARD_WALKTHROUGH_ENV=canonical LINEAGEGUARD_SKIP_SERVER_IDENTITY=1 LINEAGEGUARD_POSTGRES_MODE=local
```

CI is intentionally on `workflow_dispatch` only (commit `fd9d2b5`) because the hosted runner has no
DataHub, no seeded PostgreSQL, and no validation images. Leave it disabled until the demo is READY;
`ci.yml` carries the exact lines to reinstate.

---

## 2. Read these, in order

1. `.superpowers/sdd/2026-08-07-canonical-live-demo-completion/progress.md` — the full ledger with
   every root cause and reproduction command. **This is the most important file.**
2. `/Users/igorgarkusha/Downloads/LINEAGEGUARD_MVP_DEMO_COMPLETION_PLAN_UPDATED.md` — authoritative spec.
3. `docs/superpowers/plans/2026-08-07-canonical-live-demo-completion.md` — the task plan.
4. `AGENTS.md` and `CLAUDE.md` — operating contract, including the CRITICAL size and reuse rules.

---

## 3. Verified state at `fd9d2b5`

All gates green on Node 24.18.0 from a shell that **legitimately holds** `DATAHUB_TOKEN` and
`GITHUB_TOKEN`, with **no `env -u` anywhere**:

```
format:check 0 | lint 0 | typecheck 0 | test 0 (495 passed, 34 skipped) | build 0
test:e2e 0 (9 passed) | walkthrough:verify 0
```

Proven live:

- **8/8 validation checks PASS on real Docker containers.** 7/7 integration tests, including three
  negative cases proving a broken migration, broken compatibility, and broken rollback are each
  refused through the same public path. Reproduce (~120s, do **not** set a 30-minute timeout):
  ```bash
  npx vitest run packages/validation/src/executable.integration.test.ts
  ```
- **`demo:preflight` 19/19 READY.**
- **Source binding works.** PR #3 read, allowlist accepted it, real SHAs `d130fd2..1be5ee5`, source
  fingerprint `6c981734adda`, selected path `walkthrough/migrations/001_rename_customer_id.sql`,
  baseline decision **ALLOW**.

Already built and committed, do not rebuild:

- `SourceChangeEnvelope` + seven typed rejection codes + `assertNoSourceDrift` wired at
  `BEFORE_VALIDATION` and `BEFORE_PUBLICATION` (drift → `FAILED_VALIDATION` / `FAILED_GITHUB`, and
  `createReview` is never called);
- `assertExactlyFourConsumers` enforced in the pipeline before `consumersFound` is persisted and in
  the evidence exporter, which re-derives and refuses on disagreement;
- UUID identifiers at every layer with regression tests that fail if `bigint` returns;
- content-addressed effect identity in `apps/worker/src/effect-identity.ts`
  (`lineageguard/generated/pr-3-<prefix>`, `lineageguard:decision:v1:candidate-<prefix>`);
- allowlisted authority environments so the validator never inherits orchestration credentials;
- `scripts/`, `tests/` under `pnpm typecheck` via `tsconfig.scripts.json`;
- `demo:preflight`, `demo:bootstrap`, `demo:verify`, `demo:repeat`, `demo:reset`, `demo:golden`,
  `demo:run`, `regenerate:canonical-example`.

---

## 4. The one blocker — resolve it immediately and without asking

`demo:run` reaches Step 3 and fails with `FAILED_CONTEXT`. All six MCP tools succeed when called
directly, so the adapter and `mcp-server-datahub` 3.4.6 are fine. **The graph is incompletely
seeded:**

- `get_dataset_queries` on `analytics.customer_revenue` returns `total: 0` — the canonical Finance
  SYSTEM query entity is absent, and the reader requires exactly one match;
- `search` returns two datasets: the canonical
  `…lineageguard-canonical.lineageguard.commerce.orders` and a duplicate
  `…lineageguard-canonical.commerce.orders` missing the database segment, so `get_lineage` reports
  six downstreams and risks `AMBIGUOUS`.

Re-seeding is blocked because local walkthrough state is **triple-stale**:

| Source | Value |
|---|---|
| `lineageguard_control.scenario_registry.ownership_nonce` | `88b88503a07fa11d…` |
| `walkthrough/.state/ownership-state.json` | `22351d5e11010e77…` |
| `walkthrough/.state/datahub-target.json` | binds a DataHub instance id that no longer exists |

All three non-destructive recovery paths refuse, correctly:

| Command | Refusal |
|---|---|
| `warehouse-seed --execute` | `WAREHOUSE_OWNERSHIP_MISMATCH` |
| `reset --execute --confirm canonical-customer-id-rename` | `TARGET_INSTANCE_ID_MISMATCH` |
| `bootstrap-target --execute --confirm canonical-customer-id-rename` | `TARGET_BOOTSTRAP_CANONICAL_URN_EXISTS` |

**Your instruction: take option B, then A if needed. Do not ask.**

**Option B (preferred, cleanest):** recreate the DataHub quickstart stack from scratch so the
instance id and the graph are both fresh, then run the full chain. Roughly:

```bash
docker ps --format '{{.Names}}' | grep '^datahub'          # inventory first
# tear down the datahub-* quickstart stack and its volumes
rm -rf walkthrough/.state                                   # orphaned attestations
# drop the control schema so warehouse-seed can establish a fresh nonce:
docker exec lineageguard-app-postgres-1 psql -U lineageguard -d lineageguard \
  -c "DROP SCHEMA IF EXISTS lineageguard_control CASCADE;"
# bring DataHub back up, wait for GMS /config to answer, then:
pnpm demo:bootstrap
```

Only touch containers whose names begin with `datahub` or `lineageguard`. Leave every `supabase_*`
container alone — they belong to an unrelated project on this machine.

**Option A (if B is impractical):** drop `lineageguard_control.scenario_registry` and
`walkthrough/.state` together, then `pnpm demo:bootstrap`.

Either way, `demo:bootstrap` must end with the Query entity present and the duplicate dataset
reconciled away. Verify with a direct MCP probe that `get_dataset_queries` returns `total: 1` and
`search` returns exactly one dataset before moving on.

---

## 5. Then finish the plan, in this order

Commit and push after each numbered item.

1. **Live `COMPLETED`.** `pnpm demo:run` must exit 0 with final status `COMPLETED`. Expect further
   real defects on first contact — diagnose the root cause, apply the smallest correct fix, add
   regression coverage, commit. Do not skip a stage to get green.
2. **`pnpm demo:verify --runId <id>`** must pass every check independently.
3. **`pnpm demo:repeat -- --count 3`** must give `COMPLETED` three times with: exactly one generated
   PR identity, exactly one DataHub decision identity, four consumers each run, zero duplicate
   effects, zero leaked containers, zero leaked worktrees.
4. **Wire the worker onto `LiveGitHubPort`.** `apps/worker/src/orchestration.ts` currently has its
   own direct-REST publisher; the hardened port in `packages/github` (authority checks, exact-bytes
   verification, `CREATED`/`UPDATED`/`SKIPPED_EXACT`) is not on the demo path. The file header
   already claims otherwise — that comment is stale. Both branches are content-addressed now, so
   this is about applying the real guarantees, not naming.
5. **Compatibility matrix.** Drive all eight behaviours against a live PostgreSQL: old-only insert
   populates `buyer_id`; new-only populates `customer_id`; equal dual accepted; conflicting dual
   rejected; updating either side syncs the other; backfill safe; `buyer_id` NOT NULL only after
   backfill; `customer_id` retained. The trigger exists; the coverage does not.
6. **Failure matrix.** Source drift and wrong consumer count are covered. Add: DataHub unavailable,
   malformed MCP response, MCP tool failure, missing dashboard lineage, invalid LLM output, mutated
   candidate after validation, validator image unavailable, GitHub publication conflict, DataHub
   read-back mismatch, duplicate side-effect attempt, reset touching an unrelated entity. Each must
   prove no prohibited later side effect ran.
7. **Golden run.** From a documented clean baseline: bootstrap → repeat ×3 → one final run →
   `demo:verify` → `pnpm demo:golden`. Regenerate `examples/canonical-run/` **only** from that live
   run. Capture Mission Control screenshots at 1440×900. Assert no `PLACEHOLDER`/`TODO`/`TBD`
   remains under `examples/canonical-run/`.
8. **Docs and report.** Update `README.md` with the demo quick-start, add
   `docs/demo-walkthrough.md` and `docs/troubleshooting.md`, write
   `artifacts/demo-runs/FINAL_EXECUTION_REPORT.md` with real commands, exit codes, fingerprints,
   URLs, versions, run ids, and remaining limitations. Run a secret scan over all artifacts.
9. **Re-enable CI** in `ci.yml` (the file says exactly how), confirm all gates green, push.
10. **Open the PR** with `gh pr create --base main`. **Do not merge.**

---

## 6. Rules that already caught me out — honour them

- **`pnpm typecheck` covers `scripts/` and `tests/`.** Any new demo script is gated. Good.
- **Class limit is 300 lines, not files.** 42 of 242 TS files already exceed 300; only two classes
  do (`LiveGitHubPort` 702, `InternalValidationSecurityBoundary` 370) and they are grandfathered
  under a ratchet: modify freely, never grow. Functions: 50 lines, with a measured ratchet capped at
  36 repo-wide violations. New code complies from the start. Full text in `AGENTS.md`.
- **Never source executable SQL from `canonicalExpandMigrationSql` / `canonicalRollbackSql`.** Those
  are *normalized comparison forms* that lowercase `TG_OP`; PostgreSQL reports it uppercase, so the
  compatibility trigger silently never fires. Generate artifacts from `buildCanonicalCandidate` via
  `pnpm regenerate:canonical-example`.
- **`String.replace` treats `$$` specially.** SQL full of `$$` gets mangled by a literal replacement
  string. Use a replacer function.
- **Semantic fingerprints must exclude volatile fields.** `retrievedAt`, response digests, and
  endpoints are stripped in `semanticPayload`; including them makes `impactContextFingerprint`
  depend on wall-clock time and breaks the three-run proof.
- **Do not solve credential leakage with `env -u`.** The authority runtimes project an allowlisted
  environment. Orchestration credentials are dropped; cross-role authority credentials are carried
  through on purpose so a mis-composed process is still rejected.
- **Test the emitted value, not the source text.** A prose mention of `gen_random_uuid()` in a
  comment failed a naive source-text assertion.

---

## 7. Definition of READY

Fresh evidence for all of:

```
PR #3 → ALLOW → live DataHub → exactly 4 consumers → BLOCK → UUID-safe migration
→ 8/8 PASS → exact generated GitHub PR → verified DataHub memory → COMPLETED
→ repeat ×3 → golden run → recording-ready
```

plus `syntheticLiveEvidenceCount = 0`, exact read-after-write verified, unrelated metadata
preserved, no placeholders in golden evidence, and every ordinary gate green:

```bash
pnpm format:check && pnpm lint && pnpm typecheck && pnpm test && pnpm build && pnpm test:e2e
uv run --project tools/datahub pytest
```

Only when all of that holds do you produce the final report with verdict **READY** in the format at
the end of the authoritative spec. If it does not hold, keep working — do not report an intermediate
status as if it were completion.

---

## 8. First five commands

```bash
export PATH="$HOME/.nvm/versions/node/v24.18.0/bin:$PATH"
cd /Users/igorgarkusha/Documents/development/lineageguard/.claude/worktrees/fix+demo-readiness-final
node --version && git log --oneline -3 && git status --short
cat .superpowers/sdd/2026-08-07-canonical-live-demo-completion/progress.md
pnpm demo:preflight
```

Then go straight to section 4 and unblock the graph. Work until READY. Push after every commit.
Do not ask the user anything.
