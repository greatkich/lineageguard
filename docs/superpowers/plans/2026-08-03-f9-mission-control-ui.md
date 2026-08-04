# F9 Mission Control UI Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use `superpowers:subagent-driven-development` (recommended) or `superpowers:executing-plans` to implement this plan task-by-task. Invoke `frontend-skill` before visual implementation and `superpowers:systematic-debugging` for browser failures. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Present the canonical run as one dense, legible operational workspace where a judge sees evidence before prose and follows `ALLOW -> BLOCK -> SAFE WITH MIGRATION` at 1440x900.

**Architecture:** Server code assembles a strict `RunView` from persisted domain state and receipts; React components only format it. The workspace uses three coordinated regions—proposed change, DataHub impact, migration/verification—with a compact status rail and persisted timeline. Public mode is replay/read-only; approval controls exist only through an injected operator identity in operator mode.

**Tech Stack:** Next.js 16.2.12 App Router, React 19.2.8, TypeScript 6.0.3, CSS tokens, Vitest 4.1.10, Playwright 1.62.1.

## Product and Visual Thesis

- **Visual thesis:** a calm, high-density evidence desk—mineral-white surfaces, ink typography, restrained dividers, and decision state as the single dominant visual signal.
- **Content plan:** compact run header and transition rail; source diff; normalized impact paths/cards; migration artifact/validation receipts; persisted event timeline.
- **Interaction thesis:** synchronized evidence-reference highlighting across regions; one restrained status transition when persisted state advances; timeline/detail disclosure that preserves spatial context.
- No hero, card mosaic, glass, decorative gradient, fake terminal, ornamental animation, or unsourced metric.
- Use one action accent; `ALLOW`, `BLOCK`, and verified readiness colors are semantic tokens, not competing decorative accents.
- Respect `prefers-reduced-motion`; no required information depends on animation or hover.

## Global Constraints

- Branch `feat/f9-mission-control-ui` starts from accepted F8. An earlier shell spike may start from F4 only in a separate disposable worktree and must not be merged without current F8 contracts.
- Every visible count, label, timestamp, path, status, and URL comes from `RunView` or a checked fixture.
- UI never calculates risk, readiness, validation result, or external-effect completion.
- `SAFE WITH MIGRATION · READY FOR REVIEW` requires exactly the persisted F6 `PASS` whose fingerprint matches the artifacts and accepted `VALIDATED` status; `riskDecision` remains `BLOCK`. F7/F8 receipts render as later progress and do not define readiness.
- Polling interval is one second only while the run is nonterminal and uses `ETag`/`If-None-Match`.
- Public replay mode has no functional mutation endpoint; operator approval requires server-established identity.
- Public replay exposes the GitHub receipt URL but only the DataHub document URN/fingerprint/status; private DataHub hostnames are stripped by `RunView` projection.
- Primary acceptance viewport is exactly 1440x900; 1280x720 and 390x844 receive smoke checks without displacing primary polish.

---

### Task 1: Define and assemble the read-only RunView contract

**Files:**
- Create: `packages/domain/src/run-view.ts`
- Create: `packages/domain/test/run-view.test.ts`
- Modify: `packages/domain/src/index.ts`
- Create: `apps/web/lib/run-view-model.ts`
- Create: `apps/web/lib/run-view-repository.ts`
- Create: `apps/web/test/run-view-model.test.ts`
- Create: `tests/e2e/fixtures/canonical-completed.json`
- Create: `tests/e2e/fixtures/canonical-approval-pending.json`

**Interfaces:**

```ts
interface RunView {
  runId: string;
  mode: "LIVE_OPERATOR" | "REPLAY_PUBLIC";
  status: RunStatus;
  readiness: "NOT_READY" | "SAFE_WITH_MIGRATION";
  proposedChange: ProposedChangeView;
  baseline: RiskAssessmentView;
  grounded: RiskAssessmentView;
  decisionDelta: DecisionDeltaView;
  impact: ImpactView;
  migration: MigrationView | null;
  validation: ValidationView | null;
  githubReview: ExternalReceiptView | null;
  datahubWriteback: ExternalReceiptView | null;
  timeline: readonly RunEventView[];
  updatedAt: string;
  version: number;
}
```

- [ ] **Step 1: Write failing schema and derivation tests**

Cover exact canonical view, the approval-gated impact count plus two intermediates, stable evidence references, `BLOCK` retained while readiness is safe, safe readiness immediately after matching F6 `PASS` without F7/F8 receipts, no safe readiness for absent/stale/failed validation, later GitHub/write-back progress, pending approval, replay mode, deterministic ordering, invalid URL, and no raw MCP/model payload fields.

- [ ] **Step 2: Run and observe missing view model**

Run: `pnpm --filter @lineageguard/domain vitest run test/run-view.test.ts && pnpm --filter @lineageguard/web vitest run test/run-view-model.test.ts`
Expected: FAIL resolving run-view modules.

- [ ] **Step 3: Implement strict public projection from repository records**

All status/readiness derivation is a pure domain projection: readiness requires accepted status `VALIDATED` or a later success status plus the exact matching F6 `PASS`; external publication/write-back fields are orthogonal. Web repository loads one transactionally consistent snapshot and strips internal errors, credentials, raw payloads, approval identity details, and unredacted logs.

- [ ] **Step 4: Validate checked fixtures through the same schema**

Run: `pnpm --filter @lineageguard/domain test -- run-view && pnpm --filter @lineageguard/web test -- run-view-model`
Expected: PASS; both e2e fixtures parse as `RunView` and every reference resolves.

- [ ] **Step 5: Commit the view contract**

```bash
git add packages/domain apps/web/lib apps/web/test tests/e2e/fixtures
git commit -m "feat(web): define evidence-backed run view"
```

---

### Task 2: Implement API, ETag polling, and operator approval boundary

**Files:**
- Create: `apps/web/app/api/runs/route.ts`
- Create: `apps/web/app/api/runs/[runId]/route.ts`
- Create: `apps/web/app/api/runs/[runId]/approve-writeback/route.ts`
- Create: `apps/web/lib/http/run-etag.ts`
- Create: `apps/web/lib/poll-run.ts`
- Create: `apps/web/lib/operator-identity.ts`
- Create: `apps/web/test/api-runs.test.ts`
- Create: `apps/web/test/poll-run.test.ts`
- Create: `apps/web/test/approve-writeback.test.ts`

**Interfaces:**
- `GET /api/runs` lists the one canonical launch/replay record.
- `POST /api/runs` starts canonical live run only in operator mode; replay returns 405.
- `GET /api/runs/:runId` returns `RunView`, `ETag: "run-<id>-v<version>"`, and `304` on exact `If-None-Match`.
- `POST /api/runs/:runId/approve-writeback` requires `OperatorIdentityProvider.requireIdentity` and exact current fingerprint, then calls F8's transactional `approveAndWake`; replay returns 404.

- [ ] **Step 1: Write failing route and polling tests**

Cover 200/304, stale ETag, not found, invalid run ID, replay mutation denial, missing/forged operator identity, stale fingerprint, duplicate approval, approval on a nonwaiting run, atomic approval+wake, unchanged retry count, CSRF/origin mismatch, request body cap, one-second interval, abort on navigation, terminal-state stop, transient retry with cap, and permanent typed failure.

- [ ] **Step 2: Run and observe missing route modules**

Run: `pnpm --filter @lineageguard/web vitest run test/api-runs.test.ts test/poll-run.test.ts test/approve-writeback.test.ts`
Expected: FAIL resolving handlers/utilities.

- [ ] **Step 3: Implement explicit mode and server-established identity checks**

The public deployment injects no operator identity provider and exposes replay data only. Operator deployment obtains identity from the trusted ingress/session adapter defined by ADR-005; never trust a body/header identity supplied directly from an untrusted client. Validate origin, run version, fingerprint, and effect, then use `ApprovalRepository.approveAndWake` so the immutable approval and exact waiting-run wake are one transaction. The route never schedules a worker retry directly.

- [ ] **Step 4: Run route/polling tests**

Run: `pnpm --filter @lineageguard/web test -- api-runs poll-run approve-writeback`
Expected: PASS with no database write in public replay mode.

- [ ] **Step 5: Commit API and polling**

```bash
git add apps/web/app/api apps/web/lib/http apps/web/lib/poll-run.ts apps/web/lib/operator-identity.ts apps/web/test
git commit -m "feat(web): expose safe run polling and approval APIs"
```

---

### Task 3: Establish layout, tokens, and the decision transition rail

**Files:**
- Create: `packages/ui/src/tokens.css`
- Create: `packages/ui/src/reset.css`
- Create: `packages/ui/src/components/status-badge.tsx`
- Create: `packages/ui/src/components/evidence-link.tsx`
- Modify: `packages/ui/src/index.ts`
- Modify: `apps/web/app/globals.css`
- Modify: `apps/web/app/layout.tsx`
- Create: `apps/web/components/status/decision-transition.tsx`
- Create: `apps/web/components/workspace/run-workspace.tsx`
- Create: `apps/web/test/decision-transition.test.tsx`

**Interfaces:** `DecisionTransition` accepts persisted baseline, grounded, readiness, and timestamps; `RunWorkspace` accepts one `RunView` and renders a semantic three-region grid.

- [ ] **Step 1: Write failing semantic/status tests**

Require a single page `h1`, ordered status labels, machine-readable/current step, unchanged `BLOCK` risk value, safe readiness prerequisites, accessible evidence links, reduced-motion class/state, and no component-local invented number.

- [ ] **Step 2: Run and observe missing components**

Run: `pnpm --filter @lineageguard/web vitest run test/decision-transition.test.tsx`
Expected: FAIL resolving components.

- [ ] **Step 3: Implement the 1440x900 composition before detail components**

Use a 56px run header, 52px transition rail, remaining viewport for a `minmax(300px, 0.9fr) minmax(420px, 1.25fr) minmax(390px, 1.1fr)` grid, 1px dividers, and one compact bottom timeline drawer. At narrower widths, preserve source-impact-migration order and permit page scroll. Typography uses at most two families; shadows are not required for hierarchy.

- [ ] **Step 4: Implement restrained motion**

On persisted version advance, animate only the status indicator/layout underline for 180–240ms; evidence link focus/selection uses a 120ms background transition; timeline disclosure uses a 160–220ms height/opacity transition. Disable all three under reduced motion.

- [ ] **Step 5: Run component tests and static CSS checks**

Run: `pnpm --filter @lineageguard/web test -- decision-transition && pnpm --filter @lineageguard/ui typecheck`
Expected: PASS; CSS search contains no gradients, backdrop filters, or generic card-grid utility.

- [ ] **Step 6: Commit visual foundation**

```bash
git add packages/ui apps/web/app apps/web/components/status apps/web/components/workspace/run-workspace.tsx apps/web/test/decision-transition.test.tsx
git commit -m "feat(ui): establish Mission Control evidence workspace"
```

---

### Task 4: Implement the three evidence-first workspace regions and timeline

**Files:**
- Create: `apps/web/components/workspace/proposed-change.tsx`
- Create: `apps/web/components/workspace/impact-evidence.tsx`
- Create: `apps/web/components/workspace/lineage-path.tsx`
- Create: `apps/web/components/workspace/migration-verification.tsx`
- Create: `apps/web/components/workspace/validation-checks.tsx`
- Create: `apps/web/components/workspace/external-receipts.tsx`
- Create: `apps/web/components/timeline/run-timeline.tsx`
- Create: `apps/web/lib/evidence-selection.ts`
- Create: `apps/web/test/workspace-components.test.tsx`

**Interfaces:** Components receive immutable `RunView` slices and optional selected evidence ID callbacks. Evidence selection is presentation state only and cannot modify/filter persisted truth.

- [ ] **Step 1: Write failing content, reference, and keyboard tests**

Require readable rename/diff, exact dataset/field, two field-lineage paths, the explicitly accepted impact-card count, two intermediate labels, URNs/query fingerprint/source/owner/criticality, reason-to-evidence links, plan phases, compatibility/rollback/reviews, validation checks, GitHub/DataHub receipts, event timestamps, keyboard selection, visible focus, and link rel safety.

- [ ] **Step 2: Run and observe missing components**

Run: `pnpm --filter @lineageguard/web vitest run test/workspace-components.test.tsx`
Expected: FAIL resolving workspace components.

- [ ] **Step 3: Implement dense cardless regions**

Use headings, definition lists, aligned rows, diff lines, path connectors, disclosure elements, and dividers. The central lineage path is the visual anchor. Long URNs/query text wrap or expand without hiding source/provenance. Hover/focus/selecting an evidence reference highlights every matching occurrence using `data-evidence-id`.

- [ ] **Step 4: Run component tests and inspect at target viewport**

Run: `pnpm --filter @lineageguard/web test -- workspace-components`
Expected: PASS; manual local inspection at 1440x900 shows all three regions without clipped primary status or horizontal page overflow.

- [ ] **Step 5: Commit workspace regions**

```bash
git add apps/web/components/workspace apps/web/components/timeline apps/web/lib/evidence-selection.ts apps/web/test/workspace-components.test.tsx
git commit -m "feat(web): render coordinated impact and migration evidence"
```

---

### Task 5: Implement launcher, run page, and all operational states

**Files:**
- Modify: `apps/web/app/page.tsx`
- Create: `apps/web/app/runs/[runId]/page.tsx`
- Create: `apps/web/components/states/loading.tsx`
- Create: `apps/web/components/states/empty.tsx`
- Create: `apps/web/components/states/failure.tsx`
- Create: `apps/web/components/states/approval-pending.tsx`
- Create: `apps/web/components/states/replay-banner.tsx`
- Create: `apps/web/components/approval/writeback-approval.tsx`
- Create: `apps/web/test/run-page.test.tsx`
- Create: `tests/e2e/fixtures/canonical-loading.json`
- Create: `tests/e2e/fixtures/canonical-empty.json`
- Create: `tests/e2e/fixtures/canonical-mcp-failure.json`
- Create: `tests/e2e/fixtures/canonical-validation-failure.json`
- Create: `tests/e2e/fixtures/canonical-writeback-failure.json`

- [ ] **Step 1: Write failing route/state tests**

Cover launcher live/replay copy, loading, empty/not found, MCP failure, validation failure, approval pending, write-back failure, completed replay, retry affordance, disabled approval without operator identity, and no misleading safe label on any failure.

- [ ] **Step 2: Run and observe missing pages/states**

Run: `pnpm --filter @lineageguard/web vitest run test/run-page.test.tsx`
Expected: FAIL resolving page/state components.

- [ ] **Step 3: Implement utility-first state copy and actions**

Headings name the state and affected step; supporting copy explains scope/recovery in one short sentence. Public replay is clearly labeled as captured verified evidence. Approval action displays exact target/fingerprint/window and requires an explicit confirmation click in operator mode.

- [ ] **Step 4: Run web unit tests**

Run: `pnpm --filter @lineageguard/web test`
Expected: PASS with no network/database dependency in component tests.

- [ ] **Step 5: Commit pages and states**

```bash
git add apps/web/app/page.tsx apps/web/app/runs apps/web/components/states apps/web/components/approval apps/web/test/run-page.test.tsx tests/e2e/fixtures
git commit -m "feat(web): cover Mission Control operational states"
```

---

### Task 6: Prove visual, browser, and storyboard acceptance

**Files:**
- Create: `tests/e2e/mission-control.spec.ts`
- Create: `tests/e2e/helpers/console-errors.ts`
- Create: `tests/e2e/screenshots/.gitkeep`
- Modify: `playwright.config.ts`
- Modify: `docs/DEMO_STORYBOARD.md`
- Modify: `README.md`

- [ ] **Step 1: Write failing Playwright flows before accepting screenshots**

Test launcher-to-run, polling 200/304, source/impact/migration scanning order, evidence cross-highlight by keyboard, timeline disclosure, replay labeling, operator approval, and every fixture state. Fail on console error, page error, failed request, unnamed interactive control, trapped focus, hidden critical content, or horizontal overflow.

- [ ] **Step 2: Run at 1440x900 and observe missing/failed snapshots**

Run: `pnpm test:e2e -- --project=mission-control-1440`
Expected: FAIL until pages are wired and baseline screenshots are intentionally reviewed.

- [ ] **Step 3: Capture and review each canonical state**

Capture `loading`, `empty`, `mcp-failure`, `validation-failure`, `approval-pending`, `writeback-failure`, and `completed-replay` at 1440x900. Also smoke completed replay at 1280x720 and 390x844. Accept screenshots only after verifying text/source parity against fixtures and storyboard.

- [ ] **Step 4: Run an independent specification review**

Give a fresh read-only reviewer F9 spec, storyboard, RunView schema/fixtures, screenshots, and diff. Required result: emotional transition, evidence hierarchy, all states, and visible numbers match accepted sources. Resolve blockers.

- [ ] **Step 5: Run an independent UI/code-quality review**

Use a different fresh read-only reviewer. Inspect hierarchy, density, target viewport, responsive fallback, typography, status semantics, accessibility, reduced motion, polling cleanup, public/operator boundary, console/network errors, and no card mosaic. Resolve blockers.

- [ ] **Step 6: Invoke `superpowers:verification-before-completion` and run the final gate**

```bash
pnpm --filter @lineageguard/web test
pnpm build
pnpm test:e2e -- --project=mission-control-1440
pnpm test:e2e -- --update-snapshots=false
pnpm format:check
pnpm lint
pnpm typecheck
```

Expected: all commands exit zero; committed screenshots match; no console/request/accessibility/overflow failures; no visible value lacks a `RunView` source.

- [ ] **Step 7: Commit reviewed browser evidence and docs**

```bash
git add tests/e2e playwright.config.ts docs/DEMO_STORYBOARD.md README.md
git commit -m "test(web): verify Mission Control demo states"
```

F9 is complete only when the target recording viewport can tell the canonical story without opening developer tools or relying on narration to explain missing evidence.
