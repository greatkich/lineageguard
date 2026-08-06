from __future__ import annotations

import hashlib
from dataclasses import dataclass
from pathlib import Path
from typing import Protocol

from datahub.metadata.schema_classes import StatusClass

from lineageguard_datahub.models import ExpectedGraph
from lineageguard_datahub.provenance import datahub_target_metrics, receipt_has_registry_binding
from lineageguard_datahub.receipts import OperationReceipt, ReceiptStatus, ReceiptStore
from lineageguard_datahub.seed import (
    EntityReader,
    PlannedUpsert,
    _entity_proposal_hash,
    build_seed_plan,
    entity_has_scenario_marker,
)
from lineageguard_datahub.target_attestation import TargetAttestor, require_current_target
from lineageguard_datahub.warehouse import SqlCursor, attest_scenario_registry


class ResetPolicyError(ValueError):
    """Reset was not authorized for the exact canonical environment."""


class EntityDeleter(Protocol):
    def delete_entity(self, urn: str, hard: bool = False) -> None: ...


class EntityDeleterFactory(Protocol):
    def __call__(self) -> EntityDeleter: ...


@dataclass(frozen=True, slots=True)
class ResetPlan:
    scenario_id: str
    targets: tuple[ResetTarget, ...]
    warehouse_target_fingerprint: str
    target_attestation: str
    target_fingerprint: str

    @property
    def urns(self) -> tuple[str, ...]:
        return tuple(target.urn for target in self.targets)


@dataclass(frozen=True, slots=True)
class ResetTarget:
    urn: str
    entity_type: str
    idempotency_key: str
    ownership_nonce: str
    proposal_hash: str


@dataclass(frozen=True, slots=True)
class ResetReceipt:
    scenario_id: str
    deleted_urns: tuple[str, ...]


def build_reset_plan(
    graph: ExpectedGraph,
    *,
    environment_gate: str | None,
    platform_instance: str | None,
    creation_receipts: tuple[OperationReceipt, ...],
    root: Path,
    ownership_nonce: str,
    warehouse_target_fingerprint: str,
    target_attestation: str,
    target_fingerprint: str,
) -> ResetPlan:
    if environment_gate != "canonical":
        raise ResetPolicyError("CANONICAL_ENV_REQUIRED")
    if platform_instance != graph.platform_instance:
        raise ResetPolicyError("PLATFORM_INSTANCE_MISMATCH")
    managed = set(graph.owned_urns)
    seed_plan = build_seed_plan(graph, root, ownership_nonce)
    seed_by_entity: dict[str, list[PlannedUpsert]] = {}
    for operation in seed_plan:
        assert operation.proposal.entityUrn is not None
        seed_by_entity.setdefault(operation.proposal.entityUrn, []).append(operation)
    expected_hashes = {
        urn: _entity_proposal_hash(operations) for urn, operations in seed_by_entity.items()
    }
    created: dict[str, OperationReceipt] = {}
    for receipt in creation_receipts:
        if receipt.scenario_id != graph.scenario_id:
            continue
        if (
            receipt.operation_kind != "entity"
            or receipt.status is not ReceiptStatus.SUCCESS
            or receipt.detail_code != "ENTITY_CREATED"
        ):
            continue
        if receipt.entity_urn not in managed:
            raise ResetPolicyError("RECEIPT_TARGET_OUTSIDE_ALLOWLIST")
        if receipt.entity_urn is not None:
            if receipt.ownership_nonce != ownership_nonce:
                raise ResetPolicyError("RECEIPT_OWNERSHIP_MISMATCH")
            if not receipt_has_registry_binding(
                receipt,
                ownership_nonce=ownership_nonce,
                warehouse_target_fingerprint=warehouse_target_fingerprint,
            ):
                raise ResetPolicyError("CREATION_REGISTRY_BINDING_MISMATCH")
            if (
                receipt.metrics.get("targetAttestation") != target_attestation
                or receipt.metrics.get("targetFingerprint") != target_fingerprint
            ):
                raise ResetPolicyError("CREATION_TARGET_MISMATCH")
            expected = expected_hashes.get(receipt.entity_urn)
            if expected is not None and receipt.proposal_hash != expected:
                raise ResetPolicyError("CREATION_PROPOSAL_MISMATCH")
            if expected is None:
                first_aspect_keys: dict[str, str] = {}
                for item in creation_receipts:
                    if (
                        item.entity_urn == receipt.entity_urn
                        and item.operation_kind == "ingest-query"
                        and item.status is ReceiptStatus.SUCCESS
                        and item.aspect_name is not None
                        and item.aspect_name
                        in {
                            "queryProperties",
                            "querySubjects",
                            "dataPlatformInstance",
                            "status",
                        }
                    ):
                        first_aspect_keys.setdefault(item.aspect_name, item.idempotency_key)
                aspect_keys = sorted(first_aspect_keys.values())
                actual = hashlib.sha256("\n".join(aspect_keys).encode()).hexdigest()
                if not aspect_keys or receipt.proposal_hash != actual:
                    raise ResetPolicyError("CREATION_PROPOSAL_MISMATCH")
            created[receipt.entity_urn] = receipt
    if not created:
        raise ResetPolicyError("CREATION_RECEIPTS_REQUIRED")
    targets = tuple(
        ResetTarget(
            urn=urn,
            entity_type=_entity_type_from_urn(urn),
            idempotency_key=hashlib.sha256(f"reset:{graph.scenario_id}:{urn}".encode()).hexdigest(),
            ownership_nonce=ownership_nonce,
            proposal_hash=created[urn].proposal_hash,
        )
        for urn in sorted(created, reverse=True)
        if not urn.startswith("urn:li:domain:")
    )
    return ResetPlan(
        scenario_id=graph.scenario_id,
        targets=targets,
        warehouse_target_fingerprint=warehouse_target_fingerprint,
        target_attestation=target_attestation,
        target_fingerprint=target_fingerprint,
    )


def _entity_type_from_urn(urn: str) -> str:
    for prefix, entity_type in (
        ("urn:li:corpGroup:", "corpGroup"),
        ("urn:li:dashboard:", "dashboard"),
        ("urn:li:dataset:", "dataset"),
        ("urn:li:domain:", "domain"),
        ("urn:li:glossaryTerm:", "glossaryTerm"),
        ("urn:li:mlModel:", "mlModel"),
        ("urn:li:query:", "query"),
        ("urn:li:tag:", "tag"),
    ):
        if urn.startswith(prefix):
            return entity_type
    raise ResetPolicyError("RESET_ENTITY_TYPE_DENIED")


def execute_reset(
    deleter_factory: EntityDeleterFactory,
    reader: EntityReader,
    receipt_store: ReceiptStore,
    plan: ResetPlan,
    registry_cursor: SqlCursor,
    *,
    attest_target: TargetAttestor,
) -> ResetReceipt:
    with receipt_store.scenario_operation(plan.scenario_id, "reset"):
        require_current_target(
            attest_target,
            target_attestation=plan.target_attestation,
            target_fingerprint=plan.target_fingerprint,
        )
        attest_scenario_registry(
            registry_cursor,
            ownership_nonce=receipt_store.ownership_nonce,
            warehouse_target_fingerprint=plan.warehouse_target_fingerprint,
        )
        deleter = deleter_factory()
        return _execute_reset_under_lock(deleter, reader, receipt_store, plan)


def _execute_reset_under_lock(
    deleter: EntityDeleter,
    reader: EntityReader,
    receipt_store: ReceiptStore,
    plan: ResetPlan,
) -> ResetReceipt:
    deleted: list[str] = []
    for target in plan.targets:
        metrics = datahub_target_metrics(
            target.ownership_nonce,
            plan.warehouse_target_fingerprint,
            plan.target_attestation,
            plan.target_fingerprint,
        )
        receipt_store.append(
            OperationReceipt.create(
                scenario_id=plan.scenario_id,
                operation_kind="reset",
                entity_urn=target.urn,
                aspect_name=None,
                idempotency_key=target.idempotency_key,
                status=ReceiptStatus.PLANNED,
                detail_code="OPERATION_PLANNED",
                proposal_hash=target.proposal_hash,
                ownership_nonce=target.ownership_nonce,
                metrics=metrics | {"beforeStatus": "UNKNOWN", "afterStatus": "PLANNED"},
            )
        )
        status = reader.get_aspect(target.urn, StatusClass)
        if status is not None and status.removed is True:
            receipt_store.append(
                OperationReceipt.create(
                    scenario_id=plan.scenario_id,
                    operation_kind="reset",
                    entity_urn=target.urn,
                    aspect_name=None,
                    idempotency_key=target.idempotency_key,
                    status=ReceiptStatus.SKIPPED,
                    detail_code="ALREADY_DELETED",
                    proposal_hash=target.proposal_hash,
                    ownership_nonce=target.ownership_nonce,
                    metrics=metrics | {"beforeStatus": "ABSENT", "afterStatus": "UNCHANGED"},
                )
            )
            continue
        if not reader.exists(target.urn) or not entity_has_scenario_marker(
            reader, target.urn, target.entity_type, target.ownership_nonce
        ):
            receipt_store.append(
                OperationReceipt.create(
                    scenario_id=plan.scenario_id,
                    operation_kind="reset",
                    entity_urn=target.urn,
                    aspect_name=None,
                    idempotency_key=target.idempotency_key,
                    status=ReceiptStatus.RECONCILIATION_REQUIRED,
                    detail_code="SERVER_MARKER_REQUIRED",
                    proposal_hash=target.proposal_hash,
                    ownership_nonce=target.ownership_nonce,
                    metrics=metrics,
                )
            )
            raise ResetPolicyError(f"SERVER_MARKER_REQUIRED:{target.urn}")
        try:
            deleter.delete_entity(target.urn, hard=False)
        except Exception as error:
            receipt_store.append(
                OperationReceipt.create(
                    scenario_id=plan.scenario_id,
                    operation_kind="reset",
                    entity_urn=target.urn,
                    aspect_name=None,
                    idempotency_key=target.idempotency_key,
                    status=ReceiptStatus.FAILURE,
                    detail_code=type(error).__name__,
                    proposal_hash=target.proposal_hash,
                    ownership_nonce=target.ownership_nonce,
                    metrics=metrics | {"beforeStatus": "OWNED", "afterStatus": "FAILED"},
                )
            )
            raise
        receipt_store.append(
            OperationReceipt.create(
                scenario_id=plan.scenario_id,
                operation_kind="reset",
                entity_urn=target.urn,
                aspect_name=None,
                idempotency_key=target.idempotency_key,
                status=ReceiptStatus.SUCCESS,
                detail_code="SOFT_DELETED",
                proposal_hash=target.proposal_hash,
                ownership_nonce=target.ownership_nonce,
                metrics=metrics | {"beforeStatus": "OWNED", "afterStatus": "SOFT_DELETED"},
            )
        )
        deleted.append(target.urn)
    return ResetReceipt(plan.scenario_id, tuple(deleted))


def reconcile_reset(
    reader: EntityReader,
    receipt_store: ReceiptStore,
    plan: ResetPlan,
    registry_cursor: SqlCursor,
    *,
    attest_target: TargetAttestor,
) -> int:
    """Resolve an interrupted soft delete only from the exact live Status and owner marker."""
    reconciled = 0
    targets = {target.idempotency_key: target for target in plan.targets}
    with receipt_store.scenario_operation(
        plan.scenario_id, "reset-reconcile", reconciliation=True
    ) as unresolved:
        require_current_target(
            attest_target,
            target_attestation=plan.target_attestation,
            target_fingerprint=plan.target_fingerprint,
        )
        attest_scenario_registry(
            registry_cursor,
            ownership_nonce=receipt_store.ownership_nonce,
            warehouse_target_fingerprint=plan.warehouse_target_fingerprint,
        )
        foreign = [item for item in unresolved if item.operation_kind != "reset"]
        if foreign:
            raise ResetPolicyError("RESET_RECONCILIATION_FOREIGN_OPERATION")
        if not unresolved:
            raise ResetPolicyError("RESET_RECONCILIATION_NOT_REQUIRED")
        for pending in unresolved:
            target = targets.get(pending.idempotency_key)
            if (
                target is None
                or pending.entity_urn != target.urn
                or pending.proposal_hash != target.proposal_hash
            ):
                raise ResetPolicyError("RESET_RECONCILIATION_PLAN_MISMATCH")
            metrics = datahub_target_metrics(
                target.ownership_nonce,
                plan.warehouse_target_fingerprint,
                plan.target_attestation,
                plan.target_fingerprint,
            )
            if any(pending.metrics.get(key) != value for key, value in metrics.items()):
                raise ResetPolicyError("RESET_RECONCILIATION_PROVENANCE_MISMATCH")
            status = reader.get_aspect(target.urn, StatusClass)
            if status is not None and status.removed is True:
                detail = "LIVE_RECONCILED_APPLIED"
                after = "SOFT_DELETED"
            elif reader.exists(target.urn) and entity_has_scenario_marker(
                reader, target.urn, target.entity_type, target.ownership_nonce
            ):
                detail = "LIVE_RECONCILED_NOT_APPLIED"
                after = "OWNED"
            else:
                receipt_store.append(
                    OperationReceipt.create(
                        scenario_id=plan.scenario_id,
                        operation_kind="reset",
                        entity_urn=target.urn,
                        aspect_name=None,
                        idempotency_key=target.idempotency_key,
                        status=ReceiptStatus.RECONCILIATION_REQUIRED,
                        detail_code="LIVE_RECONCILIATION_CONFLICT",
                        proposal_hash=target.proposal_hash,
                        ownership_nonce=target.ownership_nonce,
                        metrics=metrics,
                    )
                )
                raise ResetPolicyError(f"RESET_LIVE_RECONCILIATION_CONFLICT:{target.urn}")
            receipt_store.append(
                OperationReceipt.create(
                    scenario_id=plan.scenario_id,
                    operation_kind="reset",
                    entity_urn=target.urn,
                    aspect_name=None,
                    idempotency_key=target.idempotency_key,
                    status=ReceiptStatus.SKIPPED,
                    detail_code=detail,
                    proposal_hash=target.proposal_hash,
                    ownership_nonce=target.ownership_nonce,
                    metrics=metrics | {"beforeStatus": pending.status.value, "afterStatus": after},
                )
            )
            reconciled += 1
    return reconciled
