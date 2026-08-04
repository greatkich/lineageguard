from __future__ import annotations

from pathlib import Path
from typing import Any

import pytest
from datahub.emitter.mcp import MetadataChangeProposalWrapper
from datahub.metadata.schema_classes import (
    OwnershipClass,
    QueryPropertiesClass,
    QuerySourceClass,
    QuerySubjectsClass,
    QueryUsageStatisticsClass,
    StatusClass,
)

from lineageguard_datahub.ingestion import RECIPE_DIGESTS
from lineageguard_datahub.live_query import build_live_query_plan, emit_live_query_evidence
from lineageguard_datahub.models import ExpectedGraph
from lineageguard_datahub.query_history import plan_query_execution
from lineageguard_datahub.receipts import OperationReceipt, ReceiptStatus, ReceiptStore


class FakeCatalog:
    def __init__(self, fail_at: int | None = None, fail_after_at: int | None = None) -> None:
        self.aspects: dict[tuple[str, type[object]], Any] = {}
        self.fail_at = fail_at
        self.fail_after_at = fail_after_at
        self.emitted: list[MetadataChangeProposalWrapper] = []

    def exists(self, entity_urn: str) -> bool:
        return any(urn == entity_urn for urn, _ in self.aspects)

    def get_aspect(self, entity_urn: str, aspect_type: type[Any], version: int = 0) -> Any | None:
        del version
        return self.aspects.get((entity_urn, aspect_type))

    def get_timeseries_values(
        self,
        entity_urn: str,
        aspect_type: type[Any],
        filter: dict[str, object],
        limit: int = 10,
    ) -> list[Any]:
        del filter, limit
        aspect = self.aspects.get((entity_urn, aspect_type))
        return [] if aspect is None else [aspect]

    def emit_mcp(self, proposal: MetadataChangeProposalWrapper) -> None:
        if self.fail_at is not None and len(self.emitted) == self.fail_at:
            raise RuntimeError("injected")
        self.emitted.append(proposal)
        assert proposal.entityUrn is not None and proposal.aspect is not None
        self.aspects[(proposal.entityUrn, type(proposal.aspect))] = proposal.aspect
        if self.fail_after_at is not None and len(self.emitted) - 1 == self.fail_after_at:
            raise RuntimeError("ambiguous-after-apply")


def _query_receipt(
    graph: ExpectedGraph,
    repository_root: Path,
    *,
    count: int = 3,
    total_time: float = 1.25,
    recorded_at: str | None = "2026-08-04T10:00:00+00:00",
) -> OperationReceipt:
    execution = plan_query_execution(repository_root, graph.query_evidence[0])
    return OperationReceipt.create(
        scenario_id=graph.scenario_id,
        operation_kind="query",
        entity_urn=None,
        aspect_name="pg_stat_statements",
        idempotency_key=execution.normalized_fingerprint,
        status=ReceiptStatus.SUCCESS,
        detail_code="PG_STAT_OBSERVED",
        metrics={
            "queryId": "48291",
            "executionCount": count,
            "totalExecTimeMs": total_time,
            "normalizedFingerprint": execution.normalized_fingerprint,
            "statementSha256": execution.sha256,
        },
        recorded_at=recorded_at,
    )


def _prepare_store(
    store: ReceiptStore,
    graph: ExpectedGraph,
    repository_root: Path,
    *,
    count: int = 3,
    total_time: float = 1.25,
    recorded_at: str | None = "2026-08-04T10:00:00+00:00",
) -> None:
    store.append(
        _query_receipt(
            graph,
            repository_root,
            count=count,
            total_time=total_time,
            recorded_at=recorded_at,
        )
    )
    digest = RECIPE_DIGESTS["walkthrough/metadata/postgres-ingestion.yml"]
    store.append(
        OperationReceipt.create(
            scenario_id=graph.scenario_id,
            operation_kind="ingest",
            entity_urn=None,
            aspect_name="walkthrough/metadata/postgres-ingestion.yml",
            idempotency_key=digest,
            status=ReceiptStatus.SUCCESS,
            detail_code="INGESTED",
            recorded_at=("2026-08-04T10:01:00+00:00" if recorded_at is not None else None),
        )
    )


def test_live_query_plan_is_system_provenance_and_namespaced_fallback_is_not_used(
    expected_graph: ExpectedGraph, repository_root: Path
) -> None:
    receipt = _query_receipt(expected_graph, repository_root)
    plan = build_live_query_plan(expected_graph, repository_root, receipt)
    properties = plan[0].proposal.aspect
    assert isinstance(properties, QueryPropertiesClass)
    assert properties.source == QuerySourceClass.SYSTEM
    assert plan[0].proposal.entityUrn == expected_graph.query_evidence[0].query_urn
    assert not any(isinstance(item.proposal.aspect, OwnershipClass) for item in plan)


def test_live_query_partial_failure_reconciles_successful_aspects(
    expected_graph: ExpectedGraph, repository_root: Path, tmp_path: Path
) -> None:
    store = ReceiptStore(tmp_path / "operations.jsonl")
    _prepare_store(store, expected_graph, repository_root)
    catalog = FakeCatalog(fail_at=2)
    with pytest.raises(RuntimeError, match="injected"):
        emit_live_query_evidence(catalog, catalog, store, expected_graph, repository_root)
    catalog.fail_at = None
    before = len(catalog.emitted)
    emitted = emit_live_query_evidence(catalog, catalog, store, expected_graph, repository_root)
    assert before == 2
    assert emitted == 3
    assert len(catalog.emitted) == 5
    assert sum(receipt.status is ReceiptStatus.FAILURE for receipt in store.read_all()) == 1


def test_manual_query_entity_cannot_be_promoted_to_live(
    expected_graph: ExpectedGraph, repository_root: Path, tmp_path: Path
) -> None:
    store = ReceiptStore(tmp_path / "operations.jsonl")
    receipt = _query_receipt(expected_graph, repository_root)
    _prepare_store(store, expected_graph, repository_root)
    plan = build_live_query_plan(expected_graph, repository_root, receipt, store.ownership_nonce)
    catalog = FakeCatalog()
    properties = plan[0].proposal.aspect
    assert isinstance(properties, QueryPropertiesClass)
    manual = replace_query_source(properties, QuerySourceClass.MANUAL)
    urn = plan[0].proposal.entityUrn
    assert urn is not None
    catalog.aspects[(urn, QueryPropertiesClass)] = manual
    with pytest.raises(ValueError, match="LIVE_QUERY_EXISTING_ENTITY_NOT_OWNED"):
        emit_live_query_evidence(catalog, catalog, store, expected_graph, repository_root)


def replace_query_source(properties: QueryPropertiesClass, source: str) -> QueryPropertiesClass:
    return QueryPropertiesClass(
        statement=properties.statement,
        source=source,
        created=properties.created,
        lastModified=properties.lastModified,
        customProperties={"lineageguard.ownerUrn": "urn:li:corpGroup:shared"},
    )


def test_owned_live_query_static_aspect_drift_is_refused(
    expected_graph: ExpectedGraph, repository_root: Path, tmp_path: Path
) -> None:
    store = ReceiptStore(tmp_path / "operations.jsonl")
    _prepare_store(store, expected_graph, repository_root)
    catalog = FakeCatalog()
    emit_live_query_evidence(catalog, catalog, store, expected_graph, repository_root)
    urn = expected_graph.query_evidence[0].query_urn
    subjects = catalog.aspects[(urn, QuerySubjectsClass)]
    subjects.subjects = []
    with pytest.raises(ValueError, match="LIVE_QUERY_STATIC_ASPECT_DRIFT"):
        emit_live_query_evidence(catalog, catalog, store, expected_graph, repository_root)


def test_owned_soft_deleted_query_is_undeleted_but_unowned_query_is_not(
    expected_graph: ExpectedGraph, repository_root: Path, tmp_path: Path
) -> None:
    store = ReceiptStore(tmp_path / "operations.jsonl")
    _prepare_store(store, expected_graph, repository_root)
    catalog = FakeCatalog()
    emit_live_query_evidence(catalog, catalog, store, expected_graph, repository_root)
    urn = expected_graph.query_evidence[0].query_urn
    catalog.aspects[(urn, StatusClass)] = StatusClass(removed=True)
    before = len(catalog.emitted)
    assert emit_live_query_evidence(catalog, catalog, store, expected_graph, repository_root) == 1
    assert catalog.emitted[before].aspectName == "status"
    assert catalog.aspects[(urn, StatusClass)].removed is False

    fresh_store = ReceiptStore(tmp_path / "unowned.jsonl")
    _prepare_store(fresh_store, expected_graph, repository_root)
    unowned = FakeCatalog()
    plan = build_live_query_plan(
        expected_graph,
        repository_root,
        _query_receipt(expected_graph, repository_root),
        fresh_store.ownership_nonce,
    )
    for item in plan[:-1]:
        assert item.proposal.entityUrn is not None and item.proposal.aspect is not None
        unowned.aspects[(item.proposal.entityUrn, type(item.proposal.aspect))] = (
            item.proposal.aspect
        )
    unowned.aspects[(urn, StatusClass)] = StatusClass(removed=True)
    with pytest.raises(ValueError, match="LIVE_QUERY_EXISTING_ENTITY_NOT_OWNED"):
        emit_live_query_evidence(unowned, unowned, fresh_store, expected_graph, repository_root)


def test_later_observation_updates_only_monotonic_usage(
    expected_graph: ExpectedGraph, repository_root: Path, tmp_path: Path
) -> None:
    store = ReceiptStore(tmp_path / "operations.jsonl")
    _prepare_store(store, expected_graph, repository_root)
    catalog = FakeCatalog()
    emit_live_query_evidence(catalog, catalog, store, expected_graph, repository_root)
    urn = expected_graph.query_evidence[0].query_urn
    properties_before = catalog.aspects[(urn, QueryPropertiesClass)].to_obj()
    _prepare_store(
        store,
        expected_graph,
        repository_root,
        count=5,
        total_time=2.5,
        recorded_at=None,
    )
    assert emit_live_query_evidence(catalog, catalog, store, expected_graph, repository_root) == 1
    assert catalog.aspects[(urn, QueryPropertiesClass)].to_obj() == properties_before
    usage = catalog.aspects[(urn, QueryUsageStatisticsClass)]
    assert usage.queryCount == 5


def test_ambiguous_usage_apply_is_reconciled_from_live_state(
    expected_graph: ExpectedGraph, repository_root: Path, tmp_path: Path
) -> None:
    store = ReceiptStore(tmp_path / "operations.jsonl")
    _prepare_store(store, expected_graph, repository_root)
    catalog = FakeCatalog(fail_after_at=4)
    with pytest.raises(RuntimeError, match="ambiguous-after-apply"):
        emit_live_query_evidence(catalog, catalog, store, expected_graph, repository_root)
    catalog.fail_after_at = None
    assert emit_live_query_evidence(catalog, catalog, store, expected_graph, repository_root) == 0
    assert any(
        item.aspect_name == "queryUsageStatistics" and item.status is ReceiptStatus.SKIPPED
        for item in store.read_all()
    )
