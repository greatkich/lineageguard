import { describe, expect, it } from "vitest";
import { canonicalDatasetRef, parseProposedChange } from "./change.js";
import {
  createCanonicalImpactContext,
  createEvidence,
  evidenceItemSchema,
  impactContextSchema,
} from "./evidence.js";
import {
  assertValidationReceiptBinding,
  bindMigrationCandidate,
  migrationCandidateFingerprint,
  migrationCandidateSchema,
  validationReceiptSchema,
} from "./migration.js";
import {
  compareRiskAssessments,
  evaluateGroundedRisk,
  evaluateRepositoryBaseline,
  riskAssessmentSchema,
  riskComparisonSchema,
} from "./risk.js";
import { canTransitionRunStatus, runEventStreamSchema, runStatusEventSchema } from "./run.js";

const assessedAt = "2026-08-04T09:00:00.000Z";

function required<T>(value: T | undefined, message: string): T {
  if (value === undefined) throw new Error(message);
  return value;
}

function canonicalChange(
  patch = "ALTER TABLE commerce.orders RENAME COLUMN customer_id TO buyer_id;",
) {
  const result = parseProposedChange({
    source: "FIXTURE",
    repository: "lineageguard/canonical",
    baseSha: "1111111",
    headSha: "2222222",
    files: [
      {
        path: "walkthrough/migrations/rename.sql",
        datasetRef: canonicalDatasetRef,
        patch,
      },
    ],
  });
  if (!result.ok) throw new Error(result.error.message);
  return result.value;
}

function canonicalBundle() {
  const change = canonicalChange();
  const context = createCanonicalImpactContext(change.id);
  const baseline = evaluateRepositoryBaseline(change, assessedAt);
  const grounded = evaluateGroundedRisk(change, context, assessedAt);
  return { change, context, baseline, grounded };
}

describe("canonical impact evidence", () => {
  it("contains schema, four hidden consumer outcomes, owners, and glossary with stable IDs", () => {
    const change = canonicalChange();
    const first = createCanonicalImpactContext(change.id);
    const second = createCanonicalImpactContext(change.id);
    expect(first).toEqual(second);
    expect(first.evidence.some((item) => item.kind === "SCHEMA")).toBe(true);
    expect(first.evidence.filter((item) => item.kind === "LINEAGE_PATH")).toHaveLength(2);
    expect(first.evidence.some((item) => item.kind === "DASHBOARD")).toBe(true);
    expect(first.evidence.some((item) => item.kind === "ML_MODEL")).toBe(true);
    expect(first.evidence.some((item) => item.kind === "QUERY_USAGE")).toBe(true);
    expect(first.evidence.filter((item) => item.kind === "OWNER")).toHaveLength(2);
    expect(first.evidence.some((item) => item.kind === "GLOSSARY_TERM")).toBe(true);
  });

  it("preserves the adapter-supplied raw response fingerprint separately", () => {
    const context = createCanonicalImpactContext(canonicalChange().id);
    const item = context.evidence.find((evidence) => evidence.kind === "SCHEMA");
    if (!item) throw new Error("fixture must have schema evidence");
    const changedRaw = {
      ...item,
      provenance: { ...item.provenance, responseFingerprint: "b".repeat(64) },
    };
    const parsed = evidenceItemSchema.parse(changedRaw);
    expect(parsed.id).toBe(item.id);
    expect(parsed.fingerprint).toBe(item.fingerprint);
    expect(parsed.provenance.responseFingerprint).toBe("b".repeat(64));
  });

  it("binds evidence ID and fingerprint to policy-relevant normalized fields", () => {
    const context = createCanonicalImpactContext(canonicalChange().id);
    const item = context.evidence.find((evidence) => evidence.kind === "DASHBOARD");
    if (!item) throw new Error("fixture must have dashboard evidence");
    expect(evidenceItemSchema.safeParse({ ...item, criticality: "LOW" }).success).toBe(false);
  });

  it("rejects duplicate, dangling, and semantically mismatched evidence", () => {
    const context = createCanonicalImpactContext(canonicalChange().id);
    expect(
      impactContextSchema.safeParse({
        ...context,
        evidence: [...context.evidence, context.evidence[0]],
      }).success,
    ).toBe(false);
    const wrongTopLevel = { ...context, datasetUrn: "urn:li:dataset:other" };
    expect(impactContextSchema.safeParse(wrongTopLevel).success).toBe(false);
    const lineage = context.evidence.find((item) => item.kind === "LINEAGE_PATH");
    if (!lineage) throw new Error("fixture must have lineage");
    const { id: _id, fingerprint: _fingerprint, ...draft } = lineage;
    const mismatchedLineage = createEvidence({
      ...draft,
      payload: { ...draft.payload, nodes: [...draft.payload.nodes].reverse() },
    });
    expect(
      impactContextSchema.safeParse({
        ...context,
        evidence: context.evidence.map((item) =>
          item.id === lineage.id ? mismatchedLineage : item,
        ),
      }).success,
    ).toBe(false);
  });

  it("rejects empty/incomplete COMPLETE contexts and missing required owners", () => {
    const context = createCanonicalImpactContext(canonicalChange().id);
    expect(impactContextSchema.safeParse({ ...context, evidence: [] }).success).toBe(false);
    expect(
      impactContextSchema.safeParse({
        ...context,
        evidence: context.evidence.filter((item) => item.kind !== "OWNER"),
      }).success,
    ).toBe(false);
  });

  it("distinguishes partial and failed collection and rejects future query observations", () => {
    const context = createCanonicalImpactContext(canonicalChange().id);
    expect(
      impactContextSchema.safeParse({ ...context, collectionStatus: "PARTIAL", failures: [] })
        .success,
    ).toBe(false);
    expect(
      impactContextSchema.safeParse({
        ...context,
        collectionStatus: "FAILED",
        evidence: [],
        failures: [{ tool: "get_lineage", code: "TIMEOUT", message: "Timed out." }],
      }).success,
    ).toBe(true);
    const query = context.evidence.find((item) => item.kind === "QUERY_USAGE");
    if (!query) throw new Error("fixture must have query evidence");
    const { id: _id, fingerprint: _fingerprint, ...draft } = query;
    const futureQuery = createEvidence({
      ...draft,
      payload: { ...draft.payload, lastSeenAt: "2026-08-04T08:00:00.001Z" },
    });
    expect(
      impactContextSchema.safeParse({
        ...context,
        evidence: context.evidence.map((item) => (item.id === query.id ? futureQuery : item)),
      }).success,
    ).toBe(false);
  });
});

describe("deterministic risk policy", () => {
  it("changes the canonical repository-only ALLOW/LOW assessment to grounded BLOCK", () => {
    const { context, baseline, grounded } = canonicalBundle();
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
      grounded.reasons.every((reason) => reason.evidenceIds.every((id) => evidenceIds.has(id))),
    ).toBe(true);
  });

  it("is invariant to evidence ordering and fails closed on mismatched change binding", () => {
    const { change, context } = canonicalBundle();
    expect(
      evaluateGroundedRisk(
        change,
        { ...context, evidence: [...context.evidence].reverse() },
        assessedAt,
      ),
    ).toEqual(evaluateGroundedRisk(change, context, assessedAt));
    const otherChange = canonicalChange(
      "ALTER  TABLE commerce.orders RENAME COLUMN customer_id TO buyer_id;",
    );
    expect(() => evaluateGroundedRisk(otherChange, context, assessedAt)).toThrow(/not bound/);
  });

  it("includes the exact 30-day query boundary and excludes one millisecond older", () => {
    const { change, context } = canonicalBundle();
    const query = context.evidence.find((item) => item.kind === "QUERY_USAGE");
    if (!query) throw new Error("fixture must have query evidence");
    const { id: _id, fingerprint: _fingerprint, ...draft } = query;
    const replaceQuery = (lastSeenAt: string) => {
      const replacement = createEvidence({ ...draft, payload: { ...draft.payload, lastSeenAt } });
      return {
        ...context,
        evidence: context.evidence.map((item) => (item.id === query.id ? replacement : item)),
      };
    };
    expect(
      evaluateGroundedRisk(
        change,
        replaceQuery("2026-07-05T09:00:00.000Z"),
        assessedAt,
      ).reasons.some((reason) => reason.ruleId === "LG003"),
    ).toBe(true);
    expect(
      evaluateGroundedRisk(
        change,
        replaceQuery("2026-07-05T08:59:59.999Z"),
        assessedAt,
      ).reasons.some((reason) => reason.ruleId === "LG003"),
    ).toBe(false);
  });

  it("rejects contradictory assessment and comparison payloads", () => {
    const { baseline, grounded } = canonicalBundle();
    expect(riskAssessmentSchema.safeParse({ ...grounded, decision: "ALLOW" }).success).toBe(false);
    expect(riskAssessmentSchema.safeParse({ ...grounded, risk: "LOW" }).success).toBe(false);
    expect(
      riskAssessmentSchema.safeParse({
        ...grounded,
        reasons: grounded.reasons.map((reason, index) =>
          index === 0 ? { ...reason, severity: "LOW" } : reason,
        ),
      }).success,
    ).toBe(false);
    const comparison = compareRiskAssessments(baseline, grounded);
    expect(
      riskComparisonSchema.safeParse({ ...comparison, transition: "ALLOW→ALLOW" }).success,
    ).toBe(false);
    expect(
      riskComparisonSchema.safeParse({ ...comparison, changedBecauseEvidenceIds: [] }).success,
    ).toBe(false);
    expect(riskComparisonSchema.safeParse({ ...comparison, triggeredRuleIds: [] }).success).toBe(
      false,
    );
  });
});

function candidateInput() {
  const { change, grounded } = canonicalBundle();
  const sourceEvidenceIds = [
    ...new Set(grounded.reasons.flatMap((reason) => reason.evidenceIds)),
  ].sort();
  return {
    strategy: "EXPAND_MIGRATE_CONTRACT",
    sourceChangeFingerprint: change.fingerprint,
    sourcePatchFingerprint: change.sourcePatchFingerprint,
    sourceDecision: "BLOCK",
    sourceEvidenceIds,
    summary: "Add buyer_id, migrate readers, then retire customer_id after compatibility.",
    steps: [
      {
        id: "step_expand",
        phase: "EXPAND",
        title: "Expand",
        rationale: "Keep old consumers working.",
        affectedEvidenceIds: sourceEvidenceIds.slice(0, 2),
        artifactTargets: [
          "walkthrough/migrations/001_expand.sql",
          "walkthrough/migrations/001_rollback.sql",
        ],
      },
      {
        id: "step_migrate",
        phase: "MIGRATE",
        title: "Migrate",
        rationale: "Backfill and move controlled readers.",
        affectedEvidenceIds: sourceEvidenceIds.slice(2),
        artifactTargets: ["walkthrough/models/orders.sql", "walkthrough/tests/orders_compat.sql"],
      },
      {
        id: "step_contract",
        phase: "CONTRACT",
        title: "Contract",
        rationale: "Retire the compatibility field after approval.",
        affectedEvidenceIds: [sourceEvidenceIds[0]],
        artifactTargets: ["docs/migrations/customer-id.md"],
      },
    ],
    artifacts: [
      {
        operation: "CREATE",
        path: "walkthrough/migrations/001_expand.sql",
        kind: "SQL_MIGRATION",
        content: "alter table commerce.orders add column buyer_id bigint;",
      },
      {
        operation: "CREATE",
        path: "walkthrough/migrations/001_rollback.sql",
        kind: "ROLLBACK_SQL",
        content: "alter table commerce.orders drop column buyer_id;",
      },
      {
        operation: "MODIFY",
        expectedBaseSha: change.baseSha,
        path: "walkthrough/models/orders.sql",
        kind: "DBT_MODEL",
        content: "select customer_id, buyer_id from commerce.orders",
      },
      {
        operation: "CREATE",
        path: "walkthrough/tests/orders_compat.sql",
        kind: "DBT_TEST",
        content: "select * from commerce.orders where customer_id <> buyer_id",
      },
      {
        operation: "CREATE",
        path: "docs/migrations/customer-id.md",
        kind: "MIGRATION_DOCUMENT",
        content: "Compatibility and rollback plan.",
      },
    ],
    requiredReviewers: [
      { ownerUrn: "urn:li:corpGroup:finance-analytics", reason: "Critical dashboard owner" },
      { ownerUrn: "urn:li:corpGroup:risk-ml", reason: "Production model owner" },
    ],
    compatibilityWindowDays: 30,
    rollbackPlan: "Run the rollback SQL while customer_id remains the source of truth.",
  };
}

describe("migration contracts and binding", () => {
  it("accepts and binds the exact ordered, typed artifact contract", () => {
    const bundle = canonicalBundle();
    const candidate = migrationCandidateSchema.parse(candidateInput());
    expect(
      bindMigrationCandidate(candidate, bundle.change, bundle.context, bundle.grounded),
    ).toEqual(candidate);
  });

  it("rejects wrong paths, operations, phase reuse, missing rollback, and authority fields", () => {
    const path = structuredClone(candidateInput());
    required(path.artifacts[0], "candidate must have first artifact").path = "src/payload.sql";
    expect(migrationCandidateSchema.safeParse(path).success).toBe(false);
    const operation = structuredClone(candidateInput());
    required(operation.artifacts[2], "candidate must have model artifact").operation = "CREATE";
    expect(migrationCandidateSchema.safeParse(operation).success).toBe(false);
    const reused = structuredClone(candidateInput());
    required(reused.steps[1], "candidate must have migrate step").artifactTargets.push(
      "walkthrough/migrations/001_expand.sql",
    );
    expect(migrationCandidateSchema.safeParse(reused).success).toBe(false);
    const noRollback = structuredClone(candidateInput());
    noRollback.artifacts = noRollback.artifacts.filter(
      (artifact) => artifact.kind !== "ROLLBACK_SQL",
    );
    expect(migrationCandidateSchema.safeParse(noRollback).success).toBe(false);
    expect(
      migrationCandidateSchema.safeParse({ ...candidateInput(), command: "apply" }).success,
    ).toBe(false);
    expect(
      migrationCandidateSchema.safeParse({ ...candidateInput(), deletePaths: ["src"] }).success,
    ).toBe(false);
    expect(
      migrationCandidateSchema.safeParse({ ...candidateInput(), authority: "ALLOW" }).success,
    ).toBe(false);
  });

  it("fails binding for wrong input fingerprints, evidence, decision, and base SHA", () => {
    const bundle = canonicalBundle();
    const wrongFingerprint = migrationCandidateSchema.parse({
      ...candidateInput(),
      sourceChangeFingerprint: "a".repeat(64),
    });
    expect(() =>
      bindMigrationCandidate(wrongFingerprint, bundle.change, bundle.context, bundle.grounded),
    ).toThrow();
    const wrongBaseInput = candidateInput();
    required(wrongBaseInput.artifacts[2], "candidate must have model artifact").expectedBaseSha =
      "3333333";
    const wrongBase = migrationCandidateSchema.parse(wrongBaseInput);
    expect(() =>
      bindMigrationCandidate(wrongBase, bundle.change, bundle.context, bundle.grounded),
    ).toThrow(/base SHA/);
    expect(
      migrationCandidateSchema.safeParse({ ...candidateInput(), sourceDecision: "ALLOW" }).success,
    ).toBe(false);
    const missingEvidence = structuredClone(candidateInput());
    missingEvidence.sourceEvidenceIds = missingEvidence.sourceEvidenceIds.slice(1);
    expect(migrationCandidateSchema.safeParse(missingEvidence).success).toBe(false);
    const firstReviewer = candidateInput().requiredReviewers[0];
    if (!firstReviewer) throw new Error("candidate must have reviewer");
    const missingReviewer = migrationCandidateSchema.parse({
      ...candidateInput(),
      requiredReviewers: [firstReviewer],
    });
    expect(() =>
      bindMigrationCandidate(missingReviewer, bundle.change, bundle.context, bundle.grounded),
    ).toThrow(/reviewers/);
  });
});

function validationReceiptInput(status: "PASS" | "FAIL" = "PASS") {
  const candidate = migrationCandidateSchema.parse(candidateInput());
  const paths = candidate.artifacts.map((artifact) => artifact.path).sort();
  const pathFor = (kind: (typeof candidate.artifacts)[number]["kind"]) =>
    required(
      candidate.artifacts.find((artifact) => artifact.kind === kind)?.path,
      `candidate must have ${kind}`,
    );
  const pathsForCheck = (check: string): string[] => {
    if (check === "SQL_MIGRATION" || check === "BACKFILL_EQUALITY") {
      return [pathFor("SQL_MIGRATION")];
    }
    if (check === "DBT_PARSE" || check === "DBT_COMPILE") return [pathFor("DBT_MODEL")];
    if (check === "DBT_TEST") return [pathFor("DBT_TEST")];
    if (check === "ROLLBACK") return [pathFor("ROLLBACK_SQL")];
    return [pathFor("SQL_MIGRATION"), pathFor("DBT_MODEL"), pathFor("DBT_TEST")].sort();
  };
  const checks = [
    "SQL_MIGRATION",
    "BACKFILL_EQUALITY",
    "DBT_PARSE",
    "DBT_COMPILE",
    "DBT_TEST",
    "OLD_CONSUMER_COMPATIBILITY",
    "NEW_CONSUMER_COMPATIBILITY",
    "ROLLBACK",
  ].map((check, index) => ({
    check,
    status: "PASS",
    startedAt: `2026-08-04T10:00:0${index}.000Z`,
    completedAt: `2026-08-04T10:00:0${index}.500Z`,
    summary: `${check} passed.`,
    artifactPaths: pathsForCheck(check),
  }));
  return {
    receiptId: "val_111111111111111111111111",
    candidateFingerprint: migrationCandidateFingerprint(candidate),
    status,
    artifactPaths: paths,
    checks,
    completedAt: "2026-08-04T10:00:10.000Z",
  };
}

describe("validation receipt contracts", () => {
  it("accepts only a complete passing canonical set for PASS and binds exact artifacts", () => {
    const candidate = migrationCandidateSchema.parse(candidateInput());
    const receipt = validationReceiptSchema.parse(validationReceiptInput());
    expect(() => assertValidationReceiptBinding(receipt, candidate)).not.toThrow();
    const missing = validationReceiptInput();
    missing.checks.pop();
    expect(validationReceiptSchema.safeParse(missing).success).toBe(false);
  });

  it("allows a partial set only as non-success and rejects mismatched candidate/artifact binding", () => {
    const partial = validationReceiptInput("FAIL");
    partial.checks = [
      {
        ...required(partial.checks[0], "receipt must have first check"),
        status: "FAIL",
        artifactPaths: partial.artifactPaths,
      },
    ];
    expect(validationReceiptSchema.safeParse(partial).success).toBe(true);
    expect(validationReceiptSchema.safeParse({ ...partial, status: "PASS" }).success).toBe(false);
    const candidate = migrationCandidateSchema.parse(candidateInput());
    const receipt = validationReceiptSchema.parse(validationReceiptInput());
    const otherCandidate = migrationCandidateSchema.parse({
      ...candidateInput(),
      summary: "Different candidate.",
    });
    expect(() => assertValidationReceiptBinding(receipt, otherCandidate)).toThrow(/different/);
    expect(() => assertValidationReceiptBinding(receipt, candidate)).not.toThrow();
  });
});

describe("run state and operational events", () => {
  const base = {
    runId: "run_111111111111111111111111",
  };

  it("uses distinct cancellation, GitHub, and write-back terminal states", () => {
    expect(canTransitionRunStatus("PARSING_CHANGE", "CANCELLED")).toBe(true);
    expect(canTransitionRunStatus("PUBLISHING_REVIEW", "FAILED_GITHUB")).toBe(true);
    expect(canTransitionRunStatus("WRITING_BACK", "FAILED_WRITEBACK")).toBe(true);
    expect(canTransitionRunStatus("PUBLISHING_REVIEW", "FAILED_WRITEBACK")).toBe(false);
    expect(
      runStatusEventSchema.safeParse({
        ...base,
        eventId: "evt_111111111111111111111111",
        sequence: 0,
        type: "RUN_STATUS_CHANGED",
        from: "PENDING",
        to: "COMPLETED",
        occurredAt: assessedAt,
      }).success,
    ).toBe(false);
  });

  it("accepts coherent status, lease, renewal, and retry events", () => {
    const events = [
      {
        ...base,
        eventId: "evt_111111111111111111111111",
        sequence: 0,
        type: "RUN_STATUS_CHANGED",
        from: "PENDING",
        to: "PARSING_CHANGE",
        occurredAt: "2026-08-04T09:00:00.000Z",
      },
      {
        ...base,
        eventId: "evt_222222222222222222222222",
        sequence: 1,
        type: "RUN_LEASE_ACQUIRED",
        leaseId: "lease_111111111111111111111111",
        workerId: "worker-1",
        occurredAt: "2026-08-04T09:00:01.000Z",
        expiresAt: "2026-08-04T09:10:00.000Z",
      },
      {
        ...base,
        eventId: "evt_333333333333333333333333",
        sequence: 2,
        type: "RUN_LEASE_RENEWED",
        leaseId: "lease_111111111111111111111111",
        previousExpiresAt: "2026-08-04T09:10:00.000Z",
        occurredAt: "2026-08-04T09:00:02.000Z",
        expiresAt: "2026-08-04T09:20:00.000Z",
      },
      {
        ...base,
        eventId: "evt_444444444444444444444444",
        sequence: 3,
        type: "RUN_RETRY_SCHEDULED",
        operation: "DATAHUB_READ",
        attempt: 1,
        reason: "Transient timeout.",
        occurredAt: "2026-08-04T09:00:03.000Z",
        retryAt: "2026-08-04T09:00:05.000Z",
      },
      {
        ...base,
        eventId: "evt_555555555555555555555555",
        sequence: 4,
        type: "RUN_STATUS_CHANGED",
        from: "PARSING_CHANGE",
        to: "CHANGE_PARSED",
        occurredAt: "2026-08-04T09:00:06.000Z",
      },
    ];
    expect(runEventStreamSchema.safeParse(events).success).toBe(true);
  });

  it("rejects non-monotonic sequence/time, invalid renewal, and skipped retry attempts", () => {
    const status = {
      ...base,
      eventId: "evt_111111111111111111111111",
      sequence: 0,
      type: "RUN_STATUS_CHANGED",
      from: "PENDING",
      to: "PARSING_CHANGE",
      occurredAt: "2026-08-04T09:00:02.000Z",
    };
    const retry = {
      ...base,
      eventId: "evt_222222222222222222222222",
      sequence: 2,
      type: "RUN_RETRY_SCHEDULED",
      operation: "DATAHUB_READ",
      attempt: 2,
      reason: "Retry.",
      occurredAt: "2026-08-04T09:00:01.000Z",
      retryAt: "2026-08-04T09:00:03.000Z",
    };
    expect(runEventStreamSchema.safeParse([status, retry]).success).toBe(false);
    const renewal = {
      ...base,
      eventId: "evt_333333333333333333333333",
      sequence: 1,
      type: "RUN_LEASE_RENEWED",
      leaseId: "lease_111111111111111111111111",
      previousExpiresAt: "2026-08-04T09:10:00.000Z",
      occurredAt: "2026-08-04T09:00:03.000Z",
      expiresAt: "2026-08-04T09:20:00.000Z",
    };
    expect(runEventStreamSchema.safeParse([status, renewal]).success).toBe(false);
  });
});
