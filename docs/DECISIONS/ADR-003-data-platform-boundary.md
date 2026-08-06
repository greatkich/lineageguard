# ADR-003: Data Platform Boundary, Not Microservice or API Contract Boundary

- Status: Accepted
- Date: 2026-08-06
- Decision owners: LineageGuard project

## Context

LineageGuard's canonical scenario renames `commerce.orders.customer_id` to `buyer_id` and shows
that DataHub reveals hidden downstream consumers. Reviewers and new contributors can reasonably
read that scenario two different ways:

1. LineageGuard protects **microservices that share a database**, i.e. it prevents one service's
   schema change from breaking another service that reads the same operational (OLTP) tables, or
   it substitutes for API/event contract testing between services.
2. LineageGuard protects **analytical data platform consumers** — warehouse tables, dbt models,
   BI dashboards, ML features/models, reverse ETL, and ad-hoc SQL — that sit downstream of an
   ingestion boundary (ETL/ELT, CDC, or an event stream) from an operational system of record.

Only reading (2) is correct and was always the intended product. No code, schema, or test in the
repository currently asserts reading (1) — `commerce.orders` has never been queried by multiple
independent services in the walkthrough, and no API/Protobuf/Kafka Schema Registry contract layer
exists anywhere in the codebase. However, the naming (`commerce.orders`, "Orders Service" framing
in prose, "downstream consumers" without further qualification) is generic enough that a reader
skimming the README or Mission Control UI could plausibly infer reading (1). Left uncorrected,
this ambiguity would misrepresent the product's scope to reviewers, to future contributors adding
scenarios, and to anyone evaluating whether LineageGuard is a substitute for consumer-driven
contract testing (it is not, and never has been).

## Canonical boundary

```text
Orders Service / OLTP database         (operational system of record — OUT OF SCOPE)
        │
        │  events, CDC, or batch ETL/ELT     (ingestion boundary)
        ▼
Commerce Warehouse                     (analytical platform — IN SCOPE starts here)
        │
        ▼
Orders Data Product  (commerce.orders, warehouse table)
        │
        ├──► Finance dbt mart (analytics.stg_orders → analytics.customer_revenue)
        │        └──► Revenue Dashboard
        ├──► Fraud feature (fraud.customer_features) and production model (Fraud Model v3)
        └──► unmanaged/ad-hoc SQL query (finance-monthly-close.sql)
```

`commerce.orders`, as seeded and ingested in this repository, is an analytical warehouse table —
an "Orders Data Product" — not the Orders Service's live OLTP database. It is populated by an
ingestion process (conceptually CDC/ETL from an operational system); LineageGuard's canonical
scenario begins its analysis at this warehouse table and everything downstream of it.

## Decision

LineageGuard's scope is bounded to the analytical data platform, strictly downstream of the
ingestion boundary from operational systems.

**In scope:**

- warehouse/lakehouse tables and views (e.g. `commerce.orders` as an analytical data product);
- dbt models and marts built on top of warehouse tables;
- BI dashboards and reports;
- ML features and models trained or served from warehouse/mart data;
- ad-hoc and scheduled analyst SQL against the warehouse;
- reverse ETL jobs reading from the warehouse.

**Out of scope:**

- an operational service's own OLTP database and its internal schema evolution;
- microservice-to-microservice database sharing (two services reading one operational database);
- API request/response contracts between services;
- Protobuf/gRPC schema evolution;
- Kafka Schema Registry compatibility checking;
- consumer-driven contract testing (e.g. Pact) between services;
- any operational (non-analytical) runtime data path.

If an operational service's schema changes in a way that affects the analytical platform, that
change reaches LineageGuard's scope only after it crosses the ingestion boundary (events, CDC, or
ETL/ELT) and lands in a warehouse table LineageGuard is tracking. LineageGuard has no visibility
into, and makes no claim about, the operational side of that boundary.

## Primary persona correction

The primary persona is a **data engineer or analytics engineer** evolving a warehouse table or
transformation, not a backend/microservice engineer evolving a service's private database schema.
`docs/PRODUCT_VISION.md`'s existing "secondary personas" list already included this framing
("analytics engineer changing dbt models", "backend engineer publishing data used outside a
microservice boundary"); this ADR promotes the data/analytics engineer to primary and makes the
service-vs-platform boundary explicit rather than implicit.

## What changes

This is a **presentation and documentation correction**, not a product pivot or a code rename:

- `docs/PRODUCT_VISION.md`, `docs/ARCHITECTURE.md`, `docs/PRODUCT_WALKTHROUGH.md`, `README.md`,
  and `walkthrough/README.md` gain explicit boundary language and a "not in scope" callout.
- DataHub seed metadata for `commerce.orders` gains a display name ("Orders Data Product"), a
  domain ("Commerce Analytics"), an owner ("Commerce Data Platform"), tags
  (`warehouse`, `analytical-data-product`, `cdc-derived`), and a description stating explicitly
  that this dataset is not an OLTP service database.
- Mission Control UI copy is tightened to "warehouse schema change" and "downstream data
  consumers" instead of unqualified "schema change" / "consumers", to avoid the microservice
  reading.

## What does not change

- URNs, table names, dataset identifiers, and code paths for `commerce.orders` are preserved.
  No physical rename is performed.
- The canonical scenario, its four consumer groups, the `ALLOW → BLOCK` decision flip, the
  expand–migrate–contract migration strategy, and the deterministic policy engine are unchanged.
- No new scenario, agent, dependency, or infrastructure is introduced.

## Consequences

### Positive

- Removes a plausible misreading that would undermine credibility with reviewers who work on
  microservice architectures or contract testing.
- Makes explicit, in one place, exactly which layer LineageGuard operates in — useful for future
  scenario additions (e.g. someone must not add an API-contract scenario without a new ADR).
- No regression risk: all changes are additive documentation/metadata/label precision.

### Negative

- Slightly more verbose product prose (an explicit "out of scope" list in several documents).

## Rationale for review

A DataHub-powered data lineage tool is easy to confuse with API/schema-registry contract tooling
for service architectures. Precisely scoping the boundary costs little and prevents a reviewer
from either overestimating what LineageGuard does (protecting live service traffic) or
underestimating it (assuming it is "just" a lineage viewer) when the real differentiator is
turning warehouse-level blast radius into a validated migration.
