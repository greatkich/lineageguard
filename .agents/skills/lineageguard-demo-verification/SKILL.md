---
name: lineageguard-demo-verification
description: Use before claiming the canonical LineageGuard demo works, before recording, after deployment changes, or when preparing deterministic replay artifacts.
---

# LineageGuard Demo Verification

## Required context

Read:

- `docs/DEMO_STORYBOARD.md`
- `docs/WINNING_STRATEGY.md`
- `AGENTS.md`

## Verification order

1. Start or reset the documented stack from a clean state.
2. Verify DataHub health and the canonical field-level graph.
3. Verify the unsafe PR/scenario and repository-only `ALLOW` result.
4. Run the full live workflow.
5. Confirm final `BLOCK` cites the expected hidden consumers.
6. Confirm generated migration artifacts exist and match the run manifest.
7. Run SQL/dbt/compatibility validators and inspect actual outputs.
8. Confirm GitHub review receipt.
9. Confirm DataHub write-back receipt and open the resulting entity/document.
10. Run Playwright at 1440 × 900 and inspect screenshots, console, and network failures.
11. Generate replay only from this validated live run.
12. Time the complete recording script and ensure it remains under three minutes.

## Completion evidence

Report exact commands and observed results. Include artifact paths, run ID, commit SHA, DataHub URNs, GitHub URL/receipt, and screenshot paths. Do not declare success based on a previous run or a mocked integration.
