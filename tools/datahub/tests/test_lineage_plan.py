from __future__ import annotations

from lineageguard_datahub.lineage import build_lineage_plan, edges_by_downstream
from lineageguard_datahub.models import EntityType, ExpectedGraph, Granularity


def test_column_edges_end_before_non_dataset_entities(expected_graph: ExpectedGraph) -> None:
    edges = build_lineage_plan(expected_graph)
    column_edges = [edge for edge in edges if edge.granularity is Granularity.FIELD]
    entity_edges = [edge for edge in edges if edge.granularity is Granularity.ENTITY]
    assert len(column_edges) == 3
    assert all(edge.upstream_type is EntityType.DATASET for edge in column_edges)
    assert all(edge.downstream_type is EntityType.DATASET for edge in column_edges)
    assert any(edge.downstream_type is EntityType.DASHBOARD for edge in entity_edges)
    assert any(edge.downstream_type is EntityType.MLMODEL for edge in entity_edges)


def test_lineage_grouping_is_stable(expected_graph: ExpectedGraph) -> None:
    first = edges_by_downstream(expected_graph)
    second = edges_by_downstream(expected_graph)
    assert first == second
    assert list(first) == sorted(first)
