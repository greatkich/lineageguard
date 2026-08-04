from __future__ import annotations

import hashlib
import json
from dataclasses import dataclass
from datetime import datetime
from pathlib import Path
from typing import Protocol

from datahub.emitter.mce_builder import (
    make_dataplatform_instance_urn,
    make_schema_field_urn,
)
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
    StatusClass,
)

from lineageguard_datahub.ingestion import (
    RECIPE_DIGESTS,
    build_ingestion_plan,
    dbt_artifact_metrics,
    dbt_project_fingerprint,
    ingestion_snapshot_fingerprint,
    require_dbt_build_provenance,
    verify_dbt_ingestion_artifacts,
)
from lineageguard_datahub.models import ExpectedGraph
from lineageguard_datahub.provenance import (
    datahub_target_metrics,
    receipt_has_registry_binding,
)
from lineageguard_datahub.query_history import plan_query_execution
from lineageguard_datahub.receipts import OperationReceipt, ReceiptStatus, ReceiptStore
from lineageguard_datahub.seed import (
    OWNERSHIP_NONCE_KEY,
    SCENARIO_MARKER_KEY,
    SCENARIO_MARKER_VALUE,
    EntityReader,
    McpEmitter,
)
from lineageguard_datahub.warehouse import SqlCursor, attest_scenario_registry


class LiveQueryReader(EntityReader, Protocol):
    def get_timeseries_values(
        self,
        entity_urn: str,
        aspect_type: type[QueryUsageStatisticsClass],
        filter: dict[str, object],
        limit: int = 10,
    ) -> list[QueryUsageStatisticsClass]: ...


@dataclass(frozen=True, slots=True)
class LiveQueryUpsert:
    proposal: MetadataChangeProposalWrapper
    idempotency_key: str


def _idempotency_key(proposal: MetadataChangeProposalWrapper) -> str:
    payload = json.dumps(proposal.to_obj(), sort_keys=True, separators=(",", ":")).encode()
    return hashlib.sha256(payload).hexdigest()


def latest_pg_stat_receipt(
    graph: ExpectedGraph,
    receipts: tuple[OperationReceipt, ...],
    *,
    ownership_nonce: str,
    warehouse_target_fingerprint: str,
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
    query = graph.query_evidence[0]
    required_metrics = {
        "queryId",
        "executionCount",
        "totalExecTimeMs",
        "normalizedFingerprint",
        "statementSha256",
        "databaseId",
        "userId",
    }
    if not required_metrics <= set(receipt.metrics):
        raise ValueError("PG_STAT_RECEIPT_INCOMPLETE")
    if receipt.metrics["normalizedFingerprint"] != receipt.idempotency_key:
        raise ValueError("PG_STAT_FINGERPRINT_MISMATCH")
    if receipt.metrics["statementSha256"] != query.sha256:
        raise ValueError("PG_STAT_STATEMENT_DIGEST_MISMATCH")
    if int(receipt.metrics.get("executionCount", 0)) < 1:
        raise ValueError("PG_STAT_COUNT_INVALID")
    if float(receipt.metrics.get("totalExecTimeMs", -1)) < 0:
        raise ValueError("PG_STAT_TIME_INVALID")
    if not receipt.metrics.get("databaseId") or not receipt.metrics.get("userId"):
        raise ValueError("PG_STAT_PRINCIPAL_BINDING_INVALID")
    if not receipt_has_registry_binding(
        receipt,
        ownership_nonce=ownership_nonce,
        warehouse_target_fingerprint=warehouse_target_fingerprint,
    ):
        raise ValueError("PG_STAT_REGISTRY_BINDING_INVALID")
    return receipt


def build_live_query_plan(
    graph: ExpectedGraph,
    root: Path,
    receipt: OperationReceipt,
    ownership_nonce: str = "offline-plan",
) -> tuple[LiveQueryUpsert, ...]:
    query = graph.query_evidence[0]
    execution = plan_query_execution(root, query)
    if receipt.idempotency_key != execution.normalized_fingerprint:
        raise ValueError("PG_STAT_FINGERPRINT_MISMATCH")
    recorded_at = datetime.fromisoformat(receipt.recorded_at)
    timestamp_ms = int(recorded_at.timestamp() * 1000)
    urn = query.query_urn
    audit = AuditStampClass(time=0, actor="urn:li:corpuser:lineageguard-reader")
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
                customProperties={
                    SCENARIO_MARKER_KEY: SCENARIO_MARKER_VALUE,
                    OWNERSHIP_NONCE_KEY: ownership_nonce,
                    "lineageguard.queryFingerprint": execution.normalized_fingerprint,
                },
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
                instance=make_dataplatform_instance_urn("postgres", graph.platform_instance),
            ),
        ),
        MetadataChangeProposalWrapper(entityUrn=urn, aspect=StatusClass(removed=False)),
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
    reader: LiveQueryReader,
    store: ReceiptStore,
    graph: ExpectedGraph,
    root: Path,
    registry_cursor: SqlCursor,
    *,
    warehouse_target_fingerprint: str,
    target_attestation: str,
    target_fingerprint: str,
) -> int:
    with store.scenario_operation(graph.scenario_id, "ingest-query"):
        attest_scenario_registry(
            registry_cursor,
            ownership_nonce=store.ownership_nonce,
            warehouse_target_fingerprint=warehouse_target_fingerprint,
        )
        return _emit_live_query_evidence_under_lock(
            emitter,
            reader,
            store,
            graph,
            root,
            warehouse_target_fingerprint=warehouse_target_fingerprint,
            target_attestation=target_attestation,
            target_fingerprint=target_fingerprint,
        )


def _emit_live_query_evidence_under_lock(
    emitter: McpEmitter,
    reader: LiveQueryReader,
    store: ReceiptStore,
    graph: ExpectedGraph,
    root: Path,
    *,
    warehouse_target_fingerprint: str,
    target_attestation: str,
    target_fingerprint: str,
) -> int:
    receipts = store.read_all()
    nonce = store.ownership_nonce
    receipt = latest_pg_stat_receipt(
        graph,
        receipts,
        ownership_nonce=nonce,
        warehouse_target_fingerprint=warehouse_target_fingerprint,
    )
    artifacts = verify_dbt_ingestion_artifacts(root)
    artifact_metrics = dbt_artifact_metrics(artifacts)
    project_fingerprint = dbt_project_fingerprint(root)
    snapshot_fingerprint = ingestion_snapshot_fingerprint(build_ingestion_plan(root), artifacts)
    require_dbt_build_provenance(
        receipts,
        scenario_id=graph.scenario_id,
        ownership_nonce=nonce,
        warehouse_target_fingerprint=warehouse_target_fingerprint,
        dbt_project_sha256=project_fingerprint,
        artifact_metrics=artifact_metrics,
    )
    binding_metrics: dict[str, int | float | str] = (
        datahub_target_metrics(
            nonce,
            warehouse_target_fingerprint,
            target_attestation,
            target_fingerprint,
        )
        | artifact_metrics
        | {
            "dbtProjectFingerprint": project_fingerprint,
            "ingestionSnapshotFingerprint": snapshot_fingerprint,
        }
    )
    recipe_digest = RECIPE_DIGESTS["walkthrough/metadata/postgres-ingestion.yml"]
    ingest_receipts = [
        item
        for item in receipts
        if item.operation_kind == "ingest"
        and item.aspect_name == "walkthrough/metadata/postgres-ingestion.yml"
        and item.status is ReceiptStatus.SUCCESS
        and item.idempotency_key == recipe_digest
        and item.proposal_hash == recipe_digest
        and receipt_has_registry_binding(
            item,
            ownership_nonce=nonce,
            warehouse_target_fingerprint=warehouse_target_fingerprint,
        )
        and item.metrics.get("targetAttestation") == target_attestation
        and item.metrics.get("targetFingerprint") == target_fingerprint
        and all(item.metrics.get(key) == value for key, value in binding_metrics.items())
    ]
    if not ingest_receipts:
        raise ValueError("POSTGRES_INGEST_RECEIPT_REQUIRED")
    latest_ingest = max(ingest_receipts, key=lambda item: item.recorded_at)
    if datetime.fromisoformat(latest_ingest.recorded_at) < datetime.fromisoformat(
        receipt.recorded_at
    ):
        raise ValueError("POSTGRES_INGEST_PRECEDES_QUERY")
    plan = build_live_query_plan(graph, root, receipt, nonce)
    urn = plan[0].proposal.entityUrn
    if urn is None:
        raise ValueError("LIVE_QUERY_URN_MISSING")
    for operation in plan:
        store.append(
            OperationReceipt.create(
                scenario_id=graph.scenario_id,
                operation_kind="ingest-query",
                entity_urn=urn,
                aspect_name=operation.proposal.aspectName,
                idempotency_key=operation.idempotency_key,
                status=ReceiptStatus.PLANNED,
                detail_code="OPERATION_PLANNED",
                proposal_hash=operation.idempotency_key,
                ownership_nonce=nonce,
                metrics=binding_metrics
                | _evidence_metrics(receipt, recipe_digest)
                | {"beforeStatus": "UNKNOWN", "afterStatus": "PLANNED"},
            )
        )
    stable_plan = plan[:-1]
    entity_hash = hashlib.sha256(
        "\n".join(sorted(item.idempotency_key for item in stable_plan)).encode()
    ).hexdigest()
    creation = next(
        (
            item
            for item in reversed(receipts)
            if item.operation_kind == "entity"
            and item.entity_urn == urn
            and item.status is ReceiptStatus.SUCCESS
            and item.detail_code == "ENTITY_CREATED"
        ),
        None,
    )
    existing_properties = reader.get_aspect(urn, QueryPropertiesClass)
    existed = reader.exists(urn) or existing_properties is not None
    if existed:
        properties = existing_properties
        expected = plan[0].proposal.aspect
        if (
            creation is None
            or creation.ownership_nonce != nonce
            or creation.proposal_hash != entity_hash
            or properties is None
            or properties.source != QuerySourceClass.SYSTEM
            or not isinstance(expected, QueryPropertiesClass)
            or properties.to_obj() != expected.to_obj()
        ):
            operation = stable_plan[0]
            store.append(
                OperationReceipt.create(
                    scenario_id=graph.scenario_id,
                    operation_kind="ingest-query",
                    entity_urn=urn,
                    aspect_name=operation.proposal.aspectName,
                    idempotency_key=operation.idempotency_key,
                    status=ReceiptStatus.RECONCILIATION_REQUIRED,
                    detail_code="EXISTING_ENTITY_NOT_OWNED",
                    proposal_hash=operation.idempotency_key,
                    ownership_nonce=nonce,
                    metrics=binding_metrics | _evidence_metrics(receipt, recipe_digest),
                )
            )
            raise ValueError("LIVE_QUERY_EXISTING_ENTITY_NOT_OWNED")
        for operation in stable_plan:
            aspect = operation.proposal.aspect
            if aspect is None:
                raise ValueError("LIVE_QUERY_ASPECT_MISSING")
            current = reader.get_aspect(urn, type(aspect))
            if current is not None and current.to_obj() != aspect.to_obj():
                if (
                    isinstance(aspect, StatusClass)
                    and isinstance(current, StatusClass)
                    and current.removed is True
                    and aspect.removed is False
                ):
                    continue
                store.append(
                    OperationReceipt.create(
                        scenario_id=graph.scenario_id,
                        operation_kind="ingest-query",
                        entity_urn=urn,
                        aspect_name=operation.proposal.aspectName,
                        idempotency_key=operation.idempotency_key,
                        status=ReceiptStatus.RECONCILIATION_REQUIRED,
                        detail_code="STATIC_ASPECT_DRIFT",
                        proposal_hash=operation.idempotency_key,
                        ownership_nonce=nonce,
                        metrics=binding_metrics | _evidence_metrics(receipt, recipe_digest),
                    )
                )
                raise ValueError(f"LIVE_QUERY_STATIC_ASPECT_DRIFT:{operation.proposal.aspectName}")
    emitted = 0
    for index, operation in enumerate(plan):
        proposal = operation.proposal
        aspect = proposal.aspect
        if (
            proposal.entityUrn is not None
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
                        detail_code="ASPECT_SKIPPED_EXACT",
                        proposal_hash=operation.idempotency_key,
                        ownership_nonce=nonce,
                        metrics=binding_metrics
                        | _evidence_metrics(receipt, recipe_digest)
                        | {"beforeStatus": "EXACT", "afterStatus": "UNCHANGED"},
                    )
                )
                continue
        if isinstance(aspect, QueryUsageStatisticsClass):
            observed_usage = reader.get_timeseries_values(
                urn, QueryUsageStatisticsClass, {}, limit=10
            )
            if observed_usage:
                latest = max(observed_usage, key=lambda item: item.timestampMillis)
                latest_count = int(latest.queryCount or 0)
                expected_count = int(aspect.queryCount or 0)
                if (
                    latest.timestampMillis == aspect.timestampMillis
                    and latest_count == expected_count
                ):
                    store.append(
                        OperationReceipt.create(
                            scenario_id=graph.scenario_id,
                            operation_kind="ingest-query",
                            entity_urn=urn,
                            aspect_name=proposal.aspectName,
                            idempotency_key=operation.idempotency_key,
                            status=ReceiptStatus.SKIPPED,
                            detail_code="ASPECT_SKIPPED_EXACT",
                            proposal_hash=operation.idempotency_key,
                            ownership_nonce=nonce,
                            metrics=binding_metrics
                            | _evidence_metrics(receipt, recipe_digest)
                            | {"beforeStatus": "EXACT", "afterStatus": "UNCHANGED"},
                        )
                    )
                    continue
                if (
                    latest.timestampMillis >= aspect.timestampMillis
                    or latest_count > expected_count
                ):
                    store.append(
                        OperationReceipt.create(
                            scenario_id=graph.scenario_id,
                            operation_kind="ingest-query",
                            entity_urn=urn,
                            aspect_name=proposal.aspectName,
                            idempotency_key=operation.idempotency_key,
                            status=ReceiptStatus.RECONCILIATION_REQUIRED,
                            detail_code="OBSERVATION_NOT_MONOTONIC",
                            proposal_hash=operation.idempotency_key,
                            ownership_nonce=nonce,
                            metrics=binding_metrics | _evidence_metrics(receipt, recipe_digest),
                        )
                    )
                    raise ValueError("LIVE_QUERY_OBSERVATION_NOT_MONOTONIC")
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
                    proposal_hash=operation.idempotency_key,
                    ownership_nonce=nonce,
                    metrics=binding_metrics
                    | _evidence_metrics(receipt, recipe_digest)
                    | {"beforeStatus": "MISSING", "afterStatus": "FAILED"},
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
                proposal_hash=operation.idempotency_key,
                ownership_nonce=nonce,
                metrics=binding_metrics
                | _evidence_metrics(receipt, recipe_digest)
                | {"beforeStatus": "MISSING", "afterStatus": "EMITTED"},
            )
        )
        if not existed and index == 0:
            store.append(
                OperationReceipt.create(
                    scenario_id=graph.scenario_id,
                    operation_kind="entity",
                    entity_urn=urn,
                    aspect_name=None,
                    idempotency_key=hashlib.sha256(
                        f"entity:{graph.scenario_id}:{urn}".encode()
                    ).hexdigest(),
                    status=ReceiptStatus.SUCCESS,
                    detail_code="ENTITY_CREATED",
                    proposal_hash=entity_hash,
                    ownership_nonce=nonce,
                    metrics=binding_metrics | {"beforeStatus": "ABSENT", "afterStatus": "CREATED"},
                )
            )
            existed = True
    return emitted


def _evidence_metrics(
    receipt: OperationReceipt, recipe_digest: str
) -> dict[str, int | float | str]:
    return {
        "queryFingerprint": receipt.idempotency_key,
        "pgStatQueryId": str(receipt.metrics["queryId"]),
        "executionCount": int(receipt.metrics["executionCount"]),
        "totalExecTimeMs": float(receipt.metrics["totalExecTimeMs"]),
        "observationTimestamp": receipt.recorded_at,
        "recipeFingerprint": recipe_digest,
    }


def reconcile_live_query_evidence(
    reader: LiveQueryReader,
    store: ReceiptStore,
    graph: ExpectedGraph,
    root: Path,
    registry_cursor: SqlCursor,
    *,
    warehouse_target_fingerprint: str,
    target_attestation: str,
    target_fingerprint: str,
) -> int:
    """Resolve an interrupted query upsert only from exact live DataHub aspects."""
    nonce = store.ownership_nonce
    receipts = store.read_all()
    query_receipt = latest_pg_stat_receipt(
        graph,
        receipts,
        ownership_nonce=nonce,
        warehouse_target_fingerprint=warehouse_target_fingerprint,
    )
    artifacts = verify_dbt_ingestion_artifacts(root)
    artifact_metrics = dbt_artifact_metrics(artifacts)
    project_fingerprint = dbt_project_fingerprint(root)
    snapshot_fingerprint = ingestion_snapshot_fingerprint(build_ingestion_plan(root), artifacts)
    recipe_digest = RECIPE_DIGESTS["walkthrough/metadata/postgres-ingestion.yml"]
    binding_metrics: dict[str, int | float | str] = (
        datahub_target_metrics(
            nonce,
            warehouse_target_fingerprint,
            target_attestation,
            target_fingerprint,
        )
        | artifact_metrics
        | {
            "dbtProjectFingerprint": project_fingerprint,
            "ingestionSnapshotFingerprint": snapshot_fingerprint,
        }
    )
    plan = build_live_query_plan(graph, root, query_receipt, nonce)
    by_identity = {
        (item.proposal.entityUrn, item.proposal.aspectName, item.idempotency_key): item
        for item in plan
    }
    reconciled = 0
    with store.scenario_operation(
        graph.scenario_id, "ingest-query-reconcile", reconciliation=True
    ) as unresolved:
        attest_scenario_registry(
            registry_cursor,
            ownership_nonce=nonce,
            warehouse_target_fingerprint=warehouse_target_fingerprint,
        )
        foreign = [item for item in unresolved if item.operation_kind != "ingest-query"]
        if foreign:
            raise ValueError("LIVE_QUERY_RECONCILIATION_FOREIGN_OPERATION")
        if not unresolved:
            raise ValueError("LIVE_QUERY_RECONCILIATION_NOT_REQUIRED")
        properties_applied_after_failure = False
        expected_pending_metrics = binding_metrics | _evidence_metrics(query_receipt, recipe_digest)
        for pending in unresolved:
            operation = by_identity.get(
                (pending.entity_urn, pending.aspect_name, pending.idempotency_key)
            )
            if operation is None or operation.proposal.entityUrn is None:
                raise ValueError("LIVE_QUERY_RECONCILIATION_PLAN_MISMATCH")
            if any(
                pending.metrics.get(key) != value for key, value in expected_pending_metrics.items()
            ):
                raise ValueError("LIVE_QUERY_RECONCILIATION_PROVENANCE_MISMATCH")
            expected = operation.proposal.aspect
            if expected is None:
                raise ValueError("LIVE_QUERY_ASPECT_MISSING")
            applied = False
            safe_absent = False
            if isinstance(expected, QueryUsageStatisticsClass):
                values = reader.get_timeseries_values(
                    operation.proposal.entityUrn,
                    QueryUsageStatisticsClass,
                    {},
                    limit=10,
                )
                applied = any(
                    item.timestampMillis == expected.timestampMillis
                    and int(item.queryCount or 0) == int(expected.queryCount or 0)
                    for item in values
                )
                safe_absent = not values or all(
                    item.timestampMillis < expected.timestampMillis for item in values
                )
            else:
                current = reader.get_aspect(operation.proposal.entityUrn, type(expected))
                applied = current is not None and current.to_obj() == expected.to_obj()
                safe_absent = current is None or (
                    isinstance(expected, StatusClass)
                    and isinstance(current, StatusClass)
                    and current.removed is True
                    and expected.removed is False
                )
            if (
                applied
                and pending.status is ReceiptStatus.FAILURE
                and operation.proposal.aspectName == "queryProperties"
            ):
                properties_applied_after_failure = True
            if not applied and not safe_absent:
                store.append(
                    OperationReceipt.create(
                        scenario_id=graph.scenario_id,
                        operation_kind="ingest-query",
                        entity_urn=pending.entity_urn,
                        aspect_name=pending.aspect_name,
                        idempotency_key=pending.idempotency_key,
                        proposal_hash=pending.proposal_hash,
                        status=ReceiptStatus.RECONCILIATION_REQUIRED,
                        detail_code="LIVE_RECONCILIATION_CONFLICT",
                        ownership_nonce=nonce,
                        metrics=binding_metrics,
                    )
                )
                raise ValueError("LIVE_QUERY_RECONCILIATION_CONFLICT")
            store.append(
                OperationReceipt.create(
                    scenario_id=graph.scenario_id,
                    operation_kind="ingest-query",
                    entity_urn=pending.entity_urn,
                    aspect_name=pending.aspect_name,
                    idempotency_key=pending.idempotency_key,
                    proposal_hash=pending.proposal_hash,
                    status=ReceiptStatus.SKIPPED,
                    detail_code=(
                        "LIVE_RECONCILED_APPLIED" if applied else "LIVE_RECONCILED_NOT_APPLIED"
                    ),
                    ownership_nonce=nonce,
                    metrics=binding_metrics
                    | _evidence_metrics(query_receipt, recipe_digest)
                    | {
                        "beforeStatus": pending.status.value,
                        "afterStatus": "EXACT" if applied else "ABSENT",
                    },
                )
            )
            reconciled += 1
        urn = graph.query_evidence[0].query_urn
        has_creation = any(
            item.operation_kind == "entity"
            and item.entity_urn == urn
            and item.status is ReceiptStatus.SUCCESS
            and item.detail_code == "ENTITY_CREATED"
            for item in store.read_all()
        )
        properties = reader.get_aspect(urn, QueryPropertiesClass)
        expected_properties = plan[0].proposal.aspect
        if (
            not has_creation
            and properties_applied_after_failure
            and isinstance(properties, QueryPropertiesClass)
            and isinstance(expected_properties, QueryPropertiesClass)
            and properties.to_obj() == expected_properties.to_obj()
        ):
            entity_hash = hashlib.sha256(
                "\n".join(sorted(item.idempotency_key for item in plan[:-1])).encode()
            ).hexdigest()
            store.append(
                OperationReceipt.create(
                    scenario_id=graph.scenario_id,
                    operation_kind="entity",
                    entity_urn=urn,
                    aspect_name=None,
                    idempotency_key=hashlib.sha256(
                        f"entity:{graph.scenario_id}:{urn}".encode()
                    ).hexdigest(),
                    status=ReceiptStatus.SUCCESS,
                    detail_code="ENTITY_CREATED",
                    proposal_hash=entity_hash,
                    ownership_nonce=nonce,
                    metrics=binding_metrics
                    | {"beforeStatus": "LIVE", "afterStatus": "RECONCILED_CREATED"},
                )
            )
    return reconciled
