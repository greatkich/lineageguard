from __future__ import annotations

from pathlib import Path
from typing import Any

import pytest
from datahub.emitter.mcp import MetadataChangeProposalWrapper
from datahub.metadata.schema_classes import (
    CorpGroupKeyClass,
    DashboardInfoClass,
    DashboardKeyClass,
    DatasetKeyClass,
    DatasetPropertiesClass,
    GlossaryTermKeyClass,
    MLModelKeyClass,
    QueryKeyClass,
    SchemaFieldKeyClass,
    TagKeyClass,
)

from lineageguard_datahub.models import ExpectedGraph
from lineageguard_datahub.receipts import ReceiptStatus, ReceiptStore
from lineageguard_datahub.seed import (
    build_seed_plan,
    entity_has_scenario_marker,
    seed_metadata,
)


class FakeCatalog:
    def __init__(self) -> None:
        self.aspects: dict[tuple[str, type[object]], Any] = {}

    def exists(self, entity_urn: str) -> bool:
        return any(urn == entity_urn for urn, _ in self.aspects)

    def get_aspect(self, entity_urn: str, aspect_type: type[Any], version: int = 0) -> Any | None:
        del version
        return self.aspects.get((entity_urn, aspect_type))


class RecordingEmitter:
    def __init__(self, catalog: FakeCatalog, *, fail_at: int | None = None) -> None:
        self.catalog = catalog
        self.fail_at = fail_at
        self.proposals: list[MetadataChangeProposalWrapper] = []

    def emit_mcp(self, mcp: MetadataChangeProposalWrapper) -> None:
        if self.fail_at is not None and len(self.proposals) == self.fail_at:
            raise RuntimeError("injected")
        self.proposals.append(mcp)
        assert mcp.entityUrn is not None and mcp.aspect is not None
        self.catalog.aspects[(mcp.entityUrn, type(mcp.aspect))] = mcp.aspect


class ConnectorPresence:
    pass


def _add_connector_entities(catalog: FakeCatalog, graph: ExpectedGraph) -> None:
    for urn in (*graph.connector_dataset_urns, graph.source_field.schema_field_urn):
        catalog.aspects[(urn, ConnectorPresence)] = ConnectorPresence()


def test_seed_plan_is_stable_and_idempotent(
    expected_graph: ExpectedGraph, repository_root: Path
) -> None:
    first = build_seed_plan(expected_graph, repository_root)
    second = build_seed_plan(expected_graph, repository_root)
    assert [item.idempotency_key for item in first] == [item.idempotency_key for item in second]
    assert len({item.idempotency_key for item in first}) == len(first)
    assert {item.proposal.entityUrn for item in first} <= set(expected_graph.allowed_mutation_urns)
    assert not any(
        item.proposal.aspectName in {"datasetProperties", "schemaMetadata"}
        for item in first
        if item.proposal.entityUrn in expected_graph.connector_dataset_urns
    )


def test_repeated_seed_emits_same_upsert_sequence(
    expected_graph: ExpectedGraph, repository_root: Path, tmp_path: Path
) -> None:
    catalog = FakeCatalog()
    _add_connector_entities(catalog, expected_graph)
    emitter = RecordingEmitter(catalog)
    store = ReceiptStore(tmp_path / "operations.jsonl")
    first = seed_metadata(emitter, catalog, store, expected_graph, repository_root)
    second = seed_metadata(emitter, catalog, store, expected_graph, repository_root)
    assert first.idempotency_keys == second.idempotency_keys
    assert first.emitted == len(emitter.proposals)
    assert second.emitted == 0
    assert second.skipped == first.emitted


def test_partial_failure_is_durable_and_retry_reconciles_exact_successes(
    expected_graph: ExpectedGraph, repository_root: Path, tmp_path: Path
) -> None:
    catalog = FakeCatalog()
    _add_connector_entities(catalog, expected_graph)
    store = ReceiptStore(tmp_path / "operations.jsonl")
    with pytest.raises(RuntimeError, match="injected"):
        seed_metadata(
            RecordingEmitter(catalog, fail_at=4),
            catalog,
            store,
            expected_graph,
            repository_root,
        )
    receipts = store.read_all()
    assert (
        sum(
            item.status is ReceiptStatus.SUCCESS and item.operation_kind == "seed"
            for item in receipts
        )
        == 4
    )
    assert sum(item.status is ReceiptStatus.FAILURE for item in receipts) == 1
    retry = seed_metadata(
        RecordingEmitter(catalog), catalog, store, expected_graph, repository_root
    )
    assert retry.skipped == 4
    assert retry.emitted == len(build_seed_plan(expected_graph, repository_root)) - 4


def test_plan_contains_query_governance_and_each_lineage_target(
    expected_graph: ExpectedGraph, repository_root: Path
) -> None:
    plan = build_seed_plan(expected_graph, repository_root)
    logical_keys = {item.logical_key for item in plan}
    assert not any(key.startswith("query.finance-monthly-close:") for key in logical_keys)
    assert "fraud.model-v3:training-data" in logical_keys
    dataset_downstreams = {
        edge.downstream_urn
        for edge in expected_graph.edges
        if edge.downstream_type.value == "DATASET"
    }
    for downstream_urn in dataset_downstreams:
        assert f"lineage:{downstream_urn}" in logical_keys


def test_every_upsert_uses_an_aspect_allowed_for_its_entity(
    expected_graph: ExpectedGraph, repository_root: Path
) -> None:
    key_classes = {
        "corpGroup": CorpGroupKeyClass,
        "dashboard": DashboardKeyClass,
        "dataset": DatasetKeyClass,
        "glossaryTerm": GlossaryTermKeyClass,
        "mlModel": MLModelKeyClass,
        "query": QueryKeyClass,
        "schemaField": SchemaFieldKeyClass,
        "tag": TagKeyClass,
    }
    for operation in build_seed_plan(expected_graph, repository_root):
        proposal = operation.proposal
        allowed = key_classes[proposal.entityType].ASPECT_INFO["entityAspects"]
        assert proposal.aspectName in allowed, operation.logical_key


def test_preexisting_exact_entities_never_receive_creation_receipts(
    expected_graph: ExpectedGraph, repository_root: Path, tmp_path: Path
) -> None:
    store = ReceiptStore(tmp_path / "operations.jsonl")
    catalog = FakeCatalog()
    _add_connector_entities(catalog, expected_graph)
    for operation in build_seed_plan(expected_graph, repository_root, store.ownership_nonce):
        proposal = operation.proposal
        assert proposal.entityUrn is not None and proposal.aspect is not None
        catalog.aspects[(proposal.entityUrn, type(proposal.aspect))] = proposal.aspect
    result = seed_metadata(
        RecordingEmitter(catalog), catalog, store, expected_graph, repository_root
    )
    assert result.emitted == 0
    assert not any(item.detail_code == "ENTITY_CREATED" for item in store.read_all())


def test_public_marker_without_creation_proof_cannot_authorize_reconciliation(
    expected_graph: ExpectedGraph, repository_root: Path, tmp_path: Path
) -> None:
    store = ReceiptStore(tmp_path / "operations.jsonl")
    catalog = FakeCatalog()
    _add_connector_entities(catalog, expected_graph)
    first = next(
        item
        for item in build_seed_plan(expected_graph, repository_root, store.ownership_nonce)
        if item.logical_key == "finance.revenue-dashboard:info"
    )
    assert first.proposal.entityUrn is not None and first.proposal.aspect is not None
    catalog.aspects[(first.proposal.entityUrn, type(first.proposal.aspect))] = first.proposal.aspect
    with pytest.raises(ValueError, match="EXISTING_ENTITY_NOT_OWNED"):
        seed_metadata(RecordingEmitter(catalog), catalog, store, expected_graph, repository_root)


def test_owned_entity_drift_is_not_clobbered(
    expected_graph: ExpectedGraph, repository_root: Path, tmp_path: Path
) -> None:
    store = ReceiptStore(tmp_path / "operations.jsonl")
    catalog = FakeCatalog()
    _add_connector_entities(catalog, expected_graph)
    seed_metadata(RecordingEmitter(catalog), catalog, store, expected_graph, repository_root)
    ownership_operation = next(
        item
        for item in build_seed_plan(expected_graph, repository_root, store.ownership_nonce)
        if item.logical_key == "finance.revenue-dashboard:ownership"
    )
    assert ownership_operation.proposal.entityUrn is not None
    assert ownership_operation.proposal.aspect is not None
    current = catalog.aspects[
        (
            ownership_operation.proposal.entityUrn,
            type(ownership_operation.proposal.aspect),
        )
    ]
    current.owners = []
    with pytest.raises(ValueError, match="OWNED_ASPECT_DRIFT"):
        seed_metadata(RecordingEmitter(catalog), catalog, store, expected_graph, repository_root)


def test_repeat_connector_refresh_preserves_overlays_and_owned_markers(
    expected_graph: ExpectedGraph, repository_root: Path, tmp_path: Path
) -> None:
    store = ReceiptStore(tmp_path / "operations.jsonl")
    catalog = FakeCatalog()
    _add_connector_entities(catalog, expected_graph)
    seed_metadata(RecordingEmitter(catalog), catalog, store, expected_graph, repository_root)
    source_terms = next(
        item
        for item in build_seed_plan(expected_graph, repository_root, store.ownership_nonce)
        if item.logical_key == "commerce.orders.customer_id:glossary-terms"
    )
    assert source_terms.proposal.aspect is not None
    overlay_key = (
        expected_graph.source_field.schema_field_urn,
        type(source_terms.proposal.aspect),
    )
    before_terms = catalog.aspects[overlay_key]
    for urn in expected_graph.connector_dataset_urns:
        catalog.aspects[(urn, DatasetPropertiesClass)] = DatasetPropertiesClass(
            name="connector-refreshed"
        )
    assert catalog.aspects[overlay_key] is before_terms
    dashboard = next(
        node for node in expected_graph.nodes if node.logical_key == "finance.revenue-dashboard"
    )
    assert isinstance(catalog.get_aspect(dashboard.urn, DashboardInfoClass), DashboardInfoClass)
    assert entity_has_scenario_marker(catalog, dashboard.urn, "dashboard", store.ownership_nonce)
