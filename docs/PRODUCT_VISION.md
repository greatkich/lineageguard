# LineageGuard Product Vision

## One-line vision

**Make every data schema change organization-aware before it is merged.**

## Product thesis

Modern coding agents are strong inside a repository and weak at organizational context. A schema change may look locally correct while silently breaking assets owned by other teams and stored in other repositories or platforms.

DataHub already contains the missing map: schemas, field-level lineage, dashboards, models, query history, ownership, glossary semantics, quality signals, and governance metadata. LineageGuard turns that map into an active engineering control loop.

It does not merely display blast radius. It uses DataHub context to change a decision, produce a safer implementation, prove that implementation with executable checks, and preserve the verified decision for future work.

## The user problem

A data engineer, analytics engineer, or service team wants to evolve a data contract. The changed repository contains only a partial view of the system.

Typical hidden consumers include:

- dbt models maintained by another team;
- dashboards created outside Git;
- production SQL copied into a scheduler;
- ML features and models;
- reverse ETL jobs;
- undocumented analyst queries;
- semantic definitions and retention rules;
- owners who are not in `CODEOWNERS`.

Existing repository checks answer: “Does this code compile here?”

LineageGuard answers: “Can the organization absorb this change safely?”

## Primary persona

**Data platform engineer reviewing schema and transformation changes.**

They need to:

- see hidden consumers before merge;
- distinguish safe additive changes from breaking changes;
- generate a practical migration rather than a generic warning;
- route review to actual data owners;
- leave a durable decision record.

## Secondary personas

- analytics engineer changing dbt models;
- backend engineer publishing data used outside a microservice boundary;
- ML platform engineer protecting feature and model dependencies;
- data steward reviewing deprecations and business semantics;
- AI coding agent that needs context beyond the repository.

## Canonical job to be done

> When I propose a data schema change, tell me who will be affected, explain the evidence, transform the change into a compatible migration, verify it, and preserve the decision so I can merge with confidence.

## Canonical demo scenario

The source dataset contains:

```text
commerce.orders.customer_id
```

A developer proposes renaming the column to `buyer_id`.

The changed repository's tests pass. A repository-only agent sees no consumer and returns:

```text
Decision: ALLOW
Risk: LOW
```

DataHub contains hidden context:

```text
commerce.orders.customer_id
  ├─ analytics.stg_orders.customer_id
  │    └─ analytics.customer_revenue
  │          └─ Finance Revenue Dashboard
  ├─ fraud.customer_features.customer_id
  │    └─ Fraud Model v3
  └─ unmanaged query: finance-monthly-close.sql
```

It also contains owners and semantic context:

```text
Finance Revenue Dashboard → owner: Finance Analytics
Fraud Model v3           → owner: Risk ML
customer_id              → glossary term: Customer Identifier
```

LineageGuard changes the decision to:

```text
Decision: BLOCK
Reason: four hidden consumers and one production model depend on the field
```

It then generates a safe migration:

1. add `buyer_id` as an additive field;
2. backfill `buyer_id = customer_id`;
3. preserve `customer_id` during a compatibility window;
4. update controlled dbt consumers;
5. add equality and non-null assertions;
6. create a migration document and deprecation date;
7. request Finance and Risk ML owner review;
8. validate SQL, dbt compilation, dbt tests, and compatibility;
9. create a review artifact in GitHub;
10. save the verified decision and deprecation metadata in DataHub.

## Why this is more than impact analysis

DataHub can already expose lineage and impact. LineageGuard composes that context into a complete engineering action:

```text
observe → decide → generate → validate → review → write back
```

The differentiator is not “we found downstream tables.” The differentiator is:

> **We turned an unsafe pull request into a mergeable migration and made the decision reusable.**

## Product value

### Immediate value

- prevents avoidable downstream incidents;
- reduces manual blast-radius research;
- makes code-generation agents less likely to hallucinate assumptions;
- produces migration artifacts teams can review;
- finds real owners outside repository configuration;
- documents why a change was handled in a particular way.

### Strategic value

LineageGuard can become the context and policy layer between AI coding agents and data-producing repositories. Over time it could support:

- schema registry and API contract changes;
- dbt model refactors;
- warehouse migrations;
- ML feature evolution;
- governance-aware code review;
- change memories reused across future migrations.

Those are future directions, not hackathon scope.

## MVP outcome

A judge can understand and verify the core value in less than three minutes:

1. a locally green pull request is shown;
2. DataHub reveals hidden consumers;
3. the safety decision visibly changes;
4. generated code and tests appear in a real diff;
5. validators pass;
6. DataHub receives the decision back.

## Non-goals for the hackathon

- support every SQL dialect;
- build a universal migration engine;
- autonomously merge to `main`;
- replace DataHub's catalog or lineage UI;
- build a generic chat assistant;
- implement broad enterprise authentication;
- deploy a multi-agent swarm;
- support multiple data warehouses;
- train an ML model;
- simulate production scale.

## Success metrics

Only committed evaluation output may populate final numbers.

### Core functional metrics

- hidden consumers found vs. known fixture truth;
- decision flip correctness;
- evidence coverage per risk reason;
- generated artifact compilation rate;
- validator pass rate;
- successful DataHub write-back;
- deterministic replay success.

### Demo metrics

- full canonical run completes in 60–90 seconds;
- video remains under three minutes;
- one command verifies the final stack;
- a clean reviewer can understand setup from the README;
- no manual database correction is required during the run.

## Experience principles

### Evidence before explanation

Show the lineage path, query, owner, and field before presenting a prose summary.

### Visible decision transition

The UI should make the transformation emotionally obvious:

```text
REPOSITORY ONLY: ALLOW
              ↓ DataHub context
ORGANIZATION AWARE: BLOCK
              ↓ safe migration + validation
READY FOR REVIEW
```

### Trust through real artifacts

Use real diffs, test output, DataHub entities, and GitHub review objects. Avoid decorative agent chat or fake logs.

### Minimal human effort

The reviewer should approve a clear migration plan, not manually reconstruct the blast radius.

## Product narrative

The final narrative should be consistent everywhere:

> A coding agent sees one repository. DataHub sees the organization. LineageGuard brings those views together, so risky schema changes become safe, verified migrations before they reach production.
