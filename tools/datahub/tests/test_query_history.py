from __future__ import annotations

import hashlib
from dataclasses import replace
from pathlib import Path

import pytest

from lineageguard_datahub.models import ExpectedGraph
from lineageguard_datahub.query_history import (
    QueryPolicyError,
    execute_query,
    plan_query_execution,
)


class RecordingCursor:
    def __init__(self, *, observed: bool) -> None:
        self.observed = observed
        self.commands: list[tuple[str, tuple[object, ...] | None]] = []

    @property
    def rowcount(self) -> int:
        return 2

    def execute(self, query: str, params: tuple[object, ...] | None = None) -> object:
        self.commands.append((query, params))
        return self

    def fetchall(self) -> list[object]:
        return [("customer-1", 200), ("customer-2", 100)]

    def fetchone(self) -> tuple[object, ...]:
        return (self.observed,)


def test_only_checked_read_query_is_planned(
    expected_graph: ExpectedGraph, repository_root: Path
) -> None:
    expected = expected_graph.query_evidence[0]
    plan = plan_query_execution(repository_root / expected.sql_path, expected)
    assert plan.marker == "lineageguard:finance-monthly-close"
    assert plan.sha256 == expected.sha256
    assert len(plan.normalized_fingerprint) == 64


def test_mutating_query_is_rejected(expected_graph: ExpectedGraph, tmp_path: Path) -> None:
    statement = "-- lineageguard:finance-monthly-close\nDELETE FROM commerce.orders;\n"
    path = tmp_path / "unsafe.sql"
    path.write_text(statement)
    expected = replace(
        expected_graph.query_evidence[0],
        sha256=hashlib.sha256(statement.encode()).hexdigest(),
    )
    with pytest.raises(QueryPolicyError, match="QUERY_NOT_READ_ONLY"):
        plan_query_execution(path, expected)


def test_query_digest_change_is_rejected(expected_graph: ExpectedGraph, tmp_path: Path) -> None:
    path = tmp_path / "changed.sql"
    path.write_text("-- lineageguard:finance-monthly-close\nSELECT 1;\n")
    with pytest.raises(QueryPolicyError, match="QUERY_DIGEST_MISMATCH"):
        plan_query_execution(path, expected_graph.query_evidence[0])


def test_execution_requires_pg_stat_statements_evidence(
    expected_graph: ExpectedGraph, repository_root: Path
) -> None:
    expected = expected_graph.query_evidence[0]
    plan = plan_query_execution(repository_root / expected.sql_path, expected)
    missing = RecordingCursor(observed=False)
    with pytest.raises(QueryPolicyError, match="QUERY_HISTORY_NOT_OBSERVED"):
        execute_query(missing, plan)
    observed = RecordingCursor(observed=True)
    receipt = execute_query(observed, plan)
    assert receipt.row_count == 2
    assert observed.commands[-1][1] == (f"%{plan.marker}%",)
