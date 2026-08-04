# LineageGuard Implementation Plan Index

> **For agentic workers:** REQUIRED SUB-SKILL: Use `superpowers:subagent-driven-development` (recommended) or `superpowers:executing-plans` to implement these plans task-by-task. Invoke `superpowers:using-git-worktrees` before the first implementation task.

**Goal:** Deliver the one canonical LineageGuard vertical slice through independently testable F0-F10 feature plans before the 2026-08-10 deadline.

**Architecture:** Follow the accepted TypeScript-first hybrid architecture and deterministic control-plane ADRs. Merge gate-first: prove real DataHub context and the decision flip before generation, validation, external mutations, UI polish, replay, or submission work.

**Tech Stack:** Node.js 24.18.0, pnpm 11.20.0, TypeScript 6.0.3, Next.js 16.2.12, React 19.2.8, PostgreSQL 17.10, OpenAI Agents SDK 0.14.2, Zod 4.4.3, DataHub OSS 1.6.0, MCP server 0.6.0, Python 3.12.13, uv 0.11.32, dbt Core 1.12.0, dbt-postgres 1.11.0, Biome 2.5.6, Vitest 4.1.10, Playwright 1.62.1.

## Global Constraints

- The planning packet was approved on 2026-08-04 for local F0 execution only; stop after F0 verification/review and do not begin F1 automatically.
- The visible contract of four impact cards plus two lineage intermediates is accepted; F1's checked expectation fixture must control the count used by F3/F9 and storyboard copy.
- One writer owns a worktree at a time; reviewers are read-only until findings return.
- No feature branch targets `main` directly without its specification and code-quality gates.
- The deterministic engine owns both baseline and grounded verdicts.
- DataHub mutation capabilities are structurally unavailable during context collection.
- Generated code is never called safe before F6 returns a matching `PASS` receipt.
- Production external mutations require explicit human approval.
- Replay must be captured from a receipt-bearing real run.
- The canonical rename is the only polished scenario.
- Check Run, SSE, a second polished scenario, and upstream contribution are outside the P0 critical path.

---

## Plan set

1. [F0 — Repository foundation](./2026-08-03-f0-repository-foundation.md)
2. [F1 — Canonical DataHub graph](./2026-08-03-f1-canonical-datahub-graph.md)
3. [F2 — Proposed change parser](./2026-08-03-f2-proposed-change-parser.md)
4. [F3 — DataHub context collector](./2026-08-03-f3-datahub-context-collector.md)
5. [F4 — Deterministic risk engine](./2026-08-03-f4-deterministic-risk-engine.md)
6. [F5 — Migration planner and artifacts](./2026-08-03-f5-migration-planner.md)
7. [F6 — Executable validation](./2026-08-03-f6-executable-validation.md)
8. [F7 — GitHub review artifact](./2026-08-03-f7-github-review-artifact.md)
9. [F8 — Controlled DataHub write-back](./2026-08-03-f8-datahub-writeback.md)
10. [F9 — Mission Control UI](./2026-08-03-f9-mission-control-ui.md)
11. [F10 — Replay, deployment, and submission](./2026-08-03-f10-submission-readiness.md)

## Merge and execution order

```text
F0 -> F1 -> F3 -> F4 -> F5 -> F6 -> F7 -> F8 -> F9 -> F10
       \-> F2 -/
```

- F2 may run beside F1 only after F0 merges and only in a separate worktree with disjoint ownership.
- F7 must merge before F8 starts because F8 consumes the accepted GitHub port and canonical receipt; this preserves an exact Gate D fingerprint chain.
- F9 may build a shell after F4 view/event contracts freeze, but final UI acceptance waits for F7/F8 receipts.

## Mandatory feature handoff sequence

For every linked plan:

- [ ] Create the named worktree and feature branch from the latest accepted dependency.
- [ ] Execute each task red-green-refactor with the listed commands.
- [ ] Commit each independently testable task with the listed focused message.
- [ ] Dispatch a fresh read-only specification reviewer; resolve every blocking finding.
- [ ] Dispatch a different fresh read-only code-quality reviewer; resolve every blocking finding.
- [ ] Invoke `superpowers:verification-before-completion` and run the exact final gate.
- [ ] Attach command output, external receipt IDs where applicable, and the final diff to the PR/task report.
- [ ] Merge only after evidence passes, then create dependent worktrees from the updated base.

## Stop conditions

- Stop after F1 if a human cannot see the checked canonical graph in real DataHub.
- Stop after F4 if the canonical decision is not exactly baseline `ALLOW` and grounded `BLOCK` with evidence IDs.
- Stop after F6 if the canonical patch does not pass or the broken fixture does not fail.
- Stop before video recording until F7 and F8 have real verified receipts.
- Stop feature growth at noon Europe/Madrid on 2026-08-09.
