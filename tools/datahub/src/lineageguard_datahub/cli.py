from __future__ import annotations

import argparse
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
    ConfigurationError,
    load_datahub_config,
    load_postgres_config,
    redact,
)
from lineageguard_datahub.expected_graph import graph_fingerprint, load_expected_graph
from lineageguard_datahub.ingestion import (
    build_ingestion_plan,
    ingestion_environment,
    verify_ingestion_role,
)
from lineageguard_datahub.live_query import emit_live_query_evidence
from lineageguard_datahub.paths import canonical_manifest_path, repository_root
from lineageguard_datahub.query_history import execute_query, plan_query_execution
from lineageguard_datahub.receipts import (
    OperationReceipt,
    ReceiptStatus,
    ReceiptStore,
)
from lineageguard_datahub.reset import build_reset_plan, execute_reset
from lineageguard_datahub.seed import build_seed_plan, seed_metadata
from lineageguard_datahub.verify import compare_observed_graph, observe_live, verify_query_files
from lineageguard_datahub.warehouse import (
    apply_warehouse_rows,
    apply_warehouse_seed,
    build_warehouse_seed_plan,
)

DATAHUB_VERSION = "v1.6.0"


def _parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(description="LineageGuard canonical DataHub graph tooling")
    subparsers = parser.add_subparsers(dest="command", required=True)
    for command in ("quickstart", "warehouse-seed", "query", "ingest", "metadata-seed", "reset"):
        child = subparsers.add_parser(command)
        child.add_argument(
            "--execute",
            action="store_true",
            help="perform the external mutation; without this flag only the plan is printed",
        )
    reset = subparsers.choices["reset"]
    reset.add_argument("--confirm", help="must equal the exact scenario id")
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
        with psycopg.connect(config.dsn) as connection, connection.cursor() as cursor:
            apply_warehouse_seed(
                cursor,
                plan,
                ownership_nonce=store.ownership_nonce,
                query_password=query_config.password,
                ingest_password=ingest_config.password,
                seed_password=seed_config.password,
                dbt_password=dbt_config.password,
            )
        with psycopg.connect(seed_config.dsn) as connection, connection.cursor() as cursor:
            apply_warehouse_rows(cursor, plan, ownership_nonce=store.ownership_nonce)
    return {
        "executed": execute,
        "sqlFiles": [str(path.relative_to(root)) for path in plan.sql_paths],
    }


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
                metrics={
                    "queryId": receipt.query_id,
                    "executionCount": receipt.execution_count,
                    "totalExecTimeMs": receipt.total_exec_time_ms,
                    "normalizedFingerprint": receipt.normalized_fingerprint,
                    "statementSha256": receipt.sha256,
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
        postgres_config = load_postgres_config(ingest_role=True)
        child_env = ingestion_environment(datahub_config, postgres_config)
        with psycopg.connect(postgres_config.dsn) as connection, connection.cursor() as cursor:
            verify_ingestion_role(cursor)
        for command, recipe in zip(commands, recipes, strict=True):
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
                )
            )
            try:
                _run(command, cwd=root, env=child_env)
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
                )
            )
            if recipe.path.name == "postgres-ingestion.yml":
                graph = load_expected_graph(canonical_manifest_path(root))
                emitter = DatahubRestEmitter(
                    gms_server=datahub_config.server, token=datahub_config.token
                )
                client = DataHubGraph(
                    DatahubClientConfig(server=datahub_config.server, token=datahub_config.token)
                )
                live_query_upserts = emit_live_query_evidence(emitter, client, store, graph, root)
    return {
        "executed": execute,
        "commands": commands,
        "liveQueryUpserts": live_query_upserts,
    }


def _metadata_seed(execute: bool, root: Path) -> dict[str, object]:
    graph = load_expected_graph(canonical_manifest_path(root))
    verify_query_files(graph, root)
    plan = build_seed_plan(graph, root)
    result: dict[str, object] = {
        "executed": execute,
        "scenarioId": graph.scenario_id,
        "upserts": len(plan),
        "idempotencyKeys": [operation.idempotency_key for operation in plan],
    }
    if execute:
        _require_environment_gate()
        config = load_datahub_config(write=True)
        emitter = DatahubRestEmitter(gms_server=config.server, token=config.token)
        client = DataHubGraph(DatahubClientConfig(server=config.server, token=config.token))
        receipt = seed_metadata(emitter, client, _receipt_store(root), graph, root)
        result["emitted"] = receipt.emitted
        result["skipped"] = receipt.skipped
    return result


def _reset(execute: bool, confirmation: str | None, root: Path) -> dict[str, object]:
    graph = load_expected_graph(canonical_manifest_path(root))
    plan = build_reset_plan(
        graph,
        environment_gate=os.environ.get("LINEAGEGUARD_WALKTHROUGH_ENV"),
        platform_instance=os.environ.get("LINEAGEGUARD_PLATFORM_INSTANCE"),
        creation_receipts=_receipt_store(root).read_all(),
        root=root,
        ownership_nonce=_receipt_store(root).ownership_nonce,
    )
    if execute and confirmation != graph.scenario_id:
        raise RuntimeError("SCENARIO_CONFIRMATION_REQUIRED")
    if execute:
        config = load_datahub_config(write=True)
        client = DataHubGraph(DatahubClientConfig(server=config.server, token=config.token))
        execute_reset(client, client, _receipt_store(root), plan)
    return {"executed": execute, "scenarioId": graph.scenario_id, "urns": list(plan.urns)}


def _verify(root: Path) -> tuple[dict[str, object], bool]:
    graph = load_expected_graph(canonical_manifest_path(root))
    verify_query_files(graph, root)
    config = load_datahub_config(write=False)
    client = DataHubGraph(DatahubClientConfig(server=config.server, token=config.token))
    report = compare_observed_graph(
        graph,
        observe_live(client, graph),
        _receipt_store(root).read_all(),
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
        elif arguments.command == "query":
            output = _query(arguments.execute, root)
        elif arguments.command == "ingest":
            output = _ingest(arguments.execute, root)
        elif arguments.command == "metadata-seed":
            output = _metadata_seed(arguments.execute, root)
        elif arguments.command == "reset":
            output = _reset(arguments.execute, arguments.confirm, root)
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
