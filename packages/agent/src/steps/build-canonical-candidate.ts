/**
 * Deterministic canonical migration candidate builder.
 *
 * For the MVP P0 scenario (customer_id → buyer_id rename), this builder
 * produces a strict MigrationCandidate that passes migrationCandidateSchema
 * and bindMigrationCandidate() — without relying on LLM-generated artifacts.
 *
 * The LLM is limited to plan/rationale; paths, kinds, SQL, and binding
 * are owned by application code.
 */
import type {
  ImpactContext,
  MigrationCandidate,
  ProposedChange,
  RiskAssessment,
  RiskComparison,
} from "@lineageguard/domain";

export interface CanonicalCandidateInput {
  change: ProposedChange;
  context: ImpactContext;
  comparison: RiskComparison;
  /** Optional LLM-generated rationale for the summary field */
  rationale?: string;
}

/**
 * Builds the canonical expand-migrate-contract candidate for the
 * customer_id → buyer_id rename scenario.
 *
 * All artifact paths, kinds, operations, and content are deterministic.
 * The candidate passes `migrationCandidateSchema` and `bindMigrationCandidate()`.
 */
export function buildCanonicalCandidate(input: CanonicalCandidateInput): MigrationCandidate {
  const { change, context, comparison } = input;
  const grounded = comparison.grounded;

  // Collect evidence IDs from triggered rules (same as domain test pattern)
  const sourceEvidenceIds = [
    ...new Set(grounded.reasons.flatMap((reason) => reason.evidenceIds)),
  ].sort();

  if (sourceEvidenceIds.length === 0) {
    throw new Error(
      "Cannot build migration candidate: no triggered evidence (decision should be BLOCK)",
    );
  }

  // Build reviewers from ownership evidence
  const ownerReviewers = Array.from(
    context.evidence
      .filter((item) => item.kind === "OWNER")
      .reduce((reviewers, item) => {
        const current = reviewers.get(item.payload.ownerUrn) ?? [];
        reviewers.set(item.payload.ownerUrn, [...current, item.payload.assetUrn]);
        return reviewers;
      }, new Map<string, string[]>())
      .entries(),
    ([ownerUrn, affectedAssetUrns]) => ({
      kind: "OWNER" as const,
      ownerUrn,
      affectedAssetUrns: affectedAssetUrns.sort(),
      reason: "Recorded critical asset owner",
    }),
  );

  // Build unresolved-owner escalations from LG005
  const lg005EvidenceIds =
    grounded.reasons.find((reason) => reason.ruleId === "LG005")?.evidenceIds ?? [];
  const unresolvedReviewers = lg005EvidenceIds.map((evidenceId) => {
    const item = context.evidence.find((evidence) => evidence.id === evidenceId);
    if (!item || (item.kind !== "DASHBOARD" && item.kind !== "ML_MODEL")) {
      throw new Error("LG005 evidence must identify a critical asset");
    }
    return {
      kind: "UNRESOLVED_OWNER" as const,
      evidenceId,
      affectedAssetUrn:
        item.kind === "DASHBOARD" ? item.payload.dashboardUrn : item.payload.modelUrn,
      fallbackAuthority: "DATA_PLATFORM_OWNER" as const,
      reason: "No recorded owner; escalate to the data platform owner",
    };
  });

  const requiredReviewers = [...ownerReviewers, ...unresolvedReviewers].sort((left, right) => {
    const leftKey =
      left.kind === "OWNER"
        ? `OWNER:${left.ownerUrn}`
        : `UNRESOLVED_OWNER:${left.evidenceId}:${left.affectedAssetUrn}`;
    const rightKey =
      right.kind === "OWNER"
        ? `OWNER:${right.ownerUrn}`
        : `UNRESOLVED_OWNER:${right.evidenceId}:${right.affectedAssetUrn}`;
    return leftKey.localeCompare(rightKey);
  });

  // Canonical expand-migrate-contract SQL
  const expandSql = [
    "alter table commerce.orders add column buyer_id uuid;",
    "update commerce.orders set buyer_id = customer_id;",
    "create function commerce.sync_order_customer_buyer() returns trigger language plpgsql as $$",
    "begin",
    "  if tg_op = 'INSERT' then",
    "    if new.buyer_id is null and new.customer_id is not null then",
    "      new.buyer_id := new.customer_id;",
    "    elsif new.customer_id is null and new.buyer_id is not null then",
    "      new.customer_id := new.buyer_id;",
    "    elsif new.customer_id is null and new.buyer_id is null then",
    "      raise exception 'at least one identifier must be provided';",
    "    elsif new.customer_id is distinct from new.buyer_id then",
    "      raise exception 'customer_id and buyer_id must match during compatibility window';",
    "    end if;",
    "  elsif tg_op = 'UPDATE' then",
    "    if new.customer_id is distinct from old.customer_id and new.buyer_id is not distinct from old.buyer_id then",
    "      new.buyer_id := new.customer_id;",
    "    elsif new.buyer_id is distinct from old.buyer_id and new.customer_id is not distinct from old.customer_id then",
    "      new.customer_id := new.buyer_id;",
    "    elsif new.customer_id is distinct from old.customer_id and new.buyer_id is distinct from old.buyer_id then",
    "      if new.customer_id is distinct from new.buyer_id then",
    "        raise exception 'customer_id and buyer_id must match during compatibility window';",
    "      end if;",
    "    end if;",
    "  end if;",
    "  return new;",
    "end $$;",
    "create trigger orders_customer_buyer_compat",
    "  before insert or update on commerce.orders",
    "  for each row execute function commerce.sync_order_customer_buyer();",
    "alter table commerce.orders alter column buyer_id set not null;",
  ].join("\n");

  const rollbackSql = [
    "drop trigger orders_customer_buyer_compat on commerce.orders;",
    "drop function commerce.sync_order_customer_buyer();",
    "alter table commerce.orders drop column buyer_id;",
  ].join("\n");

  // Real dbt model contents — targeting the actual walkthrough/dbt/models/ files
  const stgOrdersContent = [
    "SELECT",
    "    order_id,",
    "    customer_id,",
    "    buyer_id,",
    "    order_total,",
    "    ordered_at",
    "FROM {{ source('commerce', 'orders') }}",
  ].join("\n");

  const customerRevenueContent = [
    "SELECT",
    "    customer_id,",
    "    buyer_id,",
    "    SUM(order_total) AS lifetime_revenue",
    "FROM {{ ref('stg_orders') }}",
    "GROUP BY customer_id, buyer_id",
  ].join("\n");

  const customerFeaturesContent = [
    "SELECT",
    "    customer_id,",
    "    buyer_id,",
    "    COUNT(*) AS order_count,",
    "    MAX(order_total) AS max_order_total",
    "FROM {{ ref('stg_orders') }}",
    "GROUP BY customer_id, buyer_id",
  ].join("\n");

  // Equality test: customer_id and buyer_id must match during compatibility window
  const equalityTestContent = [
    "-- Compatibility test: customer_id and buyer_id must always match",
    "select *",
    "from {{ ref('stg_orders') }}",
    "where customer_id is distinct from buyer_id",
  ].join("\n");

  // Not-null test: buyer_id must never be null after migration
  const notNullTestContent = [
    "-- Not-null assertion: buyer_id must be populated for all rows",
    "select *",
    "from {{ ref('stg_orders') }}",
    "where buyer_id is null",
  ].join("\n");

  const migrationDoc = [
    "# Migration: customer_id → buyer_id",
    "",
    "## Strategy: Expand-Migrate-Contract",
    "",
    "### Phase 1: Expand",
    "- Add `buyer_id` column with sync trigger",
    "- Both columns remain accessible",
    "",
    "### Phase 2: Migrate",
    "- Update dbt models to expose both columns",
    "- Add compatibility and not-null tests",
    "",
    "### Phase 3: Contract",
    "- After compatibility window (30 days), deprecate `customer_id`",
    "",
    "## Rollback Plan",
    "Run `walkthrough/migrations/001_rollback.sql` while `customer_id` remains the source of truth.",
    "",
    "## Compatibility Window: 30 days",
    "",
    "## Required Reviewers",
    ...requiredReviewers.map((r) =>
      r.kind === "OWNER"
        ? `- ${r.ownerUrn} (owner of ${r.affectedAssetUrns.join(", ")})`
        : `- Escalation: ${r.affectedAssetUrn} (${r.reason})`,
    ),
  ].join("\n");

  // Distribute evidence across steps:
  // EXPAND gets first half, MIGRATE gets second half, CONTRACT gets first evidence
  const midpoint = Math.ceil(sourceEvidenceIds.length / 2);
  const expandEvidence = sourceEvidenceIds.slice(0, midpoint);
  const migrateEvidence = sourceEvidenceIds.slice(midpoint);
  // CONTRACT must reference at least one evidence
  const contractEvidence = [sourceEvidenceIds[0]!];

  // Ensure all evidence is covered exactly once across steps
  const allStepEvidence = [
    ...new Set([...expandEvidence, ...migrateEvidence, ...contractEvidence]),
  ].sort();
  if (JSON.stringify(allStepEvidence) !== JSON.stringify(sourceEvidenceIds)) {
    throw new Error("Evidence distribution failed — all source evidence must be covered by steps");
  }

  const candidate: MigrationCandidate = {
    strategy: "EXPAND_MIGRATE_CONTRACT",
    sourceChangeFingerprint: change.fingerprint,
    sourcePatchFingerprint: change.sourcePatchFingerprint,
    sourceImpactContextFingerprint: context.impactContextFingerprint,
    sourceDecision: "BLOCK",
    sourceEvidenceIds,
    summary:
      input.rationale ??
      "Add buyer_id, migrate readers, then retire customer_id after compatibility window.",
    steps: [
      {
        id: "step_expand",
        phase: "EXPAND",
        title: "Expand: add buyer_id with sync trigger",
        rationale: "Keep old consumers working while new column is added.",
        affectedEvidenceIds: expandEvidence,
        artifactTargets: [
          "walkthrough/migrations/001_expand.sql",
          "walkthrough/migrations/001_rollback.sql",
        ],
      },
      {
        id: "step_migrate",
        phase: "MIGRATE",
        title: "Migrate: update controlled readers",
        rationale: "Update all dbt consumers to use buyer_id and add compatibility assertions.",
        affectedEvidenceIds: migrateEvidence,
        artifactTargets: [
          "walkthrough/dbt/models/analytics/customer_revenue.sql",
          "walkthrough/dbt/models/fraud/customer_features.sql",
          "walkthrough/dbt/models/staging/stg_orders.sql",
          "walkthrough/dbt/tests/orders_buyer_id_not_null.sql",
          "walkthrough/dbt/tests/orders_compat.sql",
        ],
      },
      {
        id: "step_contract",
        phase: "CONTRACT",
        title: "Contract: deprecate customer_id",
        rationale: "Retire the compatibility field after approval and observation.",
        affectedEvidenceIds: contractEvidence,
        artifactTargets: ["docs/migrations/customer-id.md"],
      },
    ],
    artifacts: [
      {
        operation: "CREATE",
        path: "docs/migrations/customer-id.md",
        kind: "MIGRATION_DOCUMENT",
        content: migrationDoc,
      },
      {
        operation: "MODIFY",
        expectedBaseSha: change.baseSha,
        path: "walkthrough/dbt/models/analytics/customer_revenue.sql",
        kind: "DBT_MODEL",
        content: customerRevenueContent,
      },
      {
        operation: "MODIFY",
        expectedBaseSha: change.baseSha,
        path: "walkthrough/dbt/models/fraud/customer_features.sql",
        kind: "DBT_MODEL",
        content: customerFeaturesContent,
      },
      {
        operation: "MODIFY",
        expectedBaseSha: change.baseSha,
        path: "walkthrough/dbt/models/staging/stg_orders.sql",
        kind: "DBT_MODEL",
        content: stgOrdersContent,
      },
      {
        operation: "CREATE",
        path: "walkthrough/dbt/tests/orders_buyer_id_not_null.sql",
        kind: "DBT_TEST",
        content: notNullTestContent,
      },
      {
        operation: "CREATE",
        path: "walkthrough/dbt/tests/orders_compat.sql",
        kind: "DBT_TEST",
        content: equalityTestContent,
      },
      {
        operation: "CREATE",
        path: "walkthrough/migrations/001_expand.sql",
        kind: "SQL_MIGRATION",
        content: expandSql,
      },
      {
        operation: "CREATE",
        path: "walkthrough/migrations/001_rollback.sql",
        kind: "ROLLBACK_SQL",
        content: rollbackSql,
      },
    ] as MigrationCandidate["artifacts"],
    requiredReviewers: requiredReviewers as MigrationCandidate["requiredReviewers"],
    compatibilityWindowDays: 30,
    rollbackPlan:
      "Run walkthrough/migrations/001_rollback.sql while customer_id remains the source of truth.",
  };

  return candidate;
}
