# Product Strategy

## Target

Primary capability:

> **Organization-Aware Schema Change Safety**

long-term product impact ambition:

> Demonstrate a complete, useful, technically credible product loop in which DataHub is indispensable.

## Official evaluation model

The product release evaluates:

1. meaningful use of DataHub;
2. technical execution;
3. originality;
4. real-world usefulness;
5. release quality;
6. bonus consideration for a meaningful DataHub open-source contribution.

The project must remain optimized for those dimensions rather than for the largest possible feature set.

## Product thesis

The strongest single sentence is:

> **Without DataHub, the agent recommends merge. With DataHub, it finds hidden consumers, blocks the change, generates a compatible migration, verifies it, and writes the decision back.**

Every major implementation decision should strengthen that sentence.

## Criterion-by-criterion strategy

### 1. Use of DataHub

Weak interpretation:

- call `get_lineage`;
- display a graph;
- let the LLM summarize it.

Product interpretation:

- use schema, field-level lineage, exact paths, query history, ownership, glossary, and lifecycle metadata;
- normalize each signal into typed evidence;
- let evidence alter deterministic policy;
- cite DataHub URNs and paths in the decision;
- save the validated migration decision back as metadata/documentation;
- optionally contribute a reusable DataHub schema-change review skill.

Required proof:

```text
baselineDecision = ALLOW
finalDecision = BLOCK
changedBecause = [DataHubEvidence...]
```

### 2. Technical execution

The implementation must work end to end:

```text
Git diff
→ changed field
→ DataHub entity resolution
→ context collection
→ risk policy
→ migration plan
→ generated patch
→ dbt/SQL validation
→ GitHub artifact
→ DataHub write-back
```

Technical credibility comes from:

- typed domain models;
- schema-validated LLM output;
- deterministic policy rules;
- narrow tool allowlists;
- testable adapters;
- persisted run events;
- live and replay modes;
- visible failure handling;
- one-command verification.

### 3. Originality

DataHub already provides search, lineage, and impact-analysis capabilities. LineageGuard must not present those existing features as the invention.

The original layer is:

- comparing repository-only and organization-aware decisions;
- generating an expand–migrate–contract implementation;
- adding consumer-aware assertions and owner review;
- executing validators;
- preserving the decision for future agents.

The release wording should be explicit:

> “DataHub supplies the organizational context. LineageGuard turns that context into a safe engineering change.”

### 4. Real-world usefulness

The canonical scenario must feel like a real data-platform incident waiting to happen.

Use realistic assets:

- a PostgreSQL source schema;
- dbt staging and mart models;
- a Finance dashboard entity;
- a fraud feature/model entity;
- a query not represented in the repository;
- separate Finance and Risk ML owners.

Generated output must look mergeable:

- SQL migration;
- dbt changes;
- dbt tests/assertions;
- compatibility policy;
- migration document;
- reviewers;
- deprecation date.

### 5. Release quality

Reviewers may spend most of their time on the walkthrough guide, README, screenshots, and examples. Therefore:

- the first 15 seconds explain the risk;
- the decision flip happens before 75 seconds;
- the agent produces a real diff before 120 seconds;
- validation and write-back complete before 165 seconds;
- the final 15 seconds summarize quantified proof;
- captions remain readable at normal playback speed;
- `examples/` contains the exact before/after artifacts;
- setup uses a small number of documented commands;
- the hosted walkthrough remains available through review.

### 6. Open-source bonus

The preferred contribution is a focused DataHub-compatible skill or workflow for schema-change review, not a rushed connector.

Candidate contribution:

> `datahub-schema-change-review`

It should guide an agent through:

1. entity resolution;
2. schema inspection;
3. downstream field lineage;
4. query-history review;
5. owner and semantic context;
6. breaking-change classification;
7. migration artifact generation;
8. validation;
9. controlled write-back.

Open an upstream pull request only after the project workflow is stable. A low-quality contribution can distract from the core release.

## Canonical proof table

| Claim | Required evidence |
|---|---|
| Repository checks miss the risk | baseline assessment and green local checks |
| DataHub reveals hidden consumers | real MCP calls and DataHub URNs/paths |
| The decision changes | persisted before/after decisions with evidence IDs |
| The agent does real work | committed generated SQL/dbt/docs examples |
| The work is safe | executable validator results |
| The next agent benefits | DataHub document/tag/structured-property write-back |
| The walkthrough is reproducible | replay command and clean-start instructions |

## Scope priority

### P0 — must exist

- controlled walkthrough graph;
- repository-only baseline;
- DataHub context collector;
- deterministic decision flip;
- one generated migration;
- validation;
- DataHub write-back;
- Mission Control UI;
- README, examples, and walkthrough guide.

### P1 — add only after P0 is stable

- real GitHub Check and generated PR;
- multiple evaluation cases;
- owner approval interaction;
- upstream DataHub skill contribution;
- hosted public environment.

### P2 — cut first

- arbitrary schema diffs;
- multiple SQL dialects;
- model-provider abstraction;
- multi-user accounts;
- Slack notifications;
- rich workflow editor;
- additional agents;
- AWS deployment automation.

## Go/no-go gates

### Gate A — DataHub graph

The seeded DataHub instance must show field-level paths from `commerce.orders.customer_id` to at least:

- an analytics model;
- a dashboard;
- a fraud model;
- an unmanaged query signal.

No graph, no agent implementation.

### Gate B — decision change

A test must prove:

```text
repository-only context → ALLOW
DataHub context         → BLOCK
```

No deterministic flip, no UI polish.

### Gate C — real work

The generated migration must compile and pass the defined dbt/SQL assertions.

No passing artifact, no claim that the agent “fixes” the change.

### Gate D — write-back

The validated decision must be discoverable in DataHub after the run.

No write-back, no complete agent loop.

### Gate E — walkthrough

`pnpm walkthrough:verify` must run the canonical scenario without manual repairs and produce the expected evidence bundle.

No stable replay, no walkthrough.

## Narrative risks and mitigations

| Risk | Mitigation |
|---|---|
| Looks like built-in impact analysis | Lead with generated and verified migration, not the graph |
| Agent appears to hallucinate | Show deterministic policy and evidence IDs |
| Walkthrough is too technical | Use one human-readable rename and a clear three-stage UI |
| Too much infrastructure | One monorepo, one VPS, controlled dataset, no unnecessary platforms |
| Live network fails | Maintain replay mode from a previously validated real run |
| Write-back looks cosmetic | Open the saved decision/document in DataHub at the end |
| Generated code is unconvincing | Include exact artifacts and executable test output in `examples/` |

## Final success statement

LineageGuard wins when a reviewer can say:

> “This is not another metadata chatbot. DataHub gave the agent context it could not obtain from the repository, and the agent used it to produce a change a real team could review and merge.”
