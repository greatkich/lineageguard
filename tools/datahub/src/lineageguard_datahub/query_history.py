from __future__ import annotations

import hashlib
import re
from collections.abc import Sequence
from dataclasses import dataclass
from pathlib import Path
from typing import Protocol

from lineageguard_datahub.models import QueryEvidence


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


def plan_query_execution(path: Path, expected: QueryEvidence) -> QueryExecutionPlan:
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
    fingerprint = hashlib.sha256(normalized.encode()).hexdigest()
    return QueryExecutionPlan(expected.marker, digest, fingerprint, statement)


def execute_query(cursor: Cursor, plan: QueryExecutionPlan) -> QueryExecutionReceipt:
    cursor.execute("SET LOCAL TRANSACTION READ ONLY")
    cursor.execute("SET LOCAL statement_timeout = '5s'")
    cursor.execute(plan.statement)
    rows = cursor.fetchall()
    cursor.execute(
        "SELECT EXISTS (SELECT 1 FROM pg_stat_statements WHERE query LIKE %s)",
        (f"%{plan.marker}%",),
    )
    observed = cursor.fetchone()
    if observed is None or not observed or observed[0] is not True:
        raise QueryPolicyError("QUERY_HISTORY_NOT_OBSERVED")
    return QueryExecutionReceipt(
        marker=plan.marker,
        sha256=plan.sha256,
        normalized_fingerprint=plan.normalized_fingerprint,
        row_count=len(rows),
    )
