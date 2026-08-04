from __future__ import annotations

from dataclasses import dataclass
from pathlib import Path
from typing import Protocol


class SqlCursor(Protocol):
    def execute(self, query: str) -> object: ...


@dataclass(frozen=True, slots=True)
class WarehouseSeedPlan:
    sql_paths: tuple[Path, ...]


def build_warehouse_seed_plan(root: Path) -> WarehouseSeedPlan:
    init_dir = root / "walkthrough/warehouse/init"
    paths = tuple(sorted(init_dir.glob("[0-9][0-9][0-9]-*.sql")))
    expected_names = ("001-schemas.sql", "002-tables.sql", "003-seed.sql")
    if tuple(path.name for path in paths) != expected_names:
        raise ValueError("WAREHOUSE_SEED_FILES_MISMATCH")
    return WarehouseSeedPlan(sql_paths=paths)


def apply_warehouse_seed(cursor: SqlCursor, plan: WarehouseSeedPlan) -> None:
    for path in plan.sql_paths:
        cursor.execute(path.read_text(encoding="utf-8"))
