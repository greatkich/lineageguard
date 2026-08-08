# Final PR #8 Release Gate

**Date:** 2026-08-08

**Branch:** `fix/demo-readiness-final`

**PR:** https://github.com/greatkich/lineageguard/pull/8

**Accepted runtime commit (`FINAL_ACCEPTANCE_CODE_SHA`):**
`c589f69580c6c56744703ec089554df117e6b0dd`

**Golden run:** `run_000000000000019fe1aafd0a`

**Verdict:** **READY**

The report and refreshed golden files form an evidence-only change after acceptance. They do not
change the accepted runtime code SHA above, and the expensive LIVE sequence was not rerun after
writing them.

## Final gates

| Gate | Result |
|---|---|
| Environment preflight | PASS — 19/19 |
| `pnpm format:check` | PASS — 227 files |
| `pnpm lint` | PASS — 49 warnings and 3 infos, no errors |
| `pnpm typecheck` | PASS — all workspaces plus scripts |
| `pnpm test` | PASS — 586 passed, 43 skipped |
| `pnpm build` | PASS |
| `pnpm test:e2e` | PASS — 9 passed, 1 LIVE-only skipped |
| `uv run --project tools/datahub pytest` | PASS — 113 passed |
| Final manual CI | PASS — run [31260514610](https://github.com/greatkich/lineageguard/actions/runs/31260514610) |

The final manual CI was triggered with `workflow_dispatch` against the exact accepted runtime commit
and completed successfully. CI remains manual-only. Hosted CI covers deterministic gates; the
external-service-backed acceptance below was executed locally.

## Environment

| Component | Observed version |
|---|---|
| Node.js | v24.18.0 |
| pnpm | 11.20.0 |
| Python | 3.12.13 |
| uv | 0.11.32 |
| Docker | 29.6.2 |
| Docker Compose | v5.3.1 |
| PostgreSQL | 17.10 |
| DataHub OSS | v1.6.0 |

The stale local DataHub target attestation was recovered fail-closed. Only the disposable
`datahub` Compose project and LineageGuard-owned walkthrough schemas, roles, and local receipts were
recreated. The canonical seed then passed 8/8; the two final bootstrap checks both used the verified
idempotent fast path and passed 2/2.

## Immutable application code binding

Every accepted repeat run, the golden run, the canonical example, the replay manifest, the run
summary, `commit-sha.txt`, `environment.txt`, and the screenshot manifest name the same runtime SHA:

```text
c589f69580c6c56744703ec089554df117e6b0dd
```

Acceptance began from an empty `git status --porcelain`. Repeat and verification reject any HEAD or
tracked source/config change. Golden generation permits dirt only below the fixed evidence roots
`artifacts/demo-readiness`, `artifacts/demo-runs`, and `examples/canonical-run`.

## Canonical LIVE result

```text
Source PR:             #3, OPEN
Source head:           1be5ee50f14ba2d31122dc8d21e71eb516a2bf78
Source fingerprint:    6c981734adda29d0d6d86dc1f71411505b40a3993316690f49217e629bb0f08e
Baseline decision:     ALLOW
DataHub decision:      BLOCK
Consumer groups:       4
Synthetic evidence:    0
Generated artifacts:   8
Validation:            8/8 PASS
GitHub effect outcome: SKIPPED_EXACT
Write-back:            SUCCEEDED
Final status:          COMPLETED
```

The four consumer groups are `DATA_MODEL`, `DASHBOARD`, `ML_CONSUMER`, and `UNMANAGED_QUERY` in the
canonical order. The deterministic risk rules were `LG001`, `LG002`, `LG003`, and `LG004`.

## GitHub effect identity and zero-write replay

| Binding | Accepted value |
|---|---|
| Generated PR | https://github.com/greatkich/lineageguard/pull/7 |
| PR state | OPEN + DRAFT |
| Branch | `lineageguard/generated/pr-3-55e099499756` |
| Head commit | `3c9237679b5161ba5d4d236897b01e0e76e62e23` |
| Publication base | `290ce411bfd5372e82063fea9f1f8ca861d36442` |
| Candidate identity | `55e099499756f132e673f1459bb6ed0ad52782434edf96e7acfea891cdf2e72f` |

`main` advanced after publication, so exact reconciliation additionally proved that the immutable
publication base is the merge base and an ancestor of the current target head. It then verified the
single-parent commit, symmetric tree delta, eight blob byte payloads, and exact PR base/head/repository
bindings. All accepted repeats returned `SKIPPED_EXACT`; no GitHub mutation request was issued.

## Repeatability — 19/19

| Run | Status | Code SHA | GitHub outcome |
|---|---|---|---|
| `run_000000000000019fe1a6cc83` | COMPLETED | `c589f69580c6…` | SKIPPED_EXACT |
| `run_000000000000019fe1a7f6a6` | COMPLETED | `c589f69580c6…` | SKIPPED_EXACT |
| `run_000000000000019fe1a90cfe` | COMPLETED | `c589f69580c6…` | SKIPPED_EXACT |

Across all three runs:

- application SHA, source, impact-context, candidate, PR, branch, and head identities were stable;
- 4 consumers were found with 0 synthetic LIVE evidence items;
- all 8 validation checks passed;
- write-back succeeded;
- DataHub contained exactly one decision identity and one decision document;
- no duplicate LineageGuard metadata, leaked validator containers, or leaked worktrees remained.

Each run then passed an independent `demo:verify`: **45/45, 45/45, and 45/45**. Verification re-read
source PR #3, the generated PR/commit/tree/blobs, DataHub institutional memory, and persisted
validation observations instead of trusting the run status.

## Golden recording — 6/6

The separate LIVE run `run_000000000000019fe1aafd0a` completed with `SKIPPED_EXACT`, passed
`demo:verify` 45/45, and passed `demo:golden` 6/6. The screenshot directory contains exactly eight
non-empty PNG files plus a manifest naming the run, `LIVE` mode, `COMPLETED` status, and the accepted
runtime SHA:

1. `01-baseline-allow`
2. `02-datahub-consumers`
3. `03-allow-to-block`
4. `04-uuid-migration`
5. `05-validation-pass`
6. `06-generated-pr`
7. `07-datahub-writeback`
8. `08-completed-summary`

## DataHub write-back

The semantic decision identity is
`lineageguard:decision:v1:candidate-55e099499756f132`. Read-after-write verification found exactly
one matching decision document, decision `BLOCK`, the PR #7 link, rollback reference
`walkthrough/migrations/001_rollback.sql`, the latest verified run binding, and the canonical
Reviewed tag. Repeated runs refreshed the verified-run reference without creating another semantic
decision.

## Integrity and security

- PR #8 pointed to the exact accepted runtime SHA when the final CI and LIVE sequence ran.
- PR #7 remained OPEN+DRAFT at the same branch and head commit.
- `git diff --check` passed.
- `.env` and `.env.local` are not tracked.
- A high-confidence secret scan covered 41 changed and evidence files and found 0 credentials,
  private keys, JWTs, AWS keys, Slack tokens, or secret assignments.
- No credentials were copied from `.env` into the acceptance worktree or evidence bundle; protected
  runtime attestation files remain ignored.

## Evidence locations

- Golden run snapshot: `artifacts/demo-runs/run_000000000000019fe1aafd0a/golden-run.json`
- Evidence bundle: `artifacts/demo-readiness/`
- Eight LIVE screenshots and manifest: `artifacts/demo-readiness/screenshots/`
- Canonical replayable example: `examples/canonical-run/`
- Fixture-only UI screenshots: `artifacts/test-fixtures/screenshots/` (not acceptance evidence)

## Remaining scope limits

- One high-polish scenario only: `commerce.orders.customer_id` → `buyer_id`.
- CI intentionally remains manual-only and cannot exercise DataHub, GitHub writes, or the local
  content-addressed validation containers.
- Production still requires human approval for external mutations; autonomous merge is not enabled.
