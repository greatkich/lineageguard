# F1 Canonical DataHub Graph Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use `superpowers:subagent-driven-development` (recommended) or `superpowers:executing-plans` to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Seed and prove the complete canonical PostgreSQL/dbt/DataHub graph, including exact field lineage, owners, glossary context, critical assets, and unmanaged query evidence.

**Architecture:** Python 3.12 utilities under `tools/datahub` own deterministic demo seeding and official DataHub ingestion. The application runtime remains TypeScript and does not call these utilities. A checked expectation manifest drives both machine verification and every later visible count.

**Tech Stack:** PostgreSQL 17.10, dbt Core 1.12.0, dbt-postgres 1.11.0, DataHub OSS 1.6.0, `acryl-datahub[postgres]` 1.6.0.17, Python 3.12.13, uv 0.11.32, pytest.

## Global Constraints

- Branch `feat/f1-canonical-datahub-graph` starts from accepted F0.
- Gate A requires a real DataHub 1.6.0 instance; unit mocks cannot satisfy acceptance.
- Use exact Dataset-to-Dataset field lineage; use entity-level edges for dashboard and ML model.
- The proposed impact-card count is four; intermediate datasets remain lineage nodes. Stop for user resolution if that convention is not approved.
- Seed commands are repeatable and idempotent; reset targets only the explicit demo environment.
- Store credentials only in environment variables; redact all logs and fixtures.
- Python remains ingestion tooling, not a second application backend.

---

### Task 1: Build deterministic PostgreSQL and dbt demo data

**Files:**
- Create: `demo/warehouse/init/001-schemas.sql`
- Create: `demo/warehouse/init/002-tables.sql`
- Create: `demo/warehouse/init/003-seed.sql`
- Create: `demo/warehouse/queries/finance-monthly-close.sql`
- Create: `demo/dbt/dbt_project.yml`
- Create: `demo/dbt/profiles.yml`
- Create: `demo/dbt/models/staging/stg_orders.sql`
- Create: `demo/dbt/models/staging/stg_orders.yml`
- Create: `demo/dbt/models/analytics/customer_revenue.sql`
- Create: `demo/dbt/models/analytics/customer_revenue.yml`
- Create: `demo/dbt/models/fraud/customer_features.sql`
- Create: `demo/dbt/models/fraud/customer_features.yml`
- Create: `tools/datahub/tests/test_demo_sql.py`
- Create: `scripts/demo-db.ts`
- Create: `scripts/demo-db.test.ts`
- Modify: `compose.yaml`
- Modify: `package.json`

**Interfaces:**
- Consumes: healthy `app-postgres` from F0.
- Produces: source `commerce.orders(customer_id)` and dbt relations with deterministic `customer_id` dependencies.

- [ ] **Step 1: Write failing SQL/dbt structure tests**

```py
# tools/datahub/tests/test_demo_sql.py
from pathlib import Path


ROOT = Path(__file__).parents[3]


def test_canonical_models_preserve_customer_id_lineage() -> None:
    stg = (ROOT / "demo/dbt/models/staging/stg_orders.sql").read_text()
    revenue = (ROOT / "demo/dbt/models/analytics/customer_revenue.sql").read_text()
    fraud = (ROOT / "demo/dbt/models/fraud/customer_features.sql").read_text()
    assert "customer_id" in stg
    assert "ref('stg_orders')" in revenue
    assert "customer_id" in revenue
    assert "ref('stg_orders')" in fraud
    assert "customer_id" in fraud


def test_unmanaged_query_has_stable_identity_and_field_reference() -> None:
    query = (ROOT / "demo/warehouse/queries/finance-monthly-close.sql").read_text()
    assert "lineageguard:finance-monthly-close" in query
    assert "customer_id" in query
    assert "analytics.customer_revenue" in query
```

Also write `scripts/demo-db.test.ts` against an injected process runner. Assert the exact `start` and `seed` operation descriptors, fixed Compose service, fixed ordered SQL paths, argument-array spawning, stdin delivery without a shell, unknown-operation denial, abort propagation, output caps, and absence of credential values in errors.

- [ ] **Step 2: Run tests and observe missing demo files**

Run: `uv run --project tools/datahub pytest tools/datahub/tests/test_demo_sql.py -q`
Expected: FAIL with missing demo files.

Run: `pnpm vitest run scripts/demo-db.test.ts`
Expected: FAIL resolving `scripts/demo-db.ts`.

- [ ] **Step 3: Implement deterministic schemas, rows, and dbt models**

Create `commerce.orders` with fixed UUID/order/customer values and timestamps, never `now()`. Enable `pg_stat_statements` through PostgreSQL `shared_preload_libraries` in Compose. Use these model contracts:

```sql
-- demo/dbt/models/staging/stg_orders.sql
select order_id, customer_id, order_total, ordered_at
from {{ source('commerce', 'orders') }}
```

```sql
-- demo/dbt/models/analytics/customer_revenue.sql
select customer_id, sum(order_total) as lifetime_revenue
from {{ ref('stg_orders') }}
group by customer_id
```

```sql
-- demo/dbt/models/fraud/customer_features.sql
select customer_id, count(*) as order_count, max(order_total) as max_order_total
from {{ ref('stg_orders') }}
group by customer_id
```

Define dbt source/model column tests for non-null and accepted uniqueness where supported by the fixed rows. `profiles.yml` reads `DEMO_POSTGRES_HOST`, `DEMO_POSTGRES_PORT`, `DEMO_POSTGRES_USER`, `DEMO_POSTGRES_PASSWORD`, and `DEMO_POSTGRES_DATABASE`; it contains no value defaults for secrets.

Implement `scripts/demo-db.ts` as an erasable-syntax-only Node 24 CLI with exact `start` and `seed` operations. `start` executes `docker compose -f compose.yaml up -d --wait app-postgres`; `seed` reads only the three committed SQL files in numeric order and sends each as stdin to `docker compose -f compose.yaml exec -T app-postgres psql --set=ON_ERROR_STOP=1` using argument arrays and the active signal, never a shell. Own root scripts `"demo:db:start": "node scripts/demo-db.ts start"` and `"demo:db:seed": "node scripts/demo-db.ts seed"` in `package.json`.

- [ ] **Step 4: Run unit and executable dbt tests**

Run: `uv run --project tools/datahub pytest tools/datahub/tests/test_demo_sql.py -q && pnpm vitest run scripts/demo-db.test.ts`
Expected: SQL/dbt structure and command-policy tests PASS.

Run: `pnpm demo:db:start && pnpm demo:db:seed && uv run --project tools/datahub dbt debug --project-dir demo/dbt --profiles-dir demo/dbt && uv run --project tools/datahub dbt build --project-dir demo/dbt --profiles-dir demo/dbt`
Expected: connection PASS; 3 models and all declared tests PASS.

- [ ] **Step 5: Commit deterministic warehouse/dbt data**

```bash
git add compose.yaml demo/warehouse demo/dbt tools/datahub/tests/test_demo_sql.py scripts/demo-db.ts scripts/demo-db.test.ts package.json
git commit -m "feat: add canonical warehouse and dbt data"
```

### Task 2: Define the checked graph expectation and seed governance entities

**Files:**
- Create: `demo/scenarios/canonical/expected-datahub-graph.json`
- Create: `tools/datahub/src/lineageguard_datahub/models.py`
- Create: `tools/datahub/src/lineageguard_datahub/expected_graph.py`
- Create: `tools/datahub/src/lineageguard_datahub/seed.py`
- Create: `tools/datahub/tests/test_expected_graph.py`

**Interfaces:**
- Consumes: canonical database/dbt relation names.
- Produces: `ExpectedGraph`, `load_expected_graph(path)`, and idempotent `seed_governance(client, graph)`.

- [ ] **Step 1: Write failing expectation-schema tests**

```py
from pathlib import Path
from lineageguard_datahub.expected_graph import load_expected_graph


def test_expected_graph_has_one_source_and_four_impact_cards() -> None:
    graph = load_expected_graph(
        Path("demo/scenarios/canonical/expected-datahub-graph.json")
    )
    assert graph.source_field.logical_key == "commerce.orders.customer_id"
    assert [item.logical_key for item in graph.impact_cards] == [
        "analytics.customer_revenue",
        "finance.revenue-dashboard",
        "fraud.model-v3",
        "query.finance-monthly-close",
    ]
    assert {node.logical_key for node in graph.lineage_intermediates} == {
        "analytics.stg_orders",
        "fraud.customer_features",
    }
```

- [ ] **Step 2: Run test and observe the missing expectation loader**

Run: `uv run --project tools/datahub pytest tools/datahub/tests/test_expected_graph.py::test_expected_graph_has_one_source_and_four_impact_cards -q`
Expected: FAIL importing `expected_graph`.

- [ ] **Step 3: Implement strict expected-graph loading and governance seeding**

Use frozen dataclasses or Pydantic models with `extra="forbid"`. The JSON contains explicit logical keys, expected URNs, entity types, platform/environment, owner URNs, criticality, glossary term URN, field paths, edge type/granularity, query marker/fingerprint, and `countsAsImpactCard`.

Implement `seed_governance` with official SDK operations that upsert:

- owner groups/users for Finance Analytics and Risk ML;
- glossary term `Customer Identifier` linked to `commerce.orders.customer_id`;
- tag `LineageGuardValidated` with exact URN `urn:li:tag:LineageGuardValidated`, left unapplied until F8;
- Finance Revenue Dashboard owned by Finance Analytics and marked critical;
- Fraud Model v3 owned by Risk ML and marked production/critical;
- a document parent `LineageGuard Migration Decisions` plus an initial README document so document search tools are exposed.

Every operation derives its target URN from `ExpectedGraph`; no fuzzy search is allowed during seed.

- [ ] **Step 4: Run loader and mocked SDK-call shape tests**

Run: `uv run --project tools/datahub pytest tools/datahub/tests/test_expected_graph.py -q`
Expected: all expectation and idempotent operation-shape tests PASS.

- [ ] **Step 5: Commit the canonical expectation and governance seeder**

```bash
git add demo/scenarios/canonical/expected-datahub-graph.json tools/datahub/src/lineageguard_datahub tools/datahub/tests/test_expected_graph.py
git commit -m "feat: define canonical DataHub graph contract"
```

### Task 3: Ingest PostgreSQL/dbt metadata and exact lineage

**Files:**
- Create: `demo/metadata/postgres-ingestion.yml`
- Create: `demo/metadata/dbt-ingestion.yml`
- Create: `tools/datahub/src/lineageguard_datahub/ingest.py`
- Create: `tools/datahub/src/lineageguard_datahub/lineage.py`
- Create: `tools/datahub/tests/test_lineage_plan.py`
- Modify: `tools/datahub/pyproject.toml`
- Modify: `package.json`

**Interfaces:**
- Consumes: `ExpectedGraph`, dbt artifacts, DataHub GMS environment configuration.
- Produces: `build_lineage_plan(graph): tuple[LineageEdge, ...]` and CLI `lineageguard-datahub-ingest`.

- [ ] **Step 1: Write failing exact-lineage tests**

```py
def test_column_edges_end_before_non_dataset_entities(expected_graph) -> None:
    edges = build_lineage_plan(expected_graph)
    column_edges = [edge for edge in edges if edge.granularity == "FIELD"]
    entity_edges = [edge for edge in edges if edge.granularity == "ENTITY"]
    assert all(edge.upstream_type == "DATASET" for edge in column_edges)
    assert all(edge.downstream_type == "DATASET" for edge in column_edges)
    assert any(edge.downstream_type == "DASHBOARD" for edge in entity_edges)
    assert any(edge.downstream_type == "MLMODEL" for edge in entity_edges)
```

- [ ] **Step 2: Run test and observe missing lineage planner**

Run: `uv run --project tools/datahub pytest tools/datahub/tests/test_lineage_plan.py -q`
Expected: FAIL importing `build_lineage_plan`.

- [ ] **Step 3: Implement pinned ingestion recipes and lineage plan**

The PostgreSQL recipe sets `env: PROD`, fixed database/schema allowlists, `include_query_lineage: true`, `include_usage_statistics: true`, `min_query_calls: 1`, `top_n_queries: 20`, and excludes system/temp queries only. The dbt recipe consumes generated `manifest.json`, `catalog.json`, and `run_results.json` and uses the same platform instance/environment identity as PostgreSQL. Own `"demo:data:ingest": "uv run --project tools/datahub lineageguard-datahub-ingest"` in `package.json` before any later task invokes it.

Build explicit downstream field mappings from `commerce.orders.customer_id` through `analytics.stg_orders.customer_id` to `analytics.customer_revenue.customer_id` and `fraud.customer_features.customer_id`. Then emit entity edges to Finance Revenue Dashboard and Fraud Model v3. Refuse field edges whose endpoint is not a Dataset.

- [ ] **Step 4: Run plan tests and live ingestion**

Run: `uv run --project tools/datahub pytest tools/datahub/tests/test_lineage_plan.py -q`
Expected: PASS.

Run: `uv run --project tools/datahub lineageguard-datahub-ingest`
Expected: PostgreSQL and dbt ingestion complete; lineage operations report only expected logical keys and no token values.

- [ ] **Step 5: Commit ingestion and exact lineage**

```bash
git add demo/metadata tools/datahub/pyproject.toml tools/datahub/uv.lock tools/datahub/src/lineageguard_datahub/ingest.py tools/datahub/src/lineageguard_datahub/lineage.py tools/datahub/tests/test_lineage_plan.py package.json
git commit -m "feat: ingest exact canonical DataHub lineage"
```

### Task 4: Execute and prove unmanaged query history

**Files:**
- Create: `tools/datahub/src/lineageguard_datahub/query_history.py`
- Create: `tools/datahub/tests/test_query_history.py`
- Modify: `tools/datahub/src/lineageguard_datahub/ingest.py`
- Modify: `demo/scenarios/canonical/expected-datahub-graph.json`
- Modify: `tools/datahub/pyproject.toml`
- Modify: `package.json`

**Interfaces:**
- Consumes: committed Finance SQL and application PostgreSQL connection.
- Produces: `execute_canonical_query(connection, sql_path): QueryExecutionReceipt` and stable normalized query fingerprint.

- [ ] **Step 1: Write failing query-safety and fingerprint tests**

```py
def test_only_the_committed_read_query_is_executed(tmp_path, canonical_query) -> None:
    receipt = plan_query_execution(canonical_query)
    assert receipt.marker == "lineageguard:finance-monthly-close"
    assert receipt.statement_kind == "SELECT"
    assert receipt.fingerprint == receipt.fingerprint.lower()


def test_mutating_query_is_rejected() -> None:
    with pytest.raises(QueryPolicyError, match="QUERY_NOT_READ_ONLY"):
        plan_query_execution("delete from commerce.orders")
```

- [ ] **Step 2: Run tests and observe missing query policy**

Run: `uv run --project tools/datahub pytest tools/datahub/tests/test_query_history.py -q`
Expected: FAIL importing `plan_query_execution`.

- [ ] **Step 3: Implement allowlisted query execution and ingestion order**

Parse the first SQL keyword after comments; require `SELECT`, the exact marker, and the SHA-256 recorded in the graph manifest. Execute using a read-only PostgreSQL transaction and a fixed `statement_timeout`. Verify `pg_stat_statements` contains the marker before launching PostgreSQL ingestion. Normalize whitespace and literals only for the stored evidence fingerprint; keep the committed SQL available for judge inspection. Expose the exact Python entry point `lineageguard-datahub-query` and own `"demo:data:query": "uv run --project tools/datahub lineageguard-datahub-query"` in `package.json` before Step 4 invokes it.

- [ ] **Step 4: Run tests and live query proof**

Run: `uv run --project tools/datahub pytest tools/datahub/tests/test_query_history.py -q`
Expected: policy tests PASS.

Run: `pnpm demo:data:query && pnpm demo:data:ingest`
Expected: query receipt prints its fingerprint; ingestion reports at least one matching usage/query record.

- [ ] **Step 5: Commit query-history proof**

```bash
git add tools/datahub/src/lineageguard_datahub/query_history.py tools/datahub/src/lineageguard_datahub/ingest.py tools/datahub/tests/test_query_history.py tools/datahub/pyproject.toml demo/scenarios/canonical/expected-datahub-graph.json package.json
git commit -m "feat: capture canonical unmanaged query evidence"
```

### Task 5: Implement reset/seed/verify and prove idempotency

**Files:**
- Create: `tools/datahub/src/lineageguard_datahub/config.py`
- Create: `tools/datahub/src/lineageguard_datahub/reset.py`
- Create: `tools/datahub/src/lineageguard_datahub/verify.py`
- Create: `tools/datahub/tests/test_reset_scope.py`
- Create: `tools/datahub/tests/test_secret_redaction.py`
- Modify: `tools/datahub/pyproject.toml`
- Modify: `package.json`
- Modify: `Makefile`
- Modify: `README.md`

**Interfaces:**
- Consumes: expected graph, seeded database, live DataHub client.
- Produces/confirms: commands `demo:data:reset`, `demo:data:seed`, `demo:data:ingest`, `demo:data:query`, `demo:data:verify` and structured `GraphVerificationReport`; Task 3 owns `ingest`, Task 4 owns `query`, and this task owns the remaining three.

- [ ] **Step 1: Write failing reset-scope and verifier tests**

```py
def test_reset_refuses_non_demo_environment() -> None:
    with pytest.raises(ResetPolicyError, match="DEMO_ENV_REQUIRED"):
        build_reset_plan(env="PROD", platform_instance="shared")


def test_verifier_reports_missing_query_separately(expected_graph) -> None:
    report = compare_observed_graph(expected_graph, observed_without_query())
    assert report.ok is False
    assert report.failures[0].code == "QUERY_EVIDENCE_MISSING"
```

- [ ] **Step 2: Run tests and observe missing reset/verifier**

Run: `uv run --project tools/datahub pytest tools/datahub/tests/test_reset_scope.py tools/datahub/tests/test_secret_redaction.py -q`
Expected: FAIL importing reset/verifier modules.

- [ ] **Step 3: Implement scoped reset and structured verification**

Require `LINEAGEGUARD_DEMO_ENV=canonical` and the exact platform instance from the expectation file before reset. Reset only URNs recorded in the manifest and only the named demo PostgreSQL databases/schemas. Verification calls official DataHub APIs/MCP-compatible queries, normalizes volatile timestamps, and compares entity, field, lineage, path, owner, term, criticality, document, and query facts. Output JSON contains logical keys and fingerprints, not tokens or raw connection strings. Expose exact Python entry points `lineageguard-datahub-reset`, `lineageguard-datahub-seed`, and `lineageguard-datahub-verify`; own `"demo:data:reset": "uv run --project tools/datahub lineageguard-datahub-reset"`, `"demo:data:seed": "uv run --project tools/datahub lineageguard-datahub-seed"`, and `"demo:data:verify": "uv run --project tools/datahub lineageguard-datahub-verify"` in `package.json` without replacing the Task 3 `demo:data:ingest` or Task 4 `demo:data:query` owners.

- [ ] **Step 4: Run the canonical sequence twice**

Run:

```bash
pnpm demo:data:reset
pnpm demo:data:seed
pnpm demo:data:query
pnpm demo:data:ingest
pnpm demo:data:verify
pnpm demo:data:seed
pnpm demo:data:query
pnpm demo:data:ingest
pnpm demo:data:verify
```

Expected after the count gate is explicitly approved: both verification runs report `ok=true`, `impactCards=4`, `lineageIntermediates=2`, and the same normalized graph fingerprint; the second run creates no duplicate logical entities/edges. If the count gate is rejected, stop and revise this plan rather than running the hardcoded assertion.

- [ ] **Step 5: Commit commands and documentation**

```bash
git add tools/datahub package.json Makefile README.md
git commit -m "feat: verify repeatable canonical DataHub graph"
```

### Task 6: Independent Gate A reviews and verification

**Files:**
- Review: complete F1 diff and live DataHub state.
- Modify only for accepted review findings.

**Interfaces:**
- Consumes: repeatable live graph and F1 specification.
- Produces: Gate A evidence for F3.

- [ ] **Step 1: Run independent specification review**

Fresh read-only reviewer compares F1 with the product graph, storyboard, F1 specification, official DataHub 1.6 docs, and the approved impact-count convention. The reviewer must inspect the actual DataHub UI/API evidence and report any missing/extra entity, false field-level edge, invented count, or non-idempotent seed.

- [ ] **Step 2: Run independent code-quality/security review**

Different read-only reviewer inspects Python typing, reset target safety, SQL execution policy, ingestion reproducibility, secret redaction, error taxonomy, and fixture fidelity. Resolve blocking findings with focused test-first commits.

- [ ] **Step 3: Invoke verification-before-completion**

Run:

```bash
pnpm format:check
pnpm lint
pnpm typecheck
pnpm test
pnpm demo:data:reset
pnpm demo:data:seed
pnpm demo:data:ingest
pnpm demo:data:verify
uv run --project tools/datahub --locked pytest
```

Expected: all zero and live report `ok=true` with the approved counts and query fingerprint.

- [ ] **Step 4: Attach Gate A evidence and stop**

Attach normalized verifier JSON, screenshots/links for each canonical entity, command output, reviewer findings/resolutions, and commit SHAs. Do not start F3 automatically; a human must first confirm the graph is visible and credible.
