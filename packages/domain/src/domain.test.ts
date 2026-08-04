import { describe, expect, it } from "vitest";
import { canonicalDatasetRef, parseProposedChange } from "./change.js";
import {
  computeImpactContextFingerprint,
  createCanonicalImpactContext,
  createEvidence,
  evidenceItemSchema,
  impactContextSchema,
} from "./evidence.js";
import { sha256 } from "./hash.js";
import {
  assertValidationReceiptBinding,
  bindMigrationCandidate,
  migrationArtifactFingerprint,
  migrationCandidateFingerprint,
  migrationCandidateSchema,
  validationReceiptSchema,
} from "./migration.js";
import {
  assertRiskEvidenceReferences,
  compareRiskAssessments,
  evaluateGroundedRisk,
  evaluateRepositoryBaseline,
  riskAssessmentSchema,
  riskComparisonSchema,
} from "./risk.js";
import { canTransitionRunStatus, runEventStreamSchema } from "./run.js";

const assessedAt = "2026-08-04T09:00:00.000Z";

function required<T>(value: T | undefined, message: string): T {
  if (value === undefined) throw new Error(message);
  return value;
}

function canonicalChange(
  patch = "ALTER TABLE commerce.orders RENAME COLUMN customer_id TO buyer_id;",
  headSha = "2".repeat(40),
) {
  const result = parseProposedChange({
    source: "FIXTURE",
    repository: "lineageguard/canonical",
    baseSha: "1".repeat(40),
    headSha,
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

function reboundContext(
  context: ReturnType<typeof createCanonicalImpactContext>,
  overrides: Partial<
    Omit<ReturnType<typeof createCanonicalImpactContext>, "impactContextFingerprint">
  >,
) {
  const { impactContextFingerprint: _fingerprint, ...identity } = context;
  const rebound = {
    ...identity,
    ...overrides,
    evidence: (overrides.evidence ?? identity.evidence)
      .slice()
      .sort((left, right) => left.id.localeCompare(right.id)),
  };
  return {
    ...rebound,
    impactContextFingerprint: computeImpactContextFingerprint(rebound),
  };
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

  it("rejects empty/incomplete COMPLETE but permits observed critical assets without owners", () => {
    const context = createCanonicalImpactContext(canonicalChange().id);
    expect(impactContextSchema.safeParse({ ...context, evidence: [] }).success).toBe(false);
    const withoutOwners = reboundContext(context, {
      evidence: context.evidence.filter((item) => item.kind !== "OWNER"),
    });
    expect(impactContextSchema.safeParse(withoutOwners).success).toBe(true);
  });

  it("distinguishes partial and failed collection and rejects future query observations", () => {
    const context = createCanonicalImpactContext(canonicalChange().id);
    expect(
      impactContextSchema.safeParse({ ...context, collectionStatus: "PARTIAL", failures: [] })
        .success,
    ).toBe(false);
    expect(
      impactContextSchema.safeParse(
        reboundContext(context, {
          collectionStatus: "FAILED",
          evidence: [],
          failures: [{ tool: "get_lineage", code: "TIMEOUT", message: "Timed out." }],
        }),
      ).success,
    ).toBe(true);
    const query = context.evidence.find((item) => item.kind === "QUERY_USAGE");
    if (!query) throw new Error("fixture must have query evidence");
    const { id: _id, fingerprint: _fingerprint, ...draft } = query;
    const futureQuery = createEvidence({
      ...draft,
      payload: { ...draft.payload, lastSeenAt: "2026-08-04T08:00:00.001Z" },
    });
    expect(
      impactContextSchema.safeParse(
        reboundContext(context, {
          evidence: context.evidence.map((item) => (item.id === query.id ? futureQuery : item)),
        }),
      ).success,
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

  it("requires canonical evidence ordering and fails closed on mismatched change binding", () => {
    const { context } = canonicalBundle();
    expect(
      impactContextSchema.safeParse({ ...context, evidence: [...context.evidence].reverse() })
        .success,
    ).toBe(false);
    const otherChange = canonicalChange(undefined, "3".repeat(40));
    expect(() => evaluateGroundedRisk(otherChange, context, assessedAt)).toThrow(/not bound/);
  });

  it("includes the exact 30-day query boundary and excludes one millisecond older", () => {
    const { change, context } = canonicalBundle();
    const query = context.evidence.find((item) => item.kind === "QUERY_USAGE");
    if (!query) throw new Error("fixture must have query evidence");
    const { id: _id, fingerprint: _fingerprint, ...draft } = query;
    const replaceQuery = (lastSeenAt: string) => {
      const replacement = createEvidence({ ...draft, payload: { ...draft.payload, lastSeenAt } });
      return reboundContext(context, {
        evidence: context.evidence.map((item) => (item.id === query.id ? replacement : item)),
      });
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

  it("triggers LG005 for complete collected critical assets without owners", () => {
    const { change, context } = canonicalBundle();
    const withoutOwners = reboundContext(context, {
      evidence: context.evidence.filter((item) => item.kind !== "OWNER"),
    });
    const assessment = evaluateGroundedRisk(change, withoutOwners, assessedAt);
    expect(
      assessment.reasons.find((reason) => reason.ruleId === "LG005")?.evidenceIds,
    ).toHaveLength(2);
    expect(
      evaluateGroundedRisk(change, context, assessedAt).reasons.some(
        (reason) => reason.ruleId === "LG005",
      ),
    ).toBe(false);
  });

  it("binds full provenance and enforces collection/evaluation ordering", () => {
    const { change, context, grounded } = canonicalBundle();
    expect(grounded.impactContextFingerprint).toBe(context.impactContextFingerprint);
    const first = required(context.evidence[0], "context must have evidence");
    const changedProvenance = {
      ...context,
      evidence: context.evidence.map((item) =>
        item.id === first.id
          ? { ...item, provenance: { ...item.provenance, responseFingerprint: "c".repeat(64) } }
          : item,
      ),
    };
    expect(impactContextSchema.safeParse(changedProvenance).success).toBe(false);
    const rebound = reboundContext(context, { evidence: changedProvenance.evidence });
    expect(() => assertRiskEvidenceReferences(grounded, rebound)).toThrow(/not bound/);
    expect(() => evaluateGroundedRisk(change, context, "2026-08-04T07:59:59.999Z")).toThrow(
      /precede context collection/,
    );
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
  const { change, context, grounded } = canonicalBundle();
  const sourceEvidenceIds = [
    ...new Set(grounded.reasons.flatMap((reason) => reason.evidenceIds)),
  ].sort();
  return {
    strategy: "EXPAND_MIGRATE_CONTRACT",
    sourceChangeFingerprint: change.fingerprint,
    sourcePatchFingerprint: change.sourcePatchFingerprint,
    sourceImpactContextFingerprint: context.impactContextFingerprint,
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
    ].sort((left, right) => (left.path < right.path ? -1 : left.path > right.path ? 1 : 0)),
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
    required(
      path.artifacts.find((artifact) => artifact.kind === "SQL_MIGRATION"),
      "candidate must have SQL",
    ).path = "src/payload.sql";
    expect(migrationCandidateSchema.safeParse(path).success).toBe(false);
    const operation = structuredClone(candidateInput());
    required(
      operation.artifacts.find((artifact) => artifact.kind === "DBT_MODEL"),
      "candidate must have model",
    ).operation = "CREATE";
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
    for (const unsafePath of [
      "/walkthrough/models/orders.sql",
      "walkthrough\\models\\orders.sql",
      "walkthrough/models/../orders.sql",
      "walkthrough/models//orders.sql",
      `walkthrough/models/${"a".repeat(230)}.sql`,
    ]) {
      const unsafe = structuredClone(candidateInput());
      required(
        unsafe.artifacts.find((artifact) => artifact.kind === "DBT_MODEL"),
        "model",
      ).path = unsafePath;
      expect(migrationCandidateSchema.safeParse(unsafe).success).toBe(false);
    }
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
    required(
      wrongBaseInput.artifacts.find((artifact) => artifact.kind === "DBT_MODEL"),
      "candidate must have model artifact",
    ).expectedBaseSha = "3".repeat(40);
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
    const wrongContext = migrationCandidateSchema.parse({
      ...candidateInput(),
      sourceImpactContextFingerprint: "d".repeat(64),
    });
    expect(() =>
      bindMigrationCandidate(wrongContext, bundle.change, bundle.context, bundle.grounded),
    ).toThrow(/source binding/);
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

function validationReceiptInput(
  status: "PASS" | "FAIL" = "PASS",
  candidate = migrationCandidateSchema.parse(candidateInput()),
) {
  const paths = candidate.artifacts.map((artifact) => artifact.path).sort();
  const pathFor = (kind: (typeof candidate.artifacts)[number]["kind"]) =>
    required(
      candidate.artifacts.find((artifact) => artifact.kind === kind)?.path,
      `candidate must have ${kind}`,
    );
  const pathsForCheck = (check: string): string[] => {
    if (check === "SQL_MIGRATION" || check === "BACKFILL_EQUALITY") {
      return candidate.artifacts
        .filter((artifact) => artifact.kind === "SQL_MIGRATION")
        .map((artifact) => artifact.path)
        .sort();
    }
    if (check === "DBT_PARSE" || check === "DBT_COMPILE" || check === "DBT_TEST") {
      return candidate.artifacts
        .filter((artifact) => artifact.kind === "DBT_MODEL" || artifact.kind === "DBT_TEST")
        .map((artifact) => artifact.path)
        .sort();
    }
    if (check === "ROLLBACK") return [pathFor("ROLLBACK_SQL")];
    return candidate.artifacts
      .filter((artifact) => ["SQL_MIGRATION", "DBT_MODEL", "DBT_TEST"].includes(artifact.kind))
      .map((artifact) => artifact.path)
      .sort();
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
    artifactObservations: candidate.artifacts
      .map((artifact) => ({
        path: artifact.path,
        candidateArtifactFingerprint: migrationArtifactFingerprint(artifact),
        materializedSha256: sha256(artifact.content),
      }))
      .sort((left, right) => (left.path < right.path ? -1 : left.path > right.path ? 1 : 0)),
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

  it("binds every materialized byte and rejects multi-artifact check omissions", () => {
    const raw = structuredClone(candidateInput());
    const model = required(
      raw.artifacts.find((artifact) => artifact.kind === "DBT_MODEL"),
      "model",
    );
    raw.artifacts.push({
      ...model,
      path: "walkthrough/models/orders_shadow.sql",
      content: "select customer_id, buyer_id from commerce.orders where false",
    });
    raw.artifacts.sort((left, right) =>
      left.path < right.path ? -1 : left.path > right.path ? 1 : 0,
    );
    required(
      raw.steps.find((step) => step.phase === "MIGRATE"),
      "migrate step",
    ).artifactTargets.push("walkthrough/models/orders_shadow.sql");
    required(
      raw.steps.find((step) => step.phase === "MIGRATE"),
      "migrate step",
    ).artifactTargets.sort();
    const candidate = migrationCandidateSchema.parse(raw);
    const receipt = validationReceiptSchema.parse(validationReceiptInput("PASS", candidate));
    expect(() => assertValidationReceiptBinding(receipt, candidate)).not.toThrow();

    const omitted = structuredClone(receipt);
    required(
      omitted.checks.find((check) => check.check === "DBT_COMPILE"),
      "compile check",
    ).artifactPaths = required(
      omitted.checks.find((check) => check.check === "DBT_COMPILE"),
      "compile check",
    ).artifactPaths.filter((path) => path !== "walkthrough/models/orders_shadow.sql");
    expect(() => assertValidationReceiptBinding(omitted, candidate)).toThrow(/exact applicable/);

    const missingObservation = structuredClone(receipt);
    missingObservation.artifactObservations.pop();
    expect(validationReceiptSchema.safeParse(missingObservation).success).toBe(false);

    const changedBytes = structuredClone(receipt);
    required(
      changedBytes.artifactObservations.find(
        (observation) => observation.path === "walkthrough/models/orders_shadow.sql",
      ),
      "shadow observation",
    ).materializedSha256 = sha256("changed materialized bytes");
    expect(() => assertValidationReceiptBinding(changedBytes, candidate)).toThrow(
      /candidate bytes/,
    );
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
  const runId = "run_111111111111111111111111";
  const statuses = [
    "CREATED",
    "CHANGE_PARSED",
    "BASELINE_ASSESSED",
    "CONTEXT_COLLECTING",
    "CONTEXT_COLLECTED",
    "RISK_DECIDED",
    "MIGRATION_PLANNED",
    "PATCH_GENERATED",
    "VALIDATING",
    "VALIDATED",
    "REVIEW_ARTIFACT_CREATED",
    "WRITEBACK_PENDING",
    "COMPLETED",
  ] as const;
  const eventId = (value: number) => `evt_${value.toString(16).padStart(24, "0")}`;
  const exactStatusEvents = () =>
    statuses.slice(0, -1).map((from, index) => ({
      eventId: eventId(index + 1),
      runId,
      sequence: index,
      type: "RUN_STATUS_CHANGED",
      from,
      to: required(statuses[index + 1], "next status"),
      occurredAt: `2026-08-04T09:00:${index.toString().padStart(2, "0")}.000Z`,
    }));

  it("matches the exact documented success sequence and failure states", () => {
    expect(runEventStreamSchema.safeParse(exactStatusEvents()).success).toBe(true);
    expect(canTransitionRunStatus("CONTEXT_COLLECTING", "FAILED_CONTEXT")).toBe(true);
    expect(canTransitionRunStatus("VALIDATED", "FAILED_GITHUB")).toBe(true);
    expect(canTransitionRunStatus("WRITEBACK_PENDING", "FAILED_WRITEBACK")).toBe(true);
    expect(canTransitionRunStatus("VALIDATED", "FAILED_WRITEBACK")).toBe(false);
    expect(canTransitionRunStatus("MIGRATION_PLANNED", "CANCELLED")).toBe(true);
  });

  function contextLeaseEvents() {
    return [
      ...exactStatusEvents().slice(0, 3),
      {
        eventId: eventId(20),
        runId,
        sequence: 3,
        type: "RUN_LEASE_ACQUIRED",
        leaseId: "lease_111111111111111111111111",
        workerId: "worker-1",
        occurredAt: "2026-08-04T09:00:03.100Z",
        expiresAt: "2026-08-04T09:10:00.000Z",
      },
    ];
  }

  it("preserves lease worker through retry, renewal, release, and ownership change", () => {
    const events = [
      ...contextLeaseEvents(),
      {
        eventId: eventId(21),
        runId,
        sequence: 4,
        type: "RUN_RETRY_SCHEDULED",
        leaseId: "lease_111111111111111111111111",
        workerId: "worker-1",
        operation: "DATAHUB_READ",
        attempt: 1,
        reason: "Transient timeout.",
        occurredAt: "2026-08-04T09:00:04.000Z",
        retryAt: "2026-08-04T09:00:05.000Z",
      },
      {
        eventId: eventId(22),
        runId,
        sequence: 5,
        type: "RUN_LEASE_RENEWED",
        leaseId: "lease_111111111111111111111111",
        workerId: "worker-1",
        previousExpiresAt: "2026-08-04T09:10:00.000Z",
        occurredAt: "2026-08-04T09:00:06.000Z",
        expiresAt: "2026-08-04T09:20:00.000Z",
      },
      {
        eventId: eventId(23),
        runId,
        sequence: 6,
        type: "RUN_LEASE_RELEASED",
        leaseId: "lease_111111111111111111111111",
        workerId: "worker-1",
        occurredAt: "2026-08-04T09:00:07.000Z",
      },
      {
        eventId: eventId(24),
        runId,
        sequence: 7,
        type: "RUN_LEASE_ACQUIRED",
        leaseId: "lease_222222222222222222222222",
        workerId: "worker-2",
        occurredAt: "2026-08-04T09:00:08.000Z",
        expiresAt: "2026-08-04T09:30:00.000Z",
      },
    ];
    expect(runEventStreamSchema.safeParse(events).success).toBe(true);
  });

  it("requires explicit expiry before ownership changes", () => {
    const events = [
      ...contextLeaseEvents(),
      {
        eventId: eventId(25),
        runId,
        sequence: 4,
        type: "RUN_LEASE_EXPIRED",
        leaseId: "lease_111111111111111111111111",
        workerId: "worker-1",
        occurredAt: "2026-08-04T09:10:00.000Z",
        expiredAt: "2026-08-04T09:10:00.000Z",
      },
      {
        eventId: eventId(26),
        runId,
        sequence: 5,
        type: "RUN_LEASE_ACQUIRED",
        leaseId: "lease_222222222222222222222222",
        workerId: "worker-2",
        occurredAt: "2026-08-04T09:10:00.001Z",
        expiresAt: "2026-08-04T09:20:00.000Z",
      },
    ];
    expect(runEventStreamSchema.safeParse(events).success).toBe(true);
  });

  it("rejects overlap, late renewal, mismatched worker, wrong-state retry, and post-terminal events", () => {
    const overlap = [
      ...contextLeaseEvents(),
      {
        ...contextLeaseEvents()[3],
        eventId: eventId(30),
        sequence: 4,
        leaseId: "lease_222222222222222222222222",
        workerId: "worker-2",
      },
    ];
    expect(runEventStreamSchema.safeParse(overlap).success).toBe(false);
    const lateRenewal = [
      ...contextLeaseEvents(),
      {
        eventId: eventId(31),
        runId,
        sequence: 4,
        type: "RUN_LEASE_RENEWED",
        leaseId: "lease_111111111111111111111111",
        workerId: "worker-1",
        previousExpiresAt: "2026-08-04T09:10:00.000Z",
        occurredAt: "2026-08-04T09:10:00.000Z",
        expiresAt: "2026-08-04T09:20:00.000Z",
      },
    ];
    expect(runEventStreamSchema.safeParse(lateRenewal).success).toBe(false);
    const mismatch = [
      ...contextLeaseEvents(),
      {
        eventId: eventId(32),
        runId,
        sequence: 4,
        type: "RUN_LEASE_RELEASED",
        leaseId: "lease_111111111111111111111111",
        workerId: "worker-2",
        occurredAt: "2026-08-04T09:00:04.000Z",
      },
    ];
    expect(runEventStreamSchema.safeParse(mismatch).success).toBe(false);
    const wrongRetry = [
      {
        eventId: eventId(40),
        runId,
        sequence: 0,
        type: "RUN_LEASE_ACQUIRED",
        leaseId: "lease_111111111111111111111111",
        workerId: "worker-1",
        occurredAt: "2026-08-04T09:00:00.000Z",
        expiresAt: "2026-08-04T09:10:00.000Z",
      },
      {
        eventId: eventId(41),
        runId,
        sequence: 1,
        type: "RUN_RETRY_SCHEDULED",
        leaseId: "lease_111111111111111111111111",
        workerId: "worker-1",
        operation: "GITHUB_WRITE",
        attempt: 1,
        reason: "Wrong state.",
        occurredAt: "2026-08-04T09:00:01.000Z",
        retryAt: "2026-08-04T09:00:02.000Z",
      },
    ];
    expect(runEventStreamSchema.safeParse(wrongRetry).success).toBe(false);
    const mismatchedRetry = [
      ...contextLeaseEvents(),
      {
        eventId: eventId(42),
        runId,
        sequence: 4,
        type: "RUN_RETRY_SCHEDULED",
        leaseId: "lease_111111111111111111111111",
        workerId: "worker-2",
        operation: "DATAHUB_READ",
        attempt: 1,
        reason: "Wrong worker.",
        occurredAt: "2026-08-04T09:00:04.000Z",
        retryAt: "2026-08-04T09:11:00.000Z",
      },
    ];
    expect(runEventStreamSchema.safeParse(mismatchedRetry).success).toBe(false);
    const successEvents = exactStatusEvents();
    const terminal = [
      ...successEvents,
      {
        eventId: eventId(50),
        runId,
        sequence: successEvents.length,
        type: "RUN_LEASE_ACQUIRED",
        leaseId: "lease_333333333333333333333333",
        workerId: "worker-3",
        occurredAt: "2026-08-04T09:01:00.000Z",
        expiresAt: "2026-08-04T09:02:00.000Z",
      },
    ];
    expect(runEventStreamSchema.safeParse(terminal).success).toBe(false);
  });
});
