# LineageGuard Demo — Final Execution Report

**Date:** 2026-08-07
**Branch:** `fix/demo-readiness-final` (PR #8)
**Golden run:** `run_000000000000019fde42c1f0`
**Verdict:** READY

Every number below was produced by a command run in this worktree and is reproducible from the
persisted run record. Where something was *not* verified, this report says so rather than implying
coverage it does not have.

## Environment

| Component | Version |
|-----------|---------|
| Node.js | v24.18.0 |
| pnpm | 11.20.0 |
| TypeScript | 5.9.3 |
| DataHub OSS | v1.6.0 |
| mcp-server-datahub | 3.4.6 (package 0.6.0) |
| PostgreSQL | 17 (container `lineageguard-app-postgres-1`) |
| Docker | 29.6.2 |
| Python | 3.12.13 |
| uv | 0.11.32 |

## Two kinds of verification — do not conflate them

This project has two verification surfaces with genuinely different reach.

**1. Deterministic gates (GitHub Actions capable, run locally here).**
`format:check`, `lint`, `typecheck`, `test`, `build`, `test:e2e`. These need no external service.
The E2E suite renders Mission Control against a *seeded fixture run*, not a live execution.

**2. Live acceptance (local / external-service-backed only).**
`demo:run`, `demo:verify`, `demo:repeat`, `demo:golden`. These require a reachable DataHub GMS with
the canonical graph seeded, the walkthrough PostgreSQL, content-addressed validator images in the
local Docker daemon, and a GitHub credential. **GitHub Actions does not and cannot run these.** No
claim in this report about DataHub, the generated pull request, or container-backed validation is
supported by CI.

CI is currently on `workflow_dispatch` only. The hosted runner cannot exercise the live path, and
re-proving only the deterministic gates on every push spends a runner for no added signal. `ci.yml`
carries the exact lines to restore automatic runs.

## Pipeline execution (golden run)

```
Source: PR #3 (demo/canonical-customer-id-rename)
  Base: d130fd2 → Head: 1be5ee5
  Selected path: walkthrough/migrations/001_rename_customer_id.sql
  Source envelope identity: 6c981734adda29d0

Step 1: Parse change              ✓  rename customer_id → buyer_id
Step 2: Baseline assessment       ✓  ALLOW (repository-only)
Step 3: DataHub context           ✓  10 evidence items, 4 impact cards
Step 4: Risk evaluation           ✓  ALLOW → BLOCK (LG001, LG002, LG003, LG004)
Step 5: Migration planning        ✓  expand-migrate-contract
Step 6: Candidate building        ✓  8 artifacts (deterministic)
Step 7: Validation                ✓  8/8 PASS in real Docker containers
Step 8: GitHub publication        ✓  PR #7 (draft, content-addressed branch)
Step 9: DataHub write-back        ✓  verified by read-after-write

Final status: COMPLETED
```

Fingerprints (from `examples/canonical-run/manifest.json`):

| Binding | Value |
|---|---|
| candidate identity | `55e099499756f132e673f1459bb6ed0ad52782434edf96e7acfea891cdf2e72f` |
| validation receipt | `c4509c49d4aed1741fdb739df06954f25da0d2ffe7574bddf2b9062c11eff9e4` |
| github receipt | `418bbe6cab085efeab82738bfa8a7709a5c28a20e57b42a18eee47075ca73976` |
| writeback receipt | `c54c1acbdec586b4e72c8c7f2329597fd482cf86c961d5367e0f24ad756e3091` |
| DataHub decision identity | `lineageguard:decision:v1:candidate-55e099499756f132` |

## Independent verification — `demo:verify` 43/43

`demo:verify` does not trust the run's status field, and does not treat the presence of a receipt as
proof that the effect it describes exists. It re-reads the systems that were supposed to change:

- **Source.** Re-reads PR #3, confirms the live head still equals the analysed head, and rebuilds the
  source envelope through the same `buildCanonicalSourceEnvelope` the worker binds runs with,
  comparing the re-derived identity to the persisted one.
- **Validation.** Inspects the persisted receipt *body*: exactly eight canonical checks, every one
  PASS, an observation for every artifact whose digest matches the candidate bytes, and a receipt
  bound to the candidate identity re-derived from the stored candidate.
- **GitHub.** Walks PR → commit → tree → blobs. Confirms open + draft, that the branch name is the
  one derived from the candidate, that the commit has exactly one parent equal to the validated base,
  that the tree delta against that parent is *exactly* the eight artifact paths and nothing else, and
  that every generated blob is byte-identical to the validated artifact.
- **DataHub.** Reads institutional memory and tags. Confirms exactly one decision identity, exactly
  one decision document, that the marker equals the identity derived from this run's candidate, the
  decision value, the GitHub URL, the rollback reference, that the run named in the document exists
  and completed, that the document's validation receipt prefixes that run's receipt, that the
  canonical Reviewed tag is attached, and that no LineageGuard tag is duplicated.

A failure to inspect is a failed check. Docker, worktree, GitHub, and DataHub inspection all return
an explicit result; none degrades to an empty list.

## Repeatability — `demo:repeat --count 3` 16/16

Run from a clean baseline (`pnpm demo:reset` first).

| Run | ID | Status |
|---|---|---|
| 1 | `run_000000000000019fde397c7e` | COMPLETED |
| 2 | `run_000000000000019fde3a85d0` | COMPLETED |
| 3 | `run_000000000000019fde3b8e7c` | COMPLETED |

| Invariant | Observed |
|---|---|
| all runs completed | 3/3 |
| distinct run ids | 3 |
| source fingerprint | identical (`6c981734adda29d0`) |
| impact-context fingerprint | identical (`a44ffdb760b53fee`) |
| candidate fingerprint | identical (`55e099499756f132`) |
| consumers | 4 every run |
| validation | 8/8 every run |
| generated PR identity | 1 (`.../pull/7`) |
| DataHub decision identity | 1 (`…candidate-55e099499756f132`) |
| DataHub decision documents | 1 |
| duplicate LineageGuard tags | 0 |
| leaked validator containers | 0 |
| leaked validation worktrees | 0 |

Each of the three run IDs was then independently verified: **43/43 each**.

## Golden recording — `demo:golden` 6/6

Captured from `run_000000000000019fde42c1f0`, a real LIVE run. The recording suite seeds nothing and
refuses any run that is not a COMPLETED LIVE run; `demo:golden` exits non-zero unless verification,
export, all eight screenshots, the exact screenshot count, and the manifest all succeed.

`artifacts/demo-readiness/screenshots/` — eight states at 1440×900, plus `manifest.json` naming the
run they came from:

1. `01-baseline-allow` — baseline ALLOW in workspace context
2. `02-datahub-consumers` — the four DataHub downstream consumers
3. `03-allow-to-block` — ALLOW → BLOCK
4. `04-uuid-migration` — UUID-safe expand–migrate–contract strategy
5. `05-validation-pass` — validation PASS
6. `06-generated-pr` — the generated pull request link
7. `07-datahub-writeback` — write-back SUCCEEDED
8. `08-completed-summary` — final COMPLETED summary

Fixture UI renders live separately under `artifacts/test-fixtures/screenshots/` and are explicitly
not submission evidence.

## Test coverage

| Suite | Result | Needs external services? |
|---|---|---|
| Unit + contract (vitest) | 519 passed, 42 skipped | no |
| Playwright E2E | 9 passed, 1 skipped¹ | no (fixture-seeded) |
| Python tooling (pytest) | 113 passed | no |
| Validation integration (8 checks) | 8/8 | yes — Docker |
| Compatibility matrix (8 behaviours) | 8/8 | yes — PostgreSQL |
| Failure matrix (12 scenarios) | 12/12 | no |

¹ The skipped spec is the LIVE golden-recording suite, which is skipped unless
`LINEAGEGUARD_GOLDEN_RUN_ID` names a live run. `demo:golden` supplies it and independently asserts
the resulting files exist, so a skip can never be mistaken for captured evidence.

The 42 skipped unit tests are integration suites gated behind explicit environment flags
(`LINEAGEGUARD_TEST_MIGRATION_DATABASE_URL`, `LINEAGEGUARD_EXECUTABLE_INTEGRATION`) plus the
role-separated durable-store suite, which needs several distinct database principals.

## Gate results

```bash
pnpm format:check                      # exit 0 — 223 files
pnpm lint                              # exit 0 — 48 style warnings, no errors
pnpm typecheck                         # exit 0 — 9 projects + scripts/ + tests/
pnpm test                              # 519 passed, 42 skipped
pnpm build                             # exit 0
pnpm test:e2e                          # 9 passed, 1 skipped
uv run --project tools/datahub pytest  # 113 passed
pnpm demo:verify                       # 43/43
pnpm demo:repeat -- --count 3          # 16/16
pnpm demo:golden -- --runId <run>      # 6/6
```

Generated evidence under `artifacts/**` and `examples/canonical-run/**` is excluded from Biome, so
those files stay byte-identical to what the exporter wrote rather than being reformatted by a linter.

## Remaining limitations

1. `LiveGitHubPort`'s authority checks (effect reservation, exact-bytes verification) remain a
   documented upgrade path. The demo path uses a direct-REST publisher; its output is verified after
   the fact by `demo:verify`'s commit/tree/blob comparison rather than by pre-flight authority.
2. CI is `workflow_dispatch` only and covers deterministic gates only. It does not verify DataHub,
   the generated PR, or container-backed validation.
3. The generated commit's SHA is not reproducible across runs, because Git commit identity includes
   the commit timestamp. The branch name, the pull request, the tree, and every blob *are*
   content-addressed and stable; `demo:verify` therefore proves published content, and treats a
   moved head as acceptable only when the byte-level checks still pass.
4. One scenario only (`customer_id` → `buyer_id` on `commerce.orders`).
5. The Python `verify` tool reports tag mismatches after write-back; functional correctness is
   unaffected and is covered by `demo:verify`'s DataHub read-back.
6. No chat UI, no multi-tenant auth, no production scheduling.

## Artifacts

- Golden run snapshot: `artifacts/demo-runs/run_000000000000019fde42c1f0/golden-run.json`
- Current evidence bundle: `artifacts/demo-readiness/` (regenerated by `pnpm export-evidence`)
- Recording screenshots + manifest: `artifacts/demo-readiness/screenshots/`
- Canonical example: `examples/canonical-run/`
- Fixture UI renders (not evidence): `artifacts/test-fixtures/screenshots/`
- Superseded blocked-baseline report: `artifacts/historical/2026-08-07-blocked-baseline/`
