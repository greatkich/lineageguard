# Implementation Handoff for Codex

## Purpose

This document tells Codex how to transform the approved product/architecture foundation into feature specifications and executable Superpowers plans.

It is deliberately not a line-by-line implementation plan. Codex must inspect the repository and current official documentation, then produce plans that match the actual files and installed tool versions.

## First-session objective

The first Codex session must **plan, not code**.

Expected outputs:

1. repository and environment assessment;
2. contradictions/gaps report;
3. feature specification set;
4. dependency graph and critical path;
5. Superpowers implementation plans;
6. risk register and cut order;
7. user approval checkpoint.

## Mandatory reading

Read:

```text
AGENTS.md
docs/PRODUCT_VISION.md
docs/WINNING_STRATEGY.md
docs/ARCHITECTURE.md
docs/DEMO_STORYBOARD.md
docs/AGENT_HARNESS.md
docs/SKILLS_AND_AGENTS.md
docs/DECISIONS/*.md
```

Then inspect the actual repository tree, current branch, installed skills, available tools, and environment versions.

## Planning method

1. Invoke Superpowers `brainstorming`.
2. Treat existing documents as accepted constraints, not an invitation to restart ideation.
3. Ask only questions that materially change implementation or demo success.
4. Record any contradiction before continuing.
5. Split the work into independently testable feature specifications.
6. Use Superpowers `writing-plans` for each feature or tightly coupled feature group.
7. Save plans under `docs/superpowers/plans/`.
8. Present the plan set and critical path for approval before implementation.

## Required feature decomposition

Codex may refine boundaries, but it must cover these outcomes.

### F0 — Repository foundation and engineering gates

Outcome:

- pnpm monorepo;
- Node 24 and Python 3.12 version policy;
- TypeScript strict configuration;
- Biome;
- Vitest;
- Playwright;
- `uv` Python tooling project;
- Docker Compose layers;
- CI skeleton;
- environment validation and Makefile/task commands.

Acceptance:

- clean installation;
- minimal app/package tests pass;
- no product behavior claimed yet.

### F1 — Canonical demo data and DataHub graph

Outcome:

- PostgreSQL commerce/analytics/fraud schemas;
- deterministic seed data;
- dbt models;
- dashboard and ML entities;
- owners/glossary/criticality;
- unmanaged query history signal;
- table and field-level lineage;
- repeatable reset/seed/verify commands.

Acceptance:

- DataHub visibly contains every canonical consumer;
- an automated verification script asserts the expected graph.

This is the first critical gate.

### F2 — Proposed change domain and parser

Outcome:

- typed proposed-change model;
- canonical Git diff fixture;
- SQL/dbt schema-change parser for the supported rename case;
- explicit unsupported-case errors;
- repository-only context bundle.

Acceptance:

- canonical rename is parsed deterministically;
- unsupported syntax does not silently degrade.

### F3 — DataHub context collector

Outcome:

- `DataHubPort`;
- official MCP adapter;
- recorded fixture adapter;
- entity/field resolution;
- schema, lineage, exact paths, query, owner, glossary, and criticality collection;
- normalized evidence;
- contract tests.

Acceptance:

- canonical run returns the expected hidden consumers with stable evidence IDs;
- missing/ambiguous entity paths fail visibly.

### F4 — Deterministic risk engine and baseline comparison

Outcome:

- repository-only baseline assessor;
- policy rules `LG001+`;
- evidence-backed `ALLOW | REVIEW | BLOCK` decision;
- persisted baseline and final decisions;
- explicit decision-change explanation.

Acceptance:

```text
canonical baseline = ALLOW
canonical final    = BLOCK
```

This is the second critical gate.

### F5 — Migration planner and artifact generator

Outcome:

- bounded Agents SDK integration;
- Zod schemas;
- tool filters;
- expand–migrate–contract plan;
- SQL, dbt, tests, and migration-document artifacts;
- isolated worktree/sandbox;
- malformed-output and prompt-injection coverage.

Acceptance:

- canonical evidence produces a complete typed plan and patch;
- no policy outcome can be overridden by model output.

### F6 — Executable validation

Outcome:

- disposable database/schema;
- SQL migration validation;
- backfill equality validation;
- dbt compile/test;
- old-consumer compatibility check;
- structured receipts and logs.

Acceptance:

- generated canonical migration passes all checks;
- intentionally broken generated artifact fails with a useful reason.

This is the third critical gate.

### F7 — GitHub review integration

Outcome:

- `GitHubPort`;
- live and replay adapters;
- read proposed PR/diff;
- publish assessment/check/comment;
- create generated migration review branch/PR or equivalent review artifact;
- owner/reviewer mapping;
- idempotent retry behavior.

Acceptance:

- a real GitHub review artifact contains evidence and validation receipts;
- replay mode renders a committed validated receipt.

### F8 — Controlled DataHub write-back

Outcome:

- separate mutation configuration;
- explicit write-back policy;
- migration decision document;
- deprecation tag/structured property;
- PR/validation references;
- idempotent receipt;
- production human-approval mode.

Acceptance:

- the final decision is visible/searchable in DataHub;
- context collection cannot access mutation tools.

This is the fourth critical gate.

### F9 — Mission Control UI

Outcome:

- `/` scenario launcher;
- `/runs/[runId]` operational workspace;
- proposed change, DataHub evidence, migration, validation, PR, and write-back panels;
- persisted timeline;
- loading/failure/completed states;
- target viewport screenshots;
- accessible interactions.

Acceptance:

- the visual story matches `docs/DEMO_STORYBOARD.md`;
- all displayed facts originate from run state;
- Playwright captures required states without console errors.

### F10 — Evaluation, replay, deployment, and submission

Outcome:

- canonical and secondary eval fixtures;
- baseline-vs-grounded report;
- `examples/` artifact bundle;
- deterministic replay generated from a real validated run;
- VPS deployment;
- clean-start guide;
- final README;
- demo script/assets;
- optional upstream DataHub skill contribution.

Acceptance:

- `pnpm demo:verify` passes;
- hosted system is healthy;
- clean reviewer setup succeeds;
- recording finishes under three minutes.

## Suggested plan grouping

Superpowers plans should remain small enough to review. A reasonable starting set is:

```text
01-foundation-and-quality-gates.md
02-demo-data-and-datahub-graph.md
03-change-parser-and-domain-model.md
04-datahub-context-and-evidence.md
05-risk-engine-and-baseline.md
06-migration-agent-and-artifacts.md
07-validation-pipeline.md
08-github-and-writeback.md
09-mission-control-ui.md
10-evals-deployment-and-submission.md
```

Codex should split a plan further when it contains independent subsystems or would exceed a manageable review context.

## Critical path

```text
F0
 ↓
F1 DataHub graph
 ↓
F2 parser ───► F3 context
                  ↓
              F4 decision flip
                  ↓
              F5 generation
                  ↓
              F6 validation
               ↙       ↘
          F7 GitHub   F8 write-back
               \       /
                 F9 UI
                  ↓
          F10 demo/submission
```

UI shell work may begin after domain event contracts stabilize, but UI polish must not get ahead of the decision and validation gates.

## Internal timeline

Use the actual current date and remaining time when planning. The target sequence is:

- August 3: foundation documents, tooling, plan approval;
- August 4: demo graph and verified DataHub context;
- August 5: parser, context collector, deterministic decision flip;
- August 6: generation and executable validation;
- August 7: GitHub integration and DataHub write-back;
- August 8: Mission Control, evals, replay, deployment;
- August 9: feature freeze, clean-start verification, README, screenshots, video;
- August 10: critical fixes only and early submission.

When time slips, cut P2/P1 work before weakening the canonical vertical slice.

## Planning questions Codex must resolve

Codex should verify and record concrete answers for:

1. exact current package versions compatible with Node 24;
2. current DataHub Quickstart/Compose approach;
3. DataHub MCP transport and configuration in the chosen runtime;
4. how canonical query history will be seeded in DataHub OSS;
5. exact field-lineage ingestion method;
6. GitHub authentication mode for live demo;
7. disposable validation database strategy;
8. event delivery to the web UI: polling or SSE;
9. idempotency keys for GitHub and DataHub side effects;
10. hosted VPS resource requirements and health checks.

Use official documentation as the source of truth. Record decisions in ADRs when they affect architecture.

## Risk register

| Risk | Early test | Cut/fallback |
|---|---|---|
| Field lineage ingestion takes too long | prove F1 first | seed via official SDK/API with controlled fixtures |
| Query history unavailable in OSS seed | verify in F1 | model it as a documented query asset/evidence fixture while clearly labeling source |
| MCP mutation incompatibility | spike before F8 | use official DataHub SDK for write-back behind same port, document why |
| GitHub API permissions fail | smoke before F7 | pre-create live PR and use replay adapter for mutation step |
| Model-generated patch unstable | lock canonical repository and Zod schemas | use template-constrained generation with model-filled rationale/targets |
| VPS resource pressure | load-test Compose early | move DataHub stack to EC2 contingency |
| UI consumes too much time | stabilize contracts early | one polished run page, no broad navigation |
| Upstream skill PR distracts | wait until P0 stable | include project-local skill and contribution design only |

## Implementation constraints for plans

Every plan must preserve:

- TDD for deterministic logic;
- exact interfaces between tasks;
- no placeholders;
- observed commands and expected output;
- frequent meaningful commits;
- independent specification and quality review;
- failure paths;
- secret-safe fixtures;
- documentation updates;
- verification before completion.

## First implementation checkpoint

Do not proceed beyond F1 until a human can open DataHub and see the canonical graph. This prevents the team from building a polished agent around imaginary metadata.

## Final implementation checkpoint

Do not record the video until a clean environment can execute the canonical flow and produce:

```text
baseline: ALLOW
final: BLOCK
migration: GENERATED
validation: PASS
review artifact: CREATED
write-back: VERIFIED
```
