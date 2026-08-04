from __future__ import annotations

import argparse
import hashlib
import json
import os
import subprocess
import sys
from dataclasses import asdict
from pathlib import Path

import psycopg
from datahub.emitter.rest_emitter import DatahubRestEmitter
from datahub.ingestion.graph.client import DatahubClientConfig, DataHubGraph

from lineageguard_datahub.config import (
    CANONICAL_TARGET_ATTESTATION,
    ConfigurationError,
    load_datahub_config,
    load_postgres_config,
    redact,
)
from lineageguard_datahub.expected_graph import graph_fingerprint, load_expected_graph
from lineageguard_datahub.ingestion import (
    DBT_ARTIFACT_VERIFICATION_FINGERPRINT,
    DBT_BUILD_COMMAND_FINGERPRINT,
    DBT_DOCS_COMMAND_FINGERPRINT,
    build_ingestion_plan,
    dbt_artifact_metrics,
    dbt_environment,
    dbt_project_fingerprint,
    ingestion_environment,
    ingestion_prerequisite_failures,
    ingestion_snapshot_fingerprint,
    protected_dbt_project_snapshot,
    protected_ingestion_snapshot,
    publish_dbt_artifacts,
    require_dbt_build_provenance,
    verify_dbt_ingestion_artifacts,
    verify_ingestion_role,
)
from lineageguard_datahub.live_query import (
    emit_live_query_evidence,
    reconcile_live_query_evidence,
)
from lineageguard_datahub.paths import canonical_manifest_path, repository_root
from lineageguard_datahub.provenance import (
    datahub_target_metrics,
    latest_warehouse_receipt,
    registry_binding_metrics,
)
from lineageguard_datahub.query_history import execute_query, plan_query_execution
from lineageguard_datahub.receipts import (
    OperationReceipt,
    ReceiptStatus,
    ReceiptStore,
)
from lineageguard_datahub.reset import build_reset_plan, execute_reset, reconcile_reset
from lineageguard_datahub.seed import build_seed_plan, reconcile_seed_metadata, seed_metadata
from lineageguard_datahub.verify import compare_observed_graph, observe_live, verify_query_files
from lineageguard_datahub.warehouse import (
    apply_warehouse_rows,
    apply_warehouse_seed,
    attest_scenario_registry,
    build_warehouse_seed_plan,
    verify_dbt_relations,
    verify_dbt_role,
)

DATAHUB_VERSION = "v1.6.0"


def _parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(description="LineageGuard canonical DataHub graph tooling")
    subparsers = parser.add_subparsers(dest="command", required=True)
    for command in (
        "quickstart",
        "warehouse-seed",
        "dbt-build",
        "query",
        "ingest",
        "metadata-seed",
        "reset",
        "reconcile-seed",
        "reconcile-live-query",
        "reconcile-reset",
    ):
        child = subparsers.add_parser(command)
        child.add_argument(
            "--execute",
            action="store_true",
            help="perform the external mutation; without this flag only the plan is printed",
        )
    reset = subparsers.choices["reset"]
    reset.add_argument("--confirm", help="must equal the exact scenario id")
    reconcile_seed = subparsers.choices["reconcile-seed"]
    reconcile_seed.add_argument("--confirm", help="must equal the exact scenario id")
    reconcile_live_query = subparsers.choices["reconcile-live-query"]
    reconcile_live_query.add_argument("--confirm", help="must equal the exact scenario id")
    reconcile_reset_parser = subparsers.choices["reconcile-reset"]
    reconcile_reset_parser.add_argument("--confirm", help="must equal the exact scenario id")
    subparsers.add_parser("verify")
    subparsers.add_parser("manifest")
    return parser


def _require_environment_gate() -> None:
    if os.environ.get("LINEAGEGUARD_WALKTHROUGH_ENV") != "canonical":
        raise RuntimeError("CANONICAL_ENV_REQUIRED")


def _receipt_store(root: Path) -> ReceiptStore:
    return ReceiptStore(root / "walkthrough/.state/operations.jsonl")


def _run(command: list[str], *, cwd: Path, env: dict[str, str] | None = None) -> None:
    subprocess.run(command, cwd=cwd, check=True, shell=False, env=env)


def _quickstart(execute: bool, root: Path) -> dict[str, object]:
    command = [
        "datahub",
        "docker",
        "quickstart",
        "--version",
        DATAHUB_VERSION,
        "--no-accept-version-default",
    ]
    if execute:
        _run(command, cwd=root)
    return {"executed": execute, "command": command, "datahubVersion": DATAHUB_VERSION}


def _warehouse_seed(execute: bool, root: Path) -> dict[str, object]:
    plan = build_warehouse_seed_plan(root)
    if execute:
        _require_environment_gate()
        config = load_postgres_config(admin_role=True)
        query_config = load_postgres_config(query_role=True)
        ingest_config = load_postgres_config(ingest_role=True)
        seed_config = load_postgres_config()
        dbt_config = load_postgres_config(dbt_role=True)
        store = _receipt_store(root)
        nonce = store.ownership_nonce
        plan_fingerprint = hashlib.sha256(
            "\n".join(
                [
                    *(f"{asset.relative_path}:{asset.sha256}" for asset in plan.sql_assets),
                    config.target_fingerprint,
                ]
            ).encode()
        ).hexdigest()
        planned_metrics = registry_binding_metrics(nonce, config.target_fingerprint) | {
            "registryAttested": "pending"
        }
        with store.scenario_operation("canonical-customer-id-rename", "warehouse"):
            store.append(
                OperationReceipt.create(
                    scenario_id="canonical-customer-id-rename",
                    operation_kind="warehouse",
                    entity_urn=None,
                    aspect_name="canonical-schema",
                    idempotency_key=plan_fingerprint,
                    proposal_hash=plan_fingerprint,
                    status=ReceiptStatus.PLANNED,
                    detail_code="OPERATION_PLANNED",
                    ownership_nonce=nonce,
                    metrics=planned_metrics,
                )
            )
            try:
                with psycopg.connect(config.dsn) as connection, connection.cursor() as cursor:
                    apply_warehouse_seed(
                        cursor,
                        plan,
                        ownership_nonce=nonce,
                        query_password=query_config.password,
                        ingest_password=ingest_config.password,
                        seed_password=seed_config.password,
                        dbt_password=dbt_config.password,
                        warehouse_target_fingerprint=config.target_fingerprint,
                    )
                with (
                    psycopg.connect(seed_config.dsn) as connection,
                    connection.cursor() as cursor,
                ):
                    apply_warehouse_rows(
                        cursor,
                        plan,
                        ownership_nonce=nonce,
                        warehouse_target_fingerprint=config.target_fingerprint,
                    )
                    attest_scenario_registry(
                        cursor,
                        ownership_nonce=nonce,
                        warehouse_target_fingerprint=config.target_fingerprint,
                    )
            except Exception as error:
                store.append(
                    OperationReceipt.create(
                        scenario_id="canonical-customer-id-rename",
                        operation_kind="warehouse",
                        entity_urn=None,
                        aspect_name="canonical-schema",
                        idempotency_key=plan_fingerprint,
                        proposal_hash=plan_fingerprint,
                        status=ReceiptStatus.FAILURE,
                        detail_code=type(error).__name__,
                        ownership_nonce=nonce,
                        metrics=planned_metrics,
                    )
                )
                raise
            store.append(
                OperationReceipt.create(
                    scenario_id="canonical-customer-id-rename",
                    operation_kind="warehouse",
                    entity_urn=None,
                    aspect_name="canonical-schema",
                    idempotency_key=plan_fingerprint,
                    proposal_hash=plan_fingerprint,
                    status=ReceiptStatus.SUCCESS,
                    detail_code="WAREHOUSE_READY",
                    ownership_nonce=nonce,
                    metrics=registry_binding_metrics(nonce, config.target_fingerprint),
                )
            )
    return {
        "executed": execute,
        "sqlFiles": [asset.relative_path for asset in plan.sql_assets],
    }


def _dbt_build(execute: bool, root: Path) -> dict[str, object]:
    project_fingerprint = dbt_project_fingerprint(root)
    display_commands = [
        ["dbt", "build", "--project-dir", "walkthrough/dbt", "--target-path", "<fresh>"],
        [
            "dbt",
            "docs",
            "generate",
            "--project-dir",
            "walkthrough/dbt",
            "--target-path",
            "<same-fresh>",
        ],
    ]
    result: dict[str, object] = {
        "executed": execute,
        "projectFingerprint": project_fingerprint,
        "commands": display_commands,
    }
    if not execute:
        return result
    _require_environment_gate()
    config = load_postgres_config(dbt_role=True)
    store = _receipt_store(root)
    nonce = store.ownership_nonce
    binding_metrics = registry_binding_metrics(nonce, config.target_fingerprint) | {
        "dbtProjectFingerprint": project_fingerprint
    }
    state_parent = root / "walkthrough/.state"
    with store.scenario_operation("canonical-customer-id-rename", "dbt-build"):
        with psycopg.connect(config.dsn) as connection, connection.cursor() as cursor:
            verify_dbt_role(cursor)
            attest_scenario_registry(
                cursor,
                ownership_nonce=nonce,
                warehouse_target_fingerprint=config.target_fingerprint,
            )
        latest_warehouse_receipt(
            store.read_all(),
            scenario_id="canonical-customer-id-rename",
            ownership_nonce=nonce,
            warehouse_target_fingerprint=config.target_fingerprint,
        )
        with protected_dbt_project_snapshot(state_parent, root) as snapshot:
            target = snapshot.root / "walkthrough/dbt/target"
            commands = (
                (
                    "build",
                    DBT_BUILD_COMMAND_FINGERPRINT,
                    [
                        "dbt",
                        "build",
                        "--project-dir",
                        str(snapshot.project_dir),
                        "--profiles-dir",
                        str(snapshot.project_dir),
                        "--target-path",
                        str(target),
                        "--no-partial-parse",
                    ],
                ),
                (
                    "docs-generate",
                    DBT_DOCS_COMMAND_FINGERPRINT,
                    [
                        "dbt",
                        "docs",
                        "generate",
                        "--project-dir",
                        str(snapshot.project_dir),
                        "--profiles-dir",
                        str(snapshot.project_dir),
                        "--target-path",
                        str(target),
                        "--no-partial-parse",
                    ],
                ),
            )
            for aspect, command_fingerprint, command in commands:
                store.append(
                    OperationReceipt.create(
                        scenario_id="canonical-customer-id-rename",
                        operation_kind="dbt-build",
                        entity_urn=None,
                        aspect_name=aspect,
                        idempotency_key=command_fingerprint,
                        proposal_hash=project_fingerprint,
                        status=ReceiptStatus.PLANNED,
                        detail_code="OPERATION_PLANNED",
                        ownership_nonce=nonce,
                        metrics=binding_metrics,
                    )
                )
                try:
                    _run(command, cwd=snapshot.root, env=dbt_environment(config))
                except subprocess.CalledProcessError as error:
                    store.append(
                        OperationReceipt.create(
                            scenario_id="canonical-customer-id-rename",
                            operation_kind="dbt-build",
                            entity_urn=None,
                            aspect_name=aspect,
                            idempotency_key=command_fingerprint,
                            proposal_hash=project_fingerprint,
                            status=ReceiptStatus.FAILURE,
                            detail_code=f"EXIT_{error.returncode}",
                            ownership_nonce=nonce,
                            metrics=binding_metrics,
                        )
                    )
                    raise
                store.append(
                    OperationReceipt.create(
                        scenario_id="canonical-customer-id-rename",
                        operation_kind="dbt-build",
                        entity_urn=None,
                        aspect_name=aspect,
                        idempotency_key=command_fingerprint,
                        proposal_hash=project_fingerprint,
                        status=ReceiptStatus.SUCCESS,
                        detail_code="DBT_COMMAND_SUCCEEDED",
                        ownership_nonce=nonce,
                        metrics=binding_metrics,
                    )
                )
            store.append(
                OperationReceipt.create(
                    scenario_id="canonical-customer-id-rename",
                    operation_kind="dbt-build",
                    entity_urn=None,
                    aspect_name="artifact-set",
                    idempotency_key=DBT_ARTIFACT_VERIFICATION_FINGERPRINT,
                    proposal_hash=project_fingerprint,
                    status=ReceiptStatus.PLANNED,
                    detail_code="OPERATION_PLANNED",
                    ownership_nonce=nonce,
                    metrics=binding_metrics,
                )
            )
            try:
                artifacts = verify_dbt_ingestion_artifacts(snapshot.root)
                with psycopg.connect(config.dsn) as connection, connection.cursor() as cursor:
                    verify_dbt_role(cursor)
                    attest_scenario_registry(
                        cursor,
                        ownership_nonce=nonce,
                        warehouse_target_fingerprint=config.target_fingerprint,
                    )
                    verify_dbt_relations(cursor)
                publish_dbt_artifacts(root, artifacts)
            except Exception as error:
                store.append(
                    OperationReceipt.create(
                        scenario_id="canonical-customer-id-rename",
                        operation_kind="dbt-build",
                        entity_urn=None,
                        aspect_name="artifact-set",
                        idempotency_key=DBT_ARTIFACT_VERIFICATION_FINGERPRINT,
                        proposal_hash=project_fingerprint,
                        status=ReceiptStatus.FAILURE,
                        detail_code=type(error).__name__,
                        ownership_nonce=nonce,
                        metrics=binding_metrics,
                    )
                )
                raise
            metrics = binding_metrics | dbt_artifact_metrics(artifacts)
            store.append(
                OperationReceipt.create(
                    scenario_id="canonical-customer-id-rename",
                    operation_kind="dbt-build",
                    entity_urn=None,
                    aspect_name="artifact-set",
                    idempotency_key=DBT_ARTIFACT_VERIFICATION_FINGERPRINT,
                    proposal_hash=project_fingerprint,
                    status=ReceiptStatus.SUCCESS,
                    detail_code="DBT_ARTIFACTS_VERIFIED",
                    ownership_nonce=nonce,
                    metrics=metrics,
                )
            )
            result["artifactDigests"] = dbt_artifact_metrics(artifacts)
    return result


def _query(execute: bool, root: Path) -> dict[str, object]:
    graph = load_expected_graph(canonical_manifest_path(root))
    query = graph.query_evidence[0]
    plan = plan_query_execution(root, query)
    result: dict[str, object] = {
        "executed": execute,
        "marker": plan.marker,
        "sha256": plan.sha256,
        "normalizedFingerprint": plan.normalized_fingerprint,
    }
    if execute:
        _require_environment_gate()
        config = load_postgres_config(query_role=True)
        store = _receipt_store(root)
        nonce = store.ownership_nonce
        metrics = registry_binding_metrics(nonce, config.target_fingerprint)
        with store.scenario_operation(graph.scenario_id, "query"):
            with psycopg.connect(config.dsn) as connection, connection.cursor() as cursor:
                attest_scenario_registry(
                    cursor,
                    ownership_nonce=nonce,
                    warehouse_target_fingerprint=config.target_fingerprint,
                )
            latest_warehouse_receipt(
                store.read_all(),
                scenario_id=graph.scenario_id,
                ownership_nonce=nonce,
                warehouse_target_fingerprint=config.target_fingerprint,
            )
            store.append(
                OperationReceipt.create(
                    scenario_id=graph.scenario_id,
                    operation_kind="query",
                    entity_urn=None,
                    aspect_name="pg_stat_statements",
                    idempotency_key=plan.normalized_fingerprint,
                    status=ReceiptStatus.PLANNED,
                    detail_code="OPERATION_PLANNED",
                    proposal_hash=plan.normalized_fingerprint,
                    ownership_nonce=nonce,
                    metrics=metrics,
                )
            )
            try:
                with psycopg.connect(config.dsn) as connection, connection.cursor() as cursor:
                    receipt = execute_query(cursor, plan)
            except Exception as error:
                store.append(
                    OperationReceipt.create(
                        scenario_id=graph.scenario_id,
                        operation_kind="query",
                        entity_urn=None,
                        aspect_name="pg_stat_statements",
                        idempotency_key=plan.normalized_fingerprint,
                        status=ReceiptStatus.FAILURE,
                        detail_code=type(error).__name__,
                        ownership_nonce=nonce,
                        metrics=metrics,
                    )
                )
                raise
            result["rowCount"] = receipt.row_count
            result["pgStatQueryId"] = receipt.query_id
            result["executionCount"] = receipt.execution_count
            result["totalExecTimeMs"] = receipt.total_exec_time_ms
            store.append(
                OperationReceipt.create(
                    scenario_id=graph.scenario_id,
                    operation_kind="query",
                    entity_urn=None,
                    aspect_name="pg_stat_statements",
                    idempotency_key=plan.normalized_fingerprint,
                    status=ReceiptStatus.SUCCESS,
                    detail_code="PG_STAT_OBSERVED",
                    ownership_nonce=nonce,
                    metrics=metrics
                    | {
                        "queryId": receipt.query_id,
                        "executionCount": receipt.execution_count,
                        "totalExecTimeMs": receipt.total_exec_time_ms,
                        "normalizedFingerprint": receipt.normalized_fingerprint,
                        "statementSha256": receipt.sha256,
                        "databaseId": receipt.database_id,
                        "userId": receipt.user_id,
                    },
                )
            )
    return result


def _ingest(execute: bool, root: Path) -> dict[str, object]:
    recipes = build_ingestion_plan(root)
    commands = [["datahub", "ingest", "run", "-c", recipe.relative_path] for recipe in recipes]
    live_query_upserts = 0
    if execute:
        _require_environment_gate()
        store = _receipt_store(root)
        datahub_config = load_datahub_config(ingest=True)
        artifacts = verify_dbt_ingestion_artifacts(root)
        artifact_metrics = dbt_artifact_metrics(artifacts)
        project_fingerprint = dbt_project_fingerprint(root)
        snapshot_fingerprint = ingestion_snapshot_fingerprint(recipes, artifacts)
        postgres_config = load_postgres_config(ingest_role=True)
        child_env = ingestion_environment(datahub_config, postgres_config)
        nonce = store.ownership_nonce
        target_metrics: dict[str, int | float | str] = (
            datahub_target_metrics(
                nonce,
                postgres_config.target_fingerprint,
                datahub_config.target_attestation or CANONICAL_TARGET_ATTESTATION,
                datahub_config.target_fingerprint,
            )
            | artifact_metrics
            | {
                "dbtProjectFingerprint": project_fingerprint,
                "ingestionSnapshotFingerprint": snapshot_fingerprint,
            }
        )
        with protected_ingestion_snapshot(
            root / "walkthrough/.state", recipes, artifacts
        ) as snapshot:
            if snapshot.fingerprint != snapshot_fingerprint:
                raise ValueError("INGESTION_SNAPSHOT_FINGERPRINT_MISMATCH")
            for recipe in recipes:
                command = ["datahub", "ingest", "run", "-c", recipe.relative_path]
                with store.scenario_operation("canonical-customer-id-rename", "ingest"):
                    with (
                        psycopg.connect(postgres_config.dsn) as connection,
                        connection.cursor() as cursor,
                    ):
                        verify_ingestion_role(cursor)
                        attest_scenario_registry(
                            cursor,
                            ownership_nonce=nonce,
                            warehouse_target_fingerprint=postgres_config.target_fingerprint,
                        )
                    require_dbt_build_provenance(
                        store.read_all(),
                        scenario_id="canonical-customer-id-rename",
                        ownership_nonce=nonce,
                        warehouse_target_fingerprint=postgres_config.target_fingerprint,
                        dbt_project_sha256=project_fingerprint,
                        artifact_metrics=artifact_metrics,
                    )
                    store.append(
                        OperationReceipt.create(
                            scenario_id="canonical-customer-id-rename",
                            operation_kind="ingest",
                            entity_urn=None,
                            aspect_name=recipe.relative_path,
                            idempotency_key=recipe.sha256,
                            status=ReceiptStatus.PLANNED,
                            detail_code="OPERATION_PLANNED",
                            proposal_hash=recipe.sha256,
                            ownership_nonce=nonce,
                            metrics=target_metrics,
                        )
                    )
                    try:
                        _run(command, cwd=snapshot.root, env=child_env)
                    except subprocess.CalledProcessError as error:
                        store.append(
                            OperationReceipt.create(
                                scenario_id="canonical-customer-id-rename",
                                operation_kind="ingest",
                                entity_urn=None,
                                aspect_name=recipe.relative_path,
                                idempotency_key=recipe.sha256,
                                status=ReceiptStatus.FAILURE,
                                detail_code=f"EXIT_{error.returncode}",
                                proposal_hash=recipe.sha256,
                                ownership_nonce=nonce,
                                metrics=target_metrics,
                            )
                        )
                        raise
                    store.append(
                        OperationReceipt.create(
                            scenario_id="canonical-customer-id-rename",
                            operation_kind="ingest",
                            entity_urn=None,
                            aspect_name=recipe.relative_path,
                            idempotency_key=recipe.sha256,
                            status=ReceiptStatus.SUCCESS,
                            detail_code="INGESTED",
                            proposal_hash=recipe.sha256,
                            ownership_nonce=nonce,
                            metrics=target_metrics,
                        )
                    )
                if recipe.path.name == "postgres-ingestion.yml":
                    graph = load_expected_graph(canonical_manifest_path(root))
                    emitter = DatahubRestEmitter(
                        gms_server=datahub_config.server, token=datahub_config.token
                    )
                    client = DataHubGraph(
                        DatahubClientConfig(
                            server=datahub_config.server, token=datahub_config.token
                        )
                    )
                    with (
                        psycopg.connect(postgres_config.dsn) as connection,
                        connection.cursor() as cursor,
                    ):
                        live_query_upserts = emit_live_query_evidence(
                            emitter,
                            client,
                            store,
                            graph,
                            root,
                            cursor,
                            warehouse_target_fingerprint=postgres_config.target_fingerprint,
                            target_attestation=(
                                datahub_config.target_attestation or CANONICAL_TARGET_ATTESTATION
                            ),
                            target_fingerprint=datahub_config.target_fingerprint,
                        )
    return {
        "executed": execute,
        "commands": commands,
        "liveQueryUpserts": live_query_upserts,
    }


def _metadata_seed(execute: bool, root: Path) -> dict[str, object]:
    graph = load_expected_graph(canonical_manifest_path(root))
    verify_query_files(graph, root)
    plan = build_seed_plan(graph, root)
    store = _receipt_store(root)
    nonce = store.ownership_nonce
    target_attestation = os.environ.get("LINEAGEGUARD_DATAHUB_TARGET_ATTESTATION", "")
    target_fingerprint = ""
    warehouse_target_fingerprint = ""
    prerequisite_errors: list[str] = []
    try:
        read_config = load_datahub_config(write=False)
        if target_attestation:
            target_fingerprint = read_config.target_fingerprint
        postgres_config = load_postgres_config()
        warehouse_target_fingerprint = postgres_config.target_fingerprint
        artifacts = verify_dbt_ingestion_artifacts(root)
        artifact_metrics = dbt_artifact_metrics(artifacts)
        project_fingerprint = dbt_project_fingerprint(root)
        snapshot_fingerprint = ingestion_snapshot_fingerprint(build_ingestion_plan(root), artifacts)
    except (ConfigurationError, ValueError) as error:
        prerequisite_errors.append(str(error))
    if prerequisite_errors:
        prerequisite_failures = tuple(prerequisite_errors)
    else:
        prerequisite_failures = ingestion_prerequisite_failures(
            store.read_all(),
            scenario_id=graph.scenario_id,
            ownership_nonce=nonce,
            warehouse_target_fingerprint=warehouse_target_fingerprint,
            target_attestation=target_attestation,
            target_fingerprint=target_fingerprint,
            dbt_project_sha256=project_fingerprint,
            artifact_metrics=artifact_metrics,
            snapshot_fingerprint=snapshot_fingerprint,
        )
    result: dict[str, object] = {
        "executed": execute,
        "scenarioId": graph.scenario_id,
        "upserts": len(plan),
        "idempotencyKeys": [operation.idempotency_key for operation in plan],
        "prerequisitesReady": not prerequisite_failures,
        "prerequisiteFailures": list(prerequisite_failures),
    }
    if execute:
        _require_environment_gate()
        config = load_datahub_config(write=True)
        postgres_config = load_postgres_config()
        target_attestation = config.target_attestation or CANONICAL_TARGET_ATTESTATION
        emitter = DatahubRestEmitter(gms_server=config.server, token=config.token)
        client = DataHubGraph(DatahubClientConfig(server=config.server, token=config.token))
        with (
            psycopg.connect(postgres_config.dsn) as connection,
            connection.cursor() as cursor,
        ):
            receipt = seed_metadata(
                emitter,
                client,
                store,
                graph,
                root,
                cursor,
                warehouse_target_fingerprint=postgres_config.target_fingerprint,
                target_attestation=target_attestation,
                target_fingerprint=config.target_fingerprint,
            )
        result["emitted"] = receipt.emitted
        result["skipped"] = receipt.skipped
    return result


def _reset(execute: bool, confirmation: str | None, root: Path) -> dict[str, object]:
    graph = load_expected_graph(canonical_manifest_path(root))
    store = _receipt_store(root)
    datahub_config = load_datahub_config(write=execute)
    postgres_config = load_postgres_config()
    target_attestation = datahub_config.target_attestation or CANONICAL_TARGET_ATTESTATION
    plan = build_reset_plan(
        graph,
        environment_gate=os.environ.get("LINEAGEGUARD_WALKTHROUGH_ENV"),
        platform_instance=os.environ.get("LINEAGEGUARD_PLATFORM_INSTANCE"),
        creation_receipts=store.read_all(),
        root=root,
        ownership_nonce=store.ownership_nonce,
        warehouse_target_fingerprint=postgres_config.target_fingerprint,
        target_attestation=target_attestation,
        target_fingerprint=datahub_config.target_fingerprint,
    )
    if execute and confirmation != graph.scenario_id:
        raise RuntimeError("SCENARIO_CONFIRMATION_REQUIRED")
    if execute:
        client = DataHubGraph(
            DatahubClientConfig(server=datahub_config.server, token=datahub_config.token)
        )
        with (
            psycopg.connect(postgres_config.dsn) as connection,
            connection.cursor() as cursor,
        ):
            execute_reset(client, client, store, plan, cursor)
    return {"executed": execute, "scenarioId": graph.scenario_id, "urns": list(plan.urns)}


def _reconcile_seed(execute: bool, confirmation: str | None, root: Path) -> dict[str, object]:
    graph = load_expected_graph(canonical_manifest_path(root))
    result: dict[str, object] = {"executed": execute, "scenarioId": graph.scenario_id}
    if not execute:
        return result
    _require_environment_gate()
    if confirmation != graph.scenario_id:
        raise RuntimeError("SCENARIO_CONFIRMATION_REQUIRED")
    config = load_datahub_config(write=True)
    postgres_config = load_postgres_config()
    store = _receipt_store(root)
    client = DataHubGraph(DatahubClientConfig(server=config.server, token=config.token))
    with psycopg.connect(postgres_config.dsn) as connection, connection.cursor() as cursor:
        result["reconciled"] = reconcile_seed_metadata(
            client,
            store,
            graph,
            root,
            cursor,
            warehouse_target_fingerprint=postgres_config.target_fingerprint,
            target_attestation=config.target_attestation or CANONICAL_TARGET_ATTESTATION,
            target_fingerprint=config.target_fingerprint,
        )
    return result


def _reconcile_live_query(execute: bool, confirmation: str | None, root: Path) -> dict[str, object]:
    graph = load_expected_graph(canonical_manifest_path(root))
    result: dict[str, object] = {"executed": execute, "scenarioId": graph.scenario_id}
    if not execute:
        return result
    _require_environment_gate()
    if confirmation != graph.scenario_id:
        raise RuntimeError("SCENARIO_CONFIRMATION_REQUIRED")
    config = load_datahub_config(ingest=True)
    postgres_config = load_postgres_config(ingest_role=True)
    store = _receipt_store(root)
    client = DataHubGraph(DatahubClientConfig(server=config.server, token=config.token))
    with psycopg.connect(postgres_config.dsn) as connection, connection.cursor() as cursor:
        result["reconciled"] = reconcile_live_query_evidence(
            client,
            store,
            graph,
            root,
            cursor,
            warehouse_target_fingerprint=postgres_config.target_fingerprint,
            target_attestation=config.target_attestation or CANONICAL_TARGET_ATTESTATION,
            target_fingerprint=config.target_fingerprint,
        )
    return result


def _reconcile_reset(execute: bool, confirmation: str | None, root: Path) -> dict[str, object]:
    graph = load_expected_graph(canonical_manifest_path(root))
    result: dict[str, object] = {"executed": execute, "scenarioId": graph.scenario_id}
    if not execute:
        return result
    _require_environment_gate()
    if confirmation != graph.scenario_id:
        raise RuntimeError("SCENARIO_CONFIRMATION_REQUIRED")
    datahub_config = load_datahub_config(write=True)
    postgres_config = load_postgres_config()
    store = _receipt_store(root)
    target_attestation = datahub_config.target_attestation or CANONICAL_TARGET_ATTESTATION
    plan = build_reset_plan(
        graph,
        environment_gate=os.environ.get("LINEAGEGUARD_WALKTHROUGH_ENV"),
        platform_instance=os.environ.get("LINEAGEGUARD_PLATFORM_INSTANCE"),
        creation_receipts=store.read_all(),
        root=root,
        ownership_nonce=store.ownership_nonce,
        warehouse_target_fingerprint=postgres_config.target_fingerprint,
        target_attestation=target_attestation,
        target_fingerprint=datahub_config.target_fingerprint,
    )
    client = DataHubGraph(
        DatahubClientConfig(server=datahub_config.server, token=datahub_config.token)
    )
    with psycopg.connect(postgres_config.dsn) as connection, connection.cursor() as cursor:
        result["reconciled"] = reconcile_reset(client, store, plan, cursor)
    return result


def _verify(root: Path) -> tuple[dict[str, object], bool]:
    graph = load_expected_graph(canonical_manifest_path(root))
    verify_query_files(graph, root)
    config = load_datahub_config(write=False)
    if config.target_attestation != CANONICAL_TARGET_ATTESTATION:
        raise ConfigurationError("DATAHUB_TARGET_ATTESTATION_REQUIRED")
    postgres_config = load_postgres_config(ingest_role=True)
    store = _receipt_store(root)
    nonce = store.ownership_nonce
    with psycopg.connect(postgres_config.dsn) as connection, connection.cursor() as cursor:
        attest_scenario_registry(
            cursor,
            ownership_nonce=nonce,
            warehouse_target_fingerprint=postgres_config.target_fingerprint,
        )
    artifacts = verify_dbt_ingestion_artifacts(root)
    artifact_metrics = dbt_artifact_metrics(artifacts)
    project_fingerprint = dbt_project_fingerprint(root)
    snapshot_fingerprint = ingestion_snapshot_fingerprint(build_ingestion_plan(root), artifacts)
    client = DataHubGraph(DatahubClientConfig(server=config.server, token=config.token))
    report = compare_observed_graph(
        graph,
        observe_live(client, graph),
        store.read_all(),
        ownership_nonce=nonce,
        warehouse_target_fingerprint=postgres_config.target_fingerprint,
        target_attestation=config.target_attestation,
        target_fingerprint=config.target_fingerprint,
        dbt_project_sha256=project_fingerprint,
        artifact_metrics=artifact_metrics,
        snapshot_fingerprint=snapshot_fingerprint,
    )
    return asdict(report), report.ok


def _manifest(root: Path) -> dict[str, object]:
    graph = load_expected_graph(canonical_manifest_path(root))
    verify_query_files(graph, root)
    return {
        "scenarioId": graph.scenario_id,
        "environment": graph.environment,
        "platformInstance": graph.platform_instance,
        "managedUrns": list(graph.managed_urns),
        "impactCards": list(graph.impact_cards),
        "lineageIntermediates": list(graph.lineage_intermediates),
        "fingerprint": graph_fingerprint(graph),
    }


def main(argv: list[str] | None = None) -> int:
    arguments = _parser().parse_args(argv)
    root = repository_root()
    try:
        ok = True
        if arguments.command == "quickstart":
            output = _quickstart(arguments.execute, root)
        elif arguments.command == "warehouse-seed":
            output = _warehouse_seed(arguments.execute, root)
        elif arguments.command == "dbt-build":
            output = _dbt_build(arguments.execute, root)
        elif arguments.command == "query":
            output = _query(arguments.execute, root)
        elif arguments.command == "ingest":
            output = _ingest(arguments.execute, root)
        elif arguments.command == "metadata-seed":
            output = _metadata_seed(arguments.execute, root)
        elif arguments.command == "reset":
            output = _reset(arguments.execute, arguments.confirm, root)
        elif arguments.command == "reconcile-seed":
            output = _reconcile_seed(arguments.execute, arguments.confirm, root)
        elif arguments.command == "reconcile-live-query":
            output = _reconcile_live_query(arguments.execute, arguments.confirm, root)
        elif arguments.command == "reconcile-reset":
            output = _reconcile_reset(arguments.execute, arguments.confirm, root)
        elif arguments.command == "verify":
            output, ok = _verify(root)
        else:
            output = _manifest(root)
        print(json.dumps(output, sort_keys=True, indent=2))
        return 0 if ok else 1
    except (
        ConfigurationError,
        RuntimeError,
        ValueError,
        psycopg.Error,
        subprocess.CalledProcessError,
    ) as error:
        secrets = (
            os.environ.get("DATAHUB_TOKEN"),
            os.environ.get("DATAHUB_READ_TOKEN"),
            os.environ.get("DATAHUB_MUTATION_TOKEN"),
            os.environ.get("DATAHUB_INGEST_TOKEN"),
            os.environ.get("WALKTHROUGH_POSTGRES_PASSWORD"),
            os.environ.get("WALKTHROUGH_QUERY_POSTGRES_PASSWORD"),
            os.environ.get("WALKTHROUGH_INGEST_POSTGRES_PASSWORD"),
            os.environ.get("WALKTHROUGH_ADMIN_POSTGRES_PASSWORD"),
            os.environ.get("WALKTHROUGH_DBT_POSTGRES_PASSWORD"),
        )
        print(redact(str(error), secrets), file=sys.stderr)
        return 2


if __name__ == "__main__":
    raise SystemExit(main())
