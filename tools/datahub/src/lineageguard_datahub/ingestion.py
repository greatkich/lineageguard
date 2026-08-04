from __future__ import annotations

import json
import os
from collections.abc import Sequence
from dataclasses import dataclass
from pathlib import Path
from typing import Protocol

from lineageguard_datahub.config import DataHubConfig, PostgresConfig
from lineageguard_datahub.paths import resolve_checked_file
from lineageguard_datahub.receipts import OperationReceipt, ReceiptStatus

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


class IngestionCursor(Protocol):
    def execute(self, query: str) -> object: ...
    def fetchone(self) -> Sequence[object] | None: ...


@dataclass(frozen=True, slots=True)
class IngestionRecipe:
    path: Path
    relative_path: str
    sha256: str


def build_ingestion_plan(root: Path) -> tuple[IngestionRecipe, ...]:
    recipes: list[IngestionRecipe] = []
    for relative, digest in RECIPE_DIGESTS.items():
        path = resolve_checked_file(root, relative, digest, maximum_bytes=32 * 1024)
        text = path.read_text(encoding="utf-8")
        if "${DATAHUB_GMS_URL}" not in text or "${DATAHUB_INGEST_TOKEN}" not in text:
            raise ValueError("INGEST_RECIPE_TARGET_PLACEHOLDERS_MISSING")
        if path.name == "postgres-ingestion.yml" and not all(
            marker in text for marker in REQUIRED_POSTGRES_RECIPE_TEXT
        ):
            raise ValueError("POSTGRES_RECIPE_SCOPE_MISMATCH")
        recipes.append(IngestionRecipe(path, relative, digest))
    return tuple(recipes)


def verify_dbt_ingestion_artifacts(root: Path) -> tuple[Path, ...]:
    artifacts: list[Path] = []
    payloads: dict[str, object] = {}
    root = root.resolve()
    for relative in DBT_ARTIFACT_PATHS:
        path = root / relative
        current = root
        for part in Path(relative).parts:
            current /= part
            if current.is_symlink():
                raise ValueError(f"DBT_ARTIFACT_SYMLINK_DENIED:{relative}")
        try:
            resolved = path.resolve(strict=True)
        except FileNotFoundError as error:
            raise ValueError(f"DBT_ARTIFACT_MISSING:{relative}") from error
        if not resolved.is_relative_to(root) or not resolved.is_file():
            raise ValueError(f"DBT_ARTIFACT_PATH_INVALID:{relative}")
        if resolved.stat().st_size > 16 * 1024 * 1024:
            raise ValueError(f"DBT_ARTIFACT_TOO_LARGE:{relative}")
        try:
            payloads[relative] = json.loads(resolved.read_text(encoding="utf-8"))
        except (UnicodeDecodeError, json.JSONDecodeError) as error:
            raise ValueError(f"DBT_ARTIFACT_INVALID:{relative}") from error
        artifacts.append(resolved)
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


def ingestion_prerequisite_failures(
    receipts: tuple[OperationReceipt, ...],
    *,
    scenario_id: str,
    target_attestation: str,
    target_fingerprint: str,
    require_seed_after: bool = False,
) -> tuple[str, ...]:
    failures: list[str] = []
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
        index, latest = candidates[-1]
        if latest.status is not ReceiptStatus.SUCCESS or latest.detail_code != "INGESTED":
            failures.append(f"INGEST_PREREQUISITE_NOT_CURRENT:{relative}")
            continue
        if latest.idempotency_key != digest or latest.proposal_hash != digest:
            failures.append(f"INGEST_PREREQUISITE_DIGEST_MISMATCH:{relative}")
            continue
        if (
            latest.metrics.get("targetAttestation") != target_attestation
            or latest.metrics.get("targetFingerprint") != target_fingerprint
        ):
            failures.append(f"INGEST_PREREQUISITE_TARGET_MISMATCH:{relative}")
            continue
        success_indexes[relative] = index
    postgres_path, dbt_path = RECIPE_DIGESTS
    if (
        postgres_path in success_indexes
        and dbt_path in success_indexes
        and success_indexes[postgres_path] >= success_indexes[dbt_path]
    ):
        failures.append("INGEST_PREREQUISITE_ORDER_INVALID")
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
        ]
        if not seed_successes:
            failures.append("METADATA_SEED_RECEIPT_MISSING")
        elif max(index for index, _ in seed_successes) <= latest_ingest:
            failures.append("METADATA_SEED_ORDER_INVALID")
    return tuple(failures)


def require_ingestion_prerequisites(
    receipts: tuple[OperationReceipt, ...],
    *,
    scenario_id: str,
    target_attestation: str,
    target_fingerprint: str,
) -> None:
    failures = ingestion_prerequisite_failures(
        receipts,
        scenario_id=scenario_id,
        target_attestation=target_attestation,
        target_fingerprint=target_fingerprint,
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
        "pg_has_role(current_user, 'lineageguard_reader', 'MEMBER'), "
        f"{select_checks}, {write_checks} FROM pg_roles WHERE rolname = current_user"
    )
    result = cursor.fetchone()
    if result is None or len(result) != 15 or not all(value is True for value in result):
        raise ValueError("INGEST_POSTGRES_ROLE_NOT_READ_ONLY")
