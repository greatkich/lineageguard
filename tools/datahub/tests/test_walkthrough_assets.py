from __future__ import annotations

from pathlib import Path

from lineageguard_datahub.warehouse import build_warehouse_seed_plan


def test_canonical_models_preserve_customer_id_lineage(repository_root: Path) -> None:
    stg = (repository_root / "walkthrough/dbt/models/staging/stg_orders.sql").read_text()
    revenue = (
        repository_root / "walkthrough/dbt/models/analytics/customer_revenue.sql"
    ).read_text()
    fraud = (repository_root / "walkthrough/dbt/models/fraud/customer_features.sql").read_text()
    assert "customer_id" in stg
    assert "ref('stg_orders')" in revenue
    assert "customer_id" in revenue
    assert "ref('stg_orders')" in fraud
    assert "customer_id" in fraud


def test_unmanaged_query_has_stable_marker_and_field_reference(repository_root: Path) -> None:
    query = (
        repository_root / "walkthrough/warehouse/queries/finance-monthly-close.sql"
    ).read_text()
    assert "lineageguard:finance-monthly-close" in query
    assert "customer_id" in query
    assert "analytics.customer_revenue" in query


def test_warehouse_seed_order_is_fixed(repository_root: Path) -> None:
    plan = build_warehouse_seed_plan(repository_root)
    assert [path.name for path in plan.sql_paths] == [
        "001-schemas.sql",
        "002-tables.sql",
        "003-seed.sql",
    ]
