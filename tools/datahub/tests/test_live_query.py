from __future__ import annotations

from dataclasses import replace
from pathlib import Path
from typing import Any

import pytest
from datahub.emitter.mcp import MetadataChangeProposalWrapper
from datahub.metadata.schema_classes import QueryPropertiesClass, QuerySourceClass

from lineageguard_datahub.live_query import build_live_query_plan, emit_live_query_evidence
from lineageguard_datahub.models import ExpectedGraph
from lineageguard_datahub.query_history import plan_query_execution
from lineageguard_datahub.receipts import OperationReceipt, ReceiptStatus, ReceiptStore


class FakeCatalog:
    def __init__(self, fail_at: int | None = None) -> None:
        self.aspects: dict[tuple[str, type[object]], Any] = {}
        self.fail_at = fail_at
        self.emitted: list[MetadataChangeProposalWrapper] = []

    def exists(self, entity_urn: str) -> bool:
        return any(urn == entity_urn for urn, _ in self.aspects)

    def get_aspect(self, entity_urn: str, aspect_type: type[Any], version: int = 0) -> Any | None:
        del version
        return self.aspects.get((entity_urn, aspect_type))

    def emit_mcp(self, proposal: MetadataChangeProposalWrapper) -> None:
        if self.fail_at is not None and len(self.emitted) == self.fail_at:
            raise RuntimeError("injected")
        self.emitted.append(proposal)
        assert proposal.entityUrn is not None and proposal.aspect is not None
        self.aspects[(proposal.entityUrn, type(proposal.aspect))] = proposal.aspect


def _query_receipt(graph: ExpectedGraph, repository_root: Path) -> OperationReceipt:
    execution = plan_query_execution(repository_root, graph.query_evidence[0])
    return replace(
        OperationReceipt.create(
            scenario_id=graph.scenario_id,
            operation_kind="query",
            entity_urn=None,
            aspect_name="pg_stat_statements",
            idempotency_key=execution.normalized_fingerprint,
            status=ReceiptStatus.SUCCESS,
            detail_code="PG_STAT_OBSERVED",
            metrics={"executionCount": 3, "totalExecTimeMs": 1.25},
        ),
        recorded_at="2026-08-04T10:00:00+00:00",
    )


def test_live_query_plan_is_system_provenance_and_namespaced_fallback_is_not_used(
    expected_graph: ExpectedGraph, repository_root: Path
) -> None:
    receipt = _query_receipt(expected_graph, repository_root)
    plan = build_live_query_plan(expected_graph, repository_root, receipt)
    properties = plan[0].proposal.aspect
    assert isinstance(properties, QueryPropertiesClass)
    assert properties.source == QuerySourceClass.SYSTEM
    assert plan[0].proposal.entityUrn != expected_graph.query_evidence[0].query_urn


def test_live_query_partial_failure_reconciles_successful_aspects(
    expected_graph: ExpectedGraph, repository_root: Path, tmp_path: Path
) -> None:
    store = ReceiptStore(tmp_path / "operations.jsonl")
    store.append(_query_receipt(expected_graph, repository_root))
    catalog = FakeCatalog(fail_at=2)
    with pytest.raises(RuntimeError, match="injected"):
        emit_live_query_evidence(catalog, catalog, store, expected_graph, repository_root)
    catalog.fail_at = None
    before = len(catalog.emitted)
    emitted = emit_live_query_evidence(catalog, catalog, store, expected_graph, repository_root)
    assert before == 2
    assert emitted == 2
    assert len(catalog.emitted) == 4
    assert sum(receipt.status is ReceiptStatus.FAILURE for receipt in store.read_all()) == 1


def test_manual_query_entity_cannot_be_promoted_to_live(
    expected_graph: ExpectedGraph, repository_root: Path, tmp_path: Path
) -> None:
    store = ReceiptStore(tmp_path / "operations.jsonl")
    receipt = _query_receipt(expected_graph, repository_root)
    store.append(receipt)
    plan = build_live_query_plan(expected_graph, repository_root, receipt)
    catalog = FakeCatalog()
    properties = plan[0].proposal.aspect
    assert isinstance(properties, QueryPropertiesClass)
    manual = replace_query_source(properties, QuerySourceClass.MANUAL)
    urn = plan[0].proposal.entityUrn
    assert urn is not None
    catalog.aspects[(urn, QueryPropertiesClass)] = manual
    with pytest.raises(ValueError, match="LIVE_QUERY_EXISTING_ENTITY_MISMATCH"):
        emit_live_query_evidence(catalog, catalog, store, expected_graph, repository_root)


def replace_query_source(properties: QueryPropertiesClass, source: str) -> QueryPropertiesClass:
    return QueryPropertiesClass(
        statement=properties.statement,
        source=source,
        created=properties.created,
        lastModified=properties.lastModified,
        customProperties={"lineageguard.ownerUrn": "urn:li:corpGroup:shared"},
    )
