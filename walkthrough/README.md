# Canonical DataHub Graph

This directory defines the repeatable `commerce.orders.customer_id` impact graph used by
LineageGuard's reference product walkthrough. All data, identifiers, timestamps, entity URNs, and
query fingerprints are fixed in source control.

## Contents

- `warehouse/init/` creates and seeds the PostgreSQL source relation.
- `dbt/` builds the staging, Finance analytics, and fraud-feature relations.
- `warehouse/queries/finance-monthly-close.sql` is the allowlisted unmanaged read query.
- `metadata/` contains DataHub PostgreSQL and dbt ingestion recipes.
- `scenarios/canonical/expected-datahub-graph.json` is the machine-readable graph contract.

The expected impact cards are `analytics.customer_revenue`, the Finance dashboard, Fraud Model v3,
and the unmanaged Finance query. `analytics.stg_orders` and `fraud.customer_features` remain visible
lineage intermediates rather than inflating that user-facing count.

## Tooling

Install the pinned Python 3.12 environment:

```bash
uv sync --project tools/datahub --all-groups
```

Inspect every planned external action without executing it:

```bash
uv run --project tools/datahub lineageguard-datahub quickstart
uv run --project tools/datahub lineageguard-datahub warehouse-seed
uv run --project tools/datahub lineageguard-datahub query
uv run --project tools/datahub lineageguard-datahub ingest
uv run --project tools/datahub lineageguard-datahub metadata-seed
uv run --project tools/datahub lineageguard-datahub manifest
```

Live operations require the variables shown in `.env.example`. Secrets must be supplied through the
environment and must not be written back into this directory. Each mutation additionally requires
`--execute`. The metadata reset is narrower still: it requires the exact environment, platform
instance, scenario confirmation, and deletes only URNs recorded in the manifest.

The PostgreSQL service must preload `pg_stat_statements`; the first seed file creates the extension
idempotently. This setting belongs to the application PostgreSQL service, never DataHub's internal
databases.

The supported DataHub setup is the official CLI quickstart pinned to OSS v1.6.0:

```bash
uv run --project tools/datahub lineageguard-datahub quickstart --execute
```

After PostgreSQL is available, the canonical live sequence is:

```bash
uv run --project tools/datahub lineageguard-datahub warehouse-seed --execute
uv run --project tools/datahub dbt build --project-dir walkthrough/dbt --profiles-dir walkthrough/dbt
uv run --project tools/datahub lineageguard-datahub query --execute
uv run --project tools/datahub lineageguard-datahub ingest --execute
uv run --project tools/datahub lineageguard-datahub metadata-seed --execute
uv run --project tools/datahub lineageguard-datahub verify
```

Reset only LineageGuard-owned DataHub entities:

```bash
uv run --project tools/datahub lineageguard-datahub reset \
  --execute \
  --confirm canonical-customer-id-rename
```

`verify` exits non-zero for a missing entity, field lineage, entity lineage, owner, tag, glossary
term, or query signal. A checked-in manifest or unit test is not a live DataHub receipt; live
verification must be observed separately against the pinned server.
