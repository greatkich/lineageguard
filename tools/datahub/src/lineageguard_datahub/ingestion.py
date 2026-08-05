from __future__ import annotations

import hashlib
import json
import os
import shutil
import stat
import tempfile
from collections.abc import Iterator, Mapping, Sequence
from contextlib import contextmanager
from dataclasses import dataclass
from pathlib import Path
from typing import Protocol

from lineageguard_datahub.config import DataHubConfig, PostgresConfig
from lineageguard_datahub.paths import read_bounded_bytes, read_checked_bytes
from lineageguard_datahub.provenance import (
    latest_warehouse_receipt,
    receipt_has_registry_binding,
)
from lineageguard_datahub.receipts import (
    LIVE_RECONCILIATION_KINDS,
    ExactOperationIdentity,
    MetricValue,
    OperationReceipt,
    ReceiptStatus,
    ResolvedOperationReceipt,
    receipt_append_index,
    resolve_latest_exact_operation,
)

RECIPE_DIGESTS = {
    "walkthrough/metadata/postgres-ingestion.yml": (
        "489acdca9c293b77938f4a8e313b78e5254cb1fe85881a39cfcc14eb863742f1"
    ),
    "walkthrough/metadata/dbt-ingestion.yml": (
        "53d74a2f471bc2561b604bb60141729370cba1ce8dc0d9c84e05f9f1e5a605eb"
    ),
}
REQUIRED_POSTGRES_RECIPE_TEXT = (
    "${WALKTHROUGH_INGEST_POSTGRES_USER}",
    "${WALKTHROUGH_INGEST_POSTGRES_PASSWORD}",
    "${WALKTHROUGH_POSTGRES_SSLMODE}",
    "^commerce\\\\.orders$",
    "^analytics\\\\.stg_orders$",
    "^analytics\\\\.customer_revenue$",
    "^fraud\\\\.customer_features$",
    "include_usage_statistics: false",
    "include_query_lineage: false",
    "include_view_lineage: false",
    "include_view_column_lineage: false",
    "include_table_location_lineage: false",
)
DBT_ARTIFACT_PATHS = (
    "walkthrough/dbt/target/manifest.json",
    "walkthrough/dbt/target/run_results.json",
    "walkthrough/dbt/target/catalog.json",
)
DBT_PROJECT_FILE_DIGESTS = {
    "walkthrough/dbt/dbt_project.yml": (
        "1ff26501b29f9b4a61dbf22c9e053f37a6179c4cffc312a7ccf84be8a6f669bf"
    ),
    "walkthrough/dbt/profiles.yml": (
        "02f15f0e160a7f90fa15ae78b94e08387084d3b33fcbcf50389691257fd4f310"
    ),
    "walkthrough/dbt/macros/generate_schema_name.sql": (
        "22607c6620333fa1d6e023e3f0bf9ae5122e751f9d1d1535fde25eb624a63656"
    ),
    "walkthrough/dbt/macros/grant_canonical_readers.sql": (
        "4c0673811226795d50ea6feeeff78c46d225a148bdc2d4fd8e963ed8cf9da5b0"
    ),
    "walkthrough/dbt/models/staging/stg_orders.sql": (
        "11fa44ec156f88ee6a9e6b2165df703daa951d85a7747c7256e12d95dd317f49"
    ),
    "walkthrough/dbt/models/staging/stg_orders.yml": (
        "66785862d2089d625b6909ed0552ded8fd3c8dfafbcfe4181768449a23f383e1"
    ),
    "walkthrough/dbt/models/analytics/customer_revenue.sql": (
        "852d66d766e19cf69db53bc381e0036d8b10f2a0db4881c7901db1b9b5d2d681"
    ),
    "walkthrough/dbt/models/analytics/customer_revenue.yml": (
        "b6b86f1dece5a338e8760a44b3a3d5b53afd415b85503d34128d155134efc618"
    ),
    "walkthrough/dbt/models/fraud/customer_features.sql": (
        "cc1ce0e796d965a43274383baee894f639e50443301c0cfb5e3714f9208f1103"
    ),
    "walkthrough/dbt/models/fraud/customer_features.yml": (
        "61de45947770609f7137d155de42dcbf9ae78ca831195f038bf82bed5059e4fe"
    ),
}
ARTIFACT_METRIC_KEYS = {
    DBT_ARTIFACT_PATHS[0]: "dbtManifestSha256",
    DBT_ARTIFACT_PATHS[1]: "dbtRunResultsSha256",
    DBT_ARTIFACT_PATHS[2]: "dbtCatalogSha256",
}
CANONICAL_DBT_NODES = {
    "model.lineageguard_walkthrough.stg_orders",
    "model.lineageguard_walkthrough.customer_revenue",
    "model.lineageguard_walkthrough.customer_features",
}
CANONICAL_DBT_RELATIONS = {
    "model.lineageguard_walkthrough.stg_orders": (
        "lineageguard",
        "analytics",
        "stg_orders",
    ),
    "model.lineageguard_walkthrough.customer_revenue": (
        "lineageguard",
        "analytics",
        "customer_revenue",
    ),
    "model.lineageguard_walkthrough.customer_features": (
        "lineageguard",
        "fraud",
        "customer_features",
    ),
}
RUNTIME_ENV = ("PATH", "LANG", "LC_ALL", "SSL_CERT_FILE", "REQUESTS_CA_BUNDLE")
DBT_BUILD_COMMAND_FINGERPRINT = hashlib.sha256(
    b"dbt-build-v1|build|canonical-project|fresh-target|no-partial-parse"
).hexdigest()
DBT_DOCS_COMMAND_FINGERPRINT = hashlib.sha256(
    b"dbt-build-v1|docs-generate|canonical-project|same-fresh-target|no-partial-parse"
).hexdigest()
DBT_ARTIFACT_VERIFICATION_FINGERPRINT = hashlib.sha256(
    b"dbt-build-v1|verify-and-publish|manifest|run-results|catalog"
).hexdigest()


class IngestionCursor(Protocol):
    def execute(self, query: str) -> object: ...
    def fetchone(self) -> Sequence[object] | None: ...


@dataclass(frozen=True, slots=True)
class IngestionRecipe:
    path: Path
    relative_path: str
    sha256: str
    content: bytes


@dataclass(frozen=True, slots=True)
class DbtArtifact:
    relative_path: str
    sha256: str
    content: bytes


@dataclass(frozen=True, slots=True)
class ProtectedIngestionSnapshot:
    root: Path
    fingerprint: str

    def path_for(self, relative_path: str) -> Path:
        return self.root / relative_path


@dataclass(frozen=True, slots=True)
class ProtectedDbtProjectSnapshot:
    root: Path
    project_dir: Path
    fingerprint: str


def build_ingestion_plan(root: Path) -> tuple[IngestionRecipe, ...]:
    recipes: list[IngestionRecipe] = []
    for relative, digest in RECIPE_DIGESTS.items():
        checked = read_checked_bytes(root, relative, digest, maximum_bytes=32 * 1024)
        try:
            text = checked.content.decode("utf-8")
        except UnicodeDecodeError as error:
            raise ValueError(f"INGEST_RECIPE_ENCODING_INVALID:{relative}") from error
        if "${DATAHUB_GMS_URL}" not in text or "${DATAHUB_INGEST_TOKEN}" not in text:
            raise ValueError("INGEST_RECIPE_TARGET_PLACEHOLDERS_MISSING")
        if Path(relative).name == "postgres-ingestion.yml" and not all(
            marker in text for marker in REQUIRED_POSTGRES_RECIPE_TEXT
        ):
            raise ValueError("POSTGRES_RECIPE_SCOPE_MISMATCH")
        recipes.append(
            IngestionRecipe(root.resolve() / relative, relative, digest, checked.content)
        )
    return tuple(recipes)


def verify_dbt_ingestion_artifacts(root: Path) -> tuple[DbtArtifact, ...]:
    artifacts: list[DbtArtifact] = []
    payloads: dict[str, object] = {}
    for relative in DBT_ARTIFACT_PATHS:
        try:
            captured = read_bounded_bytes(root, relative, maximum_bytes=16 * 1024 * 1024)
        except FileNotFoundError as error:
            raise ValueError(f"DBT_ARTIFACT_MISSING:{relative}") from error
        except ValueError as error:
            code = str(error)
            if code == "CHECKED_PATH_SYMLINK_DENIED":
                raise ValueError(f"DBT_ARTIFACT_SYMLINK_DENIED:{relative}") from error
            raise ValueError(f"DBT_ARTIFACT_INVALID:{relative}:{code}") from error
        try:
            payloads[relative] = json.loads(captured.content)
        except (UnicodeDecodeError, json.JSONDecodeError) as error:
            raise ValueError(f"DBT_ARTIFACT_INVALID:{relative}") from error
        artifacts.append(DbtArtifact(relative, captured.sha256, captured.content))
    manifest = payloads[DBT_ARTIFACT_PATHS[0]]
    run_results = payloads[DBT_ARTIFACT_PATHS[1]]
    catalog = payloads[DBT_ARTIFACT_PATHS[2]]
    if not isinstance(manifest, dict) or not isinstance(manifest.get("nodes"), dict):
        raise ValueError("DBT_MANIFEST_INVALID")
    manifest_nodes = set(manifest["nodes"])
    if not manifest_nodes >= CANONICAL_DBT_NODES:
        raise ValueError("DBT_MANIFEST_CANONICAL_NODES_MISSING")
    for unique_id, expected_relation in CANONICAL_DBT_RELATIONS.items():
        node = manifest["nodes"][unique_id]
        if (
            not isinstance(node, dict)
            or (
                node.get("database"),
                node.get("schema"),
                node.get("alias"),
            )
            != expected_relation
        ):
            raise ValueError(f"DBT_MANIFEST_RELATION_MISMATCH:{unique_id}")
    if not isinstance(run_results, dict) or not isinstance(run_results.get("results"), list):
        raise ValueError("DBT_RUN_RESULTS_INVALID")
    successful = {
        item.get("unique_id")
        for item in run_results["results"]
        if isinstance(item, dict) and item.get("status") in {"success", "pass"}
    }
    if not successful >= CANONICAL_DBT_NODES:
        raise ValueError("DBT_RUN_RESULTS_CANONICAL_SUCCESS_MISSING")
    if not isinstance(catalog, dict) or not isinstance(catalog.get("nodes"), dict):
        raise ValueError("DBT_CATALOG_INVALID")
    if not set(catalog["nodes"]) >= CANONICAL_DBT_NODES:
        raise ValueError("DBT_CATALOG_CANONICAL_NODES_MISSING")
    return tuple(artifacts)


def dbt_project_fingerprint(root: Path) -> str:
    for relative, digest in DBT_PROJECT_FILE_DIGESTS.items():
        read_checked_bytes(root, relative, digest, maximum_bytes=256 * 1024)
    payload = "\n".join(
        f"{relative}:{digest}" for relative, digest in DBT_PROJECT_FILE_DIGESTS.items()
    )
    return hashlib.sha256(payload.encode()).hexdigest()


def dbt_artifact_metrics(artifacts: tuple[DbtArtifact, ...]) -> dict[str, MetricValue]:
    by_path = {artifact.relative_path: artifact for artifact in artifacts}
    if set(by_path) != set(DBT_ARTIFACT_PATHS):
        raise ValueError("DBT_ARTIFACT_SET_MISMATCH")
    metrics: dict[str, MetricValue] = {
        ARTIFACT_METRIC_KEYS[relative]: by_path[relative].sha256 for relative in DBT_ARTIFACT_PATHS
    }
    payload = "\n".join(f"{relative}:{by_path[relative].sha256}" for relative in DBT_ARTIFACT_PATHS)
    metrics["dbtArtifactSetFingerprint"] = hashlib.sha256(payload.encode()).hexdigest()
    return metrics


def ingestion_snapshot_fingerprint(
    recipes: tuple[IngestionRecipe, ...], artifacts: tuple[DbtArtifact, ...]
) -> str:
    payload = [
        *(f"{item.relative_path}:{item.sha256}" for item in recipes),
        *(f"{item.relative_path}:{item.sha256}" for item in artifacts),
    ]
    return hashlib.sha256("\n".join(payload).encode()).hexdigest()


def _write_private_file(root: Path, relative_path: str, content: bytes) -> None:
    destination = root / relative_path
    destination.parent.mkdir(mode=0o700, parents=True, exist_ok=True)
    current = root
    for part in Path(relative_path).parts[:-1]:
        current /= part
        if current.is_symlink() or current.stat().st_uid != os.getuid():
            raise ValueError("INGEST_SNAPSHOT_PARENT_UNSAFE")
        os.chmod(current, 0o700)
    descriptor = os.open(
        destination,
        os.O_WRONLY
        | os.O_CREAT
        | os.O_EXCL
        | getattr(os, "O_NOFOLLOW", 0)
        | getattr(os, "O_CLOEXEC", 0),
        0o600,
    )
    with os.fdopen(descriptor, "wb") as stream:
        stream.write(content)
        stream.flush()
        os.fsync(stream.fileno())
    info = destination.stat()
    if info.st_uid != os.getuid() or stat.S_IMODE(info.st_mode) != 0o600:
        raise ValueError("INGEST_SNAPSHOT_FILE_UNSAFE")


@contextmanager
def protected_ingestion_snapshot(
    state_parent: Path,
    recipes: tuple[IngestionRecipe, ...],
    artifacts: tuple[DbtArtifact, ...],
) -> Iterator[ProtectedIngestionSnapshot]:
    state_parent.mkdir(mode=0o700, parents=True, exist_ok=True)
    if state_parent.is_symlink() or state_parent.stat().st_uid != os.getuid():
        raise ValueError("INGEST_SNAPSHOT_STATE_UNSAFE")
    os.chmod(state_parent, 0o700)
    snapshot_root = Path(tempfile.mkdtemp(prefix="ingestion-snapshot-", dir=state_parent))
    os.chmod(snapshot_root, 0o700)
    try:
        for asset in recipes:
            _write_private_file(snapshot_root, asset.relative_path, asset.content)
        for artifact in artifacts:
            _write_private_file(snapshot_root, artifact.relative_path, artifact.content)
        fingerprint = ingestion_snapshot_fingerprint(recipes, artifacts)
        for asset in recipes:
            read_checked_bytes(
                snapshot_root,
                asset.relative_path,
                asset.sha256,
                maximum_bytes=16 * 1024 * 1024,
            )
        for artifact in artifacts:
            read_checked_bytes(
                snapshot_root,
                artifact.relative_path,
                artifact.sha256,
                maximum_bytes=16 * 1024 * 1024,
            )
        yield ProtectedIngestionSnapshot(snapshot_root, fingerprint)
    finally:
        resolved_parent = state_parent.resolve()
        resolved_snapshot = snapshot_root.resolve()
        if (
            resolved_snapshot.parent != resolved_parent
            or not resolved_snapshot.name.startswith("ingestion-snapshot-")
            or snapshot_root.is_symlink()
            or snapshot_root.stat().st_uid != os.getuid()
        ):
            raise ValueError("INGEST_SNAPSHOT_CLEANUP_REFUSED")
        shutil.rmtree(resolved_snapshot)


@contextmanager
def protected_dbt_project_snapshot(
    state_parent: Path, repository: Path
) -> Iterator[ProtectedDbtProjectSnapshot]:
    state_parent.mkdir(mode=0o700, parents=True, exist_ok=True)
    if state_parent.is_symlink() or state_parent.stat().st_uid != os.getuid():
        raise ValueError("DBT_SNAPSHOT_STATE_UNSAFE")
    os.chmod(state_parent, 0o700)
    snapshot_root = Path(tempfile.mkdtemp(prefix="dbt-project-snapshot-", dir=state_parent))
    os.chmod(snapshot_root, 0o700)
    try:
        for relative, digest in DBT_PROJECT_FILE_DIGESTS.items():
            checked = read_checked_bytes(repository, relative, digest, maximum_bytes=256 * 1024)
            _write_private_file(snapshot_root, relative, checked.content)
        fingerprint = dbt_project_fingerprint(repository)
        project_dir = snapshot_root / "walkthrough/dbt"
        yield ProtectedDbtProjectSnapshot(snapshot_root, project_dir, fingerprint)
    finally:
        resolved_parent = state_parent.resolve()
        resolved_snapshot = snapshot_root.resolve()
        if (
            resolved_snapshot.parent != resolved_parent
            or not resolved_snapshot.name.startswith("dbt-project-snapshot-")
            or snapshot_root.is_symlink()
            or snapshot_root.stat().st_uid != os.getuid()
        ):
            raise ValueError("DBT_SNAPSHOT_CLEANUP_REFUSED")
        shutil.rmtree(resolved_snapshot)


def ingestion_prerequisite_failures(
    receipts: tuple[OperationReceipt, ...],
    *,
    scenario_id: str,
    ownership_nonce: str,
    warehouse_target_fingerprint: str,
    target_attestation: str,
    target_fingerprint: str,
    dbt_project_sha256: str,
    artifact_metrics: Mapping[str, MetricValue],
    snapshot_fingerprint: str,
    query_fingerprint: str,
    require_seed_after: bool = False,
) -> tuple[str, ...]:
    failures: list[str] = []
    latest_by_identity: dict[tuple[str, str | None, str | None, str], OperationReceipt] = {}
    for receipt in receipts:
        if receipt.scenario_id == scenario_id:
            latest_by_identity[
                (
                    receipt.operation_kind,
                    receipt.entity_urn,
                    receipt.aspect_name,
                    receipt.idempotency_key,
                )
            ] = receipt
    unresolved = [
        receipt
        for receipt in latest_by_identity.values()
        if receipt.operation_kind in LIVE_RECONCILIATION_KINDS
        and receipt.status
        in {
            ReceiptStatus.PLANNED,
            ReceiptStatus.FAILURE,
            ReceiptStatus.RECONCILIATION_REQUIRED,
        }
    ]
    if unresolved:
        identities = ",".join(
            sorted(
                f"{item.operation_kind}:{item.entity_urn or '-'}:{item.aspect_name or '-'}"
                for item in unresolved
            )
        )
        failures.append(f"SCENARIO_RECONCILIATION_REQUIRED:{identities}")
    try:
        warehouse = latest_warehouse_receipt(
            receipts,
            scenario_id=scenario_id,
            ownership_nonce=ownership_nonce,
            warehouse_target_fingerprint=warehouse_target_fingerprint,
        )
        warehouse_index = receipt_append_index(receipts, warehouse)
    except ValueError as error:
        failures.append(str(error))
        warehouse_index = -1
    dbt_index = -1
    try:
        dbt_operation = require_dbt_build_provenance(
            receipts,
            scenario_id=scenario_id,
            ownership_nonce=ownership_nonce,
            warehouse_target_fingerprint=warehouse_target_fingerprint,
            dbt_project_sha256=dbt_project_sha256,
            artifact_metrics=artifact_metrics,
        )
        dbt_index = dbt_operation.index
    except ValueError as error:
        failure = str(error)
        if failure not in failures:
            failures.append(failure)
    query_index = -1
    try:
        query_operation = resolve_latest_exact_operation(
            receipts,
            ExactOperationIdentity(
                scenario_id=scenario_id,
                operation_kind="query",
                entity_urn=None,
                aspect_name="pg_stat_statements",
                idempotency_key=query_fingerprint,
                proposal_hash=query_fingerprint,
            ),
            expected_outcomes=frozenset({(ReceiptStatus.SUCCESS, "PG_STAT_OBSERVED")}),
            error_prefix="PG_STAT_RECEIPT",
        )
        query_index = query_operation.index
        if not receipt_has_registry_binding(
            query_operation.receipt,
            ownership_nonce=ownership_nonce,
            warehouse_target_fingerprint=warehouse_target_fingerprint,
        ):
            failures.append("PG_STAT_RECEIPT_BINDING_INVALID")
        if dbt_index < 0 or query_index <= dbt_index:
            failures.append("PG_STAT_RECEIPT_PRECEDES_CURRENT_DBT_ARTIFACTS")
    except ValueError as error:
        failures.append(
            "PG_STAT_RECEIPT_MISSING"
            if str(error).endswith("_MISSING")
            else "PG_STAT_RECEIPT_NOT_CURRENT"
        )
    success_indexes: dict[str, int] = {}
    for relative, digest in RECIPE_DIGESTS.items():
        candidates = [
            (index, receipt)
            for index, receipt in enumerate(receipts)
            if receipt.scenario_id == scenario_id
            and receipt.operation_kind == "ingest"
            and receipt.aspect_name == relative
        ]
        if not candidates:
            failures.append(f"INGEST_PREREQUISITE_MISSING:{relative}")
            continue
        _, latest_any = candidates[-1]
        if latest_any.idempotency_key != digest or latest_any.proposal_hash != digest:
            failures.append(f"INGEST_PREREQUISITE_DIGEST_MISMATCH:{relative}")
            continue
        try:
            resolved = resolve_latest_exact_operation(
                receipts,
                ExactOperationIdentity(
                    scenario_id=scenario_id,
                    operation_kind="ingest",
                    entity_urn=None,
                    aspect_name=relative,
                    idempotency_key=digest,
                    proposal_hash=digest,
                ),
                expected_outcomes=frozenset({(ReceiptStatus.SUCCESS, "INGESTED")}),
                error_prefix="INGEST_PREREQUISITE",
            )
        except ValueError:
            failures.append(f"INGEST_PREREQUISITE_NOT_CURRENT:{relative}")
            continue
        index, latest = resolved.index, resolved.receipt
        if (
            latest.metrics.get("targetAttestation") != target_attestation
            or latest.metrics.get("targetFingerprint") != target_fingerprint
        ):
            failures.append(f"INGEST_PREREQUISITE_TARGET_MISMATCH:{relative}")
            continue
        expected_metrics = dict(artifact_metrics) | {
            "dbtProjectFingerprint": dbt_project_sha256,
            "ingestionSnapshotFingerprint": snapshot_fingerprint,
        }
        if not receipt_has_registry_binding(
            latest,
            ownership_nonce=ownership_nonce,
            warehouse_target_fingerprint=warehouse_target_fingerprint,
        ) or any(latest.metrics.get(key) != value for key, value in expected_metrics.items()):
            failures.append(f"INGEST_PREREQUISITE_PROVENANCE_MISMATCH:{relative}")
            continue
        success_indexes[relative] = index
    postgres_path, dbt_path = RECIPE_DIGESTS
    if postgres_path in success_indexes and (
        query_index < 0 or success_indexes[postgres_path] <= query_index
    ):
        failures.append("POSTGRES_INGEST_PRECEDES_QUERY")
    if (
        postgres_path in success_indexes
        and dbt_path in success_indexes
        and success_indexes[postgres_path] >= success_indexes[dbt_path]
    ):
        failures.append("INGEST_PREREQUISITE_ORDER_INVALID")
    if success_indexes and (
        warehouse_index < 0
        or dbt_index < 0
        or warehouse_index >= dbt_index
        or dbt_index >= min(success_indexes.values())
    ):
        failures.append("INGEST_PREREQUISITE_PROVENANCE_ORDER_INVALID")
    if require_seed_after and len(success_indexes) == len(RECIPE_DIGESTS):
        latest_ingest = max(success_indexes.values())
        seed_successes = [
            (index, receipt)
            for index, receipt in enumerate(receipts)
            if receipt.scenario_id == scenario_id
            and receipt.operation_kind == "seed"
            and receipt.status in {ReceiptStatus.SUCCESS, ReceiptStatus.SKIPPED}
            and receipt.metrics.get("targetAttestation") == target_attestation
            and receipt.metrics.get("targetFingerprint") == target_fingerprint
            and receipt_has_registry_binding(
                receipt,
                ownership_nonce=ownership_nonce,
                warehouse_target_fingerprint=warehouse_target_fingerprint,
            )
        ]
        if not seed_successes:
            failures.append("METADATA_SEED_RECEIPT_MISSING")
        elif max(index for index, _ in seed_successes) <= latest_ingest:
            failures.append("METADATA_SEED_ORDER_INVALID")
    return tuple(failures)


def require_dbt_build_provenance(
    receipts: tuple[OperationReceipt, ...],
    *,
    scenario_id: str,
    ownership_nonce: str,
    warehouse_target_fingerprint: str,
    dbt_project_sha256: str,
    artifact_metrics: Mapping[str, MetricValue],
) -> ResolvedOperationReceipt:
    expected = dict(artifact_metrics) | {"dbtProjectFingerprint": dbt_project_sha256}
    try:
        artifact = resolve_latest_exact_operation(
            receipts,
            ExactOperationIdentity(
                scenario_id=scenario_id,
                operation_kind="dbt-build",
                entity_urn=None,
                aspect_name="artifact-set",
                idempotency_key=DBT_ARTIFACT_VERIFICATION_FINGERPRINT,
                proposal_hash=dbt_project_sha256,
            ),
            expected_outcomes=frozenset({(ReceiptStatus.SUCCESS, "DBT_ARTIFACTS_VERIFIED")}),
            error_prefix="DBT_BUILD_RECEIPT",
        )
    except ValueError as error:
        code = str(error)
        if code.endswith("_MISSING"):
            raise ValueError("DBT_BUILD_RECEIPT_REQUIRED") from error
        raise ValueError("DBT_BUILD_RECEIPT_NOT_CURRENT") from error
    artifact_index = artifact.index
    artifact_receipt = artifact.receipt
    if not receipt_has_registry_binding(
        artifact_receipt,
        ownership_nonce=ownership_nonce,
        warehouse_target_fingerprint=warehouse_target_fingerprint,
    ) or any(artifact_receipt.metrics.get(key) != value for key, value in expected.items()):
        raise ValueError("DBT_BUILD_RECEIPT_BINDING_MISMATCH")
    latest_dbt_index = max(
        index
        for index, receipt in enumerate(receipts)
        if receipt.scenario_id == scenario_id and receipt.operation_kind == "dbt-build"
    )
    if latest_dbt_index != artifact_index:
        raise ValueError("DBT_BUILD_RECEIPT_NOT_CURRENT")
    indexes: dict[str, int] = {}
    for aspect, digest in (
        ("build", DBT_BUILD_COMMAND_FINGERPRINT),
        ("docs-generate", DBT_DOCS_COMMAND_FINGERPRINT),
    ):
        try:
            command = resolve_latest_exact_operation(
                receipts,
                ExactOperationIdentity(
                    scenario_id=scenario_id,
                    operation_kind="dbt-build",
                    entity_urn=None,
                    aspect_name=aspect,
                    idempotency_key=digest,
                    proposal_hash=dbt_project_sha256,
                ),
                expected_outcomes=frozenset({(ReceiptStatus.SUCCESS, "DBT_COMMAND_SUCCEEDED")}),
                error_prefix="DBT_COMMAND_RECEIPT",
            )
        except ValueError as error:
            if str(error).endswith("_MISSING"):
                raise ValueError(f"DBT_COMMAND_RECEIPT_REQUIRED:{aspect}") from error
            raise ValueError(f"DBT_COMMAND_RECEIPT_NOT_CURRENT:{aspect}") from error
        if command.index >= artifact_index or not receipt_has_registry_binding(
            command.receipt,
            ownership_nonce=ownership_nonce,
            warehouse_target_fingerprint=warehouse_target_fingerprint,
        ):
            raise ValueError(f"DBT_COMMAND_RECEIPT_NOT_CURRENT:{aspect}")
        indexes[aspect] = command.index
    if indexes["build"] >= indexes["docs-generate"]:
        raise ValueError("DBT_COMMAND_ORDER_INVALID")
    warehouse = latest_warehouse_receipt(
        receipts,
        scenario_id=scenario_id,
        ownership_nonce=ownership_nonce,
        warehouse_target_fingerprint=warehouse_target_fingerprint,
    )
    if receipt_append_index(receipts, warehouse) >= indexes["build"]:
        raise ValueError("DBT_WAREHOUSE_ORDER_INVALID")
    return artifact


def require_ingestion_prerequisites(
    receipts: tuple[OperationReceipt, ...],
    *,
    scenario_id: str,
    ownership_nonce: str,
    warehouse_target_fingerprint: str,
    target_attestation: str,
    target_fingerprint: str,
    dbt_project_sha256: str,
    artifact_metrics: Mapping[str, MetricValue],
    snapshot_fingerprint: str,
    query_fingerprint: str,
) -> None:
    failures = ingestion_prerequisite_failures(
        receipts,
        scenario_id=scenario_id,
        ownership_nonce=ownership_nonce,
        warehouse_target_fingerprint=warehouse_target_fingerprint,
        target_attestation=target_attestation,
        target_fingerprint=target_fingerprint,
        dbt_project_sha256=dbt_project_sha256,
        artifact_metrics=artifact_metrics,
        snapshot_fingerprint=snapshot_fingerprint,
        query_fingerprint=query_fingerprint,
    )
    if failures:
        raise ValueError(";".join(failures))


def ingestion_environment(
    datahub: DataHubConfig,
    postgres: PostgresConfig,
    environ: dict[str, str] | None = None,
) -> dict[str, str]:
    values = os.environ if environ is None else environ
    if datahub.credential_kind != "ingest" or postgres.credential_kind != "ingest":
        raise ValueError("INGEST_CREDENTIAL_PURPOSE_MISMATCH")
    child = {key: values[key] for key in RUNTIME_ENV if key in values}
    child.update(
        {
            "DATAHUB_GMS_URL": datahub.server,
            "DATAHUB_INGEST_TOKEN": datahub.token or "",
            "WALKTHROUGH_POSTGRES_HOST": postgres.host,
            "WALKTHROUGH_POSTGRES_PORT": str(postgres.port),
            "WALKTHROUGH_POSTGRES_DATABASE": postgres.database,
            "WALKTHROUGH_POSTGRES_SSLMODE": postgres.sslmode,
            "WALKTHROUGH_INGEST_POSTGRES_USER": postgres.user,
            "WALKTHROUGH_INGEST_POSTGRES_PASSWORD": postgres.password,
        }
    )
    return child


def dbt_environment(
    postgres: PostgresConfig, environ: dict[str, str] | None = None
) -> dict[str, str]:
    values = os.environ if environ is None else environ
    if postgres.credential_kind != "dbt":
        raise ValueError("DBT_CREDENTIAL_PURPOSE_MISMATCH")
    child = {key: values[key] for key in RUNTIME_ENV if key in values}
    child.update(
        {
            "WALKTHROUGH_POSTGRES_HOST": postgres.host,
            "WALKTHROUGH_POSTGRES_PORT": str(postgres.port),
            "WALKTHROUGH_POSTGRES_DATABASE": postgres.database,
            "WALKTHROUGH_POSTGRES_SSLMODE": postgres.sslmode,
            "WALKTHROUGH_DBT_POSTGRES_USER": postgres.user,
            "WALKTHROUGH_DBT_POSTGRES_PASSWORD": postgres.password,
        }
    )
    return child


def publish_dbt_artifacts(root: Path, artifacts: tuple[DbtArtifact, ...]) -> None:
    target = root.resolve() / "walkthrough/dbt/target"
    target.mkdir(mode=0o700, parents=True, exist_ok=True)
    if target.is_symlink() or target.stat().st_uid != os.getuid():
        raise ValueError("DBT_TARGET_UNSAFE")
    os.chmod(target, 0o700)
    for artifact in artifacts:
        destination = target / Path(artifact.relative_path).name
        if destination.is_symlink():
            raise ValueError(f"DBT_TARGET_SYMLINK_DENIED:{destination.name}")
        descriptor, temporary = tempfile.mkstemp(prefix=".publish-", dir=target)
        try:
            os.fchmod(descriptor, 0o600)
            with os.fdopen(descriptor, "wb") as stream:
                stream.write(artifact.content)
                stream.flush()
                os.fsync(stream.fileno())
            os.replace(temporary, destination)
        finally:
            temporary_path = Path(temporary)
            if temporary_path.exists():
                temporary_path.unlink()


def verify_ingestion_role(cursor: IngestionCursor) -> None:
    cursor.execute("SET LOCAL TRANSACTION READ ONLY")
    select_checks = ", ".join(
        f"has_table_privilege(current_user, '{relation}', 'SELECT')"
        for relation in (
            "commerce.orders",
            "analytics.stg_orders",
            "analytics.customer_revenue",
            "fraud.customer_features",
        )
    )
    write_checks = ", ".join(
        f"NOT COALESCE(has_table_privilege(current_user, '{relation}', "
        "'INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER'), false)"
        for relation in (
            "commerce.orders",
            "analytics.stg_orders",
            "analytics.customer_revenue",
            "fraud.customer_features",
        )
    )
    cursor.execute(
        "SELECT current_user = 'lineageguard_ingest', "
        "current_setting('transaction_read_only') = 'on', NOT rolsuper, NOT rolcreatedb, "
        "NOT rolcreaterole, NOT rolreplication, "
        "pg_has_role(current_user, 'lineageguard_ingest_reader', 'MEMBER'), "
        "NOT pg_has_role(current_user, 'pg_read_all_stats', 'MEMBER'), "
        f"{select_checks}, {write_checks} FROM pg_roles WHERE rolname = current_user"
    )
    result = cursor.fetchone()
    if result is None or len(result) != 16 or not all(value is True for value in result):
        raise ValueError("INGEST_POSTGRES_ROLE_NOT_READ_ONLY")
