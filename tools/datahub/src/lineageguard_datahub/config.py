from __future__ import annotations

import hashlib
import os
from dataclasses import dataclass, field
from ipaddress import ip_address
from urllib.parse import quote, urlsplit


class ConfigurationError(ValueError):
    """Required configuration is missing or unsafe."""


CANONICAL_GMS_URL = "http://127.0.0.1:8080"


@dataclass(frozen=True, slots=True)
class DataHubConfig:
    server: str
    token: str | None = field(repr=False)
    remote: bool = False
    credential_kind: str = "read"


@dataclass(frozen=True, slots=True)
class PostgresConfig:
    host: str
    port: int
    user: str
    password: str = field(repr=False)
    database: str
    sslmode: str
    remote: bool = False
    credential_kind: str = "application"

    @property
    def dsn(self) -> str:
        return (
            f"postgresql://{quote(self.user, safe='')}:{quote(self.password, safe='')}"
            f"@{self.host}:{self.port}/{quote(self.database, safe='')}"
            f"?sslmode={quote(self.sslmode, safe='')}"
        )

    @property
    def target_fingerprint(self) -> str:
        identity = f"postgres|{self.host}|{self.port}|{self.database}|{self.sslmode}"
        return hashlib.sha256(identity.encode()).hexdigest()


def _required(name: str, environ: dict[str, str]) -> str:
    value = environ.get(name)
    if value is None or not value.strip():
        raise ConfigurationError(f"MISSING_ENV:{name}")
    if len(value) > 4096:
        raise ConfigurationError(f"ENV_TOO_LARGE:{name}")
    return value


def _is_loopback(host: str | None) -> bool:
    if host is None:
        return False
    if host.lower() == "localhost":
        return True
    try:
        return ip_address(host).is_loopback
    except ValueError:
        return False


def _require_distinct_datahub_tokens(values: dict[str, str]) -> None:
    tokens = [
        value
        for name in (
            "DATAHUB_READ_TOKEN",
            "DATAHUB_INGEST_TOKEN",
            "DATAHUB_MUTATION_TOKEN",
            "DATAHUB_BOOTSTRAP_TOKEN",
        )
        if (value := values.get(name)) is not None and value != ""
    ]
    if len(tokens) != len(set(tokens)):
        raise ConfigurationError("DATAHUB_CREDENTIAL_REUSE_DENIED")


def load_datahub_config(
    environ: dict[str, str] | None = None,
    *,
    write: bool = False,
    ingest: bool = False,
    bootstrap: bool = False,
) -> DataHubConfig:
    if sum((write, ingest, bootstrap)) > 1:
        raise ConfigurationError("DATAHUB_CREDENTIAL_PURPOSE_CONFLICT")
    values = dict(os.environ if environ is None else environ)
    _require_distinct_datahub_tokens(values)
    server = _required("DATAHUB_GMS_URL", values)
    parsed = urlsplit(server)
    if parsed.scheme not in {"http", "https"} or parsed.hostname is None:
        raise ConfigurationError("DATAHUB_GMS_URL_INVALID")
    if (
        parsed.username is not None
        or parsed.password is not None
        or parsed.query
        or parsed.fragment
    ):
        raise ConfigurationError("DATAHUB_GMS_URL_UNSAFE_COMPONENT")
    if parsed.path not in {"", "/"}:
        raise ConfigurationError("DATAHUB_GMS_URL_PATH_DENIED")
    if server != CANONICAL_GMS_URL:
        raise ConfigurationError("CANONICAL_DATAHUB_GMS_URL_REQUIRED")
    credential_kind = (
        "bootstrap" if bootstrap else ("ingest" if ingest else ("mutation" if write else "read"))
    )
    token_name = {
        "read": "DATAHUB_READ_TOKEN",
        "mutation": "DATAHUB_MUTATION_TOKEN",
        "ingest": "DATAHUB_INGEST_TOKEN",
        "bootstrap": "DATAHUB_BOOTSTRAP_TOKEN",
    }[credential_kind]
    token = values.get(token_name) or None
    if token is None:
        raise ConfigurationError(f"{token_name}_REQUIRED")
    return DataHubConfig(
        server=server,
        token=token,
        remote=False,
        credential_kind=credential_kind,
    )


def load_postgres_config(
    environ: dict[str, str] | None = None,
    *,
    query_role: bool = False,
    ingest_role: bool = False,
    dbt_role: bool = False,
    admin_role: bool = False,
) -> PostgresConfig:
    if sum((query_role, ingest_role, dbt_role, admin_role)) > 1:
        raise ConfigurationError("POSTGRES_CREDENTIAL_PURPOSE_CONFLICT")
    values = dict(os.environ if environ is None else environ)
    raw_port = _required("WALKTHROUGH_POSTGRES_PORT", values)
    try:
        port = int(raw_port)
    except ValueError as error:
        raise ConfigurationError("WALKTHROUGH_POSTGRES_PORT_INVALID") from error
    if not 1 <= port <= 65535:
        raise ConfigurationError("WALKTHROUGH_POSTGRES_PORT_INVALID")
    host = _required("WALKTHROUGH_POSTGRES_HOST", values)
    local = _is_loopback(host)
    mode = _required("LINEAGEGUARD_POSTGRES_MODE", values)
    sslmode = _required("WALKTHROUGH_POSTGRES_SSLMODE", values)
    if local and (mode != "local" or sslmode != "disable"):
        raise ConfigurationError("LOCAL_POSTGRES_MODE_MISMATCH")
    if not local and (
        mode != "remote"
        or sslmode != "verify-full"
        or values.get("LINEAGEGUARD_REMOTE_POSTGRES") != "approved"
    ):
        raise ConfigurationError("REMOTE_POSTGRES_VERIFY_FULL_REQUIRED")
    kind = (
        "query"
        if query_role
        else (
            "ingest"
            if ingest_role
            else ("dbt" if dbt_role else ("admin" if admin_role else "application"))
        )
    )
    prefix = {
        "query": "WALKTHROUGH_QUERY_POSTGRES",
        "ingest": "WALKTHROUGH_INGEST_POSTGRES",
        "dbt": "WALKTHROUGH_DBT_POSTGRES",
        "admin": "WALKTHROUGH_ADMIN_POSTGRES",
        "application": "WALKTHROUGH_POSTGRES",
    }[kind]
    user_name = f"{prefix}_USER"
    password_name = f"{prefix}_PASSWORD"
    user = _required(user_name, values)
    fixed_users = {
        "query": "lineageguard_query",
        "ingest": "lineageguard_ingest",
        "dbt": "lineageguard_dbt",
        "application": "lineageguard_seed",
    }
    if kind in fixed_users and user != fixed_users[kind]:
        raise ConfigurationError(f"{kind.upper()}_POSTGRES_PRINCIPAL_MISMATCH")
    database = _required("WALKTHROUGH_POSTGRES_DATABASE", values)
    if database != "lineageguard":
        raise ConfigurationError("WALKTHROUGH_POSTGRES_DATABASE_MISMATCH")
    return PostgresConfig(
        host=host,
        port=port,
        user=user,
        password=_required(password_name, values),
        database=database,
        sslmode=sslmode,
        remote=not local,
        credential_kind=kind,
    )


def redact(text: str, secrets: tuple[str | None, ...]) -> str:
    redacted = text[:16384]
    for secret in sorted(
        (item for item in secrets if item and len(item) <= 4096),
        key=len,
        reverse=True,
    ):
        redacted = redacted.replace(secret, "[REDACTED]")
    return redacted
