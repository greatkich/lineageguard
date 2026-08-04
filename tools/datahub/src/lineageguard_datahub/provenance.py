from __future__ import annotations

import hashlib

from lineageguard_datahub.receipts import MetricValue, OperationReceipt, ReceiptStatus

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
        if receipt.scenario_id == scenario_id and receipt.operation_kind == "warehouse"
    ]
    if not candidates:
        raise ValueError("WAREHOUSE_RECEIPT_REQUIRED")
    latest = candidates[-1]
    if latest.status is not ReceiptStatus.SUCCESS or latest.detail_code != "WAREHOUSE_READY":
        raise ValueError("WAREHOUSE_RECEIPT_NOT_CURRENT")
    if not receipt_has_registry_binding(
        latest,
        ownership_nonce=ownership_nonce,
        warehouse_target_fingerprint=warehouse_target_fingerprint,
    ):
        raise ValueError("WAREHOUSE_RECEIPT_BINDING_MISMATCH")
    return latest
