from __future__ import annotations

from collections.abc import Mapping, Sequence
from dataclasses import dataclass
from pathlib import Path
from typing import Protocol

from psycopg import sql

from lineageguard_datahub.paths import resolve_checked_file

WAREHOUSE_DATABASE = "lineageguard"
WAREHOUSE_FILE_DIGESTS = {
    "walkthrough/warehouse/init/001-schemas.sql": (
        "345034506de27a26e5fad5e72f9a0241640a8028f8b9ade8317041310a8945d2"
    ),
    "walkthrough/warehouse/init/002-tables.sql": (
        "f2f2a9e19b74bd70b730942ae43250dc65b338e8b41a9416c1bed3fab64fb73b"
    ),
    "walkthrough/warehouse/init/003-seed.sql": (
        "05f7a51d792940beab0df5ef005c313aaf76368dac0f67f18795db074d2974f8"
    ),
}
CANONICAL_RELATIONS = (
    "commerce.orders",
    "analytics.stg_orders",
    "analytics.customer_revenue",
    "fraud.customer_features",
)


class SqlCursor(Protocol):
    def execute(
        self,
        query: str | bytes | sql.SQL | sql.Composed,
        params: Sequence[object] | Mapping[str, object] | None = None,
    ) -> object: ...
    def fetchone(self) -> Sequence[object] | None: ...


@dataclass(frozen=True, slots=True)
class WarehouseSeedPlan:
    sql_paths: tuple[Path, ...]


def build_warehouse_seed_plan(root: Path) -> WarehouseSeedPlan:
    paths = tuple(
        resolve_checked_file(root, relative, digest, maximum_bytes=32 * 1024)
        for relative, digest in WAREHOUSE_FILE_DIGESTS.items()
    )
    return WarehouseSeedPlan(sql_paths=paths)


def _scalar(cursor: SqlCursor, query: str, params: tuple[object, ...] | None = None) -> object:
    cursor.execute(query, params)
    row = cursor.fetchone()
    if row is None or len(row) != 1:
        raise ValueError("WAREHOUSE_PREFLIGHT_RESULT_INVALID")
    return row[0]


def apply_warehouse_seed(
    cursor: SqlCursor,
    plan: WarehouseSeedPlan,
    *,
    ownership_nonce: str,
    query_password: str,
    ingest_password: str,
    seed_password: str,
    dbt_password: str,
) -> None:
    if _scalar(cursor, "SELECT current_database()") != WAREHOUSE_DATABASE:
        raise ValueError("WAREHOUSE_DATABASE_IDENTITY_MISMATCH")
    marker = _scalar(
        cursor,
        "SELECT to_regclass('lineageguard_control.scenario_registry')::text",
    )
    if marker is None:
        conflicts = _scalar(
            cursor,
            "SELECT (SELECT count(*) FROM pg_namespace "
            "WHERE nspname IN ('commerce','analytics','fraud')) + "
            "(SELECT count(*) FROM pg_roles WHERE rolname IN "
            "('lineageguard_reader','lineageguard_query','lineageguard_ingest',"
            "'lineageguard_seed','lineageguard_dbt'))",
        )
        if int(str(conflicts)) != 0:
            raise ValueError("WAREHOUSE_PREEXISTING_OBJECTS")
        cursor.execute("CREATE SCHEMA lineageguard_control")
        cursor.execute(
            "CREATE TABLE lineageguard_control.scenario_registry ("
            "scenario_id text PRIMARY KEY, ownership_nonce text NOT NULL, "
            "created_at timestamptz NOT NULL)"
        )
        cursor.execute(
            "INSERT INTO lineageguard_control.scenario_registry "
            "(scenario_id, ownership_nonce, created_at) VALUES (%s, %s, CURRENT_TIMESTAMP)",
            ("canonical-customer-id-rename", ownership_nonce),
        )
        for path in plan.sql_paths[:2]:
            cursor.execute(path.read_text(encoding="utf-8"))
    else:
        registered = _scalar(
            cursor,
            "SELECT ownership_nonce FROM lineageguard_control.scenario_registry "
            "WHERE scenario_id = %s",
            ("canonical-customer-id-rename",),
        )
        if registered != ownership_nonce:
            raise ValueError("WAREHOUSE_OWNERSHIP_MISMATCH")
    cursor.execute(
        "DO $$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'lineageguard_reader') "
        "THEN CREATE ROLE lineageguard_reader NOLOGIN NOSUPERUSER NOCREATEDB "
        "NOCREATEROLE NOINHERIT; "
        "END IF; END $$"
    )
    cursor.execute(
        "ALTER ROLE lineageguard_reader NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE "
        "NOREPLICATION NOINHERIT"
    )
    for role, password in (
        ("lineageguard_query", query_password),
        ("lineageguard_ingest", ingest_password),
    ):
        cursor.execute(
            f"DO $$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = '{role}') "
            f"THEN CREATE ROLE {role} LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE INHERIT; "
            "END IF; END $$"
        )
        cursor.execute(
            sql.SQL(
                "ALTER ROLE {} LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE "
                "NOREPLICATION INHERIT PASSWORD {}"
            ).format(sql.Identifier(role), sql.Literal(password))
        )
        cursor.execute(f"GRANT lineageguard_reader TO {role}")
        role_safe = _scalar(
            cursor,
            "SELECT rolcanlogin AND NOT rolsuper AND NOT rolcreatedb AND NOT rolcreaterole "
            "AND NOT rolreplication AND pg_has_role(%s, 'lineageguard_reader', 'MEMBER') "
            "FROM pg_roles WHERE rolname = %s",
            (role, role),
        )
        if role_safe is not True:
            raise ValueError(f"WAREHOUSE_ROLE_UNSAFE:{role}")
    cursor.execute(
        "DO $$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'lineageguard_seed') "
        "THEN CREATE ROLE lineageguard_seed LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE INHERIT; "
        "END IF; END $$"
    )
    cursor.execute(
        sql.SQL(
            "ALTER ROLE {} LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE "
            "NOREPLICATION INHERIT PASSWORD {}"
        ).format(sql.Identifier("lineageguard_seed"), sql.Literal(seed_password))
    )
    seed_safe = _scalar(
        cursor,
        "SELECT rolcanlogin AND NOT rolsuper AND NOT rolcreatedb AND NOT rolcreaterole "
        "AND NOT rolreplication FROM pg_roles WHERE rolname = 'lineageguard_seed'",
    )
    if seed_safe is not True:
        raise ValueError("WAREHOUSE_ROLE_UNSAFE:lineageguard_seed")
    cursor.execute(
        "DO $$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'lineageguard_dbt') "
        "THEN CREATE ROLE lineageguard_dbt LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE INHERIT; "
        "END IF; END $$"
    )
    cursor.execute(
        sql.SQL(
            "ALTER ROLE {} LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE "
            "NOREPLICATION INHERIT PASSWORD {}"
        ).format(sql.Identifier("lineageguard_dbt"), sql.Literal(dbt_password))
    )
    dbt_safe = _scalar(
        cursor,
        "SELECT rolcanlogin AND NOT rolsuper AND NOT rolcreatedb AND NOT rolcreaterole "
        "AND NOT rolreplication FROM pg_roles WHERE rolname = 'lineageguard_dbt'",
    )
    if dbt_safe is not True:
        raise ValueError("WAREHOUSE_ROLE_UNSAFE:lineageguard_dbt")
    cursor.execute("GRANT USAGE ON SCHEMA commerce, analytics, fraud TO lineageguard_reader")
    cursor.execute("GRANT SELECT ON commerce.orders TO lineageguard_reader")
    cursor.execute("GRANT pg_read_all_stats TO lineageguard_reader")
    cursor.execute("GRANT USAGE ON SCHEMA commerce TO lineageguard_seed")
    cursor.execute("GRANT SELECT, INSERT ON commerce.orders TO lineageguard_seed")
    cursor.execute("GRANT USAGE ON SCHEMA lineageguard_control TO lineageguard_seed")
    cursor.execute("GRANT SELECT ON lineageguard_control.scenario_registry TO lineageguard_seed")
    cursor.execute(f"GRANT CONNECT ON DATABASE {WAREHOUSE_DATABASE} TO lineageguard_dbt")
    cursor.execute("GRANT USAGE ON SCHEMA commerce TO lineageguard_dbt")
    cursor.execute("GRANT SELECT ON commerce.orders TO lineageguard_dbt")
    cursor.execute("GRANT USAGE, CREATE ON SCHEMA analytics, fraud TO lineageguard_dbt")


def apply_warehouse_rows(
    cursor: SqlCursor,
    plan: WarehouseSeedPlan,
    *,
    ownership_nonce: str,
) -> None:
    if _scalar(cursor, "SELECT current_database()") != WAREHOUSE_DATABASE:
        raise ValueError("WAREHOUSE_DATABASE_IDENTITY_MISMATCH")
    registered = _scalar(
        cursor,
        "SELECT ownership_nonce FROM lineageguard_control.scenario_registry WHERE scenario_id = %s",
        ("canonical-customer-id-rename",),
    )
    if registered != ownership_nonce:
        raise ValueError("WAREHOUSE_OWNERSHIP_MISMATCH")
    row_count = int(str(_scalar(cursor, "SELECT count(*) FROM commerce.orders")))
    if row_count == 0:
        cursor.execute(plan.sql_paths[2].read_text(encoding="utf-8"))
        return
    seed_exact = _scalar(
        cursor,
        "SELECT count(*) = 4 AND count(*) FILTER (WHERE "
        "(order_id::text, customer_id::text, order_total, ordered_at) IN ("
        "('10000000-0000-0000-0000-000000000001','20000000-0000-0000-0000-000000000001',125.00,'2026-07-01T09:00:00Z'),"
        "('10000000-0000-0000-0000-000000000002','20000000-0000-0000-0000-000000000001',75.50,'2026-07-02T10:15:00Z'),"
        "('10000000-0000-0000-0000-000000000003','20000000-0000-0000-0000-000000000002',310.25,'2026-07-03T11:30:00Z'),"
        "('10000000-0000-0000-0000-000000000004',"
        "'20000000-0000-0000-0000-000000000003',42.00,"
        "'2026-07-04T12:45:00Z'))) = 4 FROM commerce.orders",
    )
    if seed_exact is not True:
        raise ValueError("WAREHOUSE_SEED_CONTENT_MISMATCH")


def verify_dbt_role(cursor: SqlCursor) -> None:
    checks = _scalar(
        cursor,
        "SELECT current_user = 'lineageguard_dbt' "
        "AND NOT rolsuper AND NOT rolcreatedb AND NOT rolcreaterole AND NOT rolreplication "
        "AND has_database_privilege(current_user, 'lineageguard', 'CONNECT') "
        "AND has_schema_privilege(current_user, 'commerce', 'USAGE') "
        "AND has_table_privilege(current_user, 'commerce.orders', 'SELECT') "
        "AND NOT COALESCE(has_table_privilege(current_user, 'commerce.orders', "
        "'INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER'), false) "
        "AND has_schema_privilege(current_user, 'analytics', 'USAGE,CREATE') "
        "AND has_schema_privilege(current_user, 'fraud', 'USAGE,CREATE') "
        "FROM pg_roles WHERE rolname = current_user",
    )
    if checks is not True:
        raise ValueError("DBT_POSTGRES_ROLE_UNSAFE")
