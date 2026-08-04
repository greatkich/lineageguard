from __future__ import annotations

import hashlib

from lineageguard_datahub.receipts import (
    ExactOperationIdentity,
    MetricValue,
    OperationReceipt,
    ReceiptStatus,
    resolve_latest_exact_operation,
)

SCENARIO_ID = "canonical-customer-id-rename"


def registry_binding_metrics(
    ownership_nonce: str, warehouse_target_fingerprint: str
) -> dict[str, MetricValue]:
    return {
        "registryNonceFingerprint": hashlib.sha256(ownership_nonce.encode()).hexdigest(),
        "warehouseTargetFingerprint": warehouse_target_fingerprint,
        "registryAttested": "true",
    }


def datahub_target_metrics(
    ownership_nonce: str,
    warehouse_target_fingerprint: str,
    target_attestation: str,
    target_fingerprint: str,
) -> dict[str, MetricValue]:
    return registry_binding_metrics(ownership_nonce, warehouse_target_fingerprint) | {
        "targetAttestation": target_attestation,
        "targetFingerprint": target_fingerprint,
    }


def receipt_has_registry_binding(
    receipt: OperationReceipt,
    *,
    ownership_nonce: str,
    warehouse_target_fingerprint: str,
) -> bool:
    return receipt.ownership_nonce == ownership_nonce and all(
        receipt.metrics.get(key) == value
        for key, value in registry_binding_metrics(
            ownership_nonce, warehouse_target_fingerprint
        ).items()
    )


def latest_warehouse_receipt(
    receipts: tuple[OperationReceipt, ...],
    *,
    scenario_id: str,
    ownership_nonce: str,
    warehouse_target_fingerprint: str,
) -> OperationReceipt:
    candidates = [
        receipt
        for receipt in receipts
        if receipt.scenario_id == scenario_id
        and receipt.operation_kind == "warehouse"
        and receipt.entity_urn is None
        and receipt.aspect_name == "canonical-schema"
    ]
    if not candidates:
        raise ValueError("WAREHOUSE_RECEIPT_REQUIRED")
    expected = candidates[-1]
    resolved = resolve_latest_exact_operation(
        receipts,
        ExactOperationIdentity(
            scenario_id=scenario_id,
            operation_kind="warehouse",
            entity_urn=None,
            aspect_name="canonical-schema",
            idempotency_key=expected.idempotency_key,
            proposal_hash=expected.proposal_hash,
        ),
        expected_outcomes=frozenset({(ReceiptStatus.SUCCESS, "WAREHOUSE_READY")}),
        error_prefix="WAREHOUSE_RECEIPT",
    )
    latest = resolved.receipt
    if not receipt_has_registry_binding(
        latest,
        ownership_nonce=ownership_nonce,
        warehouse_target_fingerprint=warehouse_target_fingerprint,
    ):
        raise ValueError("WAREHOUSE_RECEIPT_BINDING_MISMATCH")
    return latest
