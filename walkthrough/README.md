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
uv run --project tools/datahub lineageguard-datahub dbt-build
uv run --project tools/datahub lineageguard-datahub query
uv run --project tools/datahub lineageguard-datahub ingest
uv run --project tools/datahub lineageguard-datahub metadata-seed
uv run --project tools/datahub lineageguard-datahub bootstrap-target
uv run --project tools/datahub lineageguard-datahub manifest
```

Live operations require the variables shown in `.env.example`. Secrets must be supplied through the
environment and must not be written back into this directory. Each mutation additionally requires
`--execute`. The metadata reset is narrower still: it requires the exact environment, platform
instance, scenario confirmation, an authenticated `ENTITY_CREATED` receipt, and the matching private
ownership nonce read back from the server. A manifest or public marker never authorizes deletion or
overwrite. An exact pre-existing entity is skipped without becoming a reset target; any differing
pre-existing entity is refused unless its creation provenance is already protected by this tool.

Metadata mutation and connector-ingestion target only the exact canonical GMS URL
`http://127.0.0.1:8080`; userinfo, query strings, fragments, alternate ports, trailing paths, and
remote DataHub targets are refused. A one-time bootstrap creates a random 256-bit live-instance ID
in a dedicated `dataPlatformInstanceProperties` marker and binds it to ignored, owner-only `0600`
local state. Every ingestion, mutation, reset, reconciliation, and verification reads that marker
with `DATAHUB_READ_TOKEN` before a write or ingestion token is loaded into a transport. Missing,
empty, substituted, or extended markers fail closed. The resulting target fingerprint is
`sha256(canonicalGmsUrl|liveInstanceId)`; neither a URL nor a checked-in constant is an attestation.

`DATAHUB_BOOTSTRAP_TOKEN` must be a short-lived, least-privilege credential limited to creating the
dedicated target marker. It is distinct from the read, mutation, and ingestion credentials and
should be revoked or removed from the environment immediately after bootstrap. The bootstrap
refuses a target containing any canonical graph URN and never overwrites an existing conflicting
marker. Remote PostgreSQL requires `sslmode=verify-full` and its own opt-in. DataHub read,
bootstrap, mutation, and ingestion tokens are separate variables and must contain distinct
non-empty values. PostgreSQL bootstrap
admin, fixed `lineageguard_seed`, fixed `lineageguard_query`, fixed `lineageguard_ingest`, and fixed
`lineageguard_dbt` credentials are separate; the query and ingestion LOGIN roles inherit separate
NOLOGIN groups. The query role can select only `analytics.customer_revenue`; the ingestion role can
select all four canonical relations. Neither inherits `pg_read_all_stats`. The seed LOGIN receives
only SELECT/INSERT on `commerce.orders`. The dbt LOGIN receives SELECT on that source plus CREATE
only in the `analytics` and `fraud` schemas. Secret fields are never included in configuration
representations, receipts, or ingestion subprocess environments.

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

Before any connector ingestion or metadata mutation, attest the empty canonical DataHub target.
The confirmation and environment gate make this a separate, explicit one-time action:

```bash
uv run --project tools/datahub lineageguard-datahub bootstrap-target \
  --execute \
  --confirm canonical-customer-id-rename
unset DATAHUB_BOOTSTRAP_TOKEN
```

The command first uses the read credential to prove that the marker and every canonical URN are
absent. Only then does it construct the bootstrap writer, create the immutable marker, and read it
back through the separate read credential. Safe recovery from an interrupted first attempt reuses
the protected local ID; an existing marker is accepted only when it is byte-for-byte equivalent to
that binding and the canonical graph is still absent.

After PostgreSQL is available, the canonical live sequence is:

```bash
uv run --project tools/datahub lineageguard-datahub warehouse-seed --execute
uv run --project tools/datahub lineageguard-datahub dbt-build --execute
uv run --project tools/datahub lineageguard-datahub query --execute
uv run --project tools/datahub lineageguard-datahub ingest --execute
uv run --project tools/datahub lineageguard-datahub metadata-seed --execute
uv run --project tools/datahub lineageguard-datahub verify
```

`dbt-build` invokes build followed by docs generation against a fresh private copy of the exact
digest-pinned project, verifies all three canonical relations, and publishes the three captured
artifacts atomically. Ingestion runs the external CLI only against a separate owner-only snapshot of
both recipes and those exact `manifest.json`, `run_results.json`, and `catalog.json` bytes.

The PostgreSQL and dbt connectors own the four Dataset entities and their base schema metadata.
`metadata-seed` runs only after those connectors and adds controlled ownership, tag, glossary, and
exact canonical lineage overlays; it never replaces connector-owned DatasetProperties or
SchemaMetadata. PostgreSQL query/view lineage and dbt column lineage are disabled in the pinned
recipes so they cannot compete with those overlays. If a connector still returns an allowlisted
UpstreamLineage aspect that differs from the exact canonical edge set, the seed stops with a
reconciliation conflict and never overwrites the connector's unrelated edges. Repeating connector
ingestion and metadata seeding preserves both connector schema and controlled overlays. Reset
therefore deletes only immutable, namespaced
entities created by this tool and never deletes connector-owned Dataset URNs.

`metadata-seed` does not emit a MANUAL Query. The pinned PostgreSQL recipe is restricted to exactly
`commerce.orders`, `analytics.stg_orders`, `analytics.customer_revenue`, and
`fraud.customer_features`. It runs in a minimal environment containing only the ingestion token and
read-only ingestion database credential. The checked `pg_stat_statements` observation is reconciled
into one deterministic namespaced Query. Stable query identity lives in official SYSTEM
`QueryProperties`, `QuerySubjects`, `DataPlatformInstance`, and official `Ownership` aspects; each
later observation is a monotonic `QueryUsageStatistics` timeseries update. The manifest immutably
binds the Query to Finance Analytics as `BUSINESS_OWNER`. Verification fetches that URN directly
and accepts it only when its statement, exact subject field, instance, owner/type, timestamp, usage
count, pg_stat id/count/time, recipe digest, proposal keys, and ordered receipts all agree.

MANUAL Query examples may remain in committed replay fixtures, but are never emitted or accepted by
the LIVE path. Ownership is represented only by DataHub's official `OwnershipClass`; no custom
property substitutes for an owner. Official Ownership is verified on the Query, Finance
revenue/dashboard, and Risk ML assets. The canonical manifest fixes the Query and Finance dashboard
as `BUSINESS_OWNER` and the fraud model as `TECHNICAL_OWNER`; changing any owner or type is contract
drift.

Reset only LineageGuard-owned DataHub entities:

```bash
uv run --project tools/datahub lineageguard-datahub reset \
  --execute \
  --confirm canonical-customer-id-rename
```

`verify` exits non-zero for a missing entity, field lineage, entity lineage, owner, tag, glossary
term, query signal, pg_stat receipt, ingestion receipt, or incomplete mixed field/entity path. The
manifest freezes the complete field inventory of every canonical dataset; missing or extra fields
fail verification. Counts come only from one connected set of reachable observed outcomes; a
failing graph never reports the manifest's expected count as though it were observed. Operation
receipts are stored with mode `0600` under ignored `walkthrough/.state/` and record planned,
successful, failed, skipped, and reconciliation-required outcomes. They are strictly bounded and
validated, chained with HMAC, and bound to a separate `0600` local ownership state. A checked-in
manifest or unit test is not a live DataHub receipt; live verification must be observed separately
against the pinned server.

One owner lock covers preflight, external mutation, and the terminal receipt. An interrupted seed,
live-query upsert, or reset blocks further scenario operations until an explicit live-state
reconciliation succeeds:

```bash
uv run --project tools/datahub lineageguard-datahub reconcile-seed --execute --confirm canonical-customer-id-rename
uv run --project tools/datahub lineageguard-datahub reconcile-live-query --execute --confirm canonical-customer-id-rename
uv run --project tools/datahub lineageguard-datahub reconcile-reset --execute --confirm canonical-customer-id-rename
```

The warehouse, dbt, read-query, and connector commands are declarative or read-only; a failed run
is retried through the same exact command. One shared resolver uses authenticated append order and
the exact scenario/kind/entity/aspect/idempotency/proposal identity, so an older success never masks
a newer failure. The current Query success must follow the current dbt artifact receipt, and the
current PostgreSQL ingestion success must follow that Query before live Query aspects can be emitted,
reconciled, or verified.

`metadata-seed --execute` requires a registry-bound warehouse receipt, the exact ordered dbt command
and three-artifact receipts, and current successful receipts for both captured connector recipes in
PostgreSQL-then-dbt order. Every receipt is bound to the private scenario nonce and non-secret
PostgreSQL/DataHub target fingerprints. `verify` also requires those receipts and a later successful
metadata overlay. Reset uses DataHub's soft
delete; verification rejects `Status.removed=true`, while a later seed may emit `removed=false` only
for an entity whose private creation receipt and retained server-side ownership marker both match.
