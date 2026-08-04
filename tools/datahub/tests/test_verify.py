from __future__ import annotations

from dataclasses import replace

from lineageguard_datahub.models import ExpectedGraph
from lineageguard_datahub.receipts import OperationReceipt, ReceiptStatus
from lineageguard_datahub.verify import compare_observed_graph, expected_observation


def _live_receipts(graph: ExpectedGraph) -> tuple[OperationReceipt, ...]:
    query = replace(
        OperationReceipt.create(
            scenario_id=graph.scenario_id,
            operation_kind="query",
            entity_urn=None,
            aspect_name="pg_stat_statements",
            idempotency_key="query",
            status=ReceiptStatus.SUCCESS,
            detail_code="PG_STAT_OBSERVED",
            metrics={"executionCount": 2, "totalExecTimeMs": 1.5},
        ),
        recorded_at="2026-08-04T10:00:00+00:00",
    )
    ingest = replace(
        OperationReceipt.create(
            scenario_id=graph.scenario_id,
            operation_kind="ingest",
            entity_urn=None,
            aspect_name="walkthrough/metadata/postgres-ingestion.yml",
            idempotency_key="ingest",
            status=ReceiptStatus.SUCCESS,
            detail_code="INGESTED",
        ),
        recorded_at="2026-08-04T10:01:00+00:00",
    )
    live_query = tuple(
        replace(
            OperationReceipt.create(
                scenario_id=graph.scenario_id,
                operation_kind="ingest-query",
                entity_urn="urn:li:query:system-observed",
                aspect_name=aspect,
                idempotency_key=aspect,
                status=ReceiptStatus.SUCCESS,
                detail_code="LIVE_QUERY_EMITTED",
            ),
            recorded_at="2026-08-04T10:01:01+00:00",
        )
        for aspect in ("queryProperties", "querySubjects", "queryUsageStatistics")
    )
    return (query, ingest, *live_query)


def test_exact_live_observation_verifies(expected_graph: ExpectedGraph) -> None:
    report = compare_observed_graph(
        expected_graph,
        expected_observation(expected_graph),
        _live_receipts(expected_graph),
    )
    assert report.ok is True
    assert report.impact_cards == 4
    assert report.lineage_intermediates == 2
    assert report.failures == ()


def test_missing_live_query_reports_observed_count_not_expected_count(
    expected_graph: ExpectedGraph,
) -> None:
    observed = expected_observation(expected_graph)
    report = compare_observed_graph(
        expected_graph,
        replace(observed, query_signals=()),
        _live_receipts(expected_graph),
    )
    assert report.ok is False
    assert report.impact_cards == 3
    assert {failure.code for failure in report.failures} >= {
        "LIVE_QUERY_EVIDENCE_MISSING",
        "IMPACT_PATH_INCOMPLETE",
    }


def test_custom_query_owner_cannot_replace_official_asset_ownership(
    expected_graph: ExpectedGraph,
) -> None:
    observed = expected_observation(expected_graph)
    revenue = next(
        node for node in expected_graph.nodes if node.logical_key == "analytics.customer_revenue"
    )
    owner = expected_graph.query_evidence[0].owner_urn
    forged = (expected_graph.query_evidence[0].query_urn, owner)
    ownership = (set(observed.ownership) - {(revenue.urn, owner)}) | {forged}
    report = compare_observed_graph(
        expected_graph,
        replace(observed, ownership=frozenset(ownership)),
        _live_receipts(expected_graph),
    )
    assert "OWNER_MISSING" in {failure.code for failure in report.failures}


def test_missing_receipts_cannot_report_live_success(expected_graph: ExpectedGraph) -> None:
    report = compare_observed_graph(expected_graph, expected_observation(expected_graph))
    assert report.ok is False
    assert {failure.code for failure in report.failures} == {
        "PG_STAT_RECEIPT_MISSING",
        "POSTGRES_INGEST_RECEIPT_MISSING",
        "LIVE_QUERY_INGEST_RECEIPTS_MISSING",
    }
