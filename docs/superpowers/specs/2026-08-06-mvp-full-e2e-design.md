# LineageGuard MVP — Full E2E + Mission Control UI

**Date:** 2026-08-06  
**Status:** Draft  
**Scope:** Complete working product from DataHub seed through agent pipeline to Mission Control UI

---

## 1. Goal

Deliver a demonstrable MVP that runs the canonical scenario end-to-end:

```
PR diff → parse change → baseline ALLOW → DataHub context → BLOCK decision
→ migration plan → patch generation → validation → GitHub PR → DataHub writeback
```

With a Mission Control UI that visualizes runs in real-time: proposed change, evidence from DataHub, generated migration, validation status, and final artifacts.

---

## 2. Architecture Overview

```
┌─────────────────────────────────────────────────────────────────┐
│                    Mission Control (Next.js)                     │
│  apps/web — neutral adaptive theme, light/dark, SSE live updates│
└───────────────────────────────┬─────────────────────────────────┘
                                │ REST + SSE
┌───────────────────────────────▼─────────────────────────────────┐
│                     Worker / Orchestrator                         │
│  apps/worker — polls runs, executes pipeline steps               │
└──┬──────────┬──────────┬──────────┬──────────┬──────────────────┘
   │          │          │          │          │
   ▼          ▼          ▼          ▼          ▼
┌──────┐ ┌────────┐ ┌────────┐ ┌──────────┐ ┌────────┐
│domain│ │datahub │ │github  │ │validation│ │  db    │
│      │ │MCP port│ │adapter │ │executor  │ │pg store│
└──────┘ └────────┘ └────────┘ └──────────┘ └────────┘
              │          │                        │
              ▼          ▼                        ▼
         DataHub GMS  GitHub API            PostgreSQL
         :8080        (live/mock)           :5432
              
┌─────────────────────────────────────────────────────────────────┐
│  LLM (OmniRoute via AI SDK)  —  localhost:20128                  │
│  Migration generation, explanation, plan authoring                │
└─────────────────────────────────────────────────────────────────┘
```

---

## 3. Phases

### Phase 1: DataHub Seed (canonical graph)

**Goal:** Populate DataHub with the canonical scenario data so the agent has real entities to query.

**Work:**
- Run Python seeding tool: `tools/datahub` → `seed` command
- Seed includes: commerce.orders dataset, customer_id field, downstream lineage (analytics models, dashboard, fraud model, unmanaged query), ownership, tags (critical, production), glossary terms
- Verify with `verify` command that all expected entities exist

**Acceptance:** `lineageguard-datahub verify` passes — all 4 consumers, field lineage, ownership, tags present in DataHub.

---

### Phase 2: Agent Package (orchestration core)

**Goal:** Wire `packages/agent` into a working pipeline that takes a change request and produces a run through all states.

**Components:**

```typescript
// packages/agent/src/pipeline.ts
interface PipelineContext {
  runId: string;
  change: ParsedChange;
  config: AgentConfig;
}

interface AgentConfig {
  datahub: DataHubContextPort;
  github: GitHubPort;
  llm: LanguageModelV1;        // AI SDK model
  store: RunStore;
  validation: ValidationPort;
}
```

**Pipeline steps (matching RunStatus FSM in domain/run.ts):**

1. `CREATED → CHANGE_PARSED` — parse SQL/dbt diff into `ParsedChange`
2. `CHANGE_PARSED → BASELINE_ASSESSED` — risk engine with repo-only context → ALLOW
3. `BASELINE_ASSESSED → CONTEXT_COLLECTING` — query DataHub MCP for field lineage, consumers, ownership
4. `CONTEXT_COLLECTING → CONTEXT_COLLECTED` — normalize evidence into typed `ImpactContext`
5. `CONTEXT_COLLECTED → RISK_DECIDED` — deterministic policy: evidence present → BLOCK
6. `RISK_DECIDED → MIGRATION_PLANNED` — LLM generates expand-migrate-contract plan
7. `MIGRATION_PLANNED → PATCH_GENERATED` — LLM generates SQL + dbt patches
8. `PATCH_GENERATED → VALIDATING` — validation executor runs checks
9. `VALIDATING → VALIDATED` — all checks pass
10. `VALIDATED → REVIEW_ARTIFACT_CREATED` — create GitHub PR with migration
11. `REVIEW_ARTIFACT_CREATED → WRITEBACK_PENDING` — write decision to DataHub
12. `WRITEBACK_PENDING → COMPLETED` — done

**LLM integration:**
```typescript
import { createOpenAI } from '@ai-sdk/openai';
import { generateObject, generateText } from 'ai';

const omniroute = createOpenAI({
  baseURL: 'http://localhost:20128/v1',
  apiKey: 'local', // OmniRoute doesn't need real key
});

const model = omniroute('auto'); // or specific model name from OmniRoute
```

**Key design decisions:**
- Each step is a pure function: `(context, prevResult) → StepResult`
- Steps persist events to the run store (packages/db) after each transition
- Failures route to `FAILED_*` states — no silent swallowing
- Replay mode: load pre-recorded step results instead of executing live

---

### Phase 3: Worker Integration

**Goal:** `apps/worker` polls the run store, claims runs via lease, and drives the pipeline.

**Work:**
- Replace heartbeat stub with real poll loop
- Claim pending runs with lease (packages/db already supports this)
- Execute pipeline steps sequentially
- Emit SSE events for real-time UI updates
- Support `--once` mode for CLI/testing

**Interface:**
```typescript
// apps/worker/src/worker.ts
export async function runWorker(options: WorkerOptions): Promise<void> {
  const store = createRunStore(config);
  const agent = createAgentPipeline(agentConfig);
  
  while (!signal.aborted) {
    const run = await store.claimNextRun(workerId);
    if (run) {
      await agent.execute(run);
    }
    await sleep(pollIntervalMs);
  }
}
```

---

### Phase 4: Mission Control UI

**Goal:** A beautiful, modern web interface showing the LineageGuard workflow.

**Tech stack:**
- Next.js 16 (already in apps/web)
- Tailwind CSS 4 + CSS variables for theming
- shadcn/ui components (neutral base, customizable)
- Framer Motion for state transitions
- SSE for live run updates

**Visual language:**
- Neutral adaptive: system-aware light/dark
- Base: slate/zinc palette
- Accents: status-semantic colors (emerald=safe, amber=warning, rose=block, sky=info)
- Typography: Inter (UI) + JetBrains Mono (code/diffs)
- Layout: 3-panel (change | evidence | migration) + bottom timeline
- Cards with subtle borders, not heavy shadows
- No purple, no terminal aesthetic, no "AI magic" gradients

**Pages:**

1. **Dashboard** (`/`) — list of runs, status badges, quick stats
2. **Run Detail** (`/runs/[runId]`) — the main 3-panel view:
   - Left: Proposed Change (diff viewer, repo-only assessment)
   - Center: DataHub Evidence (consumers, lineage mini-graph, owners, risk reasons)
   - Right: Safe Migration (plan, generated files, validation results, PR link)
   - Bottom: Run Timeline (horizontal state progression with timestamps)
3. **Settings** (`/settings`) — DataHub connection, GitHub config, LLM endpoint

**Real-time updates:**
- Worker publishes run events → API route serves SSE
- UI subscribes to `/api/runs/[runId]/events`
- Each step completion animates the next panel section

---

### Phase 5: End-to-End Verification

**Goal:** One command runs the full scenario and produces a passing result.

```bash
# Seed DataHub
pnpm seed

# Create a run for the canonical scenario
pnpm run:create --scenario rename-customer-id

# Worker picks it up and executes
pnpm worker --once

# Or: full demo
pnpm demo
```

**Acceptance criteria:**
- `baselineDecision = ALLOW` → `finalDecision = BLOCK`
- 4 consumers discovered from DataHub
- Migration patch generated (expand-migrate-contract)
- All validations pass
- GitHub PR created (or mock in local mode)
- Decision written back to DataHub
- Mission Control shows the full run with evidence

---

## 4. Data Flow (canonical scenario)

```
Input:  ALTER TABLE commerce.orders RENAME COLUMN customer_id TO buyer_id

Step 1: Parse → { table: commerce.orders, field: customer_id, op: RENAME, newName: buyer_id }

Step 2: Baseline → ALLOW (no repo-local consumers)

Step 3: DataHub query → resolves urn:li:dataset:commerce.orders, field customer_id
         → downstream lineage: 4 consumers
         → ownership: Finance team, Risk ML team
         → tags: critical, production

Step 4: Evidence → ImpactContext with 4 EvidenceItems

Step 5: Policy → BLOCK (critical consumers affected)

Step 6: LLM plan → expand-migrate-contract:
         1. ADD buyer_id (nullable)
         2. BACKFILL buyer_id FROM customer_id  
         3. UPDATE controlled dbt models
         4. ADD dbt tests (equality, not_null)
         5. DEPRECATE customer_id (with window)
         6. REQUEST owner review

Step 7: LLM generates → migration.sql, dbt model patches, tests, MIGRATION.md

Step 8: Validate → SQL syntax, dbt compile, dbt test, compatibility check

Step 9: GitHub → PR with all artifacts + evidence summary

Step 10: DataHub → write migration decision document
```

---

## 5. Technology Choices

| Layer | Choice | Rationale |
|-------|--------|-----------|
| Runtime | Node.js 24 LTS | Existing project standard |
| LLM | AI SDK + OmniRoute | Provider-agnostic, local-first |
| UI Framework | Next.js 16 | Already in apps/web |
| UI Components | shadcn/ui + Tailwind 4 | Neutral, customizable, accessible |
| Styling | CSS variables + Tailwind | Light/dark adaptive |
| Animation | Framer Motion | Smooth state transitions |
| Real-time | SSE (Server-Sent Events) | Simple, one-directional, HTTP-native |
| DataHub | MCP stdio adapter | Already built in packages/datahub |
| Database | PostgreSQL | Already configured with run store |
| Validation | packages/validation executor | Already built |
| GitHub | packages/github adapter | Already built |

---

## 6. File Structure (new/modified)

```
packages/agent/src/
  index.ts              — public exports
  pipeline.ts           — orchestration engine
  steps/
    parse-change.ts
    baseline-assess.ts
    collect-context.ts
    decide-risk.ts
    plan-migration.ts
    generate-patch.ts
    validate.ts
    create-review.ts
    writeback.ts
  llm/
    client.ts           — AI SDK setup with OmniRoute
    prompts.ts          — migration/explanation prompts
    schemas.ts          — zod schemas for structured output
  config.ts             — AgentConfig from env
  replay.ts             — replay mode support

apps/worker/src/
  worker.ts             — real poll loop with lease
  orchestration.ts      — wire agent + store + adapters
  events.ts             — SSE event publisher

apps/web/
  app/
    layout.tsx          — root layout with theme provider
    page.tsx            — dashboard (run list)
    runs/[runId]/
      page.tsx          — 3-panel run detail
    settings/
      page.tsx          — configuration
    api/
      runs/route.ts     — CRUD
      runs/[runId]/
        events/route.ts — SSE endpoint
  components/
    ui/                 — shadcn components
    diff-viewer.tsx
    evidence-panel.tsx
    migration-panel.tsx
    run-timeline.tsx
    status-badge.tsx
    lineage-mini-graph.tsx
  lib/
    theme.ts
    api-client.ts
    use-run-events.ts   — SSE hook
  styles/
    globals.css         — CSS variables, tailwind config
```

---

## 7. UI Design Principles

1. **Information density over decoration** — every pixel conveys state or data
2. **Status drives color** — neutral base, semantic accents only for ALLOW/BLOCK/PASS/FAIL
3. **Progressive disclosure** — summary first, expand for detail
4. **Code is first-class** — diffs, SQL, YAML rendered beautifully with syntax highlighting
5. **Live feel** — SSE updates animate evidence appearing, validations completing
6. **Accessible** — WCAG AA contrast, keyboard navigation, screen reader labels
7. **Responsive** — 3-panel on desktop, stacked on tablet/mobile

---

## 8. Risks and Mitigations

| Risk | Mitigation |
|------|-----------|
| OmniRoute model quality for migration generation | Structured output + validation; fallback to manual review |
| DataHub MCP latency | Cache resolved entities per run; timeout + retry |
| GitHub rate limits | Local mock mode for development; live mode for demo |
| UI complexity in 3-panel layout | Progressive: start with timeline + detail, add panels |
| Large migration diffs | Virtual scroll, collapsible sections |

---

## 9. Out of Scope (for this MVP)

- Multi-tenant / auth (single-user local deployment)
- Multiple scenarios (only canonical rename)
- Automated PR webhook trigger (manual run creation)
- Production deployment (local Docker only)
- DataHub write-back approval workflow (auto-approve in MVP)
- Mobile-optimized UI (desktop-first)

---

## 10. Success Criteria

1. ✅ `pnpm demo` runs full scenario end-to-end without manual intervention
2. ✅ Mission Control shows the run progressing through all states
3. ✅ "DataHub changed the decision" is visible — ALLOW → BLOCK transition
4. ✅ Generated migration is syntactically valid and semantically correct
5. ✅ All 6 validations pass
6. ✅ Evidence cites real DataHub URNs
7. ✅ UI is beautiful, modern, not purple, not a terminal
