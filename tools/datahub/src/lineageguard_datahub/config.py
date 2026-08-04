from __future__ import annotations

import os
from dataclasses import dataclass
from urllib.parse import quote


class ConfigurationError(ValueError):
    """Required configuration is missing or unsafe."""


@dataclass(frozen=True, slots=True)
class DataHubConfig:
    server: str
    token: str | None


@dataclass(frozen=True, slots=True)
class PostgresConfig:
    host: str
    port: int
    user: str
    password: str
    database: str

    @property
    def dsn(self) -> str:
        return (
            f"postgresql://{quote(self.user, safe='')}:{quote(self.password, safe='')}"
            f"@{self.host}:{self.port}/{quote(self.database, safe='')}"
        )


def _required(name: str, environ: dict[str, str]) -> str:
    value = environ.get(name)
    if value is None or not value.strip():
        raise ConfigurationError(f"MISSING_ENV:{name}")
    return value


def load_datahub_config(environ: dict[str, str] | None = None) -> DataHubConfig:
    values = dict(os.environ if environ is None else environ)
    server = _required("DATAHUB_GMS_URL", values)
    if not server.startswith(("http://", "https://")):
        raise ConfigurationError("DATAHUB_GMS_URL_INVALID")
    return DataHubConfig(server=server.rstrip("/"), token=values.get("DATAHUB_TOKEN") or None)


def load_postgres_config(environ: dict[str, str] | None = None) -> PostgresConfig:
    values = dict(os.environ if environ is None else environ)
    raw_port = _required("WALKTHROUGH_POSTGRES_PORT", values)
    try:
        port = int(raw_port)
    except ValueError as error:
        raise ConfigurationError("WALKTHROUGH_POSTGRES_PORT_INVALID") from error
    if not 1 <= port <= 65535:
        raise ConfigurationError("WALKTHROUGH_POSTGRES_PORT_INVALID")
    return PostgresConfig(
        host=_required("WALKTHROUGH_POSTGRES_HOST", values),
        port=port,
        user=_required("WALKTHROUGH_POSTGRES_USER", values),
        password=_required("WALKTHROUGH_POSTGRES_PASSWORD", values),
        database=_required("WALKTHROUGH_POSTGRES_DATABASE", values),
    )


def redact(text: str, secrets: tuple[str | None, ...]) -> str:
    redacted = text
    for secret in secrets:
        if secret:
            redacted = redacted.replace(secret, "[REDACTED]")
    return redacted
