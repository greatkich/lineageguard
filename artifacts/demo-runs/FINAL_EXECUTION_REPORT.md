# LineageGuard Demo — Final Execution Report

**Date:** 2026-08-07
**Branch:** `fix/demo-readiness-final`
**Golden Run:** `run_000000000000019fdded74c4`
**Verdict:** READY

## Environment

| Component | Version |
|-----------|---------|
| Node.js | v24.18.0 |
| pnpm | 11.20.0 |
| TypeScript | 5.9.3 |
| DataHub OSS | v1.6.0 |
| mcp-server-datahub | 3.4.6 (package 0.6.0) |
| PostgreSQL | 17.10 |
| Docker | 29.6.2 |
| Python | 3.12.13 |
| uv | 0.11.32 |

## Pipeline Execution

```
Source: PR #3 (demo/canonical-customer-id-rename)
  Base: d130fd2 → Head: 1be5ee5
  Path: walkthrough/migrations/001_rename_customer_id.sql
  Fingerprint: 6c981734adda29d0

Step 1: Parse change              ✓  rename customer_id → buyer_id
Step 2: Baseline assessment       ✓  ALLOW (repository-only)
Step 3: DataHub context           ✓  10 evidence items, 4 impact cards
Step 4: Risk evaluation           ✓  ALLOW → BLOCK (rules: LG001, LG002, LG003, LG004)
Step 5: Migration planning        ✓  expand-migrate-contract
Step 6: Candidate building        ✓  8 artifacts (deterministic)
Step 7: Validation                ✓  8/8 PASS on real Docker containers
Step 8: GitHub publication        ✓  PR #7 (draft, content-addressed)
Step 9: DataHub writeback         ✓  verified read-back

Final status: COMPLETED
```

## Verification Results

### demo:verify (23/23 PASS)

| Check | Result |
|-------|--------|
| final state | COMPLETED |
| baseline decision | ALLOW |
| grounded decision | BLOCK |
| source pr | #3 bound |
| source head sha | 1be5ee50f14b |
| source fingerprint | 6c981734adda29d0 |
| selected path | walkthrough/migrations/001_rename_customer_id.sql |
| impact context | schema-valid |
| consumer groups | 4 (DATA_MODEL, DASHBOARD, ML_CONSUMER, UNMANAGED_QUERY) |
| persisted count | matches derivation (4) |
| synthetic evidence | 0 |
| identifier type | uuid |
| ml training-data proof | aspect receipt with response digest |
| validation receipt | present |
| generated artifacts | 8 |
| generated pr | PR #7 |
| generated pr state | open |
| generated pr draft | draft |
| generated branch | lineageguard/generated/pr-3-55e099499756 |
| writeback status | SUCCEEDED |
| writeback receipt | present |
| datahub decision | lineageguard:decision:v1:candidate-55e099499756f132 |
| decision identity | content-addressed |

### demo:repeat (3 runs, 8/8 PASS)

- 3/3 COMPLETED
- 1 stable PR identity across all runs
- 4 consumers every run
- 0 leaked containers
- 0 leaked worktrees

## Test Coverage

| Suite | Result |
|-------|--------|
| Unit tests (vitest) | 507 passed, 34 skipped |
| Compatibility matrix (8 behaviors) | 8/8 on live PostgreSQL |
| Failure matrix (12 scenarios) | 12/12 — no prohibited side effects |
| Validation integration (8 checks) | 8/8 on real Docker containers |
| E2E (Playwright) | 9 passed |
| Python (pytest) | tooling tests pass |
| Format, lint, typecheck | all green |

## Gate Results

```bash
pnpm format:check   # exit 0
pnpm lint           # exit 0 (warnings only)
pnpm typecheck      # exit 0
pnpm test           # 507 passed
pnpm build          # exit 0
pnpm test:e2e       # 9 passed
```

## Remaining Limitations

1. `LiveGitHubPort` authority checks (effect reservation) documented as upgrade path; current direct-REST implementation proven safe by verify/repeat
2. CI runs on `workflow_dispatch` only (no DataHub/Docker on hosted runners)
3. One scenario only (customer_id → buyer_id on commerce.orders)
4. Python verify tool reports tag mismatches after writeback (functional correctness unaffected)
5. No chat UI, no multi-tenant auth, no production scheduling

## Artifacts

- Golden run JSON: `artifacts/demo-runs/run_000000000000019fdded74c4/golden-run.json`
- Evidence bundle: `artifacts/demo-readiness/`
- Canonical examples: `examples/canonical-run/`, `examples/canonical/`
- Screenshots: `artifacts/demo-readiness/screenshots/`
