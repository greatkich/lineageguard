from __future__ import annotations

from collections import defaultdict

from lineageguard_datahub.models import ExpectedGraph, Granularity, LineageEdge


class LineagePlanError(ValueError):
    """The manifest cannot be converted into unambiguous DataHub lineage."""


def build_lineage_plan(graph: ExpectedGraph) -> tuple[LineageEdge, ...]:
    """Return a deterministic plan after checking DataHub fine-lineage invariants."""
    by_downstream: dict[str, list[LineageEdge]] = defaultdict(list)
    for edge in graph.edges:
        if edge.upstream_urn == edge.downstream_urn:
            raise LineagePlanError(f"SELF_REFERENTIAL_EDGE:{edge.logical_key}")
        if edge.granularity is Granularity.FIELD and (
            edge.upstream_field_path is None or edge.downstream_field_path is None
        ):
            raise LineagePlanError(f"FIELD_PATH_REQUIRED:{edge.logical_key}")
        by_downstream[edge.downstream_urn].append(edge)

    ordered: list[LineageEdge] = []
    for downstream_urn in sorted(by_downstream):
        ordered.extend(sorted(by_downstream[downstream_urn], key=lambda edge: edge.logical_key))
    return tuple(ordered)


def edges_by_downstream(graph: ExpectedGraph) -> dict[str, tuple[LineageEdge, ...]]:
    grouped: dict[str, list[LineageEdge]] = defaultdict(list)
    for edge in build_lineage_plan(graph):
        grouped[edge.downstream_urn].append(edge)
    return {urn: tuple(edges) for urn, edges in grouped.items()}
