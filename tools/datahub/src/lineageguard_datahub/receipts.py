from __future__ import annotations

import fcntl
import hashlib
import hmac
import json
import math
import os
import re
import stat
import threading
from collections.abc import Iterator, Mapping
from contextlib import contextmanager
from dataclasses import asdict, dataclass, field, replace
from datetime import UTC, datetime
from enum import StrEnum
from pathlib import Path
from typing import Any

MAX_RECEIPT_BYTES = 4 * 1024 * 1024
MAX_RECEIPT_LINE_BYTES = 64 * 1024
MAX_RECEIPTS = 10_000
MAX_METRICS = 32
SHA256_PATTERN = re.compile(r"^[0-9a-f]{64}$")
MetricValue = int | float | str
# These read-modify-write effects require live inspection before retry. Warehouse, dbt, query,
# and connector commands are declarative or read-only and converge through an exact normal rerun.
LIVE_RECONCILIATION_KINDS = frozenset({"seed", "ingest-query", "reset"})


class ReceiptStatus(StrEnum):
    PLANNED = "PLANNED"
    RECONCILIATION_REQUIRED = "RECONCILIATION_REQUIRED"
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
    proposal_hash: str = ""
    ownership_nonce: str = ""
    metrics: dict[str, MetricValue] = field(default_factory=dict)
    previous_hash: str = ""
    record_hash: str = ""

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
        proposal_hash: str = "",
        ownership_nonce: str = "",
        metrics: Mapping[str, MetricValue] | None = None,
        recorded_at: str | None = None,
    ) -> OperationReceipt:
        return cls(
            scenario_id=scenario_id,
            operation_kind=operation_kind,
            entity_urn=entity_urn,
            aspect_name=aspect_name,
            idempotency_key=idempotency_key,
            status=status,
            detail_code=detail_code,
            recorded_at=recorded_at or datetime.now(UTC).isoformat(),
            proposal_hash=proposal_hash or idempotency_key,
            ownership_nonce=ownership_nonce,
            metrics=dict(metrics or {}),
        )


@dataclass(frozen=True, slots=True)
class ExactOperationIdentity:
    scenario_id: str
    operation_kind: str
    entity_urn: str | None
    aspect_name: str | None
    idempotency_key: str
    proposal_hash: str


@dataclass(frozen=True, slots=True)
class ResolvedOperationReceipt:
    index: int
    receipt: OperationReceipt


def receipt_append_index(receipts: tuple[OperationReceipt, ...], target: OperationReceipt) -> int:
    for index in range(len(receipts) - 1, -1, -1):
        if receipts[index] is target:
            return index
    raise ValueError("RECEIPT_NOT_FROM_SEQUENCE")


def resolve_latest_exact_operation(
    receipts: tuple[OperationReceipt, ...],
    identity: ExactOperationIdentity,
    *,
    expected_outcomes: frozenset[tuple[ReceiptStatus, str]],
    error_prefix: str,
) -> ResolvedOperationReceipt:
    """Resolve by append order; an older success never masks a newer exact-operation failure."""
    if not expected_outcomes or any(
        status not in {ReceiptStatus.SUCCESS, ReceiptStatus.SKIPPED}
        for status, _ in expected_outcomes
    ):
        raise TypeError("RECEIPT_EXPECTED_OUTCOMES_INVALID")
    candidates = [
        (index, receipt)
        for index, receipt in enumerate(receipts)
        if receipt.scenario_id == identity.scenario_id
        and receipt.operation_kind == identity.operation_kind
        and receipt.entity_urn == identity.entity_urn
        and receipt.aspect_name == identity.aspect_name
        and receipt.idempotency_key == identity.idempotency_key
    ]
    if not candidates:
        raise ValueError(f"{error_prefix}_MISSING")
    index, latest = candidates[-1]
    if latest.proposal_hash != identity.proposal_hash:
        raise ValueError(f"{error_prefix}_PROPOSAL_MISMATCH")
    if (latest.status, latest.detail_code) not in expected_outcomes:
        raise ValueError(f"{error_prefix}_NOT_CURRENT")
    return ResolvedOperationReceipt(index=index, receipt=latest)


class ReceiptStore:
    def __init__(self, path: Path) -> None:
        self.path = path
        self.state_path = path.with_name("ownership-state.json")
        self.lock_path = path.with_name("scenario-operation.lock")
        self._thread_lock = threading.RLock()
        self._lock_depth = 0
        self._lock_descriptor: int | None = None

    @property
    def ownership_nonce(self) -> str:
        return self._state()["nonce"]

    def _safe_flags(self, flags: int) -> int:
        return flags | getattr(os, "O_NOFOLLOW", 0) | getattr(os, "O_CLOEXEC", 0)

    def _validate_descriptor(self, descriptor: int, *, maximum: int) -> os.stat_result:
        info = os.fstat(descriptor)
        if not stat.S_ISREG(info.st_mode):
            raise ValueError("PROTECTED_FILE_NOT_REGULAR")
        if info.st_uid != os.getuid():
            raise ValueError("PROTECTED_FILE_WRONG_OWNER")
        if stat.S_IMODE(info.st_mode) != 0o600:
            raise ValueError("PROTECTED_FILE_MODE_MUST_BE_0600")
        if info.st_size > maximum:
            raise ValueError("PROTECTED_FILE_TOO_LARGE")
        return info

    def _prepare_parent(self) -> None:
        self.path.parent.mkdir(mode=0o700, parents=True, exist_ok=True)
        if self.path.parent.is_symlink() or not self.path.parent.is_dir():
            raise ValueError("RECEIPT_PARENT_UNSAFE")
        info = self.path.parent.stat()
        if info.st_uid != os.getuid():
            raise ValueError("RECEIPT_PARENT_WRONG_OWNER")
        os.chmod(self.path.parent, 0o700)

    @contextmanager
    def _exclusive(self) -> Iterator[None]:
        with self._thread_lock:
            if self._lock_depth == 0:
                self._prepare_parent()
                descriptor = os.open(
                    self.lock_path,
                    self._safe_flags(os.O_RDWR | os.O_CREAT),
                    0o600,
                )
                try:
                    self._validate_descriptor(descriptor, maximum=1024)
                    fcntl.flock(descriptor, fcntl.LOCK_EX)
                except Exception:
                    os.close(descriptor)
                    raise
                self._lock_descriptor = descriptor
            self._lock_depth += 1
            try:
                yield
            finally:
                self._lock_depth -= 1
                if self._lock_depth == 0:
                    assert self._lock_descriptor is not None
                    fcntl.flock(self._lock_descriptor, fcntl.LOCK_UN)
                    os.close(self._lock_descriptor)
                    self._lock_descriptor = None

    @contextmanager
    def scenario_operation(
        self,
        scenario_id: str,
        operation_kind: str,
        *,
        reconciliation: bool = False,
    ) -> Iterator[tuple[OperationReceipt, ...]]:
        """Hold the owner lock from preflight through the terminal durable receipt."""
        with self._exclusive():
            unresolved = self.unresolved(scenario_id)
            if unresolved and not reconciliation:
                identities = ",".join(
                    sorted(
                        f"{item.operation_kind}:{item.entity_urn or '-'}:{item.aspect_name or '-'}"
                        for item in unresolved
                    )
                )
                raise ValueError(f"SCENARIO_RECONCILIATION_REQUIRED:{identities}")
            try:
                yield unresolved
            except Exception:
                raise
            else:
                remaining = self.unresolved(scenario_id)
                if remaining:
                    code = (
                        "SCENARIO_RECONCILIATION_INCOMPLETE"
                        if reconciliation
                        else "SCENARIO_OPERATION_LEFT_UNRESOLVED"
                    )
                    raise ValueError(f"{code}:{operation_kind}")

    def _state(self) -> dict[str, str]:
        self._prepare_parent()
        try:
            descriptor = os.open(self.state_path, self._safe_flags(os.O_RDONLY))
        except FileNotFoundError:
            state = {"key": os.urandom(32).hex(), "nonce": os.urandom(32).hex()}
            descriptor = os.open(
                self.state_path,
                self._safe_flags(os.O_WRONLY | os.O_CREAT | os.O_EXCL),
                0o600,
            )
            with os.fdopen(descriptor, "w", encoding="utf-8") as stream:
                stream.write(json.dumps(state, sort_keys=True))
                stream.flush()
                os.fsync(stream.fileno())
            return state
        try:
            self._validate_descriptor(descriptor, maximum=1024)
        except Exception:
            os.close(descriptor)
            raise
        with os.fdopen(descriptor, "r", encoding="utf-8") as stream:
            raw = stream.read(1025)
        try:
            state = json.loads(raw)
        except json.JSONDecodeError as error:
            raise ValueError("OWNERSHIP_STATE_INVALID") from error
        if (
            not isinstance(state, dict)
            or set(state) != {"key", "nonce"}
            or any(not isinstance(state[item], str) or len(state[item]) != 64 for item in state)
        ):
            raise ValueError("OWNERSHIP_STATE_INVALID")
        return state

    @staticmethod
    def _unsigned(receipt: OperationReceipt) -> dict[str, Any]:
        payload = asdict(receipt)
        payload.pop("record_hash")
        return payload

    def _sign(self, receipt: OperationReceipt, key: str) -> str:
        payload = json.dumps(
            self._unsigned(receipt), sort_keys=True, separators=(",", ":")
        ).encode()
        return hmac.new(bytes.fromhex(key), payload, hashlib.sha256).hexdigest()

    @staticmethod
    def _validate_fields(receipt: OperationReceipt) -> None:
        if receipt.scenario_id != "canonical-customer-id-rename":
            raise ValueError("RECEIPT_SCENARIO_INVALID")
        if not re.fullmatch(r"[a-z-]{2,32}", receipt.operation_kind):
            raise ValueError("RECEIPT_OPERATION_INVALID")
        if not re.fullmatch(r"[A-Za-z0-9_:-]{2,128}", receipt.detail_code):
            raise ValueError("RECEIPT_DETAIL_INVALID")
        for name, value in (
            ("IDEMPOTENCY", receipt.idempotency_key),
            ("PROPOSAL", receipt.proposal_hash),
            ("NONCE", receipt.ownership_nonce),
        ):
            if not SHA256_PATTERN.fullmatch(value):
                raise ValueError(f"RECEIPT_{name}_INVALID")
        if receipt.previous_hash and not SHA256_PATTERN.fullmatch(receipt.previous_hash):
            raise ValueError("RECEIPT_PREVIOUS_HASH_INVALID")
        if receipt.record_hash and not SHA256_PATTERN.fullmatch(receipt.record_hash):
            raise ValueError("RECEIPT_RECORD_HASH_INVALID")
        timestamp = datetime.fromisoformat(receipt.recorded_at)
        if timestamp.tzinfo is None:
            raise ValueError("RECEIPT_TIMESTAMP_INVALID")
        if len(receipt.metrics) > MAX_METRICS:
            raise ValueError("RECEIPT_METRICS_INVALID")
        for key, metric_value in receipt.metrics.items():
            if (
                not isinstance(key, str)
                or not key
                or len(key) > 128
                or type(metric_value) not in {int, float, str}
                or (isinstance(metric_value, str) and len(metric_value) > 4096)
                or (isinstance(metric_value, float) and not math.isfinite(metric_value))
            ):
                raise ValueError("RECEIPT_METRICS_INVALID")

    def append(self, receipt: OperationReceipt) -> None:
        with self._exclusive():
            state = self._state()
            existing = self.read_all()
            if len(existing) >= MAX_RECEIPTS:
                raise ValueError("RECEIPT_COUNT_LIMIT")
            if receipt.ownership_nonce and receipt.ownership_nonce != state["nonce"]:
                raise ValueError("RECEIPT_OWNERSHIP_NONCE_MISMATCH")
            previous_hash = existing[-1].record_hash if existing else ""
            last_time = datetime.fromisoformat(existing[-1].recorded_at) if existing else None
            current_time = datetime.fromisoformat(receipt.recorded_at)
            if current_time.tzinfo is None or (last_time is not None and current_time < last_time):
                raise ValueError("RECEIPT_TIMESTAMP_OUT_OF_ORDER")
            identity = (
                receipt.operation_kind,
                receipt.entity_urn,
                receipt.aspect_name,
                receipt.idempotency_key,
            )
            for item in existing:
                other = (
                    item.operation_kind,
                    item.entity_urn,
                    item.aspect_name,
                    item.idempotency_key,
                )
                if identity == other and item.proposal_hash != receipt.proposal_hash:
                    raise ValueError("RECEIPT_DUPLICATE_CONFLICT")
            bound = replace(
                receipt,
                ownership_nonce=receipt.ownership_nonce or state["nonce"],
                previous_hash=previous_hash,
                record_hash="",
            )
            self._validate_fields(bound)
            bound = replace(bound, record_hash=self._sign(bound, state["key"]))
            encoded = (
                json.dumps(asdict(bound), sort_keys=True, separators=(",", ":")) + "\n"
            ).encode()
            if len(encoded) > MAX_RECEIPT_LINE_BYTES:
                raise ValueError("RECEIPT_LINE_TOO_LARGE")
            descriptor = os.open(
                self.path,
                self._safe_flags(os.O_APPEND | os.O_CREAT | os.O_WRONLY),
                0o600,
            )
            try:
                info = self._validate_descriptor(descriptor, maximum=MAX_RECEIPT_BYTES)
            except Exception:
                os.close(descriptor)
                raise
            if info.st_size + len(encoded) > MAX_RECEIPT_BYTES:
                os.close(descriptor)
                raise ValueError("RECEIPT_FILE_TOO_LARGE")
            with os.fdopen(descriptor, "ab") as stream:
                stream.write(encoded)
                stream.flush()
                os.fsync(stream.fileno())

    def read_all(self) -> tuple[OperationReceipt, ...]:
        with self._exclusive():
            try:
                descriptor = os.open(self.path, self._safe_flags(os.O_RDONLY))
            except FileNotFoundError:
                return ()
            try:
                self._validate_descriptor(descriptor, maximum=MAX_RECEIPT_BYTES)
            except Exception:
                os.close(descriptor)
                raise
            state = self._state()
            receipts: list[OperationReceipt] = []
            previous_hash = ""
            previous_time: datetime | None = None
            seen: dict[tuple[str, str | None, str | None, str], str] = {}
            with os.fdopen(descriptor, "rb") as stream:
                for line_number, raw_line in enumerate(stream, 1):
                    if line_number > MAX_RECEIPTS:
                        raise ValueError("RECEIPT_COUNT_LIMIT")
                    if len(raw_line) > MAX_RECEIPT_LINE_BYTES:
                        raise ValueError(f"RECEIPT_LINE_TOO_LARGE:{line_number}")
                    try:
                        raw = json.loads(raw_line)
                        receipt = self._parse(raw)
                        recorded_at = datetime.fromisoformat(receipt.recorded_at)
                    except (json.JSONDecodeError, KeyError, TypeError, ValueError) as error:
                        raise ValueError(f"RECEIPT_INVALID_LINE:{line_number}") from error
                    if recorded_at.tzinfo is None or (
                        previous_time is not None and recorded_at < previous_time
                    ):
                        raise ValueError(f"RECEIPT_TIMESTAMP_OUT_OF_ORDER:{line_number}")
                    if receipt.previous_hash != previous_hash:
                        raise ValueError(f"RECEIPT_CHAIN_BROKEN:{line_number}")
                    if receipt.ownership_nonce != state["nonce"]:
                        raise ValueError(f"RECEIPT_NONCE_INVALID:{line_number}")
                    self._validate_fields(receipt)
                    expected_hash = self._sign(replace(receipt, record_hash=""), state["key"])
                    if not hmac.compare_digest(receipt.record_hash, expected_hash):
                        raise ValueError(f"RECEIPT_HASH_INVALID:{line_number}")
                    identity = (
                        receipt.operation_kind,
                        receipt.entity_urn,
                        receipt.aspect_name,
                        receipt.idempotency_key,
                    )
                    if identity in seen and seen[identity] != receipt.proposal_hash:
                        raise ValueError(f"RECEIPT_DUPLICATE_CONFLICT:{line_number}")
                    seen[identity] = receipt.proposal_hash
                    previous_hash = receipt.record_hash
                    previous_time = recorded_at
                    receipts.append(receipt)
            return tuple(receipts)

    @staticmethod
    def _parse(raw: object) -> OperationReceipt:
        keys = {
            "scenario_id",
            "operation_kind",
            "entity_urn",
            "aspect_name",
            "idempotency_key",
            "status",
            "detail_code",
            "recorded_at",
            "proposal_hash",
            "ownership_nonce",
            "metrics",
            "previous_hash",
            "record_hash",
        }
        if not isinstance(raw, dict) or set(raw) != keys:
            raise ValueError("RECEIPT_KEYS_INVALID")
        strings = (
            "scenario_id",
            "operation_kind",
            "idempotency_key",
            "detail_code",
            "recorded_at",
            "proposal_hash",
            "ownership_nonce",
            "previous_hash",
            "record_hash",
        )
        if any(not isinstance(raw[key], str) or len(raw[key]) > 4096 for key in strings):
            raise ValueError("RECEIPT_STRING_INVALID")
        if raw["entity_urn"] is not None and not isinstance(raw["entity_urn"], str):
            raise ValueError("RECEIPT_ENTITY_INVALID")
        if raw["aspect_name"] is not None and not isinstance(raw["aspect_name"], str):
            raise ValueError("RECEIPT_ASPECT_INVALID")
        metrics = raw["metrics"]
        if not isinstance(metrics, dict) or len(metrics) > MAX_METRICS:
            raise ValueError("RECEIPT_METRICS_INVALID")
        if any(
            not isinstance(key, str)
            or not key
            or type(value) not in {int, float, str}
            or (isinstance(value, float) and not math.isfinite(value))
            for key, value in metrics.items()
        ):
            raise ValueError("RECEIPT_METRICS_INVALID")
        return OperationReceipt(
            scenario_id=raw["scenario_id"],
            operation_kind=raw["operation_kind"],
            entity_urn=raw["entity_urn"],
            aspect_name=raw["aspect_name"],
            idempotency_key=raw["idempotency_key"],
            status=ReceiptStatus(raw["status"]),
            detail_code=raw["detail_code"],
            recorded_at=raw["recorded_at"],
            proposal_hash=raw["proposal_hash"],
            ownership_nonce=raw["ownership_nonce"],
            metrics=metrics,
            previous_hash=raw["previous_hash"],
            record_hash=raw["record_hash"],
        )

    def latest_success(self, scenario_id: str, operation_kind: str) -> dict[str, OperationReceipt]:
        latest: dict[str, OperationReceipt] = {}
        for receipt in self.read_all():
            if receipt.scenario_id == scenario_id and receipt.operation_kind == operation_kind:
                latest[receipt.idempotency_key] = receipt
        return {
            key: receipt
            for key, receipt in latest.items()
            if receipt.status is ReceiptStatus.SUCCESS
        }

    def unresolved(self, scenario_id: str) -> tuple[OperationReceipt, ...]:
        latest: dict[tuple[str, str | None, str | None, str], OperationReceipt] = {}
        for receipt in self.read_all():
            if receipt.scenario_id != scenario_id:
                continue
            identity = (
                receipt.operation_kind,
                receipt.entity_urn,
                receipt.aspect_name,
                receipt.idempotency_key,
            )
            latest[identity] = receipt
        return tuple(
            receipt
            for receipt in latest.values()
            if receipt.operation_kind in LIVE_RECONCILIATION_KINDS
            and receipt.status
            in {
                ReceiptStatus.PLANNED,
                ReceiptStatus.FAILURE,
                ReceiptStatus.RECONCILIATION_REQUIRED,
            }
        )
