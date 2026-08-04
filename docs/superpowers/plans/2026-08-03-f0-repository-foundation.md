# F0 Repository Foundation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use `superpowers:subagent-driven-development` (recommended) or `superpowers:executing-plans` to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Create a pinned, strict, installable pnpm/uv monorepo whose honest foundation gates pass without claiming product behavior.

**Architecture:** The root coordinates TypeScript workspaces and delegates Python-only DataHub ingestion utilities to a locked uv project. Minimal web, worker, and package entry points establish boundaries; Compose keeps application PostgreSQL, validation PostgreSQL, and the pinned DataHub stack separate.

**Tech Stack:** Node.js 24.18.0, pnpm 11.20.0, TypeScript 6.0.3, Next.js 16.2.12, React 19.2.8, Python 3.12.13, uv 0.11.32, PostgreSQL 17.10, Docker Compose v2 or v5 via `docker compose`, Biome 2.5.6, Vitest 4.1.10, Playwright 1.62.1.

## Global Constraints

- Work on branch `feat/f0-repository-foundation` in the sibling path `/Users/igorgarkusha/Documents/development/lineageguard-worktrees/f0-repository-foundation`, created with `superpowers:using-git-worktrees`. This external path is safe before any `.gitignore` commit exists.
- The planning packet, four-impact-card/two-intermediate convention, and ADR-003/004/005 direction were approved on 2026-08-04 for local F0 execution. Stop after F0 verification/review; do not begin F1 automatically.
- Preserve the existing user-owned mode change and untracked DataHub skills; do not copy or delete them during worktree creation.
- Use TypeScript `strict: true`; no implicit `any` and no framework imports in `packages/domain`.
- Use frozen pnpm and uv locks in CI.
- Do not add product behavior, real external mutations, Redis, Temporal, Kubernetes, LangGraph, or another backend.
- Empty gates must perform an honest smoke assertion and must not print canonical success.
- Commit after every task; do not commit secrets or generated `.env` files.

---

### Task 1: Pin runtimes and implement the environment policy

**Files:**
- Create: `.node-version`
- Create: `.python-version`
- Create: `scripts/environment-policy.mjs`
- Create: `scripts/environment-policy.test.mjs`
- Create: `scripts/check-environment.sh`
- Create: `.gitignore`

**Interfaces:**
- Consumes: process/version command output only.
- Produces: `evaluateEnvironment(observed): { ok: boolean; failures: string[] }` and executable `scripts/check-environment.sh`.

- [ ] **Step 1: Write the failing version-policy tests**

```js
// scripts/environment-policy.test.mjs
import assert from "node:assert/strict";
import test from "node:test";
import { evaluateEnvironment } from "./environment-policy.mjs";

const valid = {
  node: "v24.18.0",
  python: "Python 3.12.13",
  compose: "Docker Compose version v5.3.1",
  dockerServer: "29.6.2",
  freeKilobytes: 31 * 1024 * 1024,
};

test("accepts the pinned runtime family and disk floor", () => {
  assert.deepEqual(evaluateEnvironment(valid), { ok: true, failures: [] });
});

test("accepts both supported Compose CLI major versions", () => {
  for (const compose of ["Docker Compose version v2.40.0", "Docker Compose version v5.3.1"]) {
    assert.deepEqual(evaluateEnvironment({ ...valid, compose }), { ok: true, failures: [] });
  }
});

test("reports every failed precondition without short circuiting", () => {
  const result = evaluateEnvironment({
    ...valid,
    node: "v22.23.0",
    python: "Python 3.11.3",
    compose: "docker-compose version 1.29.2",
    dockerServer: "",
    freeKilobytes: 2 * 1024 * 1024,
  });
  assert.equal(result.ok, false);
  assert.deepEqual(result.failures.map((failure) => failure.split(":")[0]), [
    "node",
    "python",
    "compose",
    "docker",
    "disk",
  ]);
});
```

- [ ] **Step 2: Run the test and observe the red state**

Run: `node --test scripts/environment-policy.test.mjs`
Expected: FAIL with `ERR_MODULE_NOT_FOUND` for `environment-policy.mjs`.

- [ ] **Step 3: Implement the policy evaluator**

```js
// scripts/environment-policy.mjs
export const MINIMUM_FREE_KILOBYTES = 30 * 1024 * 1024;

export function evaluateEnvironment(observed) {
  const failures = [];
  if (!/^v24\./.test(observed.node)) failures.push(`node:${observed.node}`);
  if (!/^Python 3\.12\./.test(observed.python)) failures.push(`python:${observed.python}`);
  if (!/^Docker Compose version v?(?:2|5)\./.test(observed.compose)) {
    failures.push(`compose:${observed.compose}`);
  }
  if (observed.dockerServer.trim().length === 0) failures.push("docker:daemon unavailable");
  if (observed.freeKilobytes < MINIMUM_FREE_KILOBYTES) {
    failures.push(`disk:${observed.freeKilobytes}`);
  }
  return { ok: failures.length === 0, failures };
}
```

Create `.node-version` containing `24.18.0` and `.python-version` containing `3.12.13`. Implement `scripts/check-environment.sh` with `set -eu`; collect `node --version`, `uv run --python 3.12 python --version`, `docker compose version`, `docker info --format '{{.ServerVersion}}'`, and the available-kilobyte field from `df -Pk .`; pass one JSON object to `environment-policy.mjs`; print only version/status data, never environment variable values. Accept supported Compose v2 and v5 output from `docker compose`; reject legacy v1 and the `docker-compose` command. A supported CLI version never bypasses the reachable-daemon or 30 GB disk checks.

- [ ] **Step 4: Run tests and the live preflight**

Run: `node --test scripts/environment-policy.test.mjs`
Expected: 3 tests PASS, covering Compose v2, Compose v5, and the aggregated legacy-v1/daemon/disk failure path.

Run: `bash scripts/check-environment.sh`
Expected on the approved local host if the 2026-08-04 observed state is unchanged: exit 0 and `environment: ok` with Node 24.18.0, Python 3.12.13 through uv, Docker Engine 29.6.2 aarch64, Compose v5.3.1, a reachable daemon, and at least 30 GB free. Any later regression must fail honestly with every violated condition.

- [ ] **Step 5: Commit the runtime policy**

```bash
git add .node-version .python-version .gitignore scripts/environment-policy.mjs scripts/environment-policy.test.mjs scripts/check-environment.sh
git commit -m "chore: pin runtime environment policy"
```

### Task 2: Create the pnpm workspace and strict quality configuration

**Files:**
- Create: `package.json`
- Create: `pnpm-workspace.yaml`
- Create: `.npmrc`
- Create: `tsconfig.base.json`
- Create: `biome.jsonc`
- Create: `vitest.workspace.ts`
- Create: `playwright.config.ts`
- Create: `tests/foundation/workspace.test.ts`
- Create: `pnpm-lock.yaml` through `pnpm install`

**Interfaces:**
- Consumes: Node/pnpm policy from Task 1.
- Produces: root scripts `format:check`, `lint`, `typecheck`, `test`, `build`, `test:e2e`, `browser:install`, `demo:verify`, `env:check`, `boundaries:check`, and `db:test:up`.

- [ ] **Step 1: Write a failing workspace-contract test**

```ts
// tests/foundation/workspace.test.ts
import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";

describe("workspace contract", () => {
  it("pins package manager and exposes every repository gate", async () => {
    const root = JSON.parse(await readFile("package.json", "utf8")) as {
      packageManager: string;
      scripts: Record<string, string>;
    };
    expect(root.packageManager).toBe("pnpm@11.20.0");
    expect(Object.keys(root.scripts)).toEqual(
      expect.arrayContaining([
        "format:check",
        "lint",
        "typecheck",
        "test",
        "build",
        "test:e2e",
        "browser:install",
        "demo:verify",
        "env:check",
        "boundaries:check",
        "db:test:up",
      ]),
    );
  });
});
```

- [ ] **Step 2: Create only enough package metadata to run the red test**

Create the root `package.json` with `private: true`, `type: "module"`, `packageManager: "pnpm@11.20.0"`, `engines.node: ">=24 <25"`, and dev dependencies pinned to TypeScript 6.0.3, Biome 2.5.6, Vitest 4.1.10, and Playwright 1.62.1. Initially omit `demo:verify`, then run:

Run: `corepack pnpm install && corepack pnpm vitest run tests/foundation/workspace.test.ts`
Expected: FAIL because `demo:verify` is absent.

- [ ] **Step 3: Add the complete root scripts and configuration**

Use these script contracts:

```json
{
  "scripts": {
    "env:check": "bash scripts/check-environment.sh",
    "format": "biome format --write .",
    "format:check": "biome format .",
    "lint": "biome lint .",
    "typecheck": "pnpm -r --if-present typecheck",
    "test": "vitest run --workspace vitest.workspace.ts",
    "build": "pnpm -r --if-present build",
    "test:e2e": "playwright test",
    "browser:install": "playwright install chromium",
    "demo:verify": "node scripts/demo-verify.mjs --foundation-only",
    "boundaries:check": "node scripts/check-boundaries.mjs",
    "db:test:up": "docker compose -f compose.yaml up -d --wait app-postgres validation-postgres"
  }
}
```

Set `strict`, `noUncheckedIndexedAccess`, `exactOptionalPropertyTypes`, `useUnknownInCatchVariables`, `noImplicitOverride`, and `noFallthroughCasesInSwitch` to `true` in `tsconfig.base.json`. Configure Biome for two-space indentation, double quotes, organized imports, recommended lint rules, and generated-directory ignores. Configure Playwright with one `chromium` project and `tests/e2e` as its directory. `browser:install` resolves the pinned workspace Playwright 1.62.1 binary; it provisions Chromium as setup and never changes `test:e2e` behavior.

- [ ] **Step 4: Run the workspace contract and static gates**

Run: `pnpm vitest run tests/foundation/workspace.test.ts`
Expected: PASS.

Run: `pnpm format:check && pnpm lint`
Expected: both exit zero.

- [ ] **Step 5: Commit workspace configuration and lockfile**

```bash
git add package.json pnpm-workspace.yaml pnpm-lock.yaml .npmrc tsconfig.base.json biome.jsonc vitest.workspace.ts playwright.config.ts tests/foundation/workspace.test.ts
git commit -m "chore: establish strict pnpm workspace gates"
```

### Task 3: Add boundary-preserving minimal applications and packages

**Files:**
- Create: `apps/web/package.json`
- Create: `apps/web/app/layout.tsx`
- Create: `apps/web/app/page.tsx`
- Create: `apps/web/app/globals.css`
- Create: `apps/web/next.config.ts`
- Create: `apps/web/tsconfig.json`
- Create: `apps/worker/package.json`
- Create: `apps/worker/src/worker.ts`
- Create: `apps/worker/src/worker.test.ts`
- Create: `packages/domain/package.json`
- Create: `packages/domain/src/index.ts`
- Create: `packages/domain/src/index.test.ts`
- Create: minimal `package.json`, `src/index.ts`, and `tsconfig.json` for `agent`, `datahub`, `github`, `validation`, `db`, and `ui`.
- Create: `tests/e2e/foundation.spec.ts`
- Create: `scripts/demo-verify.mjs`
- Create: `scripts/check-boundaries.mjs`
- Create: `tests/foundation/package-boundaries.test.ts`

**Interfaces:**
- Consumes: root TypeScript/quality configuration.
- Produces: importable package entry points, a web health page, and `createWorkerHeartbeat(now): WorkerHeartbeat`.

- [ ] **Step 1: Write failing domain and worker smoke tests**

```ts
// packages/domain/src/index.test.ts
import { expect, it } from "vitest";
import { FOUNDATION_STATUS } from "./index.js";

it("labels the repository as foundation only", () => {
  expect(FOUNDATION_STATUS).toEqual({ phase: "FOUNDATION", productReady: false });
});
```

Also write `tests/foundation/package-boundaries.test.ts` against temporary workspace fixtures. Define this exact deny-by-default matrix in the checker and import it in the tests:

```js
export const INTERNAL_DEPENDENCY_POLICY = {
  "packages/domain": [],
  "packages/agent": ["packages/domain"],
  "packages/datahub": ["packages/domain"],
  "packages/github": ["packages/domain"],
  "packages/validation": ["packages/domain"],
  "packages/db": ["packages/domain"],
  "packages/ui": ["packages/domain"],
  "apps/worker": [
    "packages/domain",
    "packages/agent",
    "packages/datahub",
    "packages/github",
    "packages/validation",
    "packages/db",
  ],
  "apps/web": ["packages/domain", "packages/db", "packages/ui"],
};
```

For every distinct importer/target pair in the nine-owner Cartesian product whose target is not in the importer's allowed set, generate a one-edge fixture and assert `FORBIDDEN_INTERNAL_EDGE` with both owner names. Assert the generated table contains exactly 57 forbidden cases; this is the complete forbidden-edge table, not a sample. Add one clean fixture containing all 15 allowed edges and assert it is acyclic. Explicitly assert that every `packages/* -> apps/*` edge is denied, that `packages/domain` rejects framework/database/MCP/model SDK imports, and that raw MCP modules or official MCP-shaped fixture types imported from `packages/datahub/src/mcp/**` or `packages/datahub/test/fixtures/**` are rejected outside the DataHub owner. Add a cycle fixture such as `apps/worker -> packages/agent -> apps/worker` and assert both the forbidden edge and a separate `INTERNAL_DEPENDENCY_CYCLE` finding with a stable path. Allowed edges remain permissions only; do not create runtime imports merely to exercise the matrix.

```ts
// apps/worker/src/worker.test.ts
import { expect, it } from "vitest";
import { createWorkerHeartbeat } from "./worker.js";

it("creates a deterministic foundation heartbeat", () => {
  expect(createWorkerHeartbeat("2026-08-03T12:00:00.000Z")).toEqual({
    service: "worker",
    phase: "FOUNDATION",
    productReady: false,
    observedAt: "2026-08-03T12:00:00.000Z",
  });
});
```

- [ ] **Step 2: Run the focused tests and observe missing modules**

Run: `pnpm vitest run packages/domain/src/index.test.ts apps/worker/src/worker.test.ts tests/foundation/package-boundaries.test.ts`
Expected: FAIL because entry points and `scripts/check-boundaries.mjs` do not exist.

- [ ] **Step 3: Implement minimal boundaries and web page**

```ts
// packages/domain/src/index.ts
export const FOUNDATION_STATUS = { phase: "FOUNDATION", productReady: false } as const;
```

```ts
// apps/worker/src/worker.ts
export interface WorkerHeartbeat {
  service: "worker";
  phase: "FOUNDATION";
  productReady: false;
  observedAt: string;
}

export function createWorkerHeartbeat(observedAt: string): WorkerHeartbeat {
  return { service: "worker", phase: "FOUNDATION", productReady: false, observedAt };
}
```

Render the same honest foundation status on `/` with semantic `<main>`, `<h1>LineageGuard</h1>`, and text `Foundation installed; canonical demo not implemented.` The Playwright smoke asserts that exact copy and zero console errors. `scripts/demo-verify.mjs --foundation-only` parses `FOUNDATION_STATUS` through a tiny JSON child process and exits zero only while `productReady === false`.

Implement `scripts/check-boundaries.mjs` as a deterministic source/import graph check over both workspace manifest dependencies and normalized source imports. Unknown internal owners and every unlisted cross-owner edge fail closed. No package may import an app. Preserve the domain infrastructure denylist and raw MCP containment rule in addition to the matrix. Run explicit DFS or Tarjan cycle detection over the complete internal owner graph and emit a stable canonical cycle path. The checker accepts repository-relative fixture roots in tests, emits owner/file/import violations without source contents, and exits non-zero on any edge, containment, or cycle violation. It is the sole owner of the `boundaries:check` command used by F3 and later plans; a future allowed edge requires an architecture review plus a synchronized policy/test change before the dependency lands.

- [ ] **Step 4: Run package, build, and browser smoke gates**

Run: `pnpm browser:install`
Expected: the pinned workspace Playwright CLI installs Chromium successfully. This is a local setup step, not a test result.

Run: `pnpm test && pnpm boundaries:check && pnpm typecheck && pnpm build && pnpm test:e2e && pnpm demo:verify`
Expected: all exit zero; the complete dependency matrix and acyclicity policy hold, and the provisioned Chromium browser displays foundation-only copy.

- [ ] **Step 5: Commit the minimal application boundaries**

```bash
git add apps packages tests/e2e tests/foundation/package-boundaries.test.ts scripts/demo-verify.mjs scripts/check-boundaries.mjs
git commit -m "chore: add honest application boundary smokes"
```

### Task 4: Lock Python tools and Compose service boundaries

**Files:**
- Create: `tools/datahub/pyproject.toml`
- Create: `tools/datahub/uv.lock` through `uv lock`
- Create: `tools/datahub/src/lineageguard_datahub/__init__.py`
- Create: `tools/datahub/src/lineageguard_datahub/version_policy.py`
- Create: `tools/datahub/tests/test_smoke.py`
- Create: `compose.yaml`
- Create: `compose.datahub.yaml`
- Create: `tests/foundation/compose.test.ts`

**Interfaces:**
- Consumes: Python 3.12 and Docker readiness.
- Produces: locked Python project and named services `app-postgres` and `validation-postgres`; DataHub starts only through its pinned CLI wrapper.

- [ ] **Step 1: Write failing Python and Compose tests**

```py
# tools/datahub/tests/test_smoke.py
from lineageguard_datahub.version_policy import PINNED_DATAHUB_VERSION, runtime_is_supported


def test_python_and_datahub_policy() -> None:
    assert runtime_is_supported((3, 12, 13))
    assert not runtime_is_supported((3, 11, 9))
    assert PINNED_DATAHUB_VERSION == "1.6.0"
```

The Compose test loads `docker compose -f compose.yaml config --format json`, then asserts distinct volumes, databases, health checks, no DataHub internal service in the application file, and PostgreSQL image `postgres:17.10`.

- [ ] **Step 2: Run tests and observe missing policy/config**

Run: `uv run --project tools/datahub pytest -q`
Expected: FAIL importing `version_policy`.

Run: `pnpm vitest run tests/foundation/compose.test.ts`
Expected: FAIL because `compose.yaml` is absent.

- [ ] **Step 3: Implement the locked tool project and Compose files**

Pin `requires-python = "==3.12.*"`, `acryl-datahub[postgres]==1.6.0.17`, `dbt-core==1.12.0`, `dbt-postgres==1.11.0`, and pytest in `pyproject.toml`. Implement:

```py
PINNED_DATAHUB_VERSION = "1.6.0"


def runtime_is_supported(version: tuple[int, int, int]) -> bool:
    return version[:2] == (3, 12)
```

Define two PostgreSQL 17.10 services on a private network with separate named volumes, databases, non-default credentials supplied only through required environment variables, and `pg_isready` health checks. `compose.datahub.yaml` contains a documented wrapper profile that runs `uv run --project tools/datahub datahub docker quickstart --version v1.6.0`; it does not copy DataHub services into the app database.

- [ ] **Step 4: Lock and verify**

Run: `uv lock --project tools/datahub && uv run --project tools/datahub --locked pytest -q`
Expected: Python test PASS and lock unchanged on the second run.

Run: `docker compose -f compose.yaml config --quiet && pnpm vitest run tests/foundation/compose.test.ts`
Expected: both PASS.

Run: `pnpm db:test:up && docker compose -f compose.yaml ps --format json`
Expected: both `app-postgres` and `validation-postgres` report healthy; then `docker compose -f compose.yaml stop app-postgres validation-postgres` exits zero.

- [ ] **Step 5: Commit Python and Compose foundation**

```bash
git add tools/datahub compose.yaml compose.datahub.yaml tests/foundation/compose.test.ts
git commit -m "chore: lock python and database service boundaries"
```

### Task 5: Add CI, task aliases, and architecture corrections

**Files:**
- Create: `.github/workflows/ci.yml`
- Create: `Makefile`
- Create: `scripts/verify-foundation.sh`
- Create: `docs/DECISIONS/ADR-003-datahub-mcp-capability-boundaries.md`
- Create: `docs/DECISIONS/ADR-004-durable-workflow-and-idempotency.md`
- Create: `docs/DECISIONS/ADR-005-demo-deployment-and-exposure.md`
- Modify: `.codex/config.toml.example`
- Modify: `scripts/bootstrap-agent-tooling.sh`
- Modify: `docs/ARCHITECTURE.md`
- Modify: `README.md`
- Modify: `docs/SOURCES.md`

**Interfaces:**
- Consumes: all F0 gates and the pinned Playwright CLI from Task 2.
- Produces: CI job matrix, local `make setup`/`make browser-install`/`make verify-foundation` ownership, clean-clone README commands, and accepted architecture records for dependent plans.

- [ ] **Step 1: Write a failing documentation/config contract test**

Extend `tests/foundation/workspace.test.ts` to assert:

```ts
const codexExample = await readFile(".codex/config.toml.example", "utf8");
const bootstrap = await readFile("scripts/bootstrap-agent-tooling.sh", "utf8");
expect(codexExample).toContain("mcp-server-datahub==0.6.0");
expect(bootstrap).toContain("uvx");
expect(`${codexExample}\n${bootstrap}`).not.toContain("@acryldata/mcp-server-datahub");

const makefile = await readFile("Makefile", "utf8");
const readme = await readFile("README.md", "utf8");
const ci = await readFile(".github/workflows/ci.yml", "utf8");
expect(makefile).toContain("pnpm exec playwright install chromium");
expect(readme).toContain("make setup");
expect(ci).toContain("pnpm exec playwright install --with-deps chromium");
```

- [ ] **Step 2: Run the contract and observe stale/missing setup contracts**

Run: `pnpm vitest run tests/foundation/workspace.test.ts`
Expected: FAIL because the obsolete npm MCP launcher remains and the Makefile/CI browser-provisioning contracts do not exist yet.

- [ ] **Step 3: Implement CI and documents**

Update both MCP examples to use the absolute `uvx` resolution pattern and `uvx --from mcp-server-datahub==0.6.0 mcp-server-datahub`, with `TOOLS_IS_MUTATION_ENABLED=false` in the read profile. Update architecture from Elasticsearch to OpenSearch where describing pinned Quickstart.

The delivery design was approved on 2026-08-04, so create each ADR with `Status: Accepted`. ADR-003 records deterministic context collection plus split read/write/verifier ports; ADR-004 records the accepted status/failure table, `FOR UPDATE SKIP LOCKED`, 60-second lease/20-second heartbeat, 1/5/30-second retry delays, polling, and idempotency keys; ADR-005 records public replay/operator-only live mode. Later evidence may change these only through an explicit superseding ADR.

Makefile owns these local targets: `browser-install` runs `pnpm exec playwright install chromium`; `setup` runs the frozen Corepack/pnpm install, locked uv sync, and then `browser-install`; `verify-foundation` runs `bash scripts/verify-foundation.sh` without silently provisioning or skipping a browser. README's clean-clone path is exactly `make setup` followed by `make verify-foundation`, explains that setup downloads pinned Chromium, and gives `pnpm exec playwright install chromium` as the direct recovery command.

Linux CI uses setup-node with `node-version-file`, Corepack, frozen install, `astral-sh/setup-uv` pinned to 0.11.32, and `uv sync --locked`. After the frozen pnpm install and before `bash scripts/verify-foundation.sh`, it must run `pnpm exec playwright install --with-deps chromium` so both the pinned browser and required Linux system packages exist. `scripts/verify-foundation.sh` executes the F0 gate commands in specification order and prints the failing command through shell tracing without environment dumps; it never converts an absent browser into success.

- [ ] **Step 4: Run the complete F0 gate**

Run: `make setup && make verify-foundation`
Expected: clean local setup provisions dependencies and pinned Chromium, then format, lint, boundary matrix/cycle checks, type, unit, build, real browser smoke, foundation demo smoke, and Python tests all exit zero.

Run: `git diff --exit-code -- pnpm-lock.yaml tools/datahub/uv.lock`
Expected: no lockfile drift.

- [ ] **Step 5: Commit CI and architecture records**

```bash
git add .github/workflows/ci.yml Makefile scripts/verify-foundation.sh .codex/config.toml.example scripts/bootstrap-agent-tooling.sh docs/DECISIONS docs/ARCHITECTURE.md docs/SOURCES.md README.md tests/foundation/workspace.test.ts
git commit -m "docs: align foundation with current runtime contracts"
```

### Task 6: Independent reviews and verification-before-completion

**Files:**
- Review: every file changed on `feat/f0-repository-foundation`.
- Modify only if a reviewer identifies a concrete issue.

**Interfaces:**
- Consumes: completed F0 diff and F0 specification.
- Produces: approved foundation evidence for F1/F2 worktrees.

- [ ] **Step 1: Dispatch a fresh read-only specification review**

Reviewer prompt: compare the branch diff with the F0 section of `docs/superpowers/specs/2026-08-03-lineageguard-f0-f10-specifications.md`, ADR-001, ADR-002, and AGENTS.md. Report missing acceptance behavior, extra scope, version drift, false product claims, and boundary violations. Do not modify files.

Expected: no unresolved blocking findings. Apply each accepted fix with its own red-green evidence and focused `fix:` commit.

- [ ] **Step 2: Dispatch a different fresh read-only code-quality review**

Reviewer prompt: inspect shell safety, TypeScript strictness, lock determinism, CI caching, Compose isolation, secret handling, portability, and maintainability. Do not repeat specification review and do not modify files.

Expected: no unresolved blocking findings. Commit accepted fixes separately.

- [ ] **Step 3: Invoke verification-before-completion and capture current output**

Run:

```bash
make setup
pnpm env:check
pnpm format:check
pnpm lint
pnpm boundaries:check
pnpm typecheck
pnpm test
pnpm build
pnpm test:e2e
pnpm demo:verify
uv run --project tools/datahub --locked pytest
git status --short
```

Expected: all gates zero; `git status --short` contains no generated artifacts and only intentionally uncommitted user-owned files if they were present in the worktree.

- [ ] **Step 4: Attach evidence and stop**

Record command versions, gate output summary, reviewer findings/resolutions, commit SHAs, and the statement `No product behavior claimed` in the PR/task report. Do not start F1 automatically.
