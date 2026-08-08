# Canonical generation fixture

`accepted-generation-response.json` is the schema-valid, source-bound candidate used for local
generation and materialization tests. It contains the additive migration, compatibility trigger,
dbt model, equality test, rollback, and reviewer-facing migration document.

This directory intentionally contains no validation receipt. A replay manifest may be committed
only after the exact candidate passes the eight executable PostgreSQL/dbt checks and the live
worker produces an authenticated Ed25519 receipt. Until that run exists, this fixture is not proof
that the migration is safe.
