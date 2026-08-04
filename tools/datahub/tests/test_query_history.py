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
    def __init__(
        self,
        *,
        observed: bool,
        read_only_role: bool = True,
        observed_statement: str | None = None,
    ) -> None:
        self.observed = observed
        self.read_only_role = read_only_role
        self.observed_statement = observed_statement
        self.commands: list[tuple[str, tuple[object, ...] | None]] = []
        self.fetchone_calls = 0

    @property
    def rowcount(self) -> int:
        return 2

    def execute(self, query: str, params: tuple[object, ...] | None = None) -> object:
        self.commands.append((query, params))
        return self

    def fetchall(self) -> list[object]:
        return [("customer-1", 200), ("customer-2", 100)]

    def fetchone(self) -> tuple[object, ...]:
        self.fetchone_calls += 1
        if self.fetchone_calls == 1:
            return (self.read_only_role,) * 16
        if self.observed:
            statement = self.observed_statement or self.commands[3][0].replace("100", "$1")
            return ("48291", 3, 1.25, statement, "16384", "16390")
        return ()


def test_only_checked_read_query_is_planned(
    expected_graph: ExpectedGraph, repository_root: Path
) -> None:
    expected = expected_graph.query_evidence[0]
    plan = plan_query_execution(repository_root, expected)
    assert plan.marker == "lineageguard:finance-monthly-close"
    assert plan.sha256 == expected.sha256
    assert len(plan.normalized_fingerprint) == 64


def test_mutating_query_is_rejected(expected_graph: ExpectedGraph, tmp_path: Path) -> None:
    statement = "-- lineageguard:finance-monthly-close\nDELETE FROM commerce.orders;\n"
    path = tmp_path / "unsafe.sql"
    path.write_text(statement)
    expected = replace(
        expected_graph.query_evidence[0],
        sql_path="unsafe.sql",
        sha256=hashlib.sha256(statement.encode()).hexdigest(),
    )
    with pytest.raises(QueryPolicyError, match="QUERY_NOT_READ_ONLY"):
        plan_query_execution(tmp_path, expected)


def test_query_digest_change_is_rejected(expected_graph: ExpectedGraph, tmp_path: Path) -> None:
    path = tmp_path / "changed.sql"
    path.write_text("-- lineageguard:finance-monthly-close\nSELECT 1;\n")
    with pytest.raises(QueryPolicyError, match="CHECKED_FILE_DIGEST_MISMATCH"):
        plan_query_execution(
            tmp_path,
            replace(expected_graph.query_evidence[0], sql_path="changed.sql"),
        )


def test_execution_requires_pg_stat_statements_evidence(
    expected_graph: ExpectedGraph, repository_root: Path
) -> None:
    expected = expected_graph.query_evidence[0]
    plan = plan_query_execution(repository_root, expected)
    missing = RecordingCursor(observed=False)
    with pytest.raises(QueryPolicyError, match="QUERY_HISTORY_NOT_OBSERVED"):
        execute_query(missing, plan)
    observed = RecordingCursor(observed=True)
    receipt = execute_query(observed, plan)
    assert receipt.row_count == 2
    assert observed.commands[-1][1] == (f"%{plan.marker}%",)
    assert receipt.execution_count == 3
    assert receipt.total_exec_time_ms == 1.25
    assert receipt.database_id == "16384"
    assert receipt.user_id == "16390"
    pg_stat_sql = observed.commands[-1][0]
    assert "dbid = (SELECT oid FROM pg_database WHERE datname = current_database())" in pg_stat_sql
    assert "userid = (SELECT oid FROM pg_roles WHERE rolname = current_user)" in pg_stat_sql
    role_sql = observed.commands[2][0]
    assert "pg_has_role" in role_sql
    assert "current_user = 'lineageguard_query'" in role_sql
    for relation in ("commerce.orders", "analytics.stg_orders", "fraud.customer_features"):
        assert relation in role_sql
    assert "lineageguard_query_reader" in role_sql
    assert "pg_read_all_stats" in role_sql


def test_execution_rejects_privileged_role(
    expected_graph: ExpectedGraph, repository_root: Path
) -> None:
    plan = plan_query_execution(repository_root, expected_graph.query_evidence[0])
    with pytest.raises(QueryPolicyError, match="QUERY_ROLE_NOT_READ_ONLY"):
        execute_query(RecordingCursor(observed=True, read_only_role=False), plan)


def test_execution_rejects_different_pg_stat_statement(
    expected_graph: ExpectedGraph, repository_root: Path
) -> None:
    plan = plan_query_execution(repository_root, expected_graph.query_evidence[0])
    with pytest.raises(QueryPolicyError, match="QUERY_HISTORY_FINGERPRINT_MISMATCH"):
        execute_query(
            RecordingCursor(
                observed=True,
                observed_statement=(
                    "-- lineageguard:finance-monthly-close\n"
                    "SELECT customer_id FROM analytics.customer_revenue WHERE "
                    "lifetime_revenue >= $1"
                ),
            ),
            plan,
        )
