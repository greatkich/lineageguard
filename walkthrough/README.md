# Canonical DataHub Graph

This directory defines the repeatable `commerce.orders.customer_id` impact graph used by
LineageGuard's reference product walkthrough. All data, identifiers, timestamps, entity URNs, and
query fingerprints are fixed in source control.

## Contents

- `warehouse/init/` creates and seeds the PostgreSQL source relation.
- `dbt/` builds the staging, Finance analytics, and fraud-feature relations.
- `warehouse/queries/finance-monthly-close.sql` is the digest-pinned read query.
- `metadata/` contains DataHub PostgreSQL and dbt ingestion recipes.
- `scenarios/canonical/expected-datahub-graph.json` is the machine-readable graph contract.

The expected impact cards are `analytics.customer_revenue`, the Finance dashboard, Fraud Model v3,
and the observed Finance query. `analytics.stg_orders` and `fraud.customer_features` remain visible
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
instance, scenario confirmation, an authenticated `ENTITY_CREATED` receipt, and the matching private
ownership nonce read back from the server. A manifest or public marker never authorizes deletion or
overwrite. An exact pre-existing entity is skipped without becoming a reset target; any differing
pre-existing entity is refused unless its creation provenance is already protected by this tool.

Local targets must use loopback addresses. Remote DataHub targets require HTTPS plus explicit remote
and mutation opt-ins. Remote PostgreSQL requires `sslmode=verify-full` and its own opt-in. DataHub
read, metadata-write, and ingestion tokens are separate variables. PostgreSQL bootstrap admin,
fixed `lineageguard_seed`, fixed `lineageguard_query`, and fixed `lineageguard_ingest` credentials
are separate; the two read-only LOGIN roles only inherit the NOLOGIN `lineageguard_reader` group.
The seed LOGIN receives only SELECT/INSERT on `commerce.orders`. Secret fields are
never included in configuration representations, receipts, or ingestion subprocess environments.

The PostgreSQL service must preload `pg_stat_statements`; the first seed file creates the extension
idempotently. This setting belongs to the application PostgreSQL service, never DataHub's internal
databases.
Bootstrap first verifies the exact isolated `lineageguard` database and refuses conflicting schemas.
Its first mutation creates a server-side scenario registry bound to the private ownership nonce;
re-runs require that nonce and exact seed contents. Every privileged SQL and ingestion recipe is a
regular repository-contained file with a code-level SHA-256 and size cap. The query command proves
role membership, a read-only transaction, exact SELECT access, and absence of write privileges on
all four canonical relations before executing the checked SQL. The dbt end hook grants SELECT only
on the three exact generated relations.

The supported DataHub setup is the official CLI quickstart pinned to OSS v1.6.0:

```bash
uv run --project tools/datahub lineageguard-datahub quickstart --execute
```

After PostgreSQL is available, the canonical live sequence is:

```bash
uv run --project tools/datahub lineageguard-datahub warehouse-seed --execute
uv run --project tools/datahub dbt build --project-dir walkthrough/dbt --profiles-dir walkthrough/dbt
uv run --project tools/datahub lineageguard-datahub metadata-seed --execute
uv run --project tools/datahub lineageguard-datahub query --execute
uv run --project tools/datahub lineageguard-datahub ingest --execute
uv run --project tools/datahub lineageguard-datahub verify
```

`metadata-seed` does not emit a MANUAL Query. The pinned PostgreSQL recipe is restricted to exactly
`commerce.orders`, `analytics.stg_orders`, `analytics.customer_revenue`, and
`fraud.customer_features`. It runs in a minimal environment containing only the ingestion token and
read-only ingestion database credential. The checked `pg_stat_statements` observation is reconciled
into one deterministic namespaced Query with official SYSTEM `QueryProperties`, `QuerySubjects`,
`DataPlatformInstance`, and `QueryUsageStatistics` aspects. Verification fetches that URN directly
and accepts it only when its statement, exact subject field, instance, timestamp, usage count,
pg_stat id/count/time, recipe digest, proposal keys, and ordered receipts all agree.

MANUAL Query examples may remain in committed replay fixtures, but are never emitted or accepted by
the LIVE path. DataHub 1.6 does not support the `Ownership` aspect on Query entities, so the tool
does not claim query ownership or encode a custom owner substitute. Official Ownership is verified
on the Finance revenue/dashboard and Risk ML assets.

Reset only LineageGuard-owned DataHub entities:

```bash
uv run --project tools/datahub lineageguard-datahub reset \
  --execute \
  --confirm canonical-customer-id-rename
```

`verify` exits non-zero for a missing entity, field lineage, entity lineage, owner, tag, glossary
term, query signal, pg_stat receipt, ingestion receipt, or incomplete mixed field/entity path. Counts
The manifest freezes the complete field inventory of every canonical dataset; missing or extra
fields fail verification. Counts come only from one connected set of reachable observed outcomes; a failing graph never reports the manifest's expected
count as though it were observed. Operation receipts are stored with mode `0600` under ignored
`walkthrough/.state/` and record every success, failure, and reconciled retry. They are strictly
bounded and validated, chained with an authenticated hash, and bound to a separate `0600` local
ownership state. A checked-in manifest
or unit test is not a live DataHub receipt; live verification must be observed separately against the
pinned server.
