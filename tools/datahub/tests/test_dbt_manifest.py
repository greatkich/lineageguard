from __future__ import annotations

import json
import os
from pathlib import Path

from dbt.cli.main import dbtRunner

from lineageguard_datahub.models import ExpectedGraph


def test_dbt_parse_relations_match_expected_graph(
    expected_graph: ExpectedGraph,
    repository_root: Path,
    tmp_path: Path,
) -> None:
    environment = {
        "WALKTHROUGH_POSTGRES_HOST": "127.0.0.1",
        "WALKTHROUGH_POSTGRES_PORT": "5432",
        "WALKTHROUGH_POSTGRES_USER": "lineageguard",
        "WALKTHROUGH_POSTGRES_PASSWORD": "placeholder",
        "WALKTHROUGH_POSTGRES_DATABASE": "lineageguard",
        "WALKTHROUGH_POSTGRES_SSLMODE": "disable",
    }
    old_environment = dict(os.environ)
    os.environ.update(environment)
    try:
        project = repository_root / "walkthrough/dbt"
        target = tmp_path / "target"
        result = dbtRunner().invoke(
            [
                "parse",
                "--project-dir",
                str(project),
                "--profiles-dir",
                str(project),
                "--target-path",
                str(target),
                "--no-partial-parse",
            ]
        )
    finally:
        os.environ.clear()
        os.environ.update(old_environment)
    assert result.success is True
    manifest = json.loads((target / "manifest.json").read_text())
    expected = {
        "model.lineageguard_walkthrough.stg_orders": ("lineageguard", "analytics", "stg_orders"),
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
    for unique_id, relation in expected.items():
        node = manifest["nodes"][unique_id]
        assert (node["database"], node["schema"], node["alias"]) == relation
