from __future__ import annotations

from urllib.parse import quote, quote_plus

import pytest

from lineageguard_datahub.config import (
    ConfigurationError,
    load_datahub_config,
    load_postgres_config,
    redact,
)


def _local_postgres() -> dict[str, str]:
    return {
        "WALKTHROUGH_POSTGRES_HOST": "127.0.0.1",
        "WALKTHROUGH_POSTGRES_PORT": "5432",
        "WALKTHROUGH_POSTGRES_USER": "lineageguard_seed",
        "WALKTHROUGH_POSTGRES_PASSWORD": "secret",
        "WALKTHROUGH_POSTGRES_DATABASE": "lineageguard",
        "LINEAGEGUARD_POSTGRES_MODE": "local",
        "WALKTHROUGH_POSTGRES_SSLMODE": "disable",
    }


def test_secret_values_are_redacted_and_hidden_from_repr() -> None:
    assert redact("token=abc password=xyz", ("abc", "xyz")) == (
        "token=[REDACTED] password=[REDACTED]"
    )
    config = load_postgres_config(_local_postgres())
    assert "secret" not in repr(config)


def test_postgres_password_has_no_default() -> None:
    values = _local_postgres()
    del values["WALKTHROUGH_POSTGRES_PASSWORD"]
    with pytest.raises(ConfigurationError, match="WALKTHROUGH_POSTGRES_PASSWORD"):
        load_postgres_config(values)


def test_query_role_uses_separate_credentials() -> None:
    values = _local_postgres()
    with pytest.raises(ConfigurationError, match="WALKTHROUGH_QUERY_POSTGRES_USER"):
        load_postgres_config(values, query_role=True)


def test_query_and_ingest_principals_are_fixed_login_names() -> None:
    values = _local_postgres() | {
        "WALKTHROUGH_QUERY_POSTGRES_USER": "lineageguard_reader",
        "WALKTHROUGH_QUERY_POSTGRES_PASSWORD": "query",
        "WALKTHROUGH_INGEST_POSTGRES_USER": "lineageguard_query",
        "WALKTHROUGH_INGEST_POSTGRES_PASSWORD": "ingest",
        "WALKTHROUGH_DBT_POSTGRES_USER": "shared_dbt",
        "WALKTHROUGH_DBT_POSTGRES_PASSWORD": "dbt",
    }
    with pytest.raises(ConfigurationError, match="QUERY_POSTGRES_PRINCIPAL_MISMATCH"):
        load_postgres_config(values, query_role=True)
    with pytest.raises(ConfigurationError, match="INGEST_POSTGRES_PRINCIPAL_MISMATCH"):
        load_postgres_config(values, ingest_role=True)
    with pytest.raises(ConfigurationError, match="DBT_POSTGRES_PRINCIPAL_MISMATCH"):
        load_postgres_config(values, dbt_role=True)
    values["WALKTHROUGH_QUERY_POSTGRES_USER"] = "lineageguard_query"
    values["WALKTHROUGH_INGEST_POSTGRES_USER"] = "lineageguard_ingest"
    values["WALKTHROUGH_DBT_POSTGRES_USER"] = "lineageguard_dbt"
    assert load_postgres_config(values, query_role=True).credential_kind == "query"
    assert load_postgres_config(values, ingest_role=True).credential_kind == "ingest"
    assert load_postgres_config(values, dbt_role=True).credential_kind == "dbt"


def test_redaction_replaces_longest_secret_first() -> None:
    assert redact("token-long token", ("token", "token-long")) == "[REDACTED] [REDACTED]"


def test_redaction_happens_before_truncation_at_output_boundary() -> None:
    secret = "BOUNDARY-secret-9b3d7a"
    output = redact("x" * 16375 + secret + "tail", (secret,))
    assert "[REDACTED]" in output
    assert secret not in output
    assert "BOUNDARY-" not in output


def test_redaction_covers_dsn_and_url_encoded_secret_forms() -> None:
    secret = "p@ss:/+ word"
    percent_encoded = quote(secret, safe="")
    plus_encoded = quote_plus(secret, safe="")
    lower_hex_encoded = percent_encoded.replace("%3A", "%3a").replace("%2F", "%2f")
    text = (
        f"postgresql://user:{percent_encoded}@db/lineageguard "
        f"url={plus_encoded} lower={lower_hex_encoded} raw={secret}"
    )
    output = redact(text, (secret,))
    assert output.count("[REDACTED]") == 4
    for value in (secret, percent_encoded, plus_encoded, lower_hex_encoded):
        assert value not in output


def test_remote_postgres_requires_verify_full_and_opt_in() -> None:
    values = _local_postgres() | {
        "WALKTHROUGH_POSTGRES_HOST": "db.example.com",
        "LINEAGEGUARD_POSTGRES_MODE": "remote",
        "WALKTHROUGH_POSTGRES_SSLMODE": "require",
    }
    with pytest.raises(ConfigurationError, match="REMOTE_POSTGRES_VERIFY_FULL_REQUIRED"):
        load_postgres_config(values)
    values["WALKTHROUGH_POSTGRES_SSLMODE"] = "verify-full"
    values["LINEAGEGUARD_REMOTE_POSTGRES"] = "approved"
    assert load_postgres_config(values).remote is True


def test_datahub_target_policy_and_separate_mutation_token() -> None:
    local = load_datahub_config(
        {
            "DATAHUB_GMS_URL": "http://127.0.0.1:8080",
            "DATAHUB_READ_TOKEN": "read",
        }
    )
    assert local.token == "read"
    assert "token=" not in repr(local)
    with pytest.raises(ConfigurationError, match="DATAHUB_MUTATION_TOKEN_REQUIRED"):
        load_datahub_config({"DATAHUB_GMS_URL": "http://127.0.0.1:8080"}, write=True)
    with pytest.raises(ConfigurationError, match="CANONICAL_DATAHUB_GMS_URL_REQUIRED"):
        load_datahub_config(
            {"DATAHUB_GMS_URL": "http://127.0.0.1:8081", "DATAHUB_READ_TOKEN": "read"}
        )
    with pytest.raises(ConfigurationError, match="DATAHUB_GMS_URL_UNSAFE_COMPONENT"):
        load_datahub_config(
            {
                "DATAHUB_GMS_URL": "http://user@127.0.0.1:8080/#fragment",
                "DATAHUB_READ_TOKEN": "read",
            }
        )
    with pytest.raises(ConfigurationError, match="DATAHUB_GMS_URL_PATH_DENIED"):
        load_datahub_config(
            {
                "DATAHUB_GMS_URL": "http://127.0.0.1:8080/arbitrary",
                "DATAHUB_READ_TOKEN": "read",
            }
        )
    local_mutation = {
        "DATAHUB_GMS_URL": "http://127.0.0.1:8080",
        "DATAHUB_MUTATION_TOKEN": "hidden",
    }
    assert load_datahub_config(local_mutation, write=True).credential_kind == "mutation"
    with pytest.raises(ConfigurationError, match="DATAHUB_INGEST_TOKEN_REQUIRED"):
        load_datahub_config(
            {"DATAHUB_GMS_URL": "http://127.0.0.1:8080"},
            ingest=True,
        )
    bootstrap = load_datahub_config(
        {
            "DATAHUB_GMS_URL": "http://127.0.0.1:8080",
            "DATAHUB_BOOTSTRAP_TOKEN": "bootstrap",
        },
        bootstrap=True,
    )
    assert bootstrap.credential_kind == "bootstrap"


def test_datahub_credentials_must_be_distinct() -> None:
    values = {
        "DATAHUB_GMS_URL": "http://127.0.0.1:8080",
        "DATAHUB_READ_TOKEN": "reused",
        "DATAHUB_INGEST_TOKEN": "reused",
        "DATAHUB_MUTATION_TOKEN": "mutation",
        "DATAHUB_BOOTSTRAP_TOKEN": "bootstrap",
    }
    with pytest.raises(ConfigurationError, match="DATAHUB_CREDENTIAL_REUSE_DENIED"):
        load_datahub_config(values, ingest=True)
