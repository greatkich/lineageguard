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
from lineageguard_datahub.paths import canonical_manifest_path, repository_root
from lineageguard_datahub.query_history import execute_query, plan_query_execution
from lineageguard_datahub.reset import build_reset_plan, execute_reset
from lineageguard_datahub.seed import build_seed_plan, seed_metadata
from lineageguard_datahub.verify import compare_observed_graph, observe_live, verify_query_files
from lineageguard_datahub.warehouse import apply_warehouse_seed, build_warehouse_seed_plan

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


def _run(command: list[str], *, cwd: Path) -> None:
    subprocess.run(command, cwd=cwd, check=True, shell=False)


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
        config = load_postgres_config()
        with psycopg.connect(config.dsn) as connection, connection.cursor() as cursor:
            apply_warehouse_seed(cursor, plan)
    return {
        "executed": execute,
        "sqlFiles": [str(path.relative_to(root)) for path in plan.sql_paths],
    }


def _query(execute: bool, root: Path) -> dict[str, object]:
    graph = load_expected_graph(canonical_manifest_path(root))
    query = graph.query_evidence[0]
    plan = plan_query_execution(root / query.sql_path, query)
    result: dict[str, object] = {
        "executed": execute,
        "marker": plan.marker,
        "sha256": plan.sha256,
        "normalizedFingerprint": plan.normalized_fingerprint,
    }
    if execute:
        _require_environment_gate()
        config = load_postgres_config()
        with psycopg.connect(config.dsn) as connection, connection.cursor() as cursor:
            receipt = execute_query(cursor, plan)
        result["rowCount"] = receipt.row_count
    return result


def _ingest(execute: bool, root: Path) -> dict[str, object]:
    recipes = (
        root / "walkthrough/metadata/postgres-ingestion.yml",
        root / "walkthrough/metadata/dbt-ingestion.yml",
    )
    commands = [["datahub", "ingest", "run", "-c", str(path.relative_to(root))] for path in recipes]
    if execute:
        _require_environment_gate()
        for command in commands:
            _run(command, cwd=root)
    return {"executed": execute, "commands": commands}


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
        config = load_datahub_config()
        emitter = DatahubRestEmitter(gms_server=config.server, token=config.token)
        receipt = seed_metadata(emitter, graph, root)
        result["emitted"] = receipt.emitted
    return result


def _reset(execute: bool, confirmation: str | None, root: Path) -> dict[str, object]:
    graph = load_expected_graph(canonical_manifest_path(root))
    plan = build_reset_plan(
        graph,
        environment_gate=os.environ.get("LINEAGEGUARD_WALKTHROUGH_ENV"),
        platform_instance=os.environ.get("LINEAGEGUARD_PLATFORM_INSTANCE"),
    )
    if execute and confirmation != graph.scenario_id:
        raise RuntimeError("SCENARIO_CONFIRMATION_REQUIRED")
    if execute:
        config = load_datahub_config()
        client = DataHubGraph(DatahubClientConfig(server=config.server, token=config.token))
        execute_reset(client, plan)
    return {"executed": execute, "scenarioId": graph.scenario_id, "urns": list(plan.urns)}


def _verify(root: Path) -> tuple[dict[str, object], bool]:
    graph = load_expected_graph(canonical_manifest_path(root))
    verify_query_files(graph, root)
    config = load_datahub_config()
    client = DataHubGraph(DatahubClientConfig(server=config.server, token=config.token))
    report = compare_observed_graph(graph, observe_live(client, graph))
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
            os.environ.get("WALKTHROUGH_POSTGRES_PASSWORD"),
        )
        print(redact(str(error), secrets), file=sys.stderr)
        return 2


if __name__ == "__main__":
    raise SystemExit(main())
