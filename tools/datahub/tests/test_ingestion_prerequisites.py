from __future__ import annotations

import json
from pathlib import Path

import pytest
import yaml
from datahub.ingestion.source.sql.postgres import PostgresConfig

from lineageguard_datahub.ingestion import (
    CANONICAL_DBT_NODES,
    CANONICAL_DBT_RELATIONS,
    DBT_ARTIFACT_PATHS,
    RECIPE_DIGESTS,
    ingestion_prerequisite_failures,
    verify_dbt_ingestion_artifacts,
)
from lineageguard_datahub.receipts import OperationReceipt, ReceiptStatus

SCENARIO = "canonical-customer-id-rename"
ATTESTATION = "canonical-local-lineageguard-v1"
TARGET = "f" * 64


def _receipt(
    relative: str,
    *,
    status: ReceiptStatus = ReceiptStatus.SUCCESS,
    digest: str | None = None,
    attestation: str = ATTESTATION,
    target: str = TARGET,
) -> OperationReceipt:
    actual_digest = digest or RECIPE_DIGESTS[relative]
    return OperationReceipt.create(
        scenario_id=SCENARIO,
        operation_kind="ingest",
        entity_urn=None,
        aspect_name=relative,
        idempotency_key=actual_digest,
        proposal_hash=actual_digest,
        status=status,
        detail_code="INGESTED" if status is ReceiptStatus.SUCCESS else "EXIT_1",
        metrics={"targetAttestation": attestation, "targetFingerprint": target},
    )


def _valid_receipts() -> tuple[OperationReceipt, ...]:
    return tuple(_receipt(relative) for relative in RECIPE_DIGESTS)


def test_ingestion_prerequisites_require_both_current_exact_ordered_receipts() -> None:
    postgres, dbt = RECIPE_DIGESTS
    assert not ingestion_prerequisite_failures(
        _valid_receipts(),
        scenario_id=SCENARIO,
        target_attestation=ATTESTATION,
        target_fingerprint=TARGET,
    )
    cases = (
        (_valid_receipts()[:1], "INGEST_PREREQUISITE_MISSING"),
        (
            (_receipt(postgres), _receipt(dbt, status=ReceiptStatus.FAILURE)),
            "INGEST_PREREQUISITE_NOT_CURRENT",
        ),
        (
            (*_valid_receipts(), _receipt(dbt, status=ReceiptStatus.PLANNED)),
            "INGEST_PREREQUISITE_NOT_CURRENT",
        ),
        (
            (_receipt(postgres), _receipt(dbt, digest="a" * 64)),
            "INGEST_PREREQUISITE_DIGEST_MISMATCH",
        ),
        (
            (_receipt(postgres), _receipt(dbt, target="b" * 64)),
            "INGEST_PREREQUISITE_TARGET_MISMATCH",
        ),
        ((_receipt(dbt), _receipt(postgres)), "INGEST_PREREQUISITE_ORDER_INVALID"),
    )
    for receipts, code in cases:
        failures = ingestion_prerequisite_failures(
            receipts,
            scenario_id=SCENARIO,
            target_attestation=ATTESTATION,
            target_fingerprint=TARGET,
        )
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
        tuple(
            path.relative_to(tmp_path).as_posix()
            for path in verify_dbt_ingestion_artifacts(tmp_path)
        )
        == DBT_ARTIFACT_PATHS
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
