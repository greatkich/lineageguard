from __future__ import annotations

import json
import os
import shutil
import stat
from dataclasses import replace
from pathlib import Path

import pytest
import yaml
from datahub.ingestion.source.sql.postgres import PostgresConfig
from support import (
    TARGET_ATTESTATION,
    TARGET_FINGERPRINT,
    WAREHOUSE_TARGET,
    append_build_provenance,
    append_ingestion_receipts,
    canonical_query_fingerprint,
    provenance_values,
)

from lineageguard_datahub.ingestion import (
    CANONICAL_DBT_NODES,
    CANONICAL_DBT_RELATIONS,
    DBT_ARTIFACT_PATHS,
    DBT_BUILD_COMMAND_FINGERPRINT,
    DBT_PROJECT_FILE_DIGESTS,
    RECIPE_DIGESTS,
    build_ingestion_plan,
    ingestion_prerequisite_failures,
    protected_dbt_project_snapshot,
    protected_ingestion_snapshot,
    verify_dbt_ingestion_artifacts,
)
from lineageguard_datahub.receipts import OperationReceipt, ReceiptStatus, ReceiptStore

SCENARIO = "canonical-customer-id-rename"


def test_ingestion_prerequisites_require_both_current_exact_ordered_receipts(
    repository_root: Path, tmp_path: Path
) -> None:
    store = ReceiptStore(tmp_path / "operations.jsonl")
    append_build_provenance(store, repository_root)
    append_ingestion_receipts(store, repository_root)
    valid = store.read_all()
    project, artifacts, snapshot = provenance_values(repository_root)
    kwargs = {
        "scenario_id": SCENARIO,
        "ownership_nonce": store.ownership_nonce,
        "warehouse_target_fingerprint": WAREHOUSE_TARGET,
        "target_attestation": TARGET_ATTESTATION,
        "target_fingerprint": TARGET_FINGERPRINT,
        "dbt_project_sha256": project,
        "artifact_metrics": artifacts,
        "snapshot_fingerprint": snapshot,
        "query_fingerprint": canonical_query_fingerprint(repository_root),
    }
    postgres, dbt = RECIPE_DIGESTS
    assert not ingestion_prerequisite_failures(valid, **kwargs)
    indexes = {item.aspect_name: index for index, item in enumerate(valid)}
    postgres_index = indexes[postgres]
    dbt_index = indexes[dbt]
    cases = (
        (tuple(item for item in valid if item.aspect_name != dbt), "INGEST_PREREQUISITE_MISSING"),
        (
            tuple(
                replace(item, status=ReceiptStatus.FAILURE, detail_code="EXIT_1")
                if index == dbt_index
                else item
                for index, item in enumerate(valid)
            ),
            "INGEST_PREREQUISITE_NOT_CURRENT",
        ),
        (
            tuple(
                replace(item, status=ReceiptStatus.PLANNED, detail_code="OPERATION_PLANNED")
                if index == dbt_index
                else item
                for index, item in enumerate(valid)
            ),
            "INGEST_PREREQUISITE_NOT_CURRENT",
        ),
        (
            tuple(
                replace(item, idempotency_key="a" * 64, proposal_hash="a" * 64)
                if index == dbt_index
                else item
                for index, item in enumerate(valid)
            ),
            "INGEST_PREREQUISITE_DIGEST_MISMATCH",
        ),
        (
            tuple(
                replace(item, metrics=item.metrics | {"targetFingerprint": "b" * 64})
                if index == dbt_index
                else item
                for index, item in enumerate(valid)
            ),
            "INGEST_PREREQUISITE_TARGET_MISMATCH",
        ),
        (
            tuple(
                valid[dbt_index]
                if index == postgres_index
                else valid[postgres_index]
                if index == dbt_index
                else item
                for index, item in enumerate(valid)
            ),
            "INGEST_PREREQUISITE_ORDER_INVALID",
        ),
    )
    for receipts, code in cases:
        failures = ingestion_prerequisite_failures(receipts, **kwargs)
        assert any(item.startswith(code) for item in failures)


def test_dbt_ingestion_requires_complete_successful_clean_target(tmp_path: Path) -> None:
    with pytest.raises(ValueError, match="DBT_ARTIFACT_MISSING"):
        verify_dbt_ingestion_artifacts(tmp_path)
    nodes = {
        node: {"database": relation[0], "schema": relation[1], "alias": relation[2]}
        for node, relation in CANONICAL_DBT_RELATIONS.items()
    }
    payloads = {
        DBT_ARTIFACT_PATHS[0]: {"nodes": nodes},
        DBT_ARTIFACT_PATHS[1]: {
            "results": [{"unique_id": node, "status": "success"} for node in CANONICAL_DBT_NODES]
        },
        DBT_ARTIFACT_PATHS[2]: {"nodes": nodes},
    }
    for relative, payload in payloads.items():
        path = tmp_path / relative
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(json.dumps(payload))
    assert (
        tuple(artifact.relative_path for artifact in verify_dbt_ingestion_artifacts(tmp_path))
        == DBT_ARTIFACT_PATHS
    )


def test_later_failed_warehouse_or_dbt_attempt_invalidates_old_provenance(
    repository_root: Path, tmp_path: Path
) -> None:
    store = ReceiptStore(tmp_path / "operations.jsonl")
    append_build_provenance(store, repository_root)
    append_ingestion_receipts(store, repository_root)
    valid = store.read_all()
    project, artifacts, snapshot = provenance_values(repository_root)
    kwargs = {
        "scenario_id": SCENARIO,
        "ownership_nonce": store.ownership_nonce,
        "warehouse_target_fingerprint": WAREHOUSE_TARGET,
        "target_attestation": TARGET_ATTESTATION,
        "target_fingerprint": TARGET_FINGERPRINT,
        "dbt_project_sha256": project,
        "artifact_metrics": artifacts,
        "snapshot_fingerprint": snapshot,
        "query_fingerprint": canonical_query_fingerprint(repository_root),
    }
    warehouse = next(item for item in valid if item.operation_kind == "warehouse")
    warehouse_failure = OperationReceipt.create(
        scenario_id=SCENARIO,
        operation_kind="warehouse",
        entity_urn=None,
        aspect_name=warehouse.aspect_name,
        idempotency_key=warehouse.idempotency_key,
        proposal_hash=warehouse.proposal_hash,
        status=ReceiptStatus.FAILURE,
        detail_code="RuntimeError",
        ownership_nonce=store.ownership_nonce,
        metrics=warehouse.metrics,
    )
    assert "WAREHOUSE_RECEIPT_NOT_CURRENT" in ingestion_prerequisite_failures(
        (*valid, warehouse_failure), **kwargs
    )
    dbt_retry = OperationReceipt.create(
        scenario_id=SCENARIO,
        operation_kind="dbt-build",
        entity_urn=None,
        aspect_name="build",
        idempotency_key=DBT_BUILD_COMMAND_FINGERPRINT,
        proposal_hash=project,
        status=ReceiptStatus.PLANNED,
        detail_code="OPERATION_PLANNED",
        ownership_nonce=store.ownership_nonce,
        metrics=valid[0].metrics | {"dbtProjectFingerprint": project},
    )
    assert "DBT_BUILD_RECEIPT_NOT_CURRENT" in ingestion_prerequisite_failures(
        (*valid, dbt_retry), **kwargs
    )


def test_pinned_postgres_recipe_disables_connector_query_lineage(
    repository_root: Path,
) -> None:
    payload = yaml.safe_load(
        (repository_root / "walkthrough/metadata/postgres-ingestion.yml").read_text()
    )
    config = PostgresConfig.model_validate(payload["source"]["config"])
    assert config.include_query_lineage is False
    assert config.include_usage_statistics is False
    assert config.include_view_lineage is False
    assert config.include_view_column_lineage is False
    assert config.include_table_location_lineage is False
    dbt_payload = yaml.safe_load(
        (repository_root / "walkthrough/metadata/dbt-ingestion.yml").read_text()
    )
    assert dbt_payload["source"]["config"]["include_column_lineage"] is False


def test_external_tools_receive_only_private_captured_snapshots(
    repository_root: Path, tmp_path: Path
) -> None:
    captured_root = tmp_path / "captured"
    for relative in (*RECIPE_DIGESTS, *DBT_ARTIFACT_PATHS):
        destination = captured_root / relative
        destination.parent.mkdir(parents=True, exist_ok=True)
        shutil.copyfile(repository_root / relative, destination)
    recipes = build_ingestion_plan(captured_root)
    artifacts = verify_dbt_ingestion_artifacts(captured_root)
    original_recipe = recipes[0].content
    (captured_root / recipes[0].relative_path).write_text("source: replaced-after-check")
    snapshot_path: Path | None = None
    with protected_ingestion_snapshot(tmp_path / "state", recipes, artifacts) as snapshot:
        snapshot_path = snapshot.root
        assert stat.S_IMODE(snapshot.root.stat().st_mode) == 0o700
        expected_paths = {item.relative_path for item in (*recipes, *artifacts)}
        assert {
            path.relative_to(snapshot.root).as_posix()
            for path in snapshot.root.rglob("*")
            if path.is_file()
        } == expected_paths
        assert snapshot.path_for(recipes[0].relative_path).read_bytes() == original_recipe
        assert all(
            stat.S_IMODE(snapshot.path_for(relative).stat().st_mode) == 0o600
            for relative in expected_paths
        )
    assert snapshot_path is not None and not snapshot_path.exists()

    dbt_snapshot_path: Path | None = None
    with protected_dbt_project_snapshot(tmp_path / "dbt-state", repository_root) as snapshot:
        dbt_snapshot_path = snapshot.root
        assert stat.S_IMODE(snapshot.root.stat().st_mode) == 0o700
        for relative in DBT_PROJECT_FILE_DIGESTS:
            path = snapshot.root / relative
            assert path.read_bytes() == (repository_root / relative).read_bytes()
            assert stat.S_IMODE(path.stat().st_mode) == 0o600
            assert path.stat().st_uid == os.getuid()
    assert dbt_snapshot_path is not None and not dbt_snapshot_path.exists()
