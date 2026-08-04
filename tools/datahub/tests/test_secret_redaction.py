from __future__ import annotations

import pytest

from lineageguard_datahub.config import (
    ConfigurationError,
    load_datahub_config,
    load_postgres_config,
    redact,
)


def test_secret_values_are_redacted() -> None:
    assert redact("token=abc password=xyz", ("abc", "xyz")) == (
        "token=[REDACTED] password=[REDACTED]"
    )


def test_postgres_password_has_no_default() -> None:
    with pytest.raises(ConfigurationError, match="WALKTHROUGH_POSTGRES_PASSWORD"):
        load_postgres_config(
            {
                "WALKTHROUGH_POSTGRES_HOST": "127.0.0.1",
                "WALKTHROUGH_POSTGRES_PORT": "5432",
                "WALKTHROUGH_POSTGRES_USER": "lineageguard",
                "WALKTHROUGH_POSTGRES_DATABASE": "lineageguard",
            }
        )


def test_datahub_token_is_optional_but_server_is_not() -> None:
    config = load_datahub_config({"DATAHUB_GMS_URL": "http://localhost:8080"})
    assert config.token is None
    with pytest.raises(ConfigurationError, match="MISSING_ENV:DATAHUB_GMS_URL"):
        load_datahub_config({})
