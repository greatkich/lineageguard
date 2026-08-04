from __future__ import annotations

import os
from collections.abc import Sequence
from dataclasses import dataclass
from pathlib import Path
from typing import Protocol

from lineageguard_datahub.config import DataHubConfig, PostgresConfig
from lineageguard_datahub.paths import resolve_checked_file

RECIPE_DIGESTS = {
    "walkthrough/metadata/postgres-ingestion.yml": (
        "b381fc2fa4eaadcc3a8fd22f2ef8e940e7eddedc949dd9f93830c02d1eb8c84b"
    ),
    "walkthrough/metadata/dbt-ingestion.yml": (
        "5af8ebb5543e86d504db2dcd9cf9f3e4e6a19b490a1daa41a4d95e7405519bc5"
    ),
}
REQUIRED_POSTGRES_RECIPE_TEXT = (
    "${WALKTHROUGH_INGEST_POSTGRES_USER}",
    "${WALKTHROUGH_INGEST_POSTGRES_PASSWORD}",
    "${WALKTHROUGH_POSTGRES_SSLMODE}",
    "^commerce\\\\.orders$",
    "^analytics\\\\.stg_orders$",
    "^analytics\\\\.customer_revenue$",
    "^fraud\\\\.customer_features$",
)
RUNTIME_ENV = ("PATH", "LANG", "LC_ALL", "SSL_CERT_FILE", "REQUESTS_CA_BUNDLE")


class IngestionCursor(Protocol):
    def execute(self, query: str) -> object: ...
    def fetchone(self) -> Sequence[object] | None: ...


@dataclass(frozen=True, slots=True)
class IngestionRecipe:
    path: Path
    relative_path: str
    sha256: str


def build_ingestion_plan(root: Path) -> tuple[IngestionRecipe, ...]:
    recipes: list[IngestionRecipe] = []
    for relative, digest in RECIPE_DIGESTS.items():
        path = resolve_checked_file(root, relative, digest, maximum_bytes=32 * 1024)
        text = path.read_text(encoding="utf-8")
        if "${DATAHUB_GMS_URL}" not in text or "${DATAHUB_INGEST_TOKEN}" not in text:
            raise ValueError("INGEST_RECIPE_TARGET_PLACEHOLDERS_MISSING")
        if path.name == "postgres-ingestion.yml" and not all(
            marker in text for marker in REQUIRED_POSTGRES_RECIPE_TEXT
        ):
            raise ValueError("POSTGRES_RECIPE_SCOPE_MISMATCH")
        recipes.append(IngestionRecipe(path, relative, digest))
    return tuple(recipes)


def ingestion_environment(
    datahub: DataHubConfig,
    postgres: PostgresConfig,
    environ: dict[str, str] | None = None,
) -> dict[str, str]:
    values = os.environ if environ is None else environ
    if datahub.credential_kind != "ingest" or postgres.credential_kind != "ingest":
        raise ValueError("INGEST_CREDENTIAL_PURPOSE_MISMATCH")
    child = {key: values[key] for key in RUNTIME_ENV if key in values}
    child.update(
        {
            "DATAHUB_GMS_URL": datahub.server,
            "DATAHUB_INGEST_TOKEN": datahub.token or "",
            "WALKTHROUGH_POSTGRES_HOST": postgres.host,
            "WALKTHROUGH_POSTGRES_PORT": str(postgres.port),
            "WALKTHROUGH_POSTGRES_DATABASE": postgres.database,
            "WALKTHROUGH_POSTGRES_SSLMODE": postgres.sslmode,
            "WALKTHROUGH_INGEST_POSTGRES_USER": postgres.user,
            "WALKTHROUGH_INGEST_POSTGRES_PASSWORD": postgres.password,
        }
    )
    return child


def verify_ingestion_role(cursor: IngestionCursor) -> None:
    cursor.execute("SET LOCAL TRANSACTION READ ONLY")
    select_checks = ", ".join(
        f"has_table_privilege(current_user, '{relation}', 'SELECT')"
        for relation in (
            "commerce.orders",
            "analytics.stg_orders",
            "analytics.customer_revenue",
            "fraud.customer_features",
        )
    )
    write_checks = ", ".join(
        f"NOT COALESCE(has_table_privilege(current_user, '{relation}', "
        "'INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER'), false)"
        for relation in (
            "commerce.orders",
            "analytics.stg_orders",
            "analytics.customer_revenue",
            "fraud.customer_features",
        )
    )
    cursor.execute(
        "SELECT current_user = 'lineageguard_ingest', "
        "current_setting('transaction_read_only') = 'on', NOT rolsuper, NOT rolcreatedb, "
        "NOT rolcreaterole, NOT rolreplication, "
        "pg_has_role(current_user, 'lineageguard_reader', 'MEMBER'), "
        f"{select_checks}, {write_checks} FROM pg_roles WHERE rolname = current_user"
    )
    result = cursor.fetchone()
    if result is None or len(result) != 15 or not all(value is True for value in result):
        raise ValueError("INGEST_POSTGRES_ROLE_NOT_READ_ONLY")
