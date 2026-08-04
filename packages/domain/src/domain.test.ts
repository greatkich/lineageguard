import { describe, expect, it } from "vitest";
import { canonicalDatasetRef, parseProposedChange } from "./change.js";
import { createCanonicalImpactContext, impactContextSchema } from "./evidence.js";
import { migrationCandidateSchema, validationReceiptSchema } from "./migration.js";
import {
  compareRiskAssessments,
  evaluateGroundedRisk,
  evaluateRepositoryBaseline,
  riskAssessmentSchema,
} from "./risk.js";
import { canTransitionRunStatus, runEventStreamSchema, runStatusEventSchema } from "./run.js";

function canonicalChange() {
  const result = parseProposedChange({
    source: "FIXTURE",
    repository: "lineageguard/canonical",
    baseSha: "1111111",
    headSha: "2222222",
    files: [
      {
        path: "walkthrough/migrations/rename.sql",
        datasetRef: canonicalDatasetRef,
        patch: "ALTER TABLE commerce.orders RENAME COLUMN customer_id TO buyer_id;",
      },
    ],
  });
  if (!result.ok) {
    throw new Error(result.error.message);
  }
  return result.value;
}

const assessedAt = "2026-08-04T09:00:00.000Z";

describe("canonical impact evidence", () => {
  it("contains the four hidden consumer outcomes, owners, and glossary with stable IDs", () => {
    const change = canonicalChange();
    const first = createCanonicalImpactContext(change.id);
    const second = createCanonicalImpactContext(change.id);

    expect(first).toEqual(second);
    expect(first.evidence.filter((item) => item.kind === "LINEAGE_PATH")).toHaveLength(2);
    expect(first.evidence.some((item) => item.kind === "DASHBOARD")).toBe(true);
    expect(first.evidence.some((item) => item.kind === "ML_MODEL")).toBe(true);
    expect(first.evidence.some((item) => item.kind === "QUERY_USAGE")).toBe(true);
    expect(first.evidence.filter((item) => item.kind === "OWNER")).toHaveLength(2);
    expect(first.evidence.some((item) => item.kind === "GLOSSARY_TERM")).toBe(true);
  });

  it("rejects duplicate and dangling evidence references", () => {
    const context = createCanonicalImpactContext(canonicalChange().id);
    const duplicate = structuredClone(context);
    const first = duplicate.evidence[0];
    if (!first) throw new Error("fixture must have evidence");
    duplicate.evidence.push(first);
    expect(impactContextSchema.safeParse(duplicate).success).toBe(false);

    const dangling = structuredClone(context);
    const dashboard = dangling.evidence.find((item) => item.kind === "DASHBOARD");
    if (!dashboard) throw new Error("fixture must have dashboard evidence");
    dashboard.relatedEvidenceIds = ["ev_000000000000000000000000"];
    expect(impactContextSchema.safeParse(dangling).success).toBe(false);
  });

  it("distinguishes complete, partial, and failed collection states", () => {
    const context = createCanonicalImpactContext(canonicalChange().id);
    expect(
      impactContextSchema.safeParse({
        ...context,
        collectionStatus: "PARTIAL",
        failures: [],
      }).success,
    ).toBe(false);
    expect(
      impactContextSchema.safeParse({
        ...context,
        collectionStatus: "FAILED",
        evidence: [],
        failures: [
          {
            tool: "get_lineage",
            code: "TIMEOUT",
            message: "DataHub lineage request timed out.",
          },
        ],
      }).success,
    ).toBe(true);
  });
});

describe("deterministic risk policy", () => {
  it("changes the canonical repository-only ALLOW/LOW assessment to grounded BLOCK", () => {
    const change = canonicalChange();
    const context = createCanonicalImpactContext(change.id);
    const baseline = evaluateRepositoryBaseline(change, assessedAt);
    const grounded = evaluateGroundedRisk(change, context, assessedAt);
    const comparison = compareRiskAssessments(baseline, grounded);

    expect(baseline).toMatchObject({ decision: "ALLOW", risk: "LOW", reasons: [] });
    expect(grounded.decision).toBe("BLOCK");
    expect(grounded.reasons.map((item) => item.ruleId)).toEqual([
      "LG001",
      "LG002",
      "LG003",
      "LG004",
    ]);
    expect(comparison).toMatchObject({ decisionChanged: true, transition: "ALLOW→BLOCK" });
    const evidenceIds = new Set(context.evidence.map((item) => item.id));
    expect(
      grounded.reasons.every((item) => item.evidenceIds.every((id) => evidenceIds.has(id))),
    ).toBe(true);
  });

  it("is invariant to evidence ordering", () => {
    const change = canonicalChange();
    const context = createCanonicalImpactContext(change.id);
    const reversed = { ...context, evidence: [...context.evidence].reverse() };
    expect(evaluateGroundedRisk(change, reversed, assessedAt)).toEqual(
      evaluateGroundedRisk(change, context, assessedAt),
    );
  });

  it("raises LG005 when an affected critical asset has no owner", () => {
    const change = canonicalChange();
    const context = createCanonicalImpactContext(change.id);
    const withoutOwners = {
      ...context,
      evidence: context.evidence.filter((item) => item.kind !== "OWNER"),
    };
    const assessment = evaluateGroundedRisk(change, withoutOwners, assessedAt);
    expect(assessment.reasons.find((item) => item.ruleId === "LG005")?.evidenceIds).toHaveLength(2);
  });

  it("rejects a forged model authority field", () => {
    const baseline = evaluateRepositoryBaseline(canonicalChange(), assessedAt);
    expect(riskAssessmentSchema.safeParse({ ...baseline, modelDecision: "BLOCK" }).success).toBe(
      false,
    );
  });
});

function candidate() {
  return {
    strategy: "EXPAND_MIGRATE_CONTRACT",
    summary: "Add buyer_id, migrate readers, then retire customer_id after compatibility.",
    steps: [
      {
        id: "step_expand",
        phase: "EXPAND",
        title: "Expand",
        rationale: "Keep old consumers working.",
        affectedEvidenceIds: ["ev_111111111111111111111111"],
        artifactTargets: ["walkthrough/migrations/001_expand.sql"],
      },
      {
        id: "step_migrate",
        phase: "MIGRATE",
        title: "Migrate",
        rationale: "Backfill and move controlled readers.",
        affectedEvidenceIds: ["ev_111111111111111111111111"],
        artifactTargets: ["walkthrough/models/orders.sql"],
      },
      {
        id: "step_contract",
        phase: "CONTRACT",
        title: "Contract",
        rationale: "Retire the compatibility field after approval.",
        affectedEvidenceIds: ["ev_111111111111111111111111"],
        artifactTargets: ["docs/migrations/customer-id.md"],
      },
    ],
    artifacts: [
      {
        path: "walkthrough/migrations/001_expand.sql",
        kind: "SQL_MIGRATION",
        content: "alter table commerce.orders add column buyer_id bigint;",
      },
      {
        path: "walkthrough/models/orders.sql",
        kind: "DBT_MODEL",
        content: "select customer_id, buyer_id from commerce.orders",
      },
      {
        path: "docs/migrations/customer-id.md",
        kind: "MIGRATION_DOCUMENT",
        content: "Compatibility and rollback plan.",
      },
    ],
    requiredReviewers: [
      { ownerUrn: "urn:li:corpGroup:finance-analytics", reason: "Critical dashboard owner" },
    ],
    compatibilityWindowDays: 30,
    rollbackPlan: "Stop new writes to buyer_id and retain customer_id as the source of truth.",
  };
}

describe("migration and validation contracts", () => {
  it("accepts only an ordered expand-migrate-contract candidate", () => {
    expect(migrationCandidateSchema.safeParse(candidate()).success).toBe(true);
    const outOfOrder = candidate();
    outOfOrder.steps.reverse();
    expect(migrationCandidateSchema.safeParse(outOfOrder).success).toBe(false);
  });

  it.each(["/tmp/payload.sql", "../payload.sql", "walkthrough/../secrets.env", "src/change.ts"])(
    "rejects forbidden artifact path %s",
    (path) => {
      const value = candidate();
      const artifact = value.artifacts[0];
      const step = value.steps[0];
      if (!artifact || !step) throw new Error("candidate fixture must have an artifact and step");
      value.artifacts[0] = { ...artifact, path };
      step.artifactTargets = [path];
      expect(migrationCandidateSchema.safeParse(value).success).toBe(false);
    },
  );

  it("rejects command, delete, and decision authority fields", () => {
    expect(
      migrationCandidateSchema.safeParse({ ...candidate(), command: "rm -rf ." }).success,
    ).toBe(false);
    expect(
      migrationCandidateSchema.safeParse({ ...candidate(), deletePaths: ["src"] }).success,
    ).toBe(false);
    expect(migrationCandidateSchema.safeParse({ ...candidate(), decision: "ALLOW" }).success).toBe(
      false,
    );
  });

  it("derives validation receipt status from checks", () => {
    const receipt = {
      receiptId: "val_111111111111111111111111",
      candidateFingerprint: "a".repeat(64),
      status: "PASS",
      completedAt: "2026-08-04T10:00:01.000Z",
      checks: [
        {
          check: "SQL_MIGRATION",
          status: "FAIL",
          startedAt: "2026-08-04T10:00:00.000Z",
          completedAt: "2026-08-04T10:00:01.000Z",
          summary: "Migration failed.",
          artifactPaths: ["walkthrough/migrations/001_expand.sql"],
        },
      ],
    };
    expect(validationReceiptSchema.safeParse(receipt).success).toBe(false);
  });
});

describe("run state contracts", () => {
  it("accepts valid transitions and rejects skips and terminal exits", () => {
    expect(canTransitionRunStatus("PENDING", "PARSING_CHANGE")).toBe(true);
    expect(canTransitionRunStatus("PENDING", "COMPLETED")).toBe(false);
    expect(canTransitionRunStatus("COMPLETED", "PENDING")).toBe(false);
    expect(
      runStatusEventSchema.safeParse({
        eventId: "evt_111111111111111111111111",
        runId: "run_111111111111111111111111",
        sequence: 0,
        type: "RUN_STATUS_CHANGED",
        from: "PENDING",
        to: "COMPLETED",
        occurredAt: assessedAt,
      }).success,
    ).toBe(false);
  });

  it("rejects discontinuous event streams", () => {
    const event = {
      eventId: "evt_111111111111111111111111",
      runId: "run_111111111111111111111111",
      sequence: 0,
      type: "RUN_STATUS_CHANGED",
      from: "PENDING",
      to: "PARSING_CHANGE",
      occurredAt: assessedAt,
    };
    expect(runEventStreamSchema.safeParse([event]).success).toBe(true);
    expect(
      runEventStreamSchema.safeParse([
        event,
        {
          ...event,
          eventId: "evt_222222222222222222222222",
          sequence: 1,
          from: "CHANGE_PARSED",
          to: "ASSESSING_BASELINE",
        },
      ]).success,
    ).toBe(false);
  });
});
