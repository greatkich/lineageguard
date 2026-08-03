# Agent Engineering Harness

## Purpose

This repository will be implemented primarily by Codex using Superpowers and repository-native skills. The harness exists to prevent fast autonomous coding from becoming unreviewed, context-poor code generation.

The operating principle is:

> **Specifications constrain the work, isolated agents implement it, independent agents review it, and evidence—not the agent—declares completion.**

## Harness layers

```text
Product vision and architecture
            ↓
Feature specification
            ↓
Executable Superpowers plan
            ↓
Isolated worktree + fresh implementer
            ↓
Focused tests and local verification
            ↓
Specification review
            ↓
Code-quality/security review
            ↓
Repository-wide verification
            ↓
Pull request and merge decision
```

## Required Superpowers workflow

### 1. Brainstorming

Use when:

- starting a feature;
- architecture or scope is ambiguous;
- a requirement conflicts with a source-of-truth document.

Output:

- clarified behavior;
- alternatives considered;
- explicit exclusions;
- approved design direction.

Do not let brainstorming reopen the already accepted TypeScript-first hybrid decision without new evidence and an ADR.

### 2. Writing plans

Each implementation plan must be saved to:

```text
docs/superpowers/plans/YYYY-MM-DD-<feature-name>.md
```

Plans must include:

- exact files;
- interfaces produced and consumed;
- failing test first;
- commands and expected outcomes;
- rollback/failure behavior;
- independently reviewable commits;
- explicit acceptance gates.

Broad instructions such as “implement error handling” are plan defects.

### 3. Git worktrees

Create a dedicated worktree for each feature or independent task group.

Rules:

- one writer per worktree;
- no shared mutable worktree between agents;
- no direct changes to `main`;
- generated migration scenarios run in their own sandbox/worktree.

### 4. Subagent-driven development

Use a fresh implementer for each plan task when practical.

The coordinator gives the subagent only:

- the task section;
- relevant interfaces;
- repository constraints;
- exact verification commands.

The coordinator must not dump the entire history into every subagent. Context should be intentional.

### 5. Test-driven development

Required for:

- parsers;
- domain policies;
- state transitions;
- evidence normalization;
- adapter contracts;
- validation logic;
- write-back idempotency.

For UI implementation, use component behavior tests and Playwright acceptance tests; do not force meaningless unit tests for visual markup.

### 6. Requesting code review

Every task receives two distinct reviews:

1. **Specification review** — does the output meet the approved behavior and boundaries?
2. **Quality review** — is the implementation maintainable, safe, tested, and simple?

A reviewer should be a fresh, read-only context. The implementer must not self-approve.

### 7. Systematic debugging

On failure:

1. reproduce;
2. collect evidence;
3. identify the failing boundary;
4. form one hypothesis;
5. test the hypothesis;
6. implement the smallest root-cause fix;
7. add regression coverage.

Do not stack speculative changes.

### 8. Verification before completion

Before saying “done,” run the task gates and inspect the actual output in the current worktree. Historical green CI is not evidence for current changes.

### 9. Finishing a development branch

Only after reviews and verification:

- summarize behavior and evidence;
- ensure docs/examples are updated;
- open a PR;
- merge through the approved method;
- remove the worktree after merge.

## Agent roles

Roles are responsibilities, not necessarily permanent custom agent definitions. Superpowers can instantiate them as fresh subagents.

### Product Architect

Responsibilities:

- interpret product source-of-truth documents;
- clarify scope;
- write feature specs and ADRs;
- protect walkthrough narrative and review alignment.

Restrictions:

- does not implement production code during planning;
- does not change accepted architecture silently.

### DataHub Integration Engineer

Responsibilities:

- DataHub deployment and health;
- ingestion and metadata seed;
- MCP connectivity;
- entity resolution;
- lineage/query/owner evidence;
- controlled write-back.

Required skills:

- official DataHub setup, search, lineage, enrich, and quality skills;
- Python/uv tooling;
- MCP contracts;
- fixture and integration testing.

### Domain and Safety Engineer

Responsibilities:

- proposed-change model;
- evidence model;
- deterministic policy;
- state machine;
- idempotency and failure semantics.

Restrictions:

- domain package remains pure;
- no LLM call determines policy outcome.

### Agent Runtime Engineer

Responsibilities:

- bounded OpenAI Agents SDK integration;
- structured outputs;
- tool filters;
- tracing;
- prompts and eval cases;
- sandbox interaction.

Restrictions:

- no unrestricted shell tool;
- no mutation tools during context collection;
- no multi-agent topology without demonstrated need.

### Full-Stack Product Engineer

Responsibilities:

- Next.js application;
- run queries/commands;
- Mission Control UI;
- accessibility and responsive behavior;
- server events/polling;
- frontend error states.

Required skills:

- React/Next.js;
- Playwright;
- screenshot-based visual review;
- accessible UI patterns.

### Walkthrough Data Engineer

Responsibilities:

- PostgreSQL schemas and data;
- dbt graph;
- controlled hidden consumers;
- DataHub entities and field lineage;
- repeatable reset/seed commands.

### Independent Reviewer

Responsibilities:

- review against the task spec;
- detect untested behavior, silent fallback, type leakage, unsafe tools, and scope creep;
- return findings by severity with file references.

Restrictions:

- read-only until findings are returned;
- no “helpful” edits while reviewing.

### QA and Visual Reviewer

Responsibilities:

- run Playwright end-to-end scenarios;
- inspect screenshots at the target walkthrough viewport;
- check console/network errors;
- verify loading, failure, empty, and completed states;
- compare the UI to the storyboard.

### Release and Release Lead

Responsibilities:

- clean-start verification;
- deployment health;
- examples and README;
- walkthrough guide timing and captions;
- release checklist field completeness;
- public URL availability through review.

## Context packages for subagents

Each task should receive a small context packet:

```text
Task goal
Relevant source-of-truth excerpts
Interfaces consumed and produced
Files allowed to change
Commands to run
Expected failure before implementation
Expected evidence after implementation
Explicit non-goals
```

Do not send a generic “build LineageGuard” prompt to an implementation subagent.

## Review gates by feature type

### Domain/policy

- unit tests for every rule;
- table-driven edge cases;
- no infrastructure imports;
- deterministic repeatability;
- evidence references required.

### Adapter

- port defined first;
- live and fixture implementation contract tests;
- timeouts and typed errors;
- raw external shape contained inside adapter;
- secret-safe logs.

### Agent behavior

- Zod schema validation;
- malformed-output test;
- tool allowlist test;
- prompt injection/untrusted metadata test;
- trace/eval fixture;
- no policy authority.

### UI

- storyboard acceptance test;
- keyboard/accessibility pass;
- no console errors;
- screenshots at 1440 × 900;
- failure and loading state;
- values originate from run state.

### Deployment

- health checks;
- restart behavior;
- persistent volumes;
- secret injection documented;
- clean Compose startup;
- rollback instructions.

## Continuous integration gates

Target workflow:

```text
Install
→ format check
→ lint
→ typecheck
→ unit tests
→ Python tooling tests
→ build
→ contract/integration tests
→ Playwright
→ walkthrough smoke
→ secret scan
```

Long DataHub integration tests may run in a dedicated workflow or nightly/manual job until stable, but the canonical walkthrough smoke must run before feature freeze.

## Commit strategy

Prefer commits that tell the implementation story:

```text
chore: establish TypeScript monorepo and quality gates
feat(walkthrough): seed canonical warehouse and dbt graph
feat(datahub): collect typed downstream impact evidence
feat(policy): block breaking changes with critical consumers
feat(agent): generate expand-migrate-contract plan
feat(validation): verify migration and consumer compatibility
feat(github): publish evidence-backed migration review
feat(datahub): persist validated migration decision
feat(web): add Mission Control decision workflow
chore(walkthrough): add deterministic replay and release artifacts
```

Do not use dozens of one-line “fix” commits or one giant final commit.

## Evidence report template

Each completed feature should provide:

```markdown
## Implemented
- ...

## Verification observed
- `command` → PASS

## Artifacts
- path or PR link

## Known limitations
- ...

## Reviewer findings
- none / list
```

## Anti-patterns

- asking one agent to design, implement, test, and approve its own work;
- coding before DataHub graph acceptance;
- mocking the product path in the final walkthrough;
- letting UI state drift from persisted workflow state;
- hiding tool failures and silently returning empty context;
- using LLM confidence as safety evidence;
- adding infrastructure because it is fashionable;
- installing broad mutation-capable MCP servers by default;
- claiming completion without observed commands.
