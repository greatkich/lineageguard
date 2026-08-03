# First Codex Prompt

Paste the prompt below into Codex from the repository root after installing Superpowers and the required skills.

---

You are starting the LineageGuard implementation-planning phase.

Do not write product code in this session.

First, inspect the repository, current branch, environment, installed plugins/skills, available MCP tools, and all source-of-truth files:

- `AGENTS.md`
- `docs/PRODUCT_VISION.md`
- `docs/PRODUCT_STRATEGY.md`
- `docs/ARCHITECTURE.md`
- `docs/PRODUCT_WALKTHROUGH.md`
- `docs/AGENT_HARNESS.md`
- `docs/SKILLS_AND_AGENTS.md`
- `docs/IMPLEMENTATION_HANDOFF.md`
- `docs/DECISIONS/*.md`

Use the Superpowers `brainstorming` skill to validate the implementation direction against those accepted constraints. Do not restart broad product ideation and do not reopen accepted ADRs without new evidence.

Then:

1. Verify current tool and dependency assumptions from official documentation, especially DataHub OSS, the official DataHub MCP Server, DataHub skills, OpenAI Agents SDK TypeScript, Codex, Superpowers, Node 24 LTS, Next.js, dbt Core, and PostgreSQL.
2. Report contradictions, missing decisions, environmental blockers, and the minimum questions that require user input.
3. Produce independently testable feature specifications covering F0–F10 in `docs/IMPLEMENTATION_HANDOFF.md`.
4. Create a dependency graph, critical path, time budget, risk register, and explicit cut order.
5. Use Superpowers `writing-plans` to create executable plans under `docs/superpowers/plans/`. Plans must use checkbox steps, exact files and interfaces, red/green TDD for deterministic code, commands with expected outcomes, frequent meaningful commits, and separate specification/code-quality review gates.
6. Do not scaffold the full monorepo or implement a feature before the plan set is reviewed.
7. End with a concise approval packet containing:
   - proposed plan files;
   - architecture questions resolved;
   - unresolved blockers;
   - first implementation worktree/branch;
   - exact first verification gate.

Global requirements:

- TypeScript-first hybrid architecture;
- Node.js 24 LTS, TypeScript strict, pnpm;
- Next.js/React UI and separate Node worker;
- Python 3.12 + uv only for DataHub ingestion/tooling;
- official DataHub MCP Server;
- deterministic risk engine owns `ALLOW | REVIEW | BLOCK`;
- model outputs are Zod-validated;
- DataHub mutations are isolated to explicit write-back;
- one writer per worktree and an independent read-only reviewer;
- no direct feature work on `main`;
- no LangGraph, Temporal, Redis, Kubernetes, multi-agent swarm, or second backend unless a reviewed ADR proves necessity;
- canonical walkthrough quality takes priority over breadth;
- release milestone is the current product milestone, so preserve the critical path and cut optional scope early.

Show the planning output for approval. Do not begin implementation automatically.

---
