from __future__ import annotations

import json
import shutil
from pathlib import Path

import pytest

from lineageguard_datahub.expected_graph import load_expected_graph
from lineageguard_datahub.ingestion import CANONICAL_DBT_NODES, CANONICAL_DBT_RELATIONS
from lineageguard_datahub.models import ExpectedGraph


@pytest.fixture(scope="session")
def repository_root(tmp_path_factory: pytest.TempPathFactory) -> Path:
    """Private canonical tree with deterministic dbt artifacts for provenance tests."""
    source = Path(__file__).resolve().parents[3]
    root = tmp_path_factory.mktemp("canonical-repository")
    shutil.copytree(
        source / "walkthrough",
        root / "walkthrough",
        ignore=shutil.ignore_patterns(".state", "target", "logs", ".user.yml"),
    )
    nodes = {
        node: {"database": relation[0], "schema": relation[1], "alias": relation[2]}
        for node, relation in CANONICAL_DBT_RELATIONS.items()
    }
    payloads = {
        "manifest.json": {"nodes": nodes},
        "run_results.json": {
            "results": [
                {"unique_id": node, "status": "success"} for node in sorted(CANONICAL_DBT_NODES)
            ]
        },
        "catalog.json": {"nodes": nodes},
    }
    target = root / "walkthrough/dbt/target"
    target.mkdir(parents=True)
    for name, payload in payloads.items():
        (target / name).write_text(json.dumps(payload, sort_keys=True))
    return root


@pytest.fixture(scope="session")
def expected_graph(repository_root: Path) -> ExpectedGraph:
    return load_expected_graph(
        repository_root / "walkthrough/scenarios/canonical/expected-datahub-graph.json"
    )
