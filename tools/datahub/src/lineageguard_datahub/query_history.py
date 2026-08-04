from __future__ import annotations

import hashlib
import re
from collections.abc import Sequence
from dataclasses import dataclass
from pathlib import Path
from typing import Protocol, cast

from lineageguard_datahub.models import QueryEvidence
from lineageguard_datahub.paths import resolve_checked_file

CANONICAL_NORMALIZED_SQL = (
    "select customer_id, lifetime_revenue from analytics.customer_revenue "
    "where lifetime_revenue >= 100 order by lifetime_revenue desc"
)
CANONICAL_PG_STAT_SQL = (
    "select customer_id, lifetime_revenue from analytics.customer_revenue "
    "where lifetime_revenue >= $1 order by lifetime_revenue desc"
)


class QueryPolicyError(ValueError):
    """A query is not the exact allowlisted canonical read."""


@dataclass(frozen=True, slots=True)
class QueryExecutionPlan:
    marker: str
    sha256: str
    normalized_fingerprint: str
    statement: str


@dataclass(frozen=True, slots=True)
class QueryExecutionReceipt:
    marker: str
    sha256: str
    normalized_fingerprint: str
    row_count: int
    query_id: str
    execution_count: int
    total_exec_time_ms: float


class Cursor(Protocol):
    @property
    def rowcount(self) -> int: ...

    def execute(self, query: str, params: tuple[object, ...] | None = None) -> object: ...

    def fetchall(self) -> Sequence[object]: ...

    def fetchone(self) -> Sequence[object] | None: ...


def _without_comments(statement: str) -> str:
    without_blocks = re.sub(r"/\*.*?\*/", " ", statement, flags=re.DOTALL)
    return re.sub(r"--[^\n]*", " ", without_blocks)


def _normalized(statement: str) -> str:
    return " ".join(_without_comments(statement).split()).rstrip(";").lower()


def normalized_sql_fingerprint(statement: str) -> str:
    return hashlib.sha256(_normalized(statement).encode()).hexdigest()


def plan_query_execution(root: Path, expected: QueryEvidence) -> QueryExecutionPlan:
    try:
        path = resolve_checked_file(root, expected.sql_path, expected.sha256)
    except ValueError as error:
        raise QueryPolicyError(str(error)) from error
    statement = path.read_text(encoding="utf-8")
    digest = hashlib.sha256(statement.encode()).hexdigest()
    if digest != expected.sha256:
        raise QueryPolicyError("QUERY_DIGEST_MISMATCH")
    if expected.marker not in statement:
        raise QueryPolicyError("QUERY_MARKER_MISSING")
    normalized = _normalized(statement)
    if not normalized.startswith("select "):
        raise QueryPolicyError("QUERY_NOT_READ_ONLY")
    if ";" in normalized:
        raise QueryPolicyError("MULTIPLE_STATEMENTS_DENIED")
    if normalized != CANONICAL_NORMALIZED_SQL:
        raise QueryPolicyError("QUERY_SHAPE_MISMATCH")
    fingerprint = normalized_sql_fingerprint(statement)
    return QueryExecutionPlan(expected.marker, digest, fingerprint, statement)


def execute_query(cursor: Cursor, plan: QueryExecutionPlan) -> QueryExecutionReceipt:
    cursor.execute("SET LOCAL TRANSACTION READ ONLY")
    cursor.execute("SET LOCAL statement_timeout = '5s'")
    cursor.execute(
        "SELECT current_user = 'lineageguard_query', "
        "current_setting('transaction_read_only') = 'on', NOT rolsuper, "
        "NOT rolcreatedb, NOT rolcreaterole, NOT rolreplication, "
        "pg_has_role(current_user, 'lineageguard_reader', 'MEMBER'), "
        "has_table_privilege(current_user, 'analytics.customer_revenue', 'SELECT'), "
        "NOT COALESCE(has_table_privilege(current_user, 'commerce.orders', "
        "'INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER'), false), "
        "NOT COALESCE(has_table_privilege(current_user, 'analytics.stg_orders', "
        "'INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER'), false), "
        "NOT COALESCE(has_table_privilege(current_user, 'analytics.customer_revenue', "
        "'INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER'), false), "
        "NOT COALESCE(has_table_privilege(current_user, 'fraud.customer_features', "
        "'INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER'), false) "
        "FROM pg_roles WHERE rolname = current_user"
    )
    role_check = cursor.fetchone()
    if (
        role_check is None
        or len(role_check) != 12
        or not all(value is True for value in role_check)
    ):
        raise QueryPolicyError("QUERY_ROLE_NOT_READ_ONLY")
    cursor.execute(plan.statement)
    rows = cursor.fetchall()
    cursor.execute(
        "SELECT queryid::text, calls::bigint, total_exec_time::double precision, query "
        "FROM pg_stat_statements WHERE query LIKE %s ORDER BY calls DESC LIMIT 1",
        (f"%{plan.marker}%",),
    )
    observed = cursor.fetchone()
    if observed is None or len(observed) != 4:
        raise QueryPolicyError("QUERY_HISTORY_NOT_OBSERVED")
    if _normalized(str(observed[3])) != CANONICAL_PG_STAT_SQL:
        raise QueryPolicyError("QUERY_HISTORY_FINGERPRINT_MISMATCH")
    execution_count = int(cast(str | int, observed[1]))
    total_exec_time_ms = float(cast(str | int | float, observed[2]))
    if execution_count < 1 or total_exec_time_ms < 0:
        raise QueryPolicyError("QUERY_HISTORY_METRICS_INVALID")
    return QueryExecutionReceipt(
        marker=plan.marker,
        sha256=plan.sha256,
        normalized_fingerprint=plan.normalized_fingerprint,
        row_count=len(rows),
        query_id=str(observed[0]),
        execution_count=execution_count,
        total_exec_time_ms=total_exec_time_ms,
    )
