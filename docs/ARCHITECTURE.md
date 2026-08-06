# LineageGuard Architecture

## Decision summary

LineageGuard uses a **TypeScript-first hybrid monorepo**.

- TypeScript owns the product runtime, workflow orchestration, MCP integration, GitHub integration, domain types, persistence, and UI.
- Python is a narrow tooling layer for DataHub ingestion and walkthrough metadata seeding.
- DataHub is the context plane.
- PostgreSQL is the walkthrough data store and LineageGuard control store.
- dbt is the executable transformation and validation layer.
- The final safety decision is deterministic.

This architecture optimizes for a short build window, a polished React experience, shared types across frontend and backend, and direct use of a TypeScript agent SDK with MCP support.

## Scope boundary

LineageGuard operates inside the analytical data platform, downstream of the ingestion boundary
from operational systems. `commerce.orders`, the canonical dataset, is an analytical warehouse
data product (an "Orders Data Product") ingested from an operational Orders Service database via
events or CDC — it is not that service's live OLTP table, and the OLTP database itself is never
in scope. LineageGuard reasons about warehouse tables, dbt models, dashboards, ML features/models,
and ad-hoc SQL downstream of that ingestion boundary. It does not protect microservice-to-
microservice database sharing and is not a substitute for API contract testing, Protobuf/gRPC
schema evolution checks, or Kafka Schema Registry compatibility checking. See
`docs/DECISIONS/ADR-003-data-platform-boundary.md`.

## System context

```text
                         ┌──────────────────────────┐
                         │      GitHub Pull Request │
                         │ schema / dbt / SQL diff  │
                         └────────────┬─────────────┘
                                      │
                                      ▼
┌────────────────────┐      ┌──────────────────────────┐
│  Mission Control   │◄────►│ LineageGuard Web / BFF  │
│ Next.js + React    │      │ commands + run queries  │
└────────────────────┘      └────────────┬─────────────┘
                                         │ enqueue
                                         ▼
                              ┌──────────────────────────┐
                              │ LineageGuard Worker      │
                              │ typed workflow/state     │
                              └───────┬────────┬─────────┘
                                      │        │
                              context │        │ artifacts/actions
                                      ▼        ▼
                         ┌────────────────┐   ┌──────────────────────┐
                         │ DataHub MCP    │   │ Sandbox + Validators │
                         │ read/write gate│   │ SQL + dbt + tests    │
                         └───────┬────────┘   └──────────┬───────────┘
                                 │                       │
                                 ▼                       ▼
                         ┌────────────────┐     ┌─────────────────────┐
                         │ DataHub OSS    │     │ GitHub + examples/  │
                         │ context graph  │     │ PR/check/artifacts  │
                         └────────────────┘     └─────────────────────┘
```

## Physical deployment

The product release deployment fits on one sufficiently sized VPS.

```text
VPS
├── reverse proxy + TLS
├── apps/web
├── apps/worker
├── PostgreSQL
│   ├── commerce schema
│   ├── analytics schema
│   ├── fraud schema
│   └── lineageguard schema
├── DataHub OSS services
│   ├── GMS
│   ├── frontend
│   ├── MySQL
│   ├── Kafka
│   └── Elasticsearch
├── DataHub MCP Server
└── dbt / Python tooling containers or jobs
```

Important distinction:

> The application and walkthrough can use one PostgreSQL instance with multiple schemas, but DataHub's internal storage and messaging services remain the official DataHub stack. “One database” does not mean forcing DataHub into the walkthrough PostgreSQL database.

EC2 is a contingency deployment target, not an MVP dependency.

## Monorepo structure

```text
apps/
  web/
    app/
      page.tsx
      runs/[runId]/page.tsx
      api/
    components/
    lib/
  worker/
    src/
      worker.ts
      orchestration/
      handlers/
packages/
  domain/
    src/
      change.ts
      evidence.ts
      decision.ts
      migration.ts
      run.ts
      events.ts
      policy/
  agent/
    src/
      baseline-assessor.ts
      migration-planner.ts
      patch-generator.ts
      prompts/
  datahub/
    src/
      client.ts
      context-collector.ts
      normalizers/
      writeback.ts
      tool-policy.ts
  github/
    src/
      port.ts
      live-adapter.ts
      replay-adapter.ts
  validation/
    src/
      validator.ts
      sql-validator.ts
      dbt-validator.ts
      compatibility-validator.ts
  db/
    src/
      client.ts
      schema.ts
      repositories/
  ui/
    src/
walkthrough/
  warehouse/
  dbt/
  metadata/
  scenarios/
tools/
  datahub/
examples/
evals/
tests/
docs/
```

The implementation planner may refine names, but it must preserve the boundaries.

## Runtime workflow

### State machine

```text
CREATED
  → CHANGE_PARSED
  → BASELINE_ASSESSED
  → CONTEXT_COLLECTING
  → CONTEXT_COLLECTED
  → RISK_DECIDED
  → MIGRATION_PLANNED
  → PATCH_GENERATED
  → VALIDATING
  → VALIDATED
  → REVIEW_ARTIFACT_CREATED
  → WRITEBACK_PENDING
  → COMPLETED
```

Failure states are explicit:

```text
FAILED_CONTEXT
FAILED_GENERATION
FAILED_VALIDATION
FAILED_GITHUB
FAILED_WRITEBACK
CANCELLED
```

Each transition writes an immutable run event. The UI renders persisted events rather than inventing progress client-side.

### Canonical sequence

1. **Parse change**
   - consume a Git diff or committed scenario fixture;
   - identify changed dataset, field, operation, old type/name, new type/name;
   - the changed dataset is always an analytical warehouse table or transformation, never an
     operational service's OLTP schema;
   - reject unsupported changes with a typed reason.

2. **Repository-only baseline**
   - inspect only the changed repository and local dbt manifest;
   - produce a structured baseline assessment;
   - canonical scenario returns `ALLOW`.

3. **Resolve DataHub entities**
   - search by platform, environment, schema, dataset, and field;
   - require a unique or explicitly selected URN;
   - preserve resolution evidence.

4. **Collect context**
   - schema fields;
   - downstream lineage;
   - exact paths for critical consumers;
   - query history;
   - entity details, owners, glossary, tags, lifecycle, quality signals.

5. **Normalize evidence**
   - convert raw MCP results into domain-owned `EvidenceItem` records;
   - deduplicate by stable fingerprint;
   - assign provenance and criticality.

6. **Make deterministic decision**
   - classify the operation;
   - evaluate policy rules;
   - return `ALLOW`, `REVIEW`, or `BLOCK` with cited evidence IDs;
   - never delegate the final verdict to a model.

7. **Plan migration**
   - give the model only normalized evidence and allowed strategy primitives;
   - require Zod-validated structured output;
   - canonical strategy is expand–migrate–contract.

8. **Generate patch**
   - operate only in an isolated worktree/sandbox;
   - generate SQL, dbt updates, tests, and Markdown migration plan;
   - do not execute arbitrary model-authored commands.

9. **Validate**
   - run allowlisted commands;
   - compile dbt;
   - run dbt tests;
   - apply migration to disposable schema/database;
   - execute compatibility assertions;
   - return structured validation evidence.

10. **Create review artifact**
    - live mode: GitHub Check, comment, branch, and/or pull request;
    - replay mode: render the exact validated artifact bundle from a prior live run.

11. **Write back to DataHub**
    - enable mutation tools only at this stage;
    - save a migration decision document;
    - add a deprecation tag or structured property where supported;
    - include PR URL, decision, evidence summary, validation result, and sunset date;
    - production mode requires explicit approval.

## Domain model

The detailed schemas belong in `packages/domain`; the following concepts are fixed.

### ProposedChange

```ts
type ChangeOperation =
  | 'ADD_FIELD'
  | 'DROP_FIELD'
  | 'RENAME_FIELD'
  | 'CHANGE_TYPE'
  | 'CHANGE_NULLABILITY'
  | 'CHANGE_SEMANTICS';

interface ProposedChange {
  id: string;
  source: 'GITHUB' | 'FIXTURE';
  repository: string;
  baseSha: string;
  headSha: string;
  datasetRef: {
    platform: string;
    environment: string;
    database?: string;
    schema: string;
    dataset: string;
  };
  field?: string;
  operation: ChangeOperation;
  before: unknown;
  after: unknown;
  files: string[];
}
```

### EvidenceItem

```ts
type EvidenceKind =
  | 'SCHEMA'
  | 'LINEAGE_EDGE'
  | 'LINEAGE_PATH'
  | 'QUERY_USAGE'
  | 'OWNER'
  | 'DASHBOARD'
  | 'ML_MODEL'
  | 'GLOSSARY_TERM'
  | 'TAG'
  | 'LIFECYCLE'
  | 'QUALITY_SIGNAL';

interface EvidenceItem {
  id: string;
  kind: EvidenceKind;
  source: 'DATAHUB_MCP';
  sourceUrn: string;
  targetUrn?: string;
  fieldPath?: string;
  title: string;
  summary: string;
  criticality: 'LOW' | 'MEDIUM' | 'HIGH' | 'CRITICAL';
  rawFingerprint: string;
}
```

### RiskDecision

```ts
type Decision = 'ALLOW' | 'REVIEW' | 'BLOCK';

interface RiskReason {
  ruleId: string;
  message: string;
  evidenceIds: string[];
  severity: 'LOW' | 'MEDIUM' | 'HIGH' | 'CRITICAL';
}

interface RiskDecision {
  decision: Decision;
  score: number;
  reasons: RiskReason[];
  evaluatedAt: string;
  policyVersion: string;
}
```

### MigrationPlan

```ts
interface MigrationPlan {
  strategy: 'EXPAND_MIGRATE_CONTRACT';
  summary: string;
  steps: Array<{
    id: string;
    title: string;
    rationale: string;
    affectedEvidenceIds: string[];
    artifactTargets: string[];
  }>;
  requiredReviewers: Array<{
    ownerUrn: string;
    reason: string;
  }>;
  compatibilityWindowDays: number;
  rollbackPlan: string;
}
```

All model-produced structures must be schema-validated. Parsing failure is a normal, testable error path.

## Deterministic risk policy

The initial policy can be intentionally small and explicit.

Example rules:

| Rule | Condition | Outcome |
|---|---|---|
| `LG001` | destructive/rename/type change with downstream field lineage | `BLOCK` |
| `LG002` | production ML model downstream | `BLOCK` |
| `LG003` | observed `SYSTEM` query subject references field | at least `REVIEW`; `BLOCK` for rename/drop |
| `LG004` | critical dashboard downstream | `BLOCK` for incompatible changes |
| `LG005` | owner missing for affected critical asset | `REVIEW` |
| `LG006` | additive nullable field with no semantic conflict | `ALLOW` |
| `LG007` | glossary/structured-property semantic conflict | `REVIEW` or `BLOCK` |

Policy evaluation returns evidence-backed reasons. Scoring is explanatory; outcome derives from rule precedence, not an opaque weighted average.

## Agent design

Use the minimum number of runtime agents.

### Baseline Assessor

Input:

- proposed change;
- local repository context only.

Output:

- structured local assessment;
- no DataHub access.

Purpose:

- provide the counterfactual that makes DataHub's value visible.

### Migration Planner / Generator

Input:

- proposed change;
- deterministic risk decision;
- normalized evidence;
- allowed strategy primitives;
- repository file manifest.

Output:

- typed migration plan;
- patch/artifact proposal.

Restrictions:

- cannot change the risk decision;
- cannot invoke unrestricted shell;
- cannot write to DataHub directly;
- cannot merge or push to `main`.

The planner and patch generator can begin as one bounded agent and be split only if evidence shows a reliability problem.

## DataHub MCP integration

### Read phase tool allowlist

Expose only the tools needed for impact analysis:

- `search`;
- `list_schema_fields`;
- `get_entities`;
- `get_lineage`;
- `get_lineage_paths_between`;
- `get_dataset_queries`.

Use tool filtering in the agent SDK. Prefix MCP tool names to avoid collisions.

### Write phase tool allowlist

Create a separate client or run configuration that exposes only approved mutations:

- `save_document`;
- `add_tags`;
- `add_structured_properties`;
- optionally `update_description`.

Do not expose mutation tools to the context-collection agent.

### Adapter contract

The application depends on a `DataHubPort`, not on raw MCP response shapes:

```ts
interface DataHubPort {
  resolveField(ref: DatasetFieldRef): Promise<ResolvedField>;
  collectImpact(input: ImpactRequest): Promise<ImpactContext>;
  writeMigrationDecision(input: WritebackRequest): Promise<WritebackReceipt>;
}
```

Create:

- a live MCP adapter;
- a recorded fixture adapter for deterministic tests/replay;
- contract tests that both adapters must satisfy.

## GitHub integration

Define a narrow port:

```ts
interface GitHubPort {
  getProposedChange(ref: PullRequestRef): Promise<GitHubChangeBundle>;
  publishAssessment(input: PublishAssessmentRequest): Promise<AssessmentReceipt>;
  createMigrationReview(input: CreateMigrationReviewRequest): Promise<MigrationReviewReceipt>;
}
```

Two implementations:

- `LiveGitHubAdapter` using a fine-grained token or GitHub App;
- `ReplayGitHubAdapter` using committed fixtures.

The final walkthrough guide should use live GitHub where stable and retain replay mode as a contingency.

## Persistence and queueing

Avoid Redis for the MVP.

Use PostgreSQL tables for:

- runs;
- run events;
- evidence;
- decisions;
- generated artifacts;
- validation results;
- external receipts.

The worker may claim pending work with a transaction and `FOR UPDATE SKIP LOCKED`. This provides a simple durable queue without another service. The planner may choose a lightweight library only if it preserves inspectability and does not increase deployment risk.

## Frontend architecture

### Routes

- `/` — scenario launcher and project explanation;
- `/runs/[runId]` — primary Mission Control experience.

### Primary layout

```text
┌────────────────────────────────────────────────────────────────────┐
│ LineageGuard · run status · repository · elapsed time              │
├───────────────────┬─────────────────────────┬──────────────────────┤
│ Proposed Change   │ DataHub Impact Evidence │ Safe Migration       │
│ diff + baseline   │ lineage + queries       │ plan + generated diff│
│                   │ owners + criticality     │ validators + PR       │
├───────────────────┴─────────────────────────┴──────────────────────┤
│ Run timeline / evidence receipts / write-back                     │
└────────────────────────────────────────────────────────────────────┘
```

### Key visual states

1. `Repository checks passed` / baseline `ALLOW`;
2. DataHub context streaming into the evidence panel;
3. decision flips to `BLOCK`;
4. migration artifacts generated;
5. validators pass;
6. status becomes `READY FOR REVIEW`;
7. DataHub write-back receipt appears.

The UI consumes persisted run state and server events. A simple polling or Server-Sent Events implementation is acceptable; WebSockets are unnecessary unless proven useful.

## Validation architecture

Validators are allowlisted, deterministic tools.

### SQL migration validator

- applies migration to a disposable database/schema;
- verifies old and new columns during compatibility window;
- verifies backfill count and equality;
- verifies rollback script syntax where applicable.

### dbt validator

- `dbt deps` where required;
- `dbt parse` or `dbt compile`;
- `dbt test` for selected models;
- records command, duration, exit status, and artifact paths.

### compatibility validator

- old consumer query still works;
- updated consumer reads the new field;
- old and new identifiers remain equivalent during the window;
- no known downstream fixture is broken.

### repository validator

- format;
- lint;
- typecheck;
- unit tests;
- build.

Validation is executed in a sandbox/worktree with hard timeouts and output limits.

## Replay and walkthrough reliability

The system supports two modes.

### Live mode

- real DataHub MCP;
- real GitHub API;
- real model calls;
- real validation.

### Replay mode

- starts from a committed run manifest generated by a successful live run;
- replays persisted events and renders the exact artifact/evidence bundle;
- clearly labels itself as replay;
- exists only as a walkthrough/review contingency.

Replay mode must never fabricate a result that was not produced by a validated live run.

## Security model

Trust boundaries:

```text
untrusted PR diff / SQL / metadata text
        ↓
parsers and normalization
        ↓
typed domain evidence
        ↓
agent generation in isolated workspace
        ↓
allowlisted validators
        ↓
explicit external mutation gate
```

Controls:

- fine-grained tokens;
- separate read and mutation DataHub configurations;
- tool allowlists;
- Zod validation;
- no direct arbitrary shell tool for the runtime agent;
- isolated worktree/sandbox;
- command and path allowlists;
- redaction in logs and fixtures;
- human approval in production mode;
- immutable event log.

## Observability

Minimum:

- structured logs with run ID and step ID;
- persisted run events;
- model/tool traces through the Agents SDK where enabled;
- validator durations and exit codes;
- MCP tool names, latency, and response fingerprints without secret/raw payload leakage;
- UI-visible failure reason and retryability.

Do not introduce a separate observability platform before the canonical run works.

## Deployment strategy

### Primary

- existing VPS;
- Docker Compose;
- reverse proxy with HTTPS;
- persistent volumes for DataHub and PostgreSQL;
- health checks;
- scheduled backup/snapshot before walkthrough;
- hosted walkthrough kept running through review.

### Contingency

- EC2 instance sized for DataHub and the application;
- same Compose topology;
- no AWS-specific application dependency.

AWS documentation or infrastructure tools may help deploy, but AWS is not part of the review story and must not consume core build time.

## Architecture acceptance criteria

1. Full stack starts with documented commands.
2. The canonical field resolves to a stable DataHub URN.
3. Read-phase agents cannot see mutation tools.
4. Baseline and final decisions are stored separately.
5. Every final reason cites evidence IDs.
6. Generated output is isolated until validation succeeds.
7. Validation receipts are persisted.
8. Write-back is idempotent and returns a receipt.
9. The UI can reconstruct a run from persisted state.
10. A validated run can be replayed without external side effects.
