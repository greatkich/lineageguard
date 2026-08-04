from __future__ import annotations

import json
from pathlib import Path

import pytest
from datahub.emitter.mce_builder import (
    make_dashboard_urn,
    make_dataset_urn_with_platform_instance,
    make_schema_field_urn,
)

from lineageguard_datahub.expected_graph import GraphContractError, load_expected_graph
from lineageguard_datahub.models import ExpectedGraph
from lineageguard_datahub.verify import verify_query_files


def test_expected_graph_has_one_source_and_four_impact_cards(expected_graph: ExpectedGraph) -> None:
    assert expected_graph.source_field.logical_key == "commerce.orders.customer_id"
    assert expected_graph.impact_cards == (
        "analytics.customer_revenue",
        "finance.revenue-dashboard",
        "fraud.model-v3",
        "query.finance-monthly-close",
    )
    assert set(expected_graph.lineage_intermediates) == {
        "analytics.stg_orders",
        "fraud.customer_features",
    }


def test_manifest_urns_match_official_datahub_builders(expected_graph: ExpectedGraph) -> None:
    nodes = {node.logical_key: node for node in expected_graph.nodes}
    assert nodes["commerce.orders"].urn == make_dataset_urn_with_platform_instance(
        "postgres",
        "lineageguard.commerce.orders",
        expected_graph.platform_instance,
        expected_graph.environment,
    )
    assert nodes["finance.revenue-dashboard"].urn == make_dashboard_urn(
        "looker", "finance-revenue-dashboard", expected_graph.platform_instance
    )
    assert expected_graph.source_field.schema_field_urn == make_schema_field_urn(
        expected_graph.source_field.dataset_urn, expected_graph.source_field.field_path
    )


def test_query_file_matches_checked_digest(
    expected_graph: ExpectedGraph, repository_root: Path
) -> None:
    verify_query_files(expected_graph, repository_root)


def test_loader_forbids_unknown_keys(repository_root: Path, tmp_path: Path) -> None:
    manifest = json.loads(
        (
            repository_root / "walkthrough/scenarios/canonical/expected-datahub-graph.json"
        ).read_text()
    )
    manifest["unexpected"] = True
    invalid = tmp_path / "invalid.json"
    invalid.write_text(json.dumps(manifest))
    with pytest.raises(GraphContractError, match="keys mismatch"):
        load_expected_graph(invalid)


def test_loader_forbids_manifest_target_expansion(repository_root: Path, tmp_path: Path) -> None:
    manifest = json.loads(
        (
            repository_root / "walkthrough/scenarios/canonical/expected-datahub-graph.json"
        ).read_text()
    )
    manifest["owners"][0]["urn"] = "urn:li:corpGroup:shared-finance"
    manifest["nodes"][2]["ownerUrns"] = ["urn:li:corpGroup:shared-finance"]
    manifest["nodes"][4]["ownerUrns"] = ["urn:li:corpGroup:shared-finance"]
    manifest["queryEvidence"][0]["ownerUrns"] = ["urn:li:corpGroup:shared-finance"]
    invalid = tmp_path / "expanded.json"
    invalid.write_text(json.dumps(manifest))
    with pytest.raises(GraphContractError, match="URN allowlist mismatch"):
        load_expected_graph(invalid)


@pytest.mark.parametrize("fields", [["customer_id"], ["customer_id", "unexpected"]])
def test_loader_freezes_complete_schema_inventory(
    repository_root: Path, tmp_path: Path, fields: list[str]
) -> None:
    manifest = json.loads(
        (
            repository_root / "walkthrough/scenarios/canonical/expected-datahub-graph.json"
        ).read_text()
    )
    manifest["nodes"][2]["schemaFields"] = fields
    invalid = tmp_path / "schema-drift.json"
    invalid.write_text(json.dumps(manifest))
    with pytest.raises(GraphContractError, match="schemaFields mismatch"):
        load_expected_graph(invalid)


@pytest.mark.parametrize(
    ("logical_key", "ownership_type"),
    [
        ("finance.revenue-dashboard", "TECHNICAL_OWNER"),
        ("fraud.model-v3", "BUSINESS_OWNER"),
    ],
)
def test_loader_freezes_canonical_ownership_types(
    repository_root: Path,
    tmp_path: Path,
    logical_key: str,
    ownership_type: str,
) -> None:
    manifest = json.loads(
        (
            repository_root / "walkthrough/scenarios/canonical/expected-datahub-graph.json"
        ).read_text()
    )
    node = next(item for item in manifest["nodes"] if item["logicalKey"] == logical_key)
    node["ownershipType"] = ownership_type
    invalid = tmp_path / "ownership-drift.json"
    invalid.write_text(json.dumps(manifest))
    with pytest.raises(GraphContractError, match="name/owner/tag mapping mismatch"):
        load_expected_graph(invalid)


@pytest.mark.parametrize(
    ("field", "value"),
    [
        ("ownerUrns", ["urn:li:corpGroup:lineageguard-canonical.risk-ml"]),
        ("ownershipType", "TECHNICAL_OWNER"),
    ],
)
def test_loader_freezes_query_finance_ownership(
    repository_root: Path, tmp_path: Path, field: str, value: object
) -> None:
    manifest = json.loads(
        (
            repository_root / "walkthrough/scenarios/canonical/expected-datahub-graph.json"
        ).read_text()
    )
    manifest["queryEvidence"][0][field] = value
    invalid = tmp_path / "query-ownership-drift.json"
    invalid.write_text(json.dumps(manifest))
    with pytest.raises(GraphContractError, match="query logical mapping mismatch"):
        load_expected_graph(invalid)
