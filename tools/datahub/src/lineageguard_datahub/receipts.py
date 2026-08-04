from __future__ import annotations

import json
import os
from dataclasses import asdict, dataclass, field
from datetime import UTC, datetime
from enum import StrEnum
from pathlib import Path


class ReceiptStatus(StrEnum):
    SUCCESS = "SUCCESS"
    FAILURE = "FAILURE"
    SKIPPED = "SKIPPED"


@dataclass(frozen=True, slots=True)
class OperationReceipt:
    scenario_id: str
    operation_kind: str
    entity_urn: str | None
    aspect_name: str | None
    idempotency_key: str
    status: ReceiptStatus
    detail_code: str
    recorded_at: str
    metrics: dict[str, int | float | str] = field(default_factory=dict)

    @classmethod
    def create(
        cls,
        *,
        scenario_id: str,
        operation_kind: str,
        entity_urn: str | None,
        aspect_name: str | None,
        idempotency_key: str,
        status: ReceiptStatus,
        detail_code: str,
        metrics: dict[str, int | float | str] | None = None,
    ) -> OperationReceipt:
        return cls(
            scenario_id=scenario_id,
            operation_kind=operation_kind,
            entity_urn=entity_urn,
            aspect_name=aspect_name,
            idempotency_key=idempotency_key,
            status=status,
            detail_code=detail_code,
            recorded_at=datetime.now(UTC).isoformat(),
            metrics=dict(metrics or {}),
        )


class ReceiptStore:
    def __init__(self, path: Path) -> None:
        self.path = path

    def append(self, receipt: OperationReceipt) -> None:
        self.path.parent.mkdir(mode=0o700, parents=True, exist_ok=True)
        descriptor = os.open(
            self.path,
            os.O_APPEND | os.O_CREAT | os.O_WRONLY,
            0o600,
        )
        with os.fdopen(descriptor, "a", encoding="utf-8") as stream:
            stream.write(json.dumps(asdict(receipt), sort_keys=True) + "\n")
            stream.flush()
            os.fsync(stream.fileno())

    def read_all(self) -> tuple[OperationReceipt, ...]:
        if not self.path.exists():
            return ()
        receipts: list[OperationReceipt] = []
        for line_number, line in enumerate(self.path.read_text(encoding="utf-8").splitlines(), 1):
            raw = json.loads(line)
            try:
                receipts.append(
                    OperationReceipt(
                        scenario_id=raw["scenario_id"],
                        operation_kind=raw["operation_kind"],
                        entity_urn=raw["entity_urn"],
                        aspect_name=raw["aspect_name"],
                        idempotency_key=raw["idempotency_key"],
                        status=ReceiptStatus(raw["status"]),
                        detail_code=raw["detail_code"],
                        recorded_at=raw["recorded_at"],
                        metrics=raw.get("metrics", {}),
                    )
                )
            except (KeyError, TypeError, ValueError) as error:
                raise ValueError(f"RECEIPT_INVALID_LINE:{line_number}") from error
        return tuple(receipts)

    def latest_success(self, scenario_id: str, operation_kind: str) -> dict[str, OperationReceipt]:
        successful: dict[str, OperationReceipt] = {}
        for receipt in self.read_all():
            if (
                receipt.scenario_id == scenario_id
                and receipt.operation_kind == operation_kind
                and receipt.status is ReceiptStatus.SUCCESS
            ):
                successful[receipt.idempotency_key] = receipt
        return successful
