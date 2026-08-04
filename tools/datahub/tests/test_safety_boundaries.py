from __future__ import annotations

import json
import os
from pathlib import Path

import pytest
from psycopg.sql import Composable

from lineageguard_datahub.config import load_datahub_config, load_postgres_config
from lineageguard_datahub.ingestion import (
    build_ingestion_plan,
    ingestion_environment,
    verify_ingestion_role,
)
from lineageguard_datahub.receipts import OperationReceipt, ReceiptStatus, ReceiptStore
from lineageguard_datahub.warehouse import (
    apply_warehouse_rows,
    apply_warehouse_seed,
    build_warehouse_seed_plan,
    verify_dbt_role,
)


class BootstrapCursor:
    def __init__(self, responses: list[object]) -> None:
        self.responses = responses
        self.commands: list[tuple[object, tuple[object, ...] | None]] = []

    def execute(self, query: object, params: tuple[object, ...] | None = None) -> object:
        self.commands.append((query, params))
        return self

    def fetchone(self) -> tuple[object]:
        return (self.responses.pop(0),)


class RoleCursor:
    def __init__(self, safe: bool = True) -> None:
        self.safe = safe
        self.commands: list[str] = []

    def execute(self, query: str) -> object:
        self.commands.append(query)
        return self

    def fetchone(self) -> tuple[bool, ...]:
        return (self.safe,) * 15


def _receipt(
    *, at: str = "2026-08-04T10:00:00+00:00", proposal: str = "a" * 64
) -> OperationReceipt:
    return OperationReceipt.create(
        scenario_id="canonical-customer-id-rename",
        operation_kind="seed",
        entity_urn="urn:li:tag:lineageguard-canonical.Critical",
        aspect_name="tagProperties",
        idempotency_key="a" * 64,
        proposal_hash=proposal,
        status=ReceiptStatus.SUCCESS,
        detail_code="ASPECT_EMITTED",
        recorded_at=at,
    )


def test_receipt_store_enforces_mode_chain_order_and_conflicts(tmp_path: Path) -> None:
    store = ReceiptStore(tmp_path / "state/operations.jsonl")
    store.append(_receipt())
    assert (store.path.stat().st_mode & 0o777) == 0o600
    assert (store.state_path.stat().st_mode & 0o777) == 0o600
    with pytest.raises(ValueError, match="TIMESTAMP_OUT_OF_ORDER"):
        store.append(_receipt(at="2026-08-04T09:00:00+00:00"))
    with pytest.raises(ValueError, match="DUPLICATE_CONFLICT"):
        store.append(_receipt(at="2026-08-04T11:00:00+00:00", proposal="b" * 64))
    payload = json.loads(store.path.read_text())
    payload["detail_code"] = "TAMPERED"
    store.path.write_text(json.dumps(payload) + "\n")
    os.chmod(store.path, 0o600)
    with pytest.raises(ValueError, match="RECEIPT_HASH_INVALID"):
        store.read_all()


def test_receipt_store_rejects_symlink_and_permissive_mode(tmp_path: Path) -> None:
    target = tmp_path / "target"
    target.write_text("")
    os.chmod(target, 0o600)
    link = tmp_path / "operations.jsonl"
    link.symlink_to(target)
    with pytest.raises(OSError):
        ReceiptStore(link).read_all()
    link.unlink()
    link.write_text("")
    os.chmod(link, 0o644)
    with pytest.raises(ValueError, match="MODE_MUST_BE_0600"):
        ReceiptStore(link).read_all()


def test_ingestion_environment_is_purpose_bound_and_minimal(repository_root: Path) -> None:
    environ = {
        "PATH": "/bin",
        "DATAHUB_GMS_URL": "http://127.0.0.1:8080",
        "DATAHUB_INGEST_TOKEN": "ingest-secret",
        "LINEAGEGUARD_DATAHUB_TARGET_ATTESTATION": "canonical-local-lineageguard-v1",
        "DATAHUB_READ_TOKEN": "read-secret",
        "DATAHUB_WRITE_TOKEN": "write-secret",
        "LINEAGEGUARD_POSTGRES_MODE": "local",
        "WALKTHROUGH_POSTGRES_HOST": "127.0.0.1",
        "WALKTHROUGH_POSTGRES_PORT": "5432",
        "WALKTHROUGH_POSTGRES_DATABASE": "lineageguard",
        "WALKTHROUGH_POSTGRES_SSLMODE": "disable",
        "WALKTHROUGH_INGEST_POSTGRES_USER": "lineageguard_ingest",
        "WALKTHROUGH_INGEST_POSTGRES_PASSWORD": "ingest-db-secret",
        "WALKTHROUGH_QUERY_POSTGRES_PASSWORD": "query-secret",
        "WALKTHROUGH_ADMIN_POSTGRES_PASSWORD": "admin-secret",
    }
    datahub = load_datahub_config(environ, ingest=True)
    postgres = load_postgres_config(environ, ingest_role=True)
    child = ingestion_environment(datahub, postgres, environ)
    assert build_ingestion_plan(repository_root)
    assert child["DATAHUB_INGEST_TOKEN"] == "ingest-secret"
    assert child["WALKTHROUGH_INGEST_POSTGRES_USER"] == "lineageguard_ingest"
    assert "DATAHUB_READ_TOKEN" not in child
    assert "DATAHUB_WRITE_TOKEN" not in child
    assert "WALKTHROUGH_QUERY_POSTGRES_PASSWORD" not in child
    assert "WALKTHROUGH_ADMIN_POSTGRES_PASSWORD" not in child
    cursor = RoleCursor()
    verify_ingestion_role(cursor)
    role_sql = cursor.commands[-1]
    for relation in (
        "commerce.orders",
        "analytics.stg_orders",
        "analytics.customer_revenue",
        "fraud.customer_features",
    ):
        assert relation in role_sql
    with pytest.raises(ValueError, match="ROLE_NOT_READ_ONLY"):
        verify_ingestion_role(RoleCursor(safe=False))


def test_recipe_and_sql_drift_or_symlink_is_rejected(repository_root: Path, tmp_path: Path) -> None:
    for relative in (
        "walkthrough/metadata/postgres-ingestion.yml",
        "walkthrough/metadata/dbt-ingestion.yml",
        "walkthrough/warehouse/init/001-schemas.sql",
        "walkthrough/warehouse/init/002-tables.sql",
        "walkthrough/warehouse/init/003-seed.sql",
    ):
        destination = tmp_path / relative
        destination.parent.mkdir(parents=True, exist_ok=True)
        destination.write_bytes((repository_root / relative).read_bytes())
    (tmp_path / "walkthrough/metadata/postgres-ingestion.yml").write_text("extra: table")
    with pytest.raises(ValueError, match="DIGEST_MISMATCH"):
        build_ingestion_plan(tmp_path)
    recipe = tmp_path / "walkthrough/metadata/postgres-ingestion.yml"
    recipe.unlink()
    recipe.symlink_to(repository_root / "walkthrough/metadata/postgres-ingestion.yml")
    with pytest.raises(ValueError, match="SYMLINK_DENIED"):
        build_ingestion_plan(tmp_path)
    sql = tmp_path / "walkthrough/warehouse/init/002-tables.sql"
    sql.write_text(sql.read_text() + "\nSELECT 1;")
    with pytest.raises(ValueError, match="DIGEST_MISMATCH"):
        build_warehouse_seed_plan(tmp_path)
    sql.unlink()
    sql.symlink_to(repository_root / "walkthrough/warehouse/init/002-tables.sql")
    with pytest.raises(ValueError, match="SYMLINK_DENIED"):
        build_warehouse_seed_plan(tmp_path)


def test_bootstrap_refuses_wrong_database_and_preexisting_schema(repository_root: Path) -> None:
    plan = build_warehouse_seed_plan(repository_root)
    with pytest.raises(ValueError, match="DATABASE_IDENTITY_MISMATCH"):
        apply_warehouse_seed(
            BootstrapCursor(["other"]),
            plan,
            ownership_nonce="nonce",
            query_password="query",
            ingest_password="ingest",
            seed_password="seed",
            dbt_password="dbt",
        )
    with pytest.raises(ValueError, match="PREEXISTING_OBJECTS"):
        apply_warehouse_seed(
            BootstrapCursor(["lineageguard", None, 1]),
            plan,
            ownership_nonce="nonce",
            query_password="query",
            ingest_password="ingest",
            seed_password="seed",
            dbt_password="dbt",
        )


def test_clean_bootstrap_provisions_distinct_login_members(repository_root: Path) -> None:
    cursor = BootstrapCursor(["lineageguard", None, 0, True, True, True, True])
    apply_warehouse_seed(
        cursor,
        build_warehouse_seed_plan(repository_root),
        ownership_nonce="nonce",
        query_password="query-password",
        ingest_password="ingest-password",
        seed_password="seed-password",
        dbt_password="dbt-password",
    )
    raw_sql = "\n".join(command for command, _ in cursor.commands if isinstance(command, str))
    assert "CREATE ROLE lineageguard_reader NOLOGIN" in raw_sql
    assert "CREATE ROLE lineageguard_query LOGIN" in raw_sql
    assert "CREATE ROLE lineageguard_ingest LOGIN" in raw_sql
    assert "CREATE ROLE lineageguard_seed LOGIN" in raw_sql
    assert "CREATE ROLE lineageguard_dbt LOGIN" in raw_sql
    assert "GRANT USAGE, CREATE ON SCHEMA analytics, fraud TO lineageguard_dbt" in raw_sql
    assert "GRANT SELECT ON commerce.orders TO lineageguard_dbt" in raw_sql
    assert "GRANT lineageguard_reader TO lineageguard_query" in raw_sql
    assert "GRANT lineageguard_reader TO lineageguard_ingest" in raw_sql
    secrets = ("query-password", "ingest-password", "seed-password", "dbt-password")
    assert all(secret not in raw_sql for secret in secrets)
    password_commands = [
        command for command, _ in cursor.commands if isinstance(command, Composable)
    ]
    assert len(password_commands) == 4
    verify_dbt_role(BootstrapCursor([True]))
    with pytest.raises(ValueError, match="DBT_POSTGRES_ROLE_UNSAFE"):
        verify_dbt_role(BootstrapCursor([False]))


def test_seed_rows_run_under_separate_owned_principal(repository_root: Path) -> None:
    plan = build_warehouse_seed_plan(repository_root)
    first = BootstrapCursor(["lineageguard", "nonce", 0])
    apply_warehouse_rows(first, plan, ownership_nonce="nonce")
    assert first.commands[-1][0] == plan.sql_paths[2].read_text()
    drifted = BootstrapCursor(["lineageguard", "nonce", 5, False])
    with pytest.raises(ValueError, match="SEED_CONTENT_MISMATCH"):
        apply_warehouse_rows(drifted, plan, ownership_nonce="nonce")
