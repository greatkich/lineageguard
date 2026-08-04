from __future__ import annotations

from pathlib import Path

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
from lineageguard_datahub.seed import build_seed_plan, seed_metadata


class RecordingEmitter:
    def __init__(self) -> None:
        self.proposals: list[object] = []

    def emit_mcp(self, mcp: object) -> None:
        self.proposals.append(mcp)


def test_seed_plan_is_stable_and_idempotent(
    expected_graph: ExpectedGraph, repository_root: Path
) -> None:
    first = build_seed_plan(expected_graph, repository_root)
    second = build_seed_plan(expected_graph, repository_root)
    assert [item.idempotency_key for item in first] == [item.idempotency_key for item in second]
    assert len({item.idempotency_key for item in first}) == len(first)
    assert {item.proposal.entityUrn for item in first} <= set(expected_graph.managed_urns)


def test_repeated_seed_emits_same_upsert_sequence(
    expected_graph: ExpectedGraph, repository_root: Path
) -> None:
    emitter = RecordingEmitter()
    first = seed_metadata(emitter, expected_graph, repository_root)
    second = seed_metadata(emitter, expected_graph, repository_root)
    assert first.idempotency_keys == second.idempotency_keys
    assert len(emitter.proposals) == first.emitted * 2


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
