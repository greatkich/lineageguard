#!/usr/bin/env bash
set -euo pipefail

echo "=== verify-foundation ==="

# Agent tooling verification
echo "--- agent skills verification ---"
node --test scripts/verify-agent-skills.test.mjs
bash scripts/bootstrap-agent-tooling.sh

# Environment check (advisory, does not block verification)
echo "--- environment check (advisory) ---"
bash scripts/check-environment.sh || echo "WARN: environment check failed (non-blocking)"

# Static analysis
echo "--- format check ---"
pnpm format:check

echo "--- lint ---"
pnpm lint

echo "--- boundaries check ---"
pnpm boundaries:check

echo "--- typecheck ---"
pnpm typecheck

# Tests
echo "--- unit tests ---"
pnpm test

# Build
echo "--- build ---"
pnpm build

# E2E
echo "--- e2e tests ---"
pnpm test:e2e

# Demo verification
echo "--- demo verify ---"
pnpm demo:verify

# Python tests
echo "--- python tests ---"
uv run --project tools/datahub --locked pytest -q

echo "=== all foundation gates passed ==="
