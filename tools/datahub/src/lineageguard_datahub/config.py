from __future__ import annotations

import os
from dataclasses import dataclass, field
from ipaddress import ip_address
from urllib.parse import quote, urlsplit


class ConfigurationError(ValueError):
    """Required configuration is missing or unsafe."""


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


def _required(name: str, environ: dict[str, str]) -> str:
    value = environ.get(name)
    if value is None or not value.strip():
        raise ConfigurationError(f"MISSING_ENV:{name}")
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


def load_datahub_config(
    environ: dict[str, str] | None = None,
    *,
    write: bool = False,
    ingest: bool = False,
) -> DataHubConfig:
    if write and ingest:
        raise ConfigurationError("DATAHUB_CREDENTIAL_PURPOSE_CONFLICT")
    values = dict(os.environ if environ is None else environ)
    server = _required("DATAHUB_GMS_URL", values)
    parsed = urlsplit(server)
    if parsed.scheme not in {"http", "https"} or parsed.hostname is None:
        raise ConfigurationError("DATAHUB_GMS_URL_INVALID")
    if parsed.username is not None or parsed.password is not None or parsed.fragment:
        raise ConfigurationError("DATAHUB_GMS_URL_UNSAFE_COMPONENT")
    local = _is_loopback(parsed.hostname)
    if parsed.scheme == "http" and not local:
        raise ConfigurationError("REMOTE_DATAHUB_HTTPS_REQUIRED")
    if not local and values.get("LINEAGEGUARD_REMOTE_DATAHUB") != "approved":
        raise ConfigurationError("REMOTE_DATAHUB_OPT_IN_REQUIRED")
    credential_kind = "ingest" if ingest else ("write" if write else "read")
    token_name = {
        "read": "DATAHUB_READ_TOKEN",
        "write": "DATAHUB_WRITE_TOKEN",
        "ingest": "DATAHUB_INGEST_TOKEN",
    }[credential_kind]
    token = values.get(token_name) or None
    if credential_kind != "read" and token is None:
        raise ConfigurationError(f"{token_name}_REQUIRED")
    if (
        credential_kind != "read"
        and not local
        and values.get("LINEAGEGUARD_REMOTE_DATAHUB_WRITE") != "approved"
    ):
        raise ConfigurationError("REMOTE_DATAHUB_WRITE_OPT_IN_REQUIRED")
    return DataHubConfig(
        server=server.rstrip("/"),
        token=token,
        remote=not local,
        credential_kind=credential_kind,
    )


def load_postgres_config(
    environ: dict[str, str] | None = None,
    *,
    query_role: bool = False,
    ingest_role: bool = False,
    admin_role: bool = False,
) -> PostgresConfig:
    if sum((query_role, ingest_role, admin_role)) > 1:
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
        else ("ingest" if ingest_role else ("admin" if admin_role else "application"))
    )
    prefix = {
        "query": "WALKTHROUGH_QUERY_POSTGRES",
        "ingest": "WALKTHROUGH_INGEST_POSTGRES",
        "admin": "WALKTHROUGH_ADMIN_POSTGRES",
        "application": "WALKTHROUGH_POSTGRES",
    }[kind]
    user_name = f"{prefix}_USER"
    password_name = f"{prefix}_PASSWORD"
    user = _required(user_name, values)
    fixed_users = {
        "query": "lineageguard_query",
        "ingest": "lineageguard_ingest",
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
    redacted = text
    for secret in sorted((item for item in secrets if item), key=len, reverse=True):
        redacted = redacted.replace(secret, "[REDACTED]")
    return redacted
