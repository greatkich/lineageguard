# LineageGuard

**A DataHub-powered change guardian that turns risky schema changes into safe, verified migration pull requests.**

LineageGuard brings organizational metadata into schema-change review so repository-local automation can reason about downstream impact before code is merged.

**Scope boundary.** LineageGuard operates inside the analytical data platform, downstream of the
ingestion boundary from operational systems. It protects warehouse tables, dbt models, BI
dashboards, ML features/models, and ad-hoc SQL — the consumers of a data product once it has
landed in the warehouse via events, CDC, or ETL/ELT. It does **not** protect microservice-to-
microservice database sharing, and it is **not** a substitute for API contract testing,
Protobuf/gRPC schema evolution, or Kafka Schema Registry compatibility checks between services.
An operational service's own OLTP schema is out of scope; only the analytical data product derived
from it is in scope. See [`docs/DECISIONS/ADR-003-data-platform-boundary.md`](docs/DECISIONS/ADR-003-data-platform-boundary.md).

The canonical local DataHub graph uses a separate one-time target bootstrap before any ingestion or
metadata mutation. See [`walkthrough/README.md`](walkthrough/README.md) for the exact attested CLI
sequence and least-privilege credential split.

A repository-level coding agent can see the code in front of it. It usually cannot see the hidden data consumers that live elsewhere in the organization: downstream dbt models, dashboards, ML features, production models, ad-hoc queries, owners, glossary rules, and data-quality expectations. LineageGuard closes that gap.

It reads a proposed warehouse schema change, gathers organizational context from DataHub, makes a deterministic safety decision, generates a backward-compatible migration, validates the generated artifacts, creates a reviewable pull request, and writes the verified decision back to DataHub for the next person or agent.

## The product walkthrough

`commerce.orders` is an analytical warehouse data product — the Orders Data Product in the
Commerce Warehouse — populated from the Orders Service's operational database via events/CDC. It
is not the Orders Service's live OLTP table, and this walkthrough never touches that operational
database. A data or analytics engineer proposes a warehouse migration:

```sql
ALTER TABLE commerce.orders
RENAME COLUMN customer_id TO buyer_id;
```

Repository checks pass and the baseline code-only assessment says `ALLOW`.

LineageGuard queries DataHub and discovers four downstream data consumers that are not visible in the changed repository:

- a Finance dbt model;
- a revenue dashboard;
- a fraud feature and production model;
- an unmanaged SQL query.

The decision changes from `ALLOW` to `BLOCK`. LineageGuard then generates an expand–migrate–contract plan that keeps `customer_id` temporarily compatible, adds `buyer_id`, backfills the value, updates known consumers, adds dbt assertions, requests the real owners, validates everything, and records the migration decision in DataHub.

The final proof should read:

```text
4 hidden consumers protected
1 safe migration generated
8 executable checks passed
0 downstream systems broken
```

## Product principles

1. **DataHub must change the decision.** A decorative lineage lookup is not enough.
2. **The agent must do real work.** The output is mergeable code, tests, documentation, and a pull request.
3. **Safety is deterministic.** The LLM explains and generates; policy code decides `ALLOW`, `REVIEW`, or `BLOCK`.
4. **Evidence is inspectable.** Every risk reason cites a DataHub entity, field, path, query, owner, or rule.
5. **Knowledge flows back.** A validated migration decision is written to DataHub for future humans and agents.
6. **One excellent vertical scenario beats a broad prototype.** The primary walkthrough must run reliably from a clean environment.

## Architecture decision

LineageGuard uses a **TypeScript-first hybrid architecture**:

- **TypeScript / Node.js 24 LTS** for the application, orchestration, DataHub MCP client, GitHub integration, worker, shared domain models, and React UI;
- **Next.js + React** for the Mission Control interface;
- **Python 3.12** only for DataHub ingestion and metadata-seeding utilities, where the official DataHub ecosystem is strongest;
- **PostgreSQL** for walkthrough business data and LineageGuard run state;
- **DataHub OSS** in its own official service stack;
- **dbt Core** for realistic transformations and executable validation.

The product is not a free-form multi-agent swarm. It is a typed, observable workflow with narrow agentic steps and explicit gates.

## Documentation map

| Document | Purpose |
|---|---|
| [`docs/PRODUCT_VISION.md`](docs/PRODUCT_VISION.md) | Product, users, problem, scope, and success definition |
| [`docs/PRODUCT_STRATEGY.md`](docs/PRODUCT_STRATEGY.md) | How the project maps to the review criteria |
| [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md) | System design, boundaries, data model, runtime, and deployment |
| [`docs/PRODUCT_WALKTHROUGH.md`](docs/PRODUCT_WALKTHROUGH.md) | The canonical product walkthrough and visual states |
| [`docs/AGENT_HARNESS.md`](docs/AGENT_HARNESS.md) | How Codex and Superpowers must plan, implement, review, and verify |
| [`docs/SKILLS_AND_AGENTS.md`](docs/SKILLS_AND_AGENTS.md) | Skills, MCP servers, agent roles, and installation guidance |
| [`docs/IMPLEMENTATION_HANDOFF.md`](docs/IMPLEMENTATION_HANDOFF.md) | Feature decomposition and planning handoff for Codex |
| [`CODEX_START_PROMPT.md`](CODEX_START_PROMPT.md) | Ready-to-paste first prompt for Codex |
| [`docs/DECISIONS/ADR-001-typescript-first-hybrid.md`](docs/DECISIONS/ADR-001-typescript-first-hybrid.md) | TypeScript vs Python decision |
| [`docs/DECISIONS/ADR-002-deterministic-control-plane.md`](docs/DECISIONS/ADR-002-deterministic-control-plane.md) | Why the LLM does not own safety decisions |
| [`docs/DECISIONS/ADR-003-data-platform-boundary.md`](docs/DECISIONS/ADR-003-data-platform-boundary.md) | Why LineageGuard is a data-platform guardian, not a microservice/API-contract tool |
| [`docs/SOURCES.md`](docs/SOURCES.md) | Official research sources |

## Intended repository shape

The implementation agent should create this structure through approved feature plans rather than scaffolding everything blindly:

```text
lineageguard/
├── apps/
│   ├── web/                         # Next.js Mission Control and BFF
│   └── worker/                      # durable run orchestration
├── packages/
│   ├── domain/                      # schemas, evidence, decisions, events
│   ├── agent/                       # bounded LLM planners/generators
│   ├── datahub/                     # MCP adapter and write-back policy
│   ├── github/                      # PR/check/comment adapter
│   ├── validation/                  # SQL/dbt/compatibility validators
│   ├── db/                          # application persistence
│   └── ui/                          # shared visual primitives
├── walkthrough/
│   ├── warehouse/                   # PostgreSQL schemas and seed data
│   ├── dbt/                         # controlled downstream models
│   ├── metadata/                    # DataHub ingestion and lineage fixtures
│   └── scenarios/                   # unsafe and safe changes
├── tools/
│   └── datahub/                     # Python 3.12 + uv metadata utilities
├── examples/                        # reviewer-readable generated artifacts
├── evals/                           # baseline vs DataHub-grounded cases
├── tests/
└── docs/
```

## Development contract

Implementation starts only after Codex has:

1. read every source-of-truth document;
2. installed and verified the required skills;
3. run Superpowers brainstorming to identify contradictions or gaps;
4. produced feature specifications;
5. produced bite-sized implementation plans in local workspace notes;
6. received approval for the plan.

See [`CODEX_START_PROMPT.md`](CODEX_START_PROMPT.md).

## Project direction

- Public, Apache-2.0-licensed development.
- One reliable canonical schema-change scenario before broader coverage.
- Reproducible evidence, executable validation, and explicit mutation controls.
- Architecture that remains useful beyond the initial release.

## Quick start

```bash
# Prerequisites: Node 24+, pnpm 11.20+, Docker, PostgreSQL, DataHub OSS
pnpm install --frozen-lockfile
pnpm check:environment

# Copy and configure environment
cp .env.example .env
# Edit .env: set DATAHUB_READ_TOKEN, DATAHUB_INGEST_TOKEN, DATAHUB_MUTATION_TOKEN,
# DATAHUB_BOOTSTRAP_TOKEN (all 4 must be distinct), GITHUB_TOKEN, SOURCE_PR_NUMBER=3

# Verify everything compiles and passes
pnpm format:check && pnpm lint && pnpm typecheck && pnpm test && pnpm build

# Run the canonical demo (full pipeline)
pnpm demo:preflight          # 19/19 environment checks
pnpm demo:bootstrap          # seed DataHub graph (first time only)
pnpm demo:run                # execute: ALLOW → BLOCK → validate → PR → writeback
pnpm demo:verify             # independently verify the last run (23 checks)
pnpm demo:repeat -- --count 3  # prove determinism
```

See [`docs/demo-walkthrough.md`](docs/demo-walkthrough.md) for the full sequence and [`docs/troubleshooting.md`](docs/troubleshooting.md) for common issues.

# Run the canonical scenario
pnpm demo
```

The demo exits 0 only when the full pipeline reaches COMPLETED (DataHub context collected, risk decided, migration generated, validated, PR created, write-back verified). Any failure exits non-zero with a clear status.

## Limitations

- One scenario only: `customer_id → buyer_id` rename on `commerce.orders`
- Validation requires Docker with pre-built content-addressed images
- No multi-tenant, no authentication on Mission Control
- Write-back uses DataHub GMS REST (not GraphQL mutations)
- Verified replay is a contingency path, not a primary demo mode

Implementation and deployment instructions evolve alongside verified product capabilities.
