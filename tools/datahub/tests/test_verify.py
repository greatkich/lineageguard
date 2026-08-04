from __future__ import annotations

from dataclasses import replace

from lineageguard_datahub.models import ExpectedGraph
from lineageguard_datahub.verify import compare_observed_graph, expected_observation


def test_exact_expected_observation_verifies(expected_graph: ExpectedGraph) -> None:
    report = compare_observed_graph(expected_graph, expected_observation(expected_graph))
    assert report.ok is True
    assert report.impact_cards == 4
    assert report.lineage_intermediates == 2
    assert report.failures == ()


def test_missing_query_is_reported_separately(expected_graph: ExpectedGraph) -> None:
    observed = expected_observation(expected_graph)
    report = compare_observed_graph(
        expected_graph,
        replace(observed, query_sha256=frozenset()),
    )
    assert report.ok is False
    assert [failure.code for failure in report.failures] == ["QUERY_EVIDENCE_MISSING"]
