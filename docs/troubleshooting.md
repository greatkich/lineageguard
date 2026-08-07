# Troubleshooting

Common issues when running the LineageGuard demo and their solutions.

## DataHub Connection

### `TIMEOUT` — DataHub MCP connection timed out

The MCP server (`mcp-server-datahub`) takes a few seconds to start via `uvx`. If the 8-second connect timeout is hit:

1. Verify DataHub GMS is healthy: `curl http://127.0.0.1:8080/config`
2. Verify `uvx` is installed: `which uvx`
3. Try running the MCP server manually to check for errors:
   ```bash
   echo '{}' | uvx --from "mcp-server-datahub==0.6.0" mcp-server-datahub --transport stdio
   ```
4. If uvx is slow on first run, it downloads the package — subsequent runs are cached.

### `DATAHUB_CREDENTIAL_REUSE_DENIED`

All 4 DataHub tokens must be distinct: `DATAHUB_READ_TOKEN`, `DATAHUB_INGEST_TOKEN`, `DATAHUB_MUTATION_TOKEN`, `DATAHUB_BOOTSTRAP_TOKEN`. Generate separate tokens via the DataHub GraphQL API.

### `TARGET_INSTANCE_ID_MISMATCH` / `WAREHOUSE_OWNERSHIP_MISMATCH`

The walkthrough state files (`walkthrough/.state/`) are bound to a specific DataHub instance. If DataHub was recreated:

```bash
rm -rf walkthrough/.state
docker exec lineageguard-app-postgres-1 psql -U lineageguard -d lineageguard \
  -c "DROP SCHEMA IF EXISTS lineageguard_control CASCADE;"
# Then re-run bootstrap-target and demo:bootstrap
```

## Validation

### `INVALID_SANDBOX_ROOT`

On macOS, `/tmp` is a symlink to `/private/tmp`. The validator rejects symlinks. Set:
```
VALIDATION_SANDBOX_ROOT=/private/tmp
```
Or the orchestration defaults to `$TMPDIR` which is correct on macOS.

### `Docker executable not found at /usr/bin/docker`

Docker Desktop on macOS installs to `/usr/local/bin/docker`. Set:
```
LINEAGEGUARD_DOCKER_EXECUTABLE=/usr/local/bin/docker
```

### `VALIDATION_RUNNER_IMAGE_ID must be set`

The validation containers need content-addressed image IDs. Find them with:
```bash
docker images --digests | grep -E "lineageguard/validation-runner|postgres:17"
```
Set `LINEAGEGUARD_VALIDATION_RUNNER_IMAGE_ID=sha256:...` and `LINEAGEGUARD_VALIDATION_POSTGRES_IMAGE_ID=sha256:...`

## GitHub

### `GitHub API 422: branch already exists`

This is normal — the pipeline uses idempotent content-addressed branches. An existing PR is reused.

### `Source PR rejected: UNKNOWN`

The source PR must match the canonical scenario (single SQL file in `walkthrough/migrations/`). Check that PR #3 (`demo/canonical-customer-id-rename`) is open and untouched.

## PostgreSQL

### `WAREHOUSE_PREEXISTING_OBJECTS`

The walkthrough schemas (`commerce`, `analytics`, `fraud`) or roles already exist from a previous incomplete seed. Clean them:

```bash
docker exec lineageguard-app-postgres-1 psql -U lineageguard -d lineageguard -c "
  DROP SCHEMA IF EXISTS commerce CASCADE;
  DROP SCHEMA IF EXISTS analytics CASCADE;
  DROP SCHEMA IF EXISTS fraud CASCADE;
  DROP SCHEMA IF EXISTS lineageguard_control CASCADE;
  -- drop roles (if they exist)
  DROP ROLE IF EXISTS lineageguard_query;
  DROP ROLE IF EXISTS lineageguard_ingest;
  DROP ROLE IF EXISTS lineageguard_seed;
  DROP ROLE IF EXISTS lineageguard_dbt;
  DROP ROLE IF EXISTS lineageguard_query_reader;
  DROP ROLE IF EXISTS lineageguard_ingest_reader;
"
```

## Node.js

### Engine warning: `Unsupported engine`

Ensure Node 24.18.0 is active:
```bash
nvm use "$(cat .node-version)"
# or
export PATH="$HOME/.nvm/versions/node/v24.18.0/bin:$PATH"
```

## General

### Tests fail with `ATTESTATION_INVALID`

If `DATAHUB_TOKEN` or `GITHUB_TOKEN` leaks into the test environment, the authority boundary correctly rejects them. The validation server's authority-environment projection drops orchestration credentials. This is working as designed — tests should not need real tokens.

### `demo:bootstrap` reports FAILED but verify shows ok=true

The bootstrap fast-path checks the Python `verify` tool. If prior writebacks added tags that the strict verify doesn't expect, it reports failures even though the graph is functionally complete. Run `demo:run` directly — the pipeline only needs the 4 impact cards to be reachable.
