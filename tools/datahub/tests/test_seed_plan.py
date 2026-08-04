from __future__ import annotations

from pathlib import Path
from typing import Any

import pytest
from datahub.emitter.mcp import MetadataChangeProposalWrapper
from datahub.metadata.schema_classes import (
    CorpGroupKeyClass,
    DashboardKeyClass,
    DatasetKeyClass,
    GlossaryTermKeyClass,
    MLModelKeyClass,
    QueryKeyClass,
    TagKeyClass,
)

from lineageguard_datahub.models import ExpectedGraph
from lineageguard_datahub.receipts import ReceiptStatus, ReceiptStore
from lineageguard_datahub.seed import build_seed_plan, seed_metadata


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


def test_seed_plan_is_stable_and_idempotent(
    expected_graph: ExpectedGraph, repository_root: Path
) -> None:
    first = build_seed_plan(expected_graph, repository_root)
    second = build_seed_plan(expected_graph, repository_root)
    assert [item.idempotency_key for item in first] == [item.idempotency_key for item in second]
    assert len({item.idempotency_key for item in first}) == len(first)
    assert {item.proposal.entityUrn for item in first} <= set(expected_graph.managed_urns)


def test_repeated_seed_emits_same_upsert_sequence(
    expected_graph: ExpectedGraph, repository_root: Path, tmp_path: Path
) -> None:
    catalog = FakeCatalog()
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
    assert sum(item.status is ReceiptStatus.SUCCESS for item in receipts) == 4
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
    assert "query.finance-monthly-close:properties" in logical_keys
    assert "query.finance-monthly-close:subjects" in logical_keys
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
        "tag": TagKeyClass,
    }
    for operation in build_seed_plan(expected_graph, repository_root):
        proposal = operation.proposal
        allowed = key_classes[proposal.entityType].ASPECT_INFO["entityAspects"]
        assert proposal.aspectName in allowed, operation.logical_key
