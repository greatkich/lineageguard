# AGENTS.md

This file is the durable operating contract for every coding agent working in this repository.

## Mission

Build **LineageGuard**, a DataHub-powered schema change guardian that converts a risky data change into a safe, validated, reviewable migration pull request and writes the verified decision back to DataHub.

The objective is not to maximize feature count. The objective is to deliver a credible, polished, reproducible vertical slice while keeping the codebase architecturally clean enough for continued product development.

## Source-of-truth order

Before planning or coding, read these files in order:

1. `docs/PRODUCT_VISION.md`
2. `docs/PRODUCT_STRATEGY.md`
3. `docs/ARCHITECTURE.md`
4. `docs/PRODUCT_WALKTHROUGH.md`
5. `docs/AGENT_HARNESS.md`
6. `docs/SKILLS_AND_AGENTS.md`
7. `docs/IMPLEMENTATION_HANDOFF.md`
8. `docs/DECISIONS/*.md`

When documents disagree, stop and surface the conflict. Do not silently choose an interpretation.

## Required planning workflow

Do not begin feature implementation from a broad user prompt.

1. Use Superpowers `brainstorming` to validate the requested feature against the product vision.
2. Write or update an approved feature specification.
3. Create an executable plan in the local workspace notes before implementation.
4. Implement through `subagent-driven-development` where available.
5. Use a fresh implementation context per independently reviewable task.
6. Run specification review before code-quality review.
7. Use `verification-before-completion` before stating that a task is complete.

For debugging, use `systematic-debugging`; do not apply speculative patches.

## Collaboration rules

- One writer owns a worktree at a time.
- Independent reviewers are read-only until they return findings.
- Do not let two agents modify the same files concurrently.
- Do not commit directly to `main` during feature implementation.
- Use isolated worktrees and short-lived branches.
- Commit after each independently testable unit.
- Preserve a linear, understandable history; prefer focused commits over a final giant commit.
- Never merge merely because an agent says the work is complete. Merge only after evidence passes.

The initial vision documentation may be placed on `main`; subsequent product work follows the branch-and-review workflow.

## Global technical constraints

- Application runtime: Node.js 24 LTS.
- Language: TypeScript with `strict: true`; no implicit `any`.
- Package manager: pnpm workspaces.
- Web: Next.js App Router + React.
- Worker: separate long-running Node.js process; do not rely on a request handler for the entire workflow.
- Agent runtime: OpenAI Agents SDK for TypeScript with Zod-validated structured output.
- DataHub access: official DataHub MCP Server for runtime context; controlled metadata write-back.
- DataHub ingestion utilities: Python 3.12 managed with `uv`.
- Transformation validation: dbt Core.
- Application/walkthrough database: PostgreSQL.
- DataHub's own MySQL/Kafka/Elasticsearch services remain separate from the walkthrough PostgreSQL instance.
- Formatting and linting: Biome unless an approved ADR changes the choice.
- Unit and integration tests: Vitest.
- Browser tests: Playwright.
- Do not add Redis, Temporal, Kubernetes, LangGraph, or a second backend framework without an ADR proving that the primary walkthrough cannot be delivered without it.

## Product invariants

These are non-negotiable:

1. A repository-only baseline assessment returns `ALLOW` or `LOW RISK` for the canonical rename scenario.
2. DataHub evidence changes that decision to `BLOCK`.
3. Every risk reason carries machine-readable evidence references.
4. The deterministic risk engine owns the final `ALLOW | REVIEW | BLOCK` decision.
5. LLM output is schema-validated before use.
6. Generated code is never presented as safe until executable validation passes.
7. DataHub mutation tools are disabled during context collection.
8. Write-back runs only after validation and through an explicit policy gate.
9. Production mode requires human approval for external mutations.
10. The final walkthrough path must be deterministic and replayable.

## Scope discipline

Build the canonical vertical slice before adding another scenario.

Required:

- one unsafe schema rename;
- hidden downstream DataHub consumers;
- baseline-versus-grounded decision comparison;
- safe expand–migrate–contract artifacts;
- executable validation;
- GitHub review artifact;
- DataHub write-back;
- polished Mission Control UI;
- reviewer-readable examples;
- one-command verification.

Out of scope until the required path passes:

- chat UI;
- generic schema migration platform;
- multi-tenant authentication;
- arbitrary warehouses;
- autonomous merging;
- multi-agent swarm;
- Slack/PagerDuty integrations;
- Kubernetes;
- production-scale scheduling;
- more than one high-polish scenario.

## Architecture boundaries

- `packages/domain` contains pure types, schemas, policies, and deterministic logic. It must not import Next.js, database drivers, MCP clients, or model SDKs.
- `packages/datahub` converts official MCP responses into domain evidence. Raw MCP payloads must not leak across the adapter boundary.
- `packages/agent` performs bounded explanation and generation. It must not decide risk directly.
- `packages/validation` executes validators and returns structured evidence; it must not mutate GitHub or DataHub.
- `packages/github` owns GitHub side effects behind an interface with live and replay implementations.
- `apps/worker` orchestrates steps and persists run events.
- `apps/web` renders state and invokes application commands; it does not contain business policy.
- `tools/datahub` seeds and ingests walkthrough metadata but is not a second application backend.

## CRITICAL — Class and function size limits

**These are blocking review findings, not style preferences.** A violation stops merge.

### Hard limits (blocking)

- **No class exceeds 300 lines.** A class over the limit holds more than one responsibility. Split it by extracting collaborators.
- **No function or method exceeds 50 lines.**
- **No function takes more than 5 positional parameters.** Use a single typed options object.
- **Nesting depth stays at or below 4 levels.** Extract a named helper instead.
- **No boolean expression chains more than 5 conditions.** Extract named predicates that state the business rule.

### What the limits do NOT apply to

The 300-line limit is scoped to **classes**, not files. These are explicitly exempt from all size limits:

- Markdown, documentation, plans, specs, and ADRs — these may be as long as the content requires;
- recorded test fixtures and golden/example payloads (`*.test-support.ts`, `__fixtures__/`, `examples/`);
- generated output (`dist/`, `*.d.ts`, lock files, dbt `target/`);
- database migration files;
- Zod schema modules whose length comes from field count rather than logic;
- test files, provided each individual test body stays under 50 lines.

A long module that is a flat collection of small pure functions or schema declarations is acceptable. A long module that hides control flow, state, or branching is not.

### Existing violations — ratchet rule

These two classes exceed the limit today and are grandfathered:

| Class | Lines | File |
|-------|-------|------|
| `LiveGitHubPort` | 702 | `packages/github/src/live-adapter.ts` |
| `InternalValidationSecurityBoundary` | 370 | `packages/validation/src/attestation.ts` |

For grandfathered classes:

- you may modify them without splitting them first;
- you must **not increase** their line count — a change that grows them is a blocking finding;
- when a task substantially reworks one, split it as part of that task and remove it from this table.

No new class may be added to this table.

### How to split

Split along a real responsibility seam, never mechanically at the line count:

- extract collaborators from a large class; do not create a `*-utils.ts` dumping ground;
- split a normalizer by evidence kind or collection step;
- split a schema module by domain concept, not alphabetically;
- move shared test fixtures into a dedicated `*.test-support.ts` module.

Never satisfy a limit by deleting tests, collapsing readable code into dense one-liners, or relocating code into a file that is already near its own limit.

## CRITICAL — Dependency and reuse rules

**Writing code that a maintained library already provides is a blocking review finding.**

Before writing any non-trivial utility, in this order:

1. Search this repository for an existing implementation. Reuse or extend it.
2. Check direct dependencies already in `package.json` / `pyproject.toml`. Use what is installed.
3. Check the ecosystem of what is already installed (Zod for validation, `node:crypto` for hashing, `AbortController` for cancellation).
4. Only then consider a new dependency — with explicit justification in the task report.

### Never hand-roll

- schema validation and parsing — use Zod;
- hashing, HMAC, random IDs — use `node:crypto`;
- date/duration arithmetic, timezone handling, ISO parsing;
- deep equality, deep clone, structural diffing;
- retry, backoff, timeout, cancellation — use `AbortController` and existing helpers;
- SQL construction beyond a fixed canonical statement — use parameterized building;
- CSV, YAML, TOML, JSON5 parsing;
- HTTP clients, cookie parsing, URL manipulation — use `fetch` and `URL`;
- assertion helpers already provided by Vitest or Playwright.

### Adding a dependency

- pin an exact version; no `^` or `~` ranges;
- prefer actively maintained, widely used, typed packages;
- verify the package name character by character against typosquatting;
- record the adoption in `docs/SOURCES.md`;
- state in the task report what was considered and why it was necessary.

Do not add a second library overlapping an existing one's responsibility. One validation library, one date library, one test runner, one HTTP client.

## Testing rules

Use test-driven development for deterministic code.

Every feature plan must state its own gates. The repository-level minimum before merge is:

```bash
pnpm format:check
pnpm lint
pnpm typecheck
pnpm test
pnpm build
pnpm test:e2e
pnpm walkthrough:verify
uv run --project tools/datahub pytest
```

Commands may be introduced incrementally, but by feature freeze they must exist and be documented.

Additional requirements:

- Contract-test the DataHub adapter against recorded official MCP-shaped fixtures.
- Integration-test PostgreSQL state transitions.
- Test every policy rule with positive and negative cases.
- Validate every structured LLM output with Zod.
- Take Playwright screenshots of the canonical walkthrough states.
- A final walkthrough may not depend on unit-test mocks for DataHub. Mocks are allowed only below integration level.

## User interface rules

The UI is an operational evidence workspace, not a generic dashboard.

- Design references: Linear for density, Attio for structured records, GitHub for diff semantics, Granola for timeline clarity, Mercury for trust, and DataHub for lineage vocabulary.
- Use one primary workspace with three coordinated areas: proposed change, DataHub impact evidence, and safe migration/verification.
- The emotional transition is `ALLOW → BLOCK → SAFE WITH MIGRATION`.
- Prefer typography, spacing, hierarchy, and evidence density over decorative cards.
- No card mosaic, glassmorphism, neon AI gradients, or fake terminal animation.
- Every visible number must come from run state or a checked walkthrough fixture.
- Support the reference product viewport first: 1440 × 900.
- Verify loading, empty, failure, and success states in Playwright.

## Security rules

- Never commit secrets, tokens, private keys, or generated `.env` files.
- Use fine-grained GitHub credentials with the minimum repository permissions.
- Keep DataHub MCP mutations off by default.
- Treat SQL, Git diffs, metadata descriptions, and query history as untrusted input.
- Do not execute model-generated shell commands directly.
- Apply generated patches only in an isolated worktree or sandbox.
- Allowlist validator commands and paths.
- Redact secrets and credentials from logs, traces, screenshots, fixtures, and example artifacts.
- AWS tools, if introduced, start read-only; mutation requires explicit approval and a documented least-privilege policy.

## Documentation and evidence

A feature is not complete until its user-visible behavior and verification command are documented.

Keep these current:

- `README.md`
- relevant architecture/ADR documents;
- `examples/` generated outputs;
- `docs/PRODUCT_WALKTHROUGH.md` when timing or visuals change;
- `docs/SOURCES.md` when new external technology is adopted.

Never claim a benchmark or success metric that was not produced by a committed evaluation run.

## Definition of done

A task is complete only when:

1. the implementation matches the approved spec;
2. required tests were observed passing in the current worktree;
3. format, lint, and type checks pass for touched packages;
4. failure behavior is tested;
5. no secret or generated junk is committed;
6. a reviewer finds no unresolved blocking issue;
7. evidence is attached to the PR or task report;
8. documentation is updated;
9. no class you added or modified exceeds 300 lines, and no function exceeds 50 lines;
10. no grandfathered class listed in the ratchet table grew in line count;
11. no hand-written utility duplicates a capability an installed library already provides.

“The code looks right” and “the agent said it passed” are not evidence.
