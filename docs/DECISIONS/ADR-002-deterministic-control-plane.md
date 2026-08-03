# ADR-002: Deterministic Control Plane Around Bounded Agentic Steps

- Status: Accepted
- Date: 2026-08-03
- Decision owners: LineageGuard project

## Context

LineageGuard makes safety recommendations about schema changes and creates migration artifacts. A language model is useful for explanation, planning, and code generation, but its output is probabilistic and may be influenced by untrusted repository or metadata content.

The project needs a strong agentic story without allowing the model to invent the final safety verdict, execute arbitrary commands, or mutate external systems without control.

## Options considered

### Free-form autonomous agent

The model receives GitHub, DataHub, shell, database, and mutation tools and decides how to complete the task.

Rejected because:

- behavior is difficult to reproduce;
- tool surface is too broad;
- safety decision is not auditable;
- prompt injection or tool confusion can cause side effects;
- the walkthrough can fail unpredictably;
- testing becomes largely observational.

### Multi-agent graph framework

Several specialized agents coordinate through a general graph/orchestration framework.

Rejected for the MVP because:

- the workflow is already known and mostly deterministic;
- another framework adds concepts, dependencies, and debugging cost;
- multi-agent delegation is not itself a review criterion;
- a week-long project benefits more from evidence and polish than topology.

### Deterministic application workflow with bounded agents

Application code owns states, policies, tool access, retries, validation, and side effects. Models are invoked only for narrow structured tasks.

## Decision

Use a deterministic control plane with bounded agentic steps.

Application code owns:

- parsing;
- entity resolution workflow;
- evidence normalization;
- policy evaluation;
- state transitions;
- retries/timeouts;
- validator execution;
- mutation gates;
- idempotency.

Models may own:

- repository-only explanation;
- migration-plan drafting;
- code/artifact generation within constrained targets;
- evidence-grounded summaries.

Models may not own:

- final `ALLOW | REVIEW | BLOCK` decision;
- unrestricted shell commands;
- direct GitHub merge;
- DataHub write-back without the policy gate;
- validator pass/fail determination.

## Runtime roles

Start with at most two agent roles:

1. baseline assessor;
2. migration planner/generator.

Split roles only when evaluation shows that a narrower context materially improves reliability.

## Tool policy

- DataHub read tools and mutation tools are never exposed in the same context-collection run.
- Tool names are allowlisted.
- Model outputs are validated against strict schemas.
- Generated patches are applied only in an isolated workspace.
- Validators execute allowlisted commands with limits.
- External writes require an idempotency key and a persisted receipt.

## Consequences

### Positive

- reproducible walkthrough;
- explainable decisions;
- strong unit and integration testing;
- narrow security boundaries;
- simple failure recovery;
- clear evidence that the agent is useful without pretending it is infallible.

### Negative

- less “autonomous” in marketing terms;
- more explicit application code;
- supported change types must be modeled deliberately.

## Rationale for review

The product release rewards technical execution and real-world usefulness. A controlled agent that produces a verified PR is more credible than an impressive but unpredictable swarm. The agentic value remains clear: DataHub context changes the plan and the model produces artifacts that deterministic systems then verify.
