from __future__ import annotations

from collections.abc import Callable
from dataclasses import replace
from pathlib import Path
from typing import Any

import pytest
from datahub.metadata.schema_classes import StatusClass

from lineageguard_datahub.ingestion import (
    DBT_ARTIFACT_VERIFICATION_FINGERPRINT,
    DBT_BUILD_COMMAND_FINGERPRINT,
    DBT_DOCS_COMMAND_FINGERPRINT,
    RECIPE_DIGESTS,
)
from lineageguard_datahub.live_query import build_live_query_plan
from lineageguard_datahub.models import ExpectedGraph
from lineageguard_datahub.provenance import datahub_target_metrics, registry_binding_metrics
from lineageguard_datahub.query_history import plan_query_execution
from lineageguard_datahub.receipts import OperationReceipt, ReceiptStatus
from lineageguard_datahub.verify import (
    ObservedGraph,
    expected_observation,
    observe_live,
)
from lineageguard_datahub.verify import (
    compare_observed_graph as _compare_observed_graph,
)

TARGET_ATTESTATION = "canonical-local-lineageguard-v1"
TARGET_FINGERPRINT = "f" * 64
WAREHOUSE_TARGET_FINGERPRINT = "e" * 64
OWNERSHIP_NONCE = "d" * 64
DBT_PROJECT_FINGERPRINT = "9" * 64
SNAPSHOT_FINGERPRINT = "8" * 64
ARTIFACT_METRICS = {
    "dbtManifestSha256": "1" * 64,
    "dbtRunResultsSha256": "2" * 64,
    "dbtCatalogSha256": "3" * 64,
    "dbtArtifactSetFingerprint": "4" * 64,
}


def compare_observed_graph(
    graph: ExpectedGraph,
    observed: ObservedGraph,
    receipts: tuple[OperationReceipt, ...] = (),
):
    return _compare_observed_graph(
        graph,
        observed,
        receipts,
        ownership_nonce=OWNERSHIP_NONCE,
        warehouse_target_fingerprint=WAREHOUSE_TARGET_FINGERPRINT,
        target_attestation=TARGET_ATTESTATION,
        target_fingerprint=TARGET_FINGERPRINT,
        dbt_project_sha256=DBT_PROJECT_FINGERPRINT,
        artifact_metrics=ARTIFACT_METRICS,
        snapshot_fingerprint=SNAPSHOT_FINGERPRINT,
    )


def _live_bundle(
    graph: ExpectedGraph, repository_root: Path
) -> tuple[ObservedGraph, tuple[OperationReceipt, ...]]:
    execution = plan_query_execution(repository_root, graph.query_evidence[0])
    registry_metrics = registry_binding_metrics(OWNERSHIP_NONCE, WAREHOUSE_TARGET_FINGERPRINT)
    target_metrics = (
        datahub_target_metrics(
            OWNERSHIP_NONCE,
            WAREHOUSE_TARGET_FINGERPRINT,
            TARGET_ATTESTATION,
            TARGET_FINGERPRINT,
        )
        | ARTIFACT_METRICS
        | {
            "dbtProjectFingerprint": DBT_PROJECT_FINGERPRINT,
            "ingestionSnapshotFingerprint": SNAPSHOT_FINGERPRINT,
        }
    )
    warehouse = OperationReceipt.create(
        scenario_id=graph.scenario_id,
        operation_kind="warehouse",
        entity_urn=None,
        aspect_name="canonical-schema",
        idempotency_key="0" * 64,
        status=ReceiptStatus.SUCCESS,
        detail_code="WAREHOUSE_READY",
        recorded_at="2026-08-04T08:00:00+00:00",
        ownership_nonce=OWNERSHIP_NONCE,
        metrics=registry_metrics,
    )
    dbt_build = tuple(
        OperationReceipt.create(
            scenario_id=graph.scenario_id,
            operation_kind="dbt-build",
            entity_urn=None,
            aspect_name=aspect,
            idempotency_key=fingerprint,
            proposal_hash=DBT_PROJECT_FINGERPRINT,
            status=ReceiptStatus.SUCCESS,
            detail_code="DBT_COMMAND_SUCCEEDED",
            recorded_at=recorded_at,
            ownership_nonce=OWNERSHIP_NONCE,
            metrics=registry_metrics | {"dbtProjectFingerprint": DBT_PROJECT_FINGERPRINT},
        )
        for aspect, fingerprint, recorded_at in (
            ("build", DBT_BUILD_COMMAND_FINGERPRINT, "2026-08-04T08:01:00+00:00"),
            (
                "docs-generate",
                DBT_DOCS_COMMAND_FINGERPRINT,
                "2026-08-04T08:02:00+00:00",
            ),
        )
    )
    dbt_artifacts = OperationReceipt.create(
        scenario_id=graph.scenario_id,
        operation_kind="dbt-build",
        entity_urn=None,
        aspect_name="artifact-set",
        idempotency_key=DBT_ARTIFACT_VERIFICATION_FINGERPRINT,
        proposal_hash=DBT_PROJECT_FINGERPRINT,
        status=ReceiptStatus.SUCCESS,
        detail_code="DBT_ARTIFACTS_VERIFIED",
        recorded_at="2026-08-04T08:03:00+00:00",
        ownership_nonce=OWNERSHIP_NONCE,
        metrics=registry_metrics
        | ARTIFACT_METRICS
        | {"dbtProjectFingerprint": DBT_PROJECT_FINGERPRINT},
    )
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
            "databaseId": "16384",
            "userId": "16390",
            **registry_metrics,
        },
        ownership_nonce=OWNERSHIP_NONCE,
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
        ownership_nonce=OWNERSHIP_NONCE,
        metrics=target_metrics,
    )
    plan = build_live_query_plan(graph, repository_root, query, OWNERSHIP_NONCE)
    metrics = target_metrics | {
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
            ownership_nonce=OWNERSHIP_NONCE,
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
    dbt_digest = RECIPE_DIGESTS["walkthrough/metadata/dbt-ingestion.yml"]
    dbt_ingest = OperationReceipt.create(
        scenario_id=graph.scenario_id,
        operation_kind="ingest",
        entity_urn=None,
        aspect_name="walkthrough/metadata/dbt-ingestion.yml",
        idempotency_key=dbt_digest,
        proposal_hash=dbt_digest,
        status=ReceiptStatus.SUCCESS,
        detail_code="INGESTED",
        recorded_at="2026-08-04T10:02:00+00:00",
        ownership_nonce=OWNERSHIP_NONCE,
        metrics=target_metrics,
    )
    seed = OperationReceipt.create(
        scenario_id=graph.scenario_id,
        operation_kind="seed",
        entity_urn=graph.owned_urns[0],
        aspect_name="status",
        idempotency_key="c" * 64,
        proposal_hash="c" * 64,
        status=ReceiptStatus.SUCCESS,
        detail_code="ASPECT_EMITTED",
        recorded_at="2026-08-04T10:03:00+00:00",
        ownership_nonce=OWNERSHIP_NONCE,
        metrics=target_metrics,
    )
    return replace(observed, query_signals=(signal,)), (
        warehouse,
        *dbt_build,
        dbt_artifacts,
        query,
        ingest,
        *live,
        dbt_ingest,
        seed,
    )


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
        "WAREHOUSE_RECEIPT_REQUIRED",
        "DBT_BUILD_RECEIPT_REQUIRED",
        "INGEST_PREREQUISITE_MISSING",
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
    live_index = next(
        index for index, item in enumerate(changed) if item.operation_kind == "ingest-query"
    )
    changed[live_index] = mutation(changed[live_index])
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


class RemovedEntityReader:
    def __init__(self, removed_urn: str) -> None:
        self.removed_urn = removed_urn

    def exists(self, entity_urn: str) -> bool:
        return True

    def get_aspect(self, entity_urn: str, aspect_type: type[Any], version: int = 0) -> Any | None:
        del version
        if entity_urn == self.removed_urn and aspect_type is StatusClass:
            return StatusClass(removed=True)
        return None

    def get_timeseries_values(
        self,
        entity_urn: str,
        aspect_type: type[Any],
        filter: dict[str, Any],
        limit: int = 10,
    ) -> list[Any]:
        del entity_urn, aspect_type, filter, limit
        return []


def test_soft_removed_entity_is_excluded_from_live_verification(
    expected_graph: ExpectedGraph,
) -> None:
    removed = next(
        node.urn for node in expected_graph.nodes if node.logical_key == "finance.revenue-dashboard"
    )
    observed = observe_live(RemovedEntityReader(removed), expected_graph)
    assert removed not in observed.entity_urns
    report = compare_observed_graph(expected_graph, observed)
    assert "ENTITY_INVENTORY_MISMATCH" in {item.code for item in report.failures}
