from __future__ import annotations

from pathlib import Path

import pytest

from lineageguard_datahub.expected_graph import load_expected_graph
from lineageguard_datahub.models import ExpectedGraph


@pytest.fixture(scope="session")
def repository_root() -> Path:
    return Path(__file__).resolve().parents[3]


@pytest.fixture(scope="session")
def expected_graph(repository_root: Path) -> ExpectedGraph:
    return load_expected_graph(
        repository_root / "walkthrough/scenarios/canonical/expected-datahub-graph.json"
    )
