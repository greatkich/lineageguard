from __future__ import annotations

import hashlib
from dataclasses import dataclass
from typing import Protocol

from lineageguard_datahub.models import ExpectedGraph
from lineageguard_datahub.receipts import OperationReceipt, ReceiptStatus, ReceiptStore
from lineageguard_datahub.seed import EntityReader, entity_has_scenario_marker


class ResetPolicyError(ValueError):
    """Reset was not authorized for the exact canonical environment."""


class EntityDeleter(Protocol):
    def delete_entity(self, urn: str, hard: bool = False) -> None: ...


@dataclass(frozen=True, slots=True)
class ResetPlan:
    scenario_id: str
    targets: tuple[ResetTarget, ...]

    @property
    def urns(self) -> tuple[str, ...]:
        return tuple(target.urn for target in self.targets)


@dataclass(frozen=True, slots=True)
class ResetTarget:
    urn: str
    entity_type: str
    idempotency_key: str


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
) -> ResetPlan:
    if environment_gate != "canonical":
        raise ResetPolicyError("CANONICAL_ENV_REQUIRED")
    if platform_instance != graph.platform_instance:
        raise ResetPolicyError("PLATFORM_INSTANCE_MISMATCH")
    managed = set(graph.managed_urns)
    created: set[str] = set()
    for receipt in creation_receipts:
        if receipt.scenario_id != graph.scenario_id:
            continue
        if receipt.operation_kind != "seed" or receipt.status is not ReceiptStatus.SUCCESS:
            continue
        if receipt.entity_urn not in managed:
            raise ResetPolicyError("RECEIPT_TARGET_OUTSIDE_ALLOWLIST")
        if receipt.entity_urn is not None:
            created.add(receipt.entity_urn)
    if not created:
        raise ResetPolicyError("CREATION_RECEIPTS_REQUIRED")
    targets = tuple(
        ResetTarget(
            urn=urn,
            entity_type=_entity_type_from_urn(urn),
            idempotency_key=hashlib.sha256(f"reset:{graph.scenario_id}:{urn}".encode()).hexdigest(),
        )
        for urn in sorted(created, reverse=True)
    )
    return ResetPlan(scenario_id=graph.scenario_id, targets=targets)


def _entity_type_from_urn(urn: str) -> str:
    for prefix, entity_type in (
        ("urn:li:corpGroup:", "corpGroup"),
        ("urn:li:dashboard:", "dashboard"),
        ("urn:li:dataset:", "dataset"),
        ("urn:li:glossaryTerm:", "glossaryTerm"),
        ("urn:li:mlModel:", "mlModel"),
        ("urn:li:query:", "query"),
        ("urn:li:tag:", "tag"),
    ):
        if urn.startswith(prefix):
            return entity_type
    raise ResetPolicyError("RESET_ENTITY_TYPE_DENIED")


def execute_reset(
    deleter: EntityDeleter,
    reader: EntityReader,
    receipt_store: ReceiptStore,
    plan: ResetPlan,
) -> ResetReceipt:
    successful = receipt_store.latest_success(plan.scenario_id, "reset")
    deleted: list[str] = []
    for target in plan.targets:
        if target.idempotency_key in successful and not reader.exists(target.urn):
            continue
        if not reader.exists(target.urn) or not entity_has_scenario_marker(
            reader, target.urn, target.entity_type
        ):
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
            )
        )
        deleted.append(target.urn)
    return ResetReceipt(plan.scenario_id, tuple(deleted))
