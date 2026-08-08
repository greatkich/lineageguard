# Demo Walkthrough

This document describes the exact sequence to run the canonical LineageGuard demo from a clean state.

## Prerequisites

- Node.js 24.18.0 (pinned in `.node-version`)
- pnpm 11.20+
- Docker Desktop with at least 4 GiB free disk
- DataHub OSS quickstart (v1.6.0) running at `http://127.0.0.1:8080`
- PostgreSQL 17 (via the `lineageguard-app-postgres-1` container)
- A GitHub token with repo scope
- Python 3.12 + `uv` for the DataHub tooling

## Environment Setup

```bash
# Ensure Node 24
export PATH="$HOME/.nvm/versions/node/v24.18.0/bin:$PATH"
node --version  # must print v24.18.0

# Install dependencies
pnpm install --frozen-lockfile

# Copy and configure .env
cp .env.example .env
# Required: DATAHUB_READ_TOKEN, DATAHUB_INGEST_TOKEN, DATAHUB_MUTATION_TOKEN,
#           DATAHUB_BOOTSTRAP_TOKEN (all 4 must be distinct)
#           GITHUB_TOKEN, GITHUB_OWNER, GITHUB_REPO, SOURCE_PR_NUMBER=3
#           LINEAGEGUARD_DATABASE_URL, LINEAGEGUARD_DOCKER_EXECUTABLE
#           LINEAGEGUARD_VALIDATION_RUNNER_IMAGE_ID, LINEAGEGUARD_VALIDATION_POSTGRES_IMAGE_ID
```

## Demo Lifecycle Commands

| Command | Purpose |
|---------|---------|
| `pnpm demo:preflight` | Verify all 19 environment prerequisites |
| `pnpm demo:bootstrap` | Seed the walkthrough PostgreSQL and DataHub graph |
| `pnpm demo:run` | Execute the full canonical pipeline (build + run) |
| `pnpm demo:verify -- --runId <id>` | Independently verify a completed run (23 checks) |
| `pnpm demo:repeat -- --count 3` | Prove determinism across N identical runs |
| `pnpm demo:golden -- --runId <id>` | Capture golden artifacts from a verified run |
| `pnpm demo:reset` | Clear run records (preserves the DataHub graph) |

## Full Demo Sequence

```bash
# 1. Preflight check
pnpm demo:preflight
# Expected: 19/19 READY

# 2. Bootstrap the DataHub graph (first time only)
pnpm demo:bootstrap
# Expected: bootstrap: READY

# 3. Run the canonical pipeline
pnpm demo:run
# Expected: Status: COMPLETED, Decision: ALLOW → BLOCK, Consumers: 4

# 4. Verify the run
pnpm demo:verify -- --runId <run-id-from-step-3>
# Expected: 23/23 checks passed, verify: PASS

# 5. Prove determinism
pnpm demo:repeat -- --count 3
# Expected: 8/8 checks passed, repeat: PASS

# 6. Capture golden evidence
pnpm demo:golden -- --runId <run-id>
# Expected: golden: DONE
```

## What the Pipeline Does

1. **Parse change**: Reads PR #3 from GitHub, extracts the rename SQL
2. **Baseline assessment**: Repository-only check → `ALLOW`
3. **DataHub context**: Queries 6 MCP tools, collects 10 evidence items, discovers 4 hidden consumers
4. **Risk evaluation**: 5-rule engine upgrades decision to `BLOCK` (rules LG001-LG004)
5. **Migration planning**: Generates expand-migrate-contract strategy
6. **Candidate building**: Produces 8 deterministic artifacts (migration, backfill, trigger, dbt models, rollback)
7. **Validation**: Runs 8 checks in isolated Docker containers (SQL, dbt, compatibility, rollback)
8. **GitHub publication**: Creates draft PR with content-addressed branch naming
9. **DataHub writeback**: Records the decision with exact read-back verification

## Verification Guarantees

- Content-addressed branch: `lineageguard/generated/pr-3-<fingerprint>`
- Content-addressed decision: `lineageguard:decision:v1:candidate-<fingerprint>`
- Zero synthetic evidence (syntheticLiveEvidenceCount = 0)
- Idempotent: repeated runs produce the same PR and decision identity
- No leaked containers or worktrees after execution
