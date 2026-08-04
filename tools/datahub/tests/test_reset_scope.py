from __future__ import annotations

from pathlib import Path
from typing import Any

import pytest

from lineageguard_datahub.models import ExpectedGraph
from lineageguard_datahub.receipts import OperationReceipt, ReceiptStatus, ReceiptStore
from lineageguard_datahub.reset import ResetPolicyError, build_reset_plan, execute_reset
from lineageguard_datahub.seed import build_seed_plan


class CatalogDeleter:
    def __init__(self, aspects: dict[tuple[str, type[object]], Any], fail_at: int | None = None):
        self.aspects = aspects
        self.fail_at = fail_at
        self.deleted: list[tuple[str, bool]] = []

    def exists(self, entity_urn: str) -> bool:
        return any(urn == entity_urn for urn, _ in self.aspects)

    def get_aspect(self, entity_urn: str, aspect_type: type[Any], version: int = 0) -> Any | None:
        del version
        return self.aspects.get((entity_urn, aspect_type))

    def delete_entity(self, urn: str, hard: bool = False) -> None:
        if self.fail_at is not None and len(self.deleted) == self.fail_at:
            raise RuntimeError("injected")
        self.deleted.append((urn, hard))
        self.aspects = {key: value for key, value in self.aspects.items() if key[0] != urn}


def _creation_state(
    expected_graph: ExpectedGraph, repository_root: Path
) -> tuple[tuple[OperationReceipt, ...], dict[tuple[str, type[object]], Any]]:
    receipts: list[OperationReceipt] = []
    aspects: dict[tuple[str, type[object]], Any] = {}
    for operation in build_seed_plan(expected_graph, repository_root):
        proposal = operation.proposal
        assert proposal.entityUrn is not None and proposal.aspect is not None
        aspects[(proposal.entityUrn, type(proposal.aspect))] = proposal.aspect
        receipts.append(
            OperationReceipt.create(
                scenario_id=expected_graph.scenario_id,
                operation_kind="seed",
                entity_urn=proposal.entityUrn,
                aspect_name=proposal.aspectName,
                idempotency_key=operation.idempotency_key,
                status=ReceiptStatus.SUCCESS,
                detail_code="EMITTED",
            )
        )
    return tuple(receipts), aspects


def test_reset_refuses_non_canonical_environment(expected_graph: ExpectedGraph) -> None:
    with pytest.raises(ResetPolicyError, match="CANONICAL_ENV_REQUIRED"):
        build_reset_plan(
            expected_graph,
            environment_gate="production",
            platform_instance=expected_graph.platform_instance,
            creation_receipts=(),
        )


def test_reset_requires_creation_receipts(expected_graph: ExpectedGraph) -> None:
    with pytest.raises(ResetPolicyError, match="CREATION_RECEIPTS_REQUIRED"):
        build_reset_plan(
            expected_graph,
            environment_gate="canonical",
            platform_instance=expected_graph.platform_instance,
            creation_receipts=(),
        )


def test_reset_rejects_receipt_outside_allowlist(expected_graph: ExpectedGraph) -> None:
    receipt = OperationReceipt.create(
        scenario_id=expected_graph.scenario_id,
        operation_kind="seed",
        entity_urn="urn:li:tag:shared",
        aspect_name="tagProperties",
        idempotency_key="bad",
        status=ReceiptStatus.SUCCESS,
        detail_code="EMITTED",
    )
    with pytest.raises(ResetPolicyError, match="RECEIPT_TARGET_OUTSIDE_ALLOWLIST"):
        build_reset_plan(
            expected_graph,
            environment_gate="canonical",
            platform_instance=expected_graph.platform_instance,
            creation_receipts=(receipt,),
        )


def test_reset_uses_receipts_markers_and_recovers_partial_failure(
    expected_graph: ExpectedGraph, repository_root: Path, tmp_path: Path
) -> None:
    receipts, aspects = _creation_state(expected_graph, repository_root)
    store = ReceiptStore(tmp_path / "operations.jsonl")
    for receipt in receipts:
        store.append(receipt)
    plan = build_reset_plan(
        expected_graph,
        environment_gate="canonical",
        platform_instance=expected_graph.platform_instance,
        creation_receipts=store.read_all(),
    )
    catalog = CatalogDeleter(aspects, fail_at=2)
    with pytest.raises(RuntimeError, match="injected"):
        execute_reset(catalog, catalog, store, plan)
    assert len(catalog.deleted) == 2
    catalog.fail_at = None
    receipt = execute_reset(catalog, catalog, store, plan)
    assert len(receipt.deleted_urns) == len(plan.urns) - 2
    assert set(urn for urn, _ in catalog.deleted) == set(plan.urns)
    assert all(hard is False for _, hard in catalog.deleted)
