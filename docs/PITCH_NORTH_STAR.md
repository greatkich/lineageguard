# Pitch North Star

This document is the authoritative narrative target for the LineageGuard hackathon pitch, demo, README positioning, screenshots, and final submission copy.

If implementation, UI, documentation, or demo choices conflict with this story, preserve the story unless there is concrete technical evidence that it cannot be demonstrated honestly.

## One-sentence pitch

**Coding agents know the repository. DataHub knows the organization’s data context. LineageGuard connects those two worlds and makes AI-generated data changes safe.**

## Core product thesis

DataHub is not presented as merely a catalog UI or a static lineage map. For LineageGuard, DataHub is the organization-wide context graph that exposes information a repository-local coding agent cannot reliably know on its own:

- schemas and fields;
- column-level lineage;
- downstream dbt models and analytical data products;
- BI dashboards;
- ML features and production models;
- query history and unmanaged SQL consumers;
- ownership and review targets;
- governance, quality, and lifecycle metadata.

LineageGuard turns that organizational context into a decision and then into verified action.

## The winning story

The canonical scenario is a warehouse/data-product schema change:

```sql
ALTER TABLE commerce.orders
RENAME COLUMN customer_id TO buyer_id;
```

The changed repository is internally healthy. SQL is valid, local checks pass, and a repository-only coding agent sees no reason to stop the change.

```text
REPOSITORY CONTEXT ONLY
ALLOW
```

LineageGuard then asks DataHub for the organizational context surrounding `commerce.orders.customer_id`.

DataHub reveals four hidden downstream consumer groups that are not visible in the changed repository:

1. a Finance dbt/data-model consumer;
2. a Revenue BI dashboard;
3. a Fraud ML feature and production model path;
4. an unmanaged analyst SQL query.

That evidence changes the deterministic safety decision:

```text
WITHOUT DATAHUB
ALLOW

WITH DATAHUB
BLOCK
```

**This transition is the emotional and technical centerpiece of the pitch.**

The point is not that DataHub can display lineage. The point is that organizational metadata changes the behavior of an AI coding workflow.

## LineageGuard must do more than warn

A lineage-only warning would be too weak. After DataHub changes the decision, LineageGuard performs real work:

1. generates a backward-compatible expand–migrate–contract plan;
2. adds `buyer_id` without immediately removing `customer_id`;
3. backfills the new field from the old field;
4. preserves the legacy contract during a deprecation window;
5. updates in-scope dbt consumers where repository access exists;
6. generates compatibility, equality, and non-null tests;
7. creates migration actions and review targets for externally owned consumers;
8. validates the generated artifacts with deterministic checks;
9. publishes the exact validated patch as a real GitHub pull request;
10. writes the verified migration decision and evidence back to DataHub.

The full product loop is:

```text
ALLOW
  ↓
DataHub finds what the repository could not know
  ↓
BLOCK
  ↓
LineageGuard generates a safe migration
  ↓
Deterministic validation proves it
  ↓
A real GitHub PR is created
  ↓
DataHub remembers the verified decision
```

Short form:

```text
ALLOW → BLOCK → FIX → VERIFY → REMEMBER
```

## System boundary

LineageGuard protects **analytical data contracts**, not direct database sharing between microservices.

The canonical boundary is:

```text
Operational Orders Service / OLTP
        │
        │ API / events / CDC
        ▼
Commerce Warehouse / Lakehouse
        │
        ▼
Orders Data Product
commerce.orders.customer_id
        │
        ├── Finance dbt / analytical model
        ├── Revenue dashboard
        ├── Fraud ML feature → production model
        └── unmanaged analyst SQL
```

The Orders Service OLTP database is outside the LineageGuard scope.

LineageGuard does not replace:

- REST or gRPC API contracts;
- OpenAPI;
- Protobuf;
- Kafka Schema Registry;
- consumer-driven contract testing between operational services.

This distinction must remain explicit in the pitch and documentation.

## What each technology contributes

```text
GitHub / repository
= local implementation context

DataHub
= organization-wide data context

LLM / coding agent
= reasoning and code generation

LineageGuard
= deterministic decision + safe action + verification + memory
```

DataHub must be indispensable to the story: without DataHub, the canonical repository-only assessment must plausibly remain `ALLOW`; with DataHub evidence, the decision must change to `BLOCK`.

## Canonical pitch language

### 20-second version

> Modern coding agents understand code very well, but they do not understand the organization-wide context of data. A change that looks safe inside one repository can silently break dashboards, ML models, and data products owned by other teams. LineageGuard uses DataHub as the context graph: it discovers the hidden blast radius, blocks the dangerous change, generates a safe migration, verifies it, and creates a reviewable pull request.

### 45-second version

> Imagine an AI coding agent changing `customer_id` to `buyer_id`. Every local test passes, so it recommends merging. But it cannot know that the same field is consumed by a Finance dashboard, a Fraud model, another dbt model, and an analyst’s SQL query outside the repository.
>
> DataHub knows those relationships. LineageGuard queries DataHub through MCP, receives the organization-wide context, and changes the decision from ALLOW to BLOCK. Then it goes beyond warning: it generates a backward-compatible migration, adds tests, validates the exact patch, creates a real GitHub pull request, and writes the verified decision back to DataHub.
>
> DataHub becomes more than a catalog: it becomes the safety context for AI-generated data changes.

## Demo north star

The final video should target approximately 2:35–2:45 and stay below the official three-minute limit.

The canonical sequence is:

1. **0:00–0:18 — Looks safe.** Show the real source PR and green repository checks. Repository-only result: `ALLOW`.
2. **0:18–0:33 — Context gap.** Explain that a repository is not the organization.
3. **0:33–1:05 — DataHub evidence.** Show the four real hidden consumer groups and inspectable lineage/query/owner evidence.
4. **1:05–1:20 — Winning moment.** `ALLOW → BLOCK`. Pause on the fact that DataHub changed the decision.
5. **1:20–1:53 — Real work.** Generate the backward-compatible migration and tests.
6. **1:53–2:10 — Proof.** Show deterministic validation passing; the model does not grade its own output.
7. **2:10–2:27 — Real artifact.** Open the exact validated GitHub PR with its receipt/evidence.
8. **2:27–2:40 — Remember.** Show verified write-back in DataHub.
9. **2:40–2:45 — Close.** Land the final product statement.

## Final closing line

The preferred closing statement is:

> **Coding agents know the code. DataHub knows the company’s data system. LineageGuard connects the two — and makes AI-generated changes safe.**

An optional final on-screen line is:

```text
Repository context tells you whether the code works.
DataHub context tells you whether the organization survives the change.
```

Use the second line only if the tone remains credible rather than theatrical.

## Pitch invariants

The final pitch and demo must satisfy all of these:

1. The actor is a data/analytics engineer or coding agent changing an analytical data product, not a microservice directly sharing another service’s OLTP database.
2. Repository-only analysis returns `ALLOW` for the canonical change.
3. DataHub returns real, inspectable evidence for exactly four downstream consumer groups.
4. DataHub evidence causes a deterministic transition to `BLOCK`.
5. The demo visibly proves that DataHub changed the decision.
6. LineageGuard generates an actual compatibility-preserving migration rather than only explaining one.
7. Deterministic validators, not the LLM, declare the generated result safe.
8. The published GitHub PR contains the exact validated patch.
9. The verified decision is written back to DataHub and read back successfully.
10. The final narrative remains `ALLOW → BLOCK → FIX → VERIFY → REMEMBER`.

## What not to optimize for before submission

Do not weaken the canonical story by adding breadth. Before the north-star scenario is verified, do not prioritize:

- additional schema-change scenarios;
- microservice API-contract analysis;
- AWS-specific architecture;
- a multi-agent swarm;
- generic chat;
- multi-tenancy;
- a broad data-governance product;
- a large UI redesign;
- autonomous merge to `main`.

One complete, credible, inspectable vertical story is the submission target.
