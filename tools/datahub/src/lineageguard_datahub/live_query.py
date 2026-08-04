from __future__ import annotations

import hashlib
import json
from dataclasses import dataclass
from datetime import datetime
from pathlib import Path

from datahub.emitter.mce_builder import make_schema_field_urn
from datahub.emitter.mcp import MetadataChangeProposalWrapper
from datahub.metadata.schema_classes import (
    AuditStampClass,
    DataPlatformInstanceClass,
    QueryLanguageClass,
    QueryPropertiesClass,
    QuerySourceClass,
    QueryStatementClass,
    QuerySubjectClass,
    QuerySubjectsClass,
    QueryUsageStatisticsClass,
)
from datahub.metadata.urns import QueryUrn

from lineageguard_datahub.models import ExpectedGraph
from lineageguard_datahub.query_history import plan_query_execution
from lineageguard_datahub.receipts import OperationReceipt, ReceiptStatus, ReceiptStore
from lineageguard_datahub.seed import EntityReader, McpEmitter


@dataclass(frozen=True, slots=True)
class LiveQueryUpsert:
    proposal: MetadataChangeProposalWrapper
    idempotency_key: str


def _idempotency_key(proposal: MetadataChangeProposalWrapper) -> str:
    payload = json.dumps(proposal.to_obj(), sort_keys=True, separators=(",", ":")).encode()
    return hashlib.sha256(payload).hexdigest()


def latest_pg_stat_receipt(
    graph: ExpectedGraph, receipts: tuple[OperationReceipt, ...]
) -> OperationReceipt:
    candidates = [
        receipt
        for receipt in receipts
        if receipt.scenario_id == graph.scenario_id
        and receipt.operation_kind == "query"
        and receipt.status is ReceiptStatus.SUCCESS
        and receipt.detail_code == "PG_STAT_OBSERVED"
    ]
    if not candidates:
        raise ValueError("PG_STAT_RECEIPT_REQUIRED")
    receipt = max(candidates, key=lambda item: item.recorded_at)
    if int(receipt.metrics.get("executionCount", 0)) < 1:
        raise ValueError("PG_STAT_COUNT_INVALID")
    if float(receipt.metrics.get("totalExecTimeMs", -1)) < 0:
        raise ValueError("PG_STAT_TIME_INVALID")
    return receipt


def build_live_query_plan(
    graph: ExpectedGraph, root: Path, receipt: OperationReceipt
) -> tuple[LiveQueryUpsert, ...]:
    query = graph.query_evidence[0]
    execution = plan_query_execution(root, query)
    if receipt.idempotency_key != execution.normalized_fingerprint:
        raise ValueError("PG_STAT_FINGERPRINT_MISMATCH")
    recorded_at = datetime.fromisoformat(receipt.recorded_at)
    timestamp_ms = int(recorded_at.timestamp() * 1000)
    urn = QueryUrn(execution.normalized_fingerprint).urn()
    audit = AuditStampClass(time=timestamp_ms, actor="urn:li:corpuser:lineageguard-reader")
    proposals = (
        MetadataChangeProposalWrapper(
            entityUrn=urn,
            aspect=QueryPropertiesClass(
                statement=QueryStatementClass(
                    value=execution.statement,
                    language=QueryLanguageClass.SQL,
                ),
                source=QuerySourceClass.SYSTEM,
                created=audit,
                lastModified=audit,
            ),
        ),
        MetadataChangeProposalWrapper(
            entityUrn=urn,
            aspect=QuerySubjectsClass(
                subjects=[
                    QuerySubjectClass(entity=query.dataset_urn),
                    QuerySubjectClass(
                        entity=make_schema_field_urn(query.dataset_urn, query.field_path)
                    ),
                ]
            ),
        ),
        MetadataChangeProposalWrapper(
            entityUrn=urn,
            aspect=DataPlatformInstanceClass(
                platform="urn:li:dataPlatform:postgres",
                instance=graph.platform_instance,
            ),
        ),
        MetadataChangeProposalWrapper(
            entityUrn=urn,
            aspect=QueryUsageStatisticsClass(
                timestampMillis=timestamp_ms,
                queryCount=int(receipt.metrics["executionCount"]),
                lastExecutedAt=timestamp_ms,
                uniqueUserCount=1,
            ),
        ),
    )
    return tuple(LiveQueryUpsert(item, _idempotency_key(item)) for item in proposals)


def emit_live_query_evidence(
    emitter: McpEmitter,
    reader: EntityReader,
    store: ReceiptStore,
    graph: ExpectedGraph,
    root: Path,
) -> int:
    receipt = latest_pg_stat_receipt(graph, store.read_all())
    plan = build_live_query_plan(graph, root, receipt)
    urn = plan[0].proposal.entityUrn
    if urn is None:
        raise ValueError("LIVE_QUERY_URN_MISSING")
    if reader.exists(urn):
        properties = reader.get_aspect(urn, QueryPropertiesClass)
        expected = plan[0].proposal.aspect
        if (
            properties is None
            or properties.source != QuerySourceClass.SYSTEM
            or not isinstance(expected, QueryPropertiesClass)
            or properties.statement.value != expected.statement.value
        ):
            raise ValueError("LIVE_QUERY_EXISTING_ENTITY_MISMATCH")
    emitted = 0
    successful = store.latest_success(graph.scenario_id, "ingest-query")
    for operation in plan:
        proposal = operation.proposal
        aspect = proposal.aspect
        if (
            operation.idempotency_key in successful
            and proposal.entityUrn is not None
            and aspect is not None
            and not isinstance(aspect, QueryUsageStatisticsClass)
        ):
            current = reader.get_aspect(proposal.entityUrn, type(aspect))
            if current is not None and current.to_obj() == aspect.to_obj():
                store.append(
                    OperationReceipt.create(
                        scenario_id=graph.scenario_id,
                        operation_kind="ingest-query",
                        entity_urn=proposal.entityUrn,
                        aspect_name=proposal.aspectName,
                        idempotency_key=operation.idempotency_key,
                        status=ReceiptStatus.SKIPPED,
                        detail_code="RECONCILED_EXACT_SUCCESS",
                    )
                )
                continue
        try:
            emitter.emit_mcp(proposal)
        except Exception as error:
            store.append(
                OperationReceipt.create(
                    scenario_id=graph.scenario_id,
                    operation_kind="ingest-query",
                    entity_urn=proposal.entityUrn,
                    aspect_name=proposal.aspectName,
                    idempotency_key=operation.idempotency_key,
                    status=ReceiptStatus.FAILURE,
                    detail_code=type(error).__name__,
                )
            )
            raise
        emitted += 1
        store.append(
            OperationReceipt.create(
                scenario_id=graph.scenario_id,
                operation_kind="ingest-query",
                entity_urn=proposal.entityUrn,
                aspect_name=proposal.aspectName,
                idempotency_key=operation.idempotency_key,
                status=ReceiptStatus.SUCCESS,
                detail_code="LIVE_QUERY_EMITTED",
            )
        )
    return emitted
