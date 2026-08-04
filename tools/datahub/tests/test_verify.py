from __future__ import annotations

from collections.abc import Callable
from dataclasses import replace
from pathlib import Path

import pytest

from lineageguard_datahub.ingestion import RECIPE_DIGESTS
from lineageguard_datahub.live_query import build_live_query_plan
from lineageguard_datahub.models import ExpectedGraph
from lineageguard_datahub.query_history import plan_query_execution
from lineageguard_datahub.receipts import OperationReceipt, ReceiptStatus
from lineageguard_datahub.verify import ObservedGraph, compare_observed_graph, expected_observation


def _live_bundle(
    graph: ExpectedGraph, repository_root: Path
) -> tuple[ObservedGraph, tuple[OperationReceipt, ...]]:
    execution = plan_query_execution(repository_root, graph.query_evidence[0])
    query = OperationReceipt.create(
        scenario_id=graph.scenario_id,
        operation_kind="query",
        entity_urn=None,
        aspect_name="pg_stat_statements",
        idempotency_key=execution.normalized_fingerprint,
        status=ReceiptStatus.SUCCESS,
        detail_code="PG_STAT_OBSERVED",
        recorded_at="2026-08-04T10:00:00+00:00",
        metrics={
            "queryId": "48291",
            "executionCount": 2,
            "totalExecTimeMs": 1.5,
            "normalizedFingerprint": execution.normalized_fingerprint,
            "statementSha256": execution.sha256,
        },
    )
    recipe_digest = RECIPE_DIGESTS["walkthrough/metadata/postgres-ingestion.yml"]
    ingest = OperationReceipt.create(
        scenario_id=graph.scenario_id,
        operation_kind="ingest",
        entity_urn=None,
        aspect_name="walkthrough/metadata/postgres-ingestion.yml",
        idempotency_key=recipe_digest,
        status=ReceiptStatus.SUCCESS,
        detail_code="INGESTED",
        recorded_at="2026-08-04T10:01:00+00:00",
    )
    plan = build_live_query_plan(graph, repository_root, query, "nonce")
    metrics = {
        "queryFingerprint": execution.normalized_fingerprint,
        "pgStatQueryId": "48291",
        "executionCount": 2,
        "totalExecTimeMs": 1.5,
        "observationTimestamp": query.recorded_at,
        "recipeFingerprint": recipe_digest,
        "beforeStatus": "MISSING",
        "afterStatus": "EMITTED",
    }
    live = tuple(
        OperationReceipt.create(
            scenario_id=graph.scenario_id,
            operation_kind="ingest-query",
            entity_urn=graph.query_evidence[0].query_urn,
            aspect_name=item.proposal.aspectName,
            idempotency_key=item.idempotency_key,
            proposal_hash=item.idempotency_key,
            status=ReceiptStatus.SUCCESS,
            detail_code="LIVE_QUERY_EMITTED",
            recorded_at="2026-08-04T10:01:01+00:00",
            metrics=metrics,
        )
        for item in plan
    )
    observed = expected_observation(graph)
    signal = replace(
        observed.query_signals[0],
        usage_count=2,
        observation_timestamp_ms=1785837600000,
        aspect_keys=tuple((item.proposal.aspectName or "", item.idempotency_key) for item in plan),
    )
    return replace(observed, query_signals=(signal,)), (query, ingest, *live)


def test_exact_live_observation_verifies(
    expected_graph: ExpectedGraph, repository_root: Path
) -> None:
    observed, receipts = _live_bundle(expected_graph, repository_root)
    report = compare_observed_graph(expected_graph, observed, receipts)
    assert report.ok is True
    assert report.impact_cards == 4
    assert report.lineage_intermediates == 2
    assert report.failures == ()


def test_missing_live_query_reports_observed_count_not_expected_count(
    expected_graph: ExpectedGraph, repository_root: Path
) -> None:
    observed, receipts = _live_bundle(expected_graph, repository_root)
    report = compare_observed_graph(
        expected_graph,
        replace(observed, query_signals=()),
        receipts,
    )
    assert report.ok is False
    assert report.impact_cards == 3
    assert {failure.code for failure in report.failures} >= {
        "LIVE_QUERY_EVIDENCE_MISSING",
        "IMPACT_PATH_INCOMPLETE",
    }


def test_split_or_mismatched_live_signal_is_rejected(
    expected_graph: ExpectedGraph, repository_root: Path
) -> None:
    observed, receipts = _live_bundle(expected_graph, repository_root)
    signal = observed.query_signals[0]
    split = replace(signal, usage_count=signal.usage_count + 1)
    report = compare_observed_graph(
        expected_graph,
        replace(observed, query_signals=(signal, split)),
        receipts,
    )
    assert report.ok is False
    assert "LIVE_QUERY_SIGNAL_SPLIT" in {item.code for item in report.failures}


def test_custom_query_owner_cannot_replace_official_asset_ownership(
    expected_graph: ExpectedGraph, repository_root: Path
) -> None:
    observed, receipts = _live_bundle(expected_graph, repository_root)
    revenue = next(
        node for node in expected_graph.nodes if node.logical_key == "analytics.customer_revenue"
    )
    owner = expected_graph.owners[0].urn
    ownership = (set(observed.ownership) - {(revenue.urn, owner)}) | {
        (expected_graph.query_evidence[0].query_urn, owner)
    }
    report = compare_observed_graph(
        expected_graph,
        replace(observed, ownership=frozenset(ownership)),
        receipts,
    )
    assert "OWNER_MISMATCH" in {failure.code for failure in report.failures}


def test_missing_receipts_cannot_report_live_success(expected_graph: ExpectedGraph) -> None:
    report = compare_observed_graph(expected_graph, expected_observation(expected_graph))
    assert report.ok is False
    assert {failure.code for failure in report.failures} == {
        "PG_STAT_RECEIPT_MISSING",
        "POSTGRES_INGEST_RECEIPT_MISSING",
        "LIVE_QUERY_INGEST_RECEIPTS_MISSING",
    }


@pytest.mark.parametrize(
    ("mutation", "expected_code"),
    [
        (
            lambda item: replace(item, entity_urn="urn:li:query:third"),
            "LIVE_QUERY_RECEIPT_URN_MISMATCH",
        ),
        (
            lambda item: replace(item, recorded_at="2026-08-04T09:00:00+00:00"),
            "LIVE_QUERY_RECEIPT_STALE",
        ),
        (
            lambda item: replace(item, metrics=item.metrics | {"executionCount": 99}),
            "LIVE_QUERY_RECEIPT_METRICS_MISMATCH",
        ),
        (lambda item: replace(item, idempotency_key="wrong"), "LIVE_QUERY_RECEIPT_KEY_MISMATCH"),
    ],
)
def test_live_receipts_are_exactly_bound(
    expected_graph: ExpectedGraph,
    repository_root: Path,
    mutation: Callable[[OperationReceipt], OperationReceipt],
    expected_code: str,
) -> None:
    observed, receipts = _live_bundle(expected_graph, repository_root)
    changed = list(receipts)
    changed[2] = mutation(changed[2])
    report = compare_observed_graph(expected_graph, observed, tuple(changed))
    assert expected_code in {item.code for item in report.failures}


def test_manual_signal_and_extra_schema_field_are_rejected(
    expected_graph: ExpectedGraph, repository_root: Path
) -> None:
    observed, receipts = _live_bundle(expected_graph, repository_root)
    manual = replace(observed.query_signals[0], source="MANUAL")
    report = compare_observed_graph(
        expected_graph,
        replace(
            observed,
            query_signals=(manual,),
            schema_fields=observed.schema_fields | {"urn:li:schemaField:unexpected"},
        ),
        receipts,
    )
    assert {item.code for item in report.failures} >= {
        "LIVE_QUERY_EVIDENCE_MISSING",
        "SCHEMA_FIELD_INVENTORY_MISMATCH",
    }
