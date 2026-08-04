from __future__ import annotations

from collections.abc import Mapping
from pathlib import Path

from lineageguard_datahub.ingestion import (
    DBT_ARTIFACT_VERIFICATION_FINGERPRINT,
    DBT_BUILD_COMMAND_FINGERPRINT,
    DBT_DOCS_COMMAND_FINGERPRINT,
    RECIPE_DIGESTS,
    build_ingestion_plan,
    dbt_artifact_metrics,
    dbt_project_fingerprint,
    ingestion_snapshot_fingerprint,
    verify_dbt_ingestion_artifacts,
)
from lineageguard_datahub.provenance import datahub_target_metrics, registry_binding_metrics
from lineageguard_datahub.receipts import MetricValue, OperationReceipt, ReceiptStatus, ReceiptStore

SCENARIO = "canonical-customer-id-rename"
WAREHOUSE_TARGET = "e" * 64
TARGET_ATTESTATION = "canonical-local-lineageguard-v1"
TARGET_FINGERPRINT = "f" * 64


class RegistryCursor:
    def __init__(self, nonce: str, warehouse_target: str = WAREHOUSE_TARGET) -> None:
        self.nonce = nonce
        self.warehouse_target = warehouse_target
        self.queries: list[tuple[str, tuple[object, ...] | None]] = []

    def execute(self, query: str, params: tuple[object, ...] | None = None) -> RegistryCursor:
        self.queries.append((query, params))
        return self

    def fetchone(self) -> tuple[str, str, str]:
        return SCENARIO, self.nonce, self.warehouse_target


def provenance_values(
    root: Path,
) -> tuple[str, dict[str, MetricValue], str]:
    artifacts = verify_dbt_ingestion_artifacts(root)
    return (
        dbt_project_fingerprint(root),
        dbt_artifact_metrics(artifacts),
        ingestion_snapshot_fingerprint(build_ingestion_plan(root), artifacts),
    )


def full_target_metrics(
    root: Path,
    ownership_nonce: str,
    *,
    warehouse_target: str = WAREHOUSE_TARGET,
    target_attestation: str = TARGET_ATTESTATION,
    target_fingerprint: str = TARGET_FINGERPRINT,
) -> dict[str, MetricValue]:
    project, artifacts, snapshot = provenance_values(root)
    return (
        datahub_target_metrics(
            ownership_nonce,
            warehouse_target,
            target_attestation,
            target_fingerprint,
        )
        | artifacts
        | {
            "dbtProjectFingerprint": project,
            "ingestionSnapshotFingerprint": snapshot,
        }
    )


def _append(
    store: ReceiptStore,
    *,
    operation_kind: str,
    aspect_name: str,
    idempotency_key: str,
    detail_code: str,
    recorded_at: str,
    proposal_hash: str | None = None,
    metrics: Mapping[str, MetricValue] | None = None,
) -> None:
    store.append(
        OperationReceipt.create(
            scenario_id=SCENARIO,
            operation_kind=operation_kind,
            entity_urn=None,
            aspect_name=aspect_name,
            idempotency_key=idempotency_key,
            proposal_hash=proposal_hash or idempotency_key,
            status=ReceiptStatus.SUCCESS,
            detail_code=detail_code,
            recorded_at=recorded_at,
            ownership_nonce=store.ownership_nonce,
            metrics=metrics,
        )
    )


def append_build_provenance(store: ReceiptStore, root: Path) -> None:
    nonce = store.ownership_nonce
    project, artifacts, _ = provenance_values(root)
    binding = registry_binding_metrics(nonce, WAREHOUSE_TARGET)
    _append(
        store,
        operation_kind="warehouse",
        aspect_name="canonical-schema",
        idempotency_key="1" * 64,
        detail_code="WAREHOUSE_READY",
        recorded_at="2020-01-01T08:00:00+00:00",
        metrics=binding,
    )
    for aspect, fingerprint, recorded_at in (
        ("build", DBT_BUILD_COMMAND_FINGERPRINT, "2020-01-01T08:01:00+00:00"),
        ("docs-generate", DBT_DOCS_COMMAND_FINGERPRINT, "2020-01-01T08:02:00+00:00"),
    ):
        _append(
            store,
            operation_kind="dbt-build",
            aspect_name=aspect,
            idempotency_key=fingerprint,
            proposal_hash=project,
            detail_code="DBT_COMMAND_SUCCEEDED",
            recorded_at=recorded_at,
            metrics=binding | {"dbtProjectFingerprint": project},
        )
    _append(
        store,
        operation_kind="dbt-build",
        aspect_name="artifact-set",
        idempotency_key=DBT_ARTIFACT_VERIFICATION_FINGERPRINT,
        proposal_hash=project,
        detail_code="DBT_ARTIFACTS_VERIFIED",
        recorded_at="2020-01-01T08:03:00+00:00",
        metrics=binding | artifacts | {"dbtProjectFingerprint": project},
    )


def append_ingestion_receipts(
    store: ReceiptStore,
    root: Path,
    *,
    start_minute: int = 1,
    hour_prefix: str = "2020-01-01T10",
) -> None:
    metrics = full_target_metrics(root, store.ownership_nonce)
    for index, (relative, digest) in enumerate(RECIPE_DIGESTS.items()):
        _append(
            store,
            operation_kind="ingest",
            aspect_name=relative,
            idempotency_key=digest,
            detail_code="INGESTED",
            recorded_at=f"{hour_prefix}:{start_minute + index:02d}:00+00:00",
            metrics=metrics,
        )
