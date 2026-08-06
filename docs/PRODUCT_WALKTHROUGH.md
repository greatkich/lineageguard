# Product Walkthrough

## Objective

Show how DataHub gives an AI coding agent organizational context it cannot obtain from a repository, and how LineageGuard turns that context into a safe, verified migration.

LineageGuard operates inside the analytical data platform: `commerce.orders` is an analytical
warehouse data product (the Orders Data Product in the Commerce Warehouse), populated from the
Orders Service's operational database via events or CDC. The walkthrough never touches that
operational database — it protects downstream data consumers (dbt marts, dashboards, ML
features/models, ad-hoc SQL), not microservice-to-microservice database sharing, and it is not a
substitute for API/Protobuf/Kafka Schema Registry contract testing. See
`docs/DECISIONS/ADR-003-data-platform-boundary.md`.

The walkthrough should feel like a product, not a narrated architecture diagram.

## Reference environment

- Viewport: 1440 × 900.
- Main surfaces: GitHub, LineageGuard Mission Control, DataHub UI.
- Keep validation evidence concise and readable without depending on terminal narration.

## Narrative arc

```text
Looks safe → hidden danger → decision changes → agent repairs → evidence proves safety → knowledge persists
```

## Readiness state

Prepare before presenting the workflow:

- DataHub seeded with the canonical graph;
- a live GitHub PR proposing the unsafe rename;
- repository checks already green;
- a clean LineageGuard run ready to launch;
- DataHub read access healthy;
- GitHub write permission healthy;
- mutation/write-back access disabled until the final step;
- deterministic model settings and scenario inputs;
- replay bundle from a successful rehearsal;
- browser tabs ordered and authenticated;
- all secrets and personal data hidden.

## Canonical script

### The local view says safe

**Visual:** GitHub PR diff.

```diff
- customer_id
+ buyer_id
```

Show green checks.

**Voiceover:**

> “This pull request renames a customer identifier on the Orders Data Product in the Commerce Warehouse. Every test in this repository passes, so a normal coding agent recommends merging it.”

On-screen result:

```text
Repository-only assessment
ALLOW · LOW RISK
```

### State the context gap

**Visual:** Switch to LineageGuard with the proposed change in the left panel.

**Voiceover:**

> “But a repository is not the organization. Dashboards, models, and analyst queries downstream in the data platform can depend on this field without appearing anywhere in this codebase.”

Press **Analyze with DataHub**.

### DataHub discovers hidden consumers

**Visual:** The middle evidence panel fills progressively.

Show concise, real tool activity:

```text
Resolved field
Collected downstream lineage
Found exact paths
Resolved cataloged query subjects
Resolved owners and critical assets
```

Evidence appears:

```text
Finance Revenue Dashboard       CRITICAL
analytics.customer_revenue      HIGH
Fraud Model v3                  CRITICAL
finance-monthly-close.sql       HIGH
```

A compact lineage path highlights the renamed field.

**Voiceover:**

> “Through DataHub, LineageGuard finds four hidden data consumers, including a production fraud model and an unmanaged Finance query. Each reason is linked to a real DataHub entity or lineage path.”

### The product transition

**Visual:** Animate only the semantic state transition, not decorative effects.

```text
ALLOW  →  BLOCK
```

Show reason:

```text
Breaking rename affects 4 downstream consumers
Production model dependency detected
```

**Voiceover:**

> “The same change is no longer considered safe. DataHub changed the decision.”

Pause briefly. This is the key moment.

### The agent performs real work

**Visual:** Right panel shows an expand–migrate–contract plan and then a generated diff.

Artifacts:

- add `buyer_id`;
- backfill from `customer_id`;
- keep compatibility alias;
- update controlled dbt models;
- add equality and non-null tests;
- create `MIGRATION.md`;
- request Finance and Risk ML review;
- set a deprecation window.

**Voiceover:**

> “LineageGuard does not stop at a warning. It generates a backward-compatible migration, updates the consumers it controls, adds executable assertions, and routes review to the owners DataHub identified.”

### Verification, not confidence theater

**Visual:** Validation timeline.

```text
SQL migration             PASS
Backfill equality         PASS
dbt compile               PASS
dbt tests                 PASS
Old consumer compatibility PASS
Generated project checks  PASS
```

Optionally show a compact real command output for two seconds.

**Voiceover:**

> “The model does not declare its own output safe. Deterministic validators do.”

Status becomes:

```text
SAFE WITH MIGRATION · READY FOR REVIEW
```

### Real review artifact

**Visual:** Open the generated GitHub review or PR.

Show:

- changed files;
- DataHub evidence summary;
- requested reviewers;
- validation receipt.

**Voiceover:**

> “The result is a real reviewable pull request, not a chat response.”

### Learn after

**Visual:** DataHub entity/document page.

Show:

- migration decision document;
- deprecation metadata;
- PR reference;
- validation status.

**Voiceover:**

> “After validation, LineageGuard writes the decision back to DataHub, so the next human or agent inherits the migration context.”

### Final proof

**Visual:** Return to Mission Control summary.

```text
4 hidden consumers protected
1 safe migration generated
6 validations passed
0 downstream systems broken
```

**Voiceover:**

> “A coding agent sees one repository. DataHub sees the organization. LineageGuard makes schema changes safe before they reach production.”

## Mission Control design

### Header

- LineageGuard wordmark;
- repository and PR;
- run status;
- elapsed time;
- mode: Live or Replay.

### Left: Proposed Change

- GitHub-style diff;
- changed field and operation (a warehouse schema change, not an operational service change);
- repository-only result;
- local checks.

### Center: DataHub Evidence

- resolved asset and field;
- compact lineage graph;
- critical downstream data consumer list;
- query usage;
- owners;
- evidence receipts.

### Right: Safe Migration

- strategy and ordered steps;
- generated file list/diff;
- validators;
- reviewer targets;
- PR/write-back receipts.

### Bottom: Run timeline

A horizontal or compact vertical timeline of persisted states. It should make failures inspectable without becoming a log viewer.

## Visual language

Reference qualities:

- Linear: controlled density and fast scanning;
- Attio: structured, premium records;
- GitHub: trusted diff and review conventions;
- Granola: clear event/timeline storytelling;
- Mercury: calm, high-trust presentation;
- DataHub: lineage and metadata vocabulary.

Avoid:

- “AI magic” gradients;
- animated fake terminals;
- floating cards with no hierarchy;
- excessive chat bubbles;
- unverified metrics;
- tiny code text;
- long architecture explanations.

## Walkthrough reliability plan

### Live path

Use real DataHub MCP, model calls, validators, GitHub, and write-back.

### Contingency path

Use a committed replay bundle generated by a successful live rehearsal. Label it `Replay of validated run`; do not imply new external actions are happening.

### Failure fallback order

1. retry the failed bounded step once;
2. switch GitHub mutation to a pre-created review artifact while retaining live analysis;
3. use the validated replay bundle;
4. never debug infrastructure during the walkthrough.

## Required screenshot states

Capture with Playwright:

1. repository-only `ALLOW`;
2. context collection in progress;
3. `BLOCK` with four consumers;
4. generated migration diff;
5. all validations passed;
6. ready-for-review summary;
7. write-back receipt;
8. an intentional DataHub-unavailable failure state.

## Walkthrough acceptance criteria

- A viewer understands the problem within 15 seconds.
- “DataHub changed the decision” is visible before 80 seconds.
- Generated code appears before two minutes.
- The walkthrough guide proves validation and write-back.
- No claim relies only on voiceover.
- Every shown metric maps to persisted run data.
- The final cut remains concise.
