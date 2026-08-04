import { z } from "zod";
import { type ProposedChange, proposedChangeSchema } from "./change.js";
import { type ImpactContext, impactContextSchema } from "./evidence.js";
import { sha256 } from "./hash.js";
import { bindGroundedRiskAssessment, type RiskAssessment } from "./risk.js";

const evidenceIdSchema = z.string().regex(/^ev_[a-f0-9]{24}$/);
const fingerprintSchema = z.string().regex(/^[a-f0-9]{64}$/);
const gitShaSchema = z.string().regex(/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/);
const isoDateTimeSchema = z.iso.datetime({ offset: true });
const contentSchema = z.string().min(1).max(100_000);

function artifactPath(pattern: RegExp) {
  return z
    .string()
    .min(1)
    .max(240)
    .refine((path) => !path.startsWith("/") && !path.includes("\\"), "Path must be relative POSIX")
    .refine(
      (path) =>
        path.split("/").every((segment) => segment !== "" && segment !== "." && segment !== ".."),
      "Path must use normalized segments",
    )
    .regex(pattern);
}
const sqlMigrationPathSchema = artifactPath(
  /^walkthrough\/migrations\/(?!.*rollback)[A-Za-z0-9._-]+\.sql$/,
);
const rollbackPathSchema = artifactPath(
  /^walkthrough\/migrations\/[A-Za-z0-9._-]*rollback[A-Za-z0-9._-]*\.sql$/i,
);
const dbtModelPathSchema = artifactPath(/^walkthrough\/models\/[A-Za-z0-9_./-]+\.sql$/);
const dbtTestPathSchema = artifactPath(/^walkthrough\/tests\/[A-Za-z0-9_./-]+\.sql$/);
const migrationDocumentPathSchema = artifactPath(/^docs\/migrations\/[A-Za-z0-9._-]+\.md$/);

export const migrationArtifactPathSchema = z.union([
  sqlMigrationPathSchema,
  rollbackPathSchema,
  dbtModelPathSchema,
  dbtTestPathSchema,
  migrationDocumentPathSchema,
]);

const createArtifactBase = {
  operation: z.literal("CREATE"),
  content: contentSchema,
};
const modifyArtifactBase = {
  operation: z.literal("MODIFY"),
  expectedBaseSha: gitShaSchema,
  content: contentSchema,
};

const sqlMigrationArtifactSchema = z
  .object({ ...createArtifactBase, kind: z.literal("SQL_MIGRATION"), path: sqlMigrationPathSchema })
  .strict();
const rollbackArtifactSchema = z
  .object({ ...createArtifactBase, kind: z.literal("ROLLBACK_SQL"), path: rollbackPathSchema })
  .strict();
const dbtModelArtifactSchema = z
  .object({ ...modifyArtifactBase, kind: z.literal("DBT_MODEL"), path: dbtModelPathSchema })
  .strict();
const dbtTestArtifactSchema = z
  .object({ ...createArtifactBase, kind: z.literal("DBT_TEST"), path: dbtTestPathSchema })
  .strict();
const migrationDocumentArtifactSchema = z
  .object({
    ...createArtifactBase,
    kind: z.literal("MIGRATION_DOCUMENT"),
    path: migrationDocumentPathSchema,
  })
  .strict();

export const migrationArtifactSchema = z.discriminatedUnion("kind", [
  sqlMigrationArtifactSchema,
  rollbackArtifactSchema,
  dbtModelArtifactSchema,
  dbtTestArtifactSchema,
  migrationDocumentArtifactSchema,
]);

export type MigrationArtifact = z.infer<typeof migrationArtifactSchema>;
export function migrationArtifactFingerprint(artifact: MigrationArtifact): string {
  return sha256(migrationArtifactSchema.parse(artifact));
}
export const migrationPhaseSchema = z.enum(["EXPAND", "MIGRATE", "CONTRACT"]);

export const migrationReviewerSchema = z.discriminatedUnion("kind", [
  z
    .object({
      kind: z.literal("OWNER"),
      ownerUrn: z.string().min(8).max(1_000).startsWith("urn:li:"),
      affectedAssetUrns: z.array(z.string().min(8).max(1_000).startsWith("urn:li:")).min(1).max(20),
      reason: z.string().min(1).max(500),
    })
    .strict(),
  z
    .object({
      kind: z.literal("UNRESOLVED_OWNER"),
      evidenceId: evidenceIdSchema,
      affectedAssetUrn: z.string().min(8).max(1_000).startsWith("urn:li:"),
      fallbackAuthority: z.literal("DATA_PLATFORM_OWNER"),
      reason: z.string().min(1).max(500),
    })
    .strict(),
]);

export const migrationStepSchema = z
  .object({
    id: z.string().regex(/^step_[a-z0-9-]{1,60}$/),
    phase: migrationPhaseSchema,
    title: z.string().min(1).max(160),
    rationale: z.string().min(1).max(1_000),
    affectedEvidenceIds: z.array(evidenceIdSchema).min(1).max(200),
    artifactTargets: z.array(migrationArtifactPathSchema).min(1).max(20),
  })
  .strict();

const phaseKinds = {
  EXPAND: new Set<MigrationArtifact["kind"]>(["SQL_MIGRATION", "ROLLBACK_SQL"]),
  MIGRATE: new Set<MigrationArtifact["kind"]>(["DBT_MODEL", "DBT_TEST"]),
  CONTRACT: new Set<MigrationArtifact["kind"]>(["MIGRATION_DOCUMENT"]),
} as const;

export const migrationCandidateSchema = z
  .object({
    strategy: z.literal("EXPAND_MIGRATE_CONTRACT"),
    sourceChangeFingerprint: fingerprintSchema,
    sourcePatchFingerprint: fingerprintSchema,
    sourceImpactContextFingerprint: fingerprintSchema,
    sourceDecision: z.literal("BLOCK"),
    sourceEvidenceIds: z.array(evidenceIdSchema).min(1).max(200),
    summary: z.string().min(1).max(2_000),
    steps: z.array(migrationStepSchema).min(3).max(20),
    artifacts: z.array(migrationArtifactSchema).min(5).max(20),
    requiredReviewers: z.array(migrationReviewerSchema).min(1).max(20),
    compatibilityWindowDays: z.number().int().min(1).max(90),
    rollbackPlan: z.string().min(1).max(2_000),
  })
  .strict()
  .superRefine((candidate, refinement) => {
    const phases = candidate.steps.map((step) => step.phase);
    const firstMigrate = phases.indexOf("MIGRATE");
    const firstContract = phases.indexOf("CONTRACT");
    if (
      phases[0] !== "EXPAND" ||
      firstMigrate < 1 ||
      firstContract <= firstMigrate ||
      phases.some((phase, index) =>
        index < firstMigrate
          ? phase !== "EXPAND"
          : index < firstContract
            ? phase !== "MIGRATE"
            : phase !== "CONTRACT",
      )
    ) {
      refinement.addIssue({
        code: "custom",
        message: "Phases must be ordered EXPAND, MIGRATE, CONTRACT",
        path: ["steps"],
      });
    }

    const sourceEvidence = [...candidate.sourceEvidenceIds].sort();
    if (
      new Set(candidate.sourceEvidenceIds).size !== candidate.sourceEvidenceIds.length ||
      candidate.sourceEvidenceIds.some((id, index) => id !== sourceEvidence[index])
    ) {
      refinement.addIssue({
        code: "custom",
        message: "Source evidence IDs must be unique and sorted",
        path: ["sourceEvidenceIds"],
      });
    }
    const usedEvidence = [
      ...new Set(candidate.steps.flatMap((step) => step.affectedEvidenceIds)),
    ].sort();
    if (JSON.stringify(usedEvidence) !== JSON.stringify(sourceEvidence)) {
      refinement.addIssue({
        code: "custom",
        message: "Steps must cover the exact source evidence set",
        path: ["steps"],
      });
    }
    for (const [stepIndex, step] of candidate.steps.entries()) {
      const sortedStepEvidence = [...step.affectedEvidenceIds].sort();
      if (
        new Set(step.affectedEvidenceIds).size !== step.affectedEvidenceIds.length ||
        step.affectedEvidenceIds.some((id, index) => id !== sortedStepEvidence[index])
      ) {
        refinement.addIssue({
          code: "custom",
          message: "Step evidence IDs must be unique and sorted",
          path: ["steps", stepIndex, "affectedEvidenceIds"],
        });
      }
      const sortedTargets = [...step.artifactTargets].sort();
      if (step.artifactTargets.some((path, index) => path !== sortedTargets[index])) {
        refinement.addIssue({
          code: "custom",
          message: "Artifact targets must use canonical path order",
          path: ["steps", stepIndex, "artifactTargets"],
        });
      }
    }

    const artifactsByPath = new Map(
      candidate.artifacts.map((artifact) => [artifact.path, artifact]),
    );
    if (artifactsByPath.size !== candidate.artifacts.length) {
      refinement.addIssue({
        code: "custom",
        message: "Artifact paths must be unique",
        path: ["artifacts"],
      });
    }
    const sortedArtifactPaths = candidate.artifacts.map((artifact) => artifact.path).sort();
    if (
      candidate.artifacts.some((artifact, index) => artifact.path !== sortedArtifactPaths[index])
    ) {
      refinement.addIssue({
        code: "custom",
        message: "Artifacts must use canonical path order",
        path: ["artifacts"],
      });
    }
    const reviewerKeys = candidate.requiredReviewers.map((reviewer) =>
      reviewer.kind === "OWNER"
        ? `OWNER:${reviewer.ownerUrn}`
        : `UNRESOLVED_OWNER:${reviewer.evidenceId}:${reviewer.affectedAssetUrn}`,
    );
    const sortedReviewerKeys = [...reviewerKeys].sort();
    if (
      new Set(reviewerKeys).size !== reviewerKeys.length ||
      reviewerKeys.some((key, index) => key !== sortedReviewerKeys[index])
    ) {
      refinement.addIssue({
        code: "custom",
        message: "Reviewers must be unique and canonically ordered",
        path: ["requiredReviewers"],
      });
    }
    if (candidate.artifacts.filter((artifact) => artifact.kind === "ROLLBACK_SQL").length !== 1) {
      refinement.addIssue({
        code: "custom",
        message: "Exactly one executable rollback SQL artifact is required",
        path: ["artifacts"],
      });
    }
    const roleCounts = new Map<MigrationArtifact["kind"], number>();
    for (const artifact of candidate.artifacts) {
      roleCounts.set(artifact.kind, (roleCounts.get(artifact.kind) ?? 0) + 1);
    }
    if (
      (roleCounts.get("SQL_MIGRATION") ?? 0) < 1 ||
      (roleCounts.get("DBT_MODEL") ?? 0) < 1 ||
      (roleCounts.get("DBT_TEST") ?? 0) < 1 ||
      (roleCounts.get("MIGRATION_DOCUMENT") ?? 0) !== 1
    ) {
      refinement.addIssue({
        code: "custom",
        message: "Candidate is missing a mandatory artifact role",
        path: ["artifacts"],
      });
    }
    const referenceCounts = new Map<string, number>();
    for (const [stepIndex, step] of candidate.steps.entries()) {
      for (const target of step.artifactTargets) {
        const artifact = artifactsByPath.get(target);
        referenceCounts.set(target, (referenceCounts.get(target) ?? 0) + 1);
        if (!artifact) {
          refinement.addIssue({
            code: "custom",
            message: `Unknown artifact target: ${target}`,
            path: ["steps", stepIndex, "artifactTargets"],
          });
        } else if (!phaseKinds[step.phase].has(artifact.kind)) {
          refinement.addIssue({
            code: "custom",
            message: `${artifact.kind} is incompatible with ${step.phase}`,
            path: ["steps", stepIndex, "artifactTargets"],
          });
        }
      }
    }
    for (const artifact of candidate.artifacts) {
      if (referenceCounts.get(artifact.path) !== 1) {
        refinement.addIssue({
          code: "custom",
          message: "Every artifact must be referenced exactly once",
          path: ["artifacts"],
        });
      }
    }
  });

export type MigrationCandidate = z.infer<typeof migrationCandidateSchema>;

export function migrationCandidateFingerprint(candidate: MigrationCandidate): string {
  return sha256(migrationCandidateSchema.parse(candidate));
}

export function bindMigrationCandidate(
  candidateInput: MigrationCandidate,
  changeInput: ProposedChange,
  contextInput: ImpactContext,
  assessmentInput: RiskAssessment,
): MigrationCandidate {
  const candidate = migrationCandidateSchema.parse(candidateInput);
  const change = proposedChangeSchema.parse(changeInput);
  const context = impactContextSchema.parse(contextInput);
  const assessment = bindGroundedRiskAssessment(change, context, assessmentInput);
  if (
    context.changeId !== change.id ||
    assessment.changeId !== change.id ||
    assessment.contextMode !== "DATAHUB_GROUNDED" ||
    candidate.sourceChangeFingerprint !== change.fingerprint ||
    candidate.sourcePatchFingerprint !== change.sourcePatchFingerprint ||
    candidate.sourceImpactContextFingerprint !== context.impactContextFingerprint ||
    assessment.impactContextFingerprint !== context.impactContextFingerprint ||
    candidate.sourceDecision !== assessment.decision
  ) {
    throw new Error("Migration candidate source binding does not match the change and decision");
  }
  const expectedEvidenceIds = [
    ...new Set(assessment.reasons.flatMap((reason) => reason.evidenceIds)),
  ].sort();
  if (JSON.stringify(candidate.sourceEvidenceIds) !== JSON.stringify(expectedEvidenceIds)) {
    throw new Error("Migration candidate does not cite the exact risk evidence set");
  }
  const contextEvidenceIds = new Set(context.evidence.map((item) => item.id));
  if (candidate.sourceEvidenceIds.some((id) => !contextEvidenceIds.has(id))) {
    throw new Error("Migration candidate cites evidence outside the bound impact context");
  }
  const ownerAssets = new Map<string, string[]>();
  for (const item of context.evidence.filter((evidence) => evidence.kind === "OWNER")) {
    ownerAssets.set(item.payload.ownerUrn, [
      ...(ownerAssets.get(item.payload.ownerUrn) ?? []),
      item.payload.assetUrn,
    ]);
  }
  const ownerReviewers = candidate.requiredReviewers.filter(
    (reviewer) => reviewer.kind === "OWNER",
  );
  if (ownerReviewers.length !== ownerAssets.size) {
    throw new Error("Migration candidate owner reviewers do not match ownership evidence");
  }
  for (const reviewer of ownerReviewers) {
    const expectedAssets = [...(ownerAssets.get(reviewer.ownerUrn) ?? [])].sort();
    if (JSON.stringify(reviewer.affectedAssetUrns) !== JSON.stringify(expectedAssets)) {
      throw new Error("Migration candidate owner reviewer assets do not match ownership evidence");
    }
  }
  const lg005Ids =
    assessment.reasons.find((reason) => reason.ruleId === "LG005")?.evidenceIds ?? [];
  const expectedEscalations = lg005Ids
    .map((evidenceId) => {
      const item = context.evidence.find((evidence) => evidence.id === evidenceId);
      const assetUrn =
        item?.kind === "DASHBOARD"
          ? item.payload.dashboardUrn
          : item?.kind === "ML_MODEL"
            ? item.payload.modelUrn
            : undefined;
      if (!assetUrn) throw new Error("LG005 must reference an affected critical asset");
      return `${evidenceId}:${assetUrn}`;
    })
    .sort();
  const actualEscalations = candidate.requiredReviewers
    .filter((reviewer) => reviewer.kind === "UNRESOLVED_OWNER")
    .map((reviewer) => `${reviewer.evidenceId}:${reviewer.affectedAssetUrn}`)
    .sort();
  if (JSON.stringify(actualEscalations) !== JSON.stringify(expectedEscalations)) {
    throw new Error("Migration candidate unresolved-owner escalations do not match LG005 evidence");
  }
  if (
    candidate.artifacts.some(
      (artifact) => artifact.operation === "MODIFY" && artifact.expectedBaseSha !== change.baseSha,
    )
  ) {
    throw new Error("Modified artifact base SHA does not match the proposed change base");
  }
  return candidate;
}

export const validationCheckNameSchema = z.enum([
  "SQL_MIGRATION",
  "BACKFILL_EQUALITY",
  "DBT_PARSE",
  "DBT_COMPILE",
  "DBT_TEST",
  "OLD_CONSUMER_COMPATIBILITY",
  "NEW_CONSUMER_COMPATIBILITY",
  "ROLLBACK",
]);
const requiredValidationChecks = validationCheckNameSchema.options;

export const structuralValidationCheckSchema = z
  .object({
    check: validationCheckNameSchema,
    status: z.enum(["PASS", "FAIL"]),
    startedAt: isoDateTimeSchema,
    completedAt: isoDateTimeSchema,
    summary: z.string().min(1).max(1_000),
    artifactPaths: z.array(migrationArtifactPathSchema).min(1).max(20),
  })
  .strict()
  .superRefine((check, refinement) => {
    if (new Date(check.completedAt).getTime() < new Date(check.startedAt).getTime()) {
      refinement.addIssue({
        code: "custom",
        message: "Validation check cannot complete before it starts",
        path: ["completedAt"],
      });
    }
    const sortedPaths = [...check.artifactPaths].sort();
    if (
      new Set(check.artifactPaths).size !== check.artifactPaths.length ||
      check.artifactPaths.some((path, index) => path !== sortedPaths[index])
    ) {
      refinement.addIssue({
        code: "custom",
        message: "Check artifact paths must be unique and sorted",
        path: ["artifactPaths"],
      });
    }
  });

export const artifactObservationSchema = z
  .object({
    path: migrationArtifactPathSchema,
    candidateArtifactFingerprint: fingerprintSchema,
    materializedSha256: fingerprintSchema,
  })
  .strict();

/** Structural transport validation only; this does not prove that validators executed. */
export const structuralValidationReceiptSchema = z
  .object({
    candidateFingerprint: fingerprintSchema,
    status: z.enum(["PASS", "FAIL"]),
    artifactPaths: z.array(migrationArtifactPathSchema).min(1).max(20),
    artifactObservations: z.array(artifactObservationSchema).min(1).max(20),
    checks: z.array(structuralValidationCheckSchema).min(1).max(20),
    completedAt: isoDateTimeSchema,
  })
  .strict()
  .superRefine((receipt, refinement) => {
    const checkNames = receipt.checks.map((check) => check.check);
    if (new Set(checkNames).size !== checkNames.length) {
      refinement.addIssue({
        code: "custom",
        message: "Validation check names must be unique",
        path: ["checks"],
      });
    }
    const canonicalCheckOrder = requiredValidationChecks;
    if (
      receipt.status === "PASS" &&
      checkNames.some((check, index) => check !== canonicalCheckOrder[index])
    ) {
      refinement.addIssue({
        code: "custom",
        message: "Passing checks must use canonical order",
        path: ["checks"],
      });
    }
    const receiptPaths = [...receipt.artifactPaths].sort();
    if (
      new Set(receipt.artifactPaths).size !== receipt.artifactPaths.length ||
      receipt.artifactPaths.some((path, index) => path !== receiptPaths[index])
    ) {
      refinement.addIssue({
        code: "custom",
        message: "Receipt artifact paths must be unique and sorted",
        path: ["artifactPaths"],
      });
    }
    const observationPaths = receipt.artifactObservations.map((observation) => observation.path);
    if (
      new Set(observationPaths).size !== observationPaths.length ||
      JSON.stringify(observationPaths) !== JSON.stringify(receiptPaths)
    ) {
      refinement.addIssue({
        code: "custom",
        message: "Artifact observations must exactly cover paths in canonical order",
        path: ["artifactObservations"],
      });
    }
    const checkPaths = new Set(receipt.checks.flatMap((check) => check.artifactPaths));
    if ([...checkPaths].some((path) => !receiptPaths.includes(path))) {
      refinement.addIssue({
        code: "custom",
        message: "Validation checks cannot cite paths outside the receipt",
        path: ["checks"],
      });
    }
    if (
      receipt.checks.some(
        (check) => new Date(check.completedAt).getTime() > new Date(receipt.completedAt).getTime(),
      )
    ) {
      refinement.addIssue({
        code: "custom",
        message: "Receipt cannot complete before its checks",
        path: ["completedAt"],
      });
    }
    if (receipt.status === "PASS") {
      const expected = [...requiredValidationChecks].sort();
      const actual = [...checkNames].sort();
      if (
        JSON.stringify(actual) !== JSON.stringify(expected) ||
        receipt.checks.some((check) => check.status !== "PASS")
      ) {
        refinement.addIssue({
          code: "custom",
          message: "PASS requires the complete canonical passing check set",
          path: ["checks"],
        });
      }
    } else if (
      receipt.checks.every((check) => check.status === "PASS") &&
      checkNames.length === requiredValidationChecks.length
    ) {
      refinement.addIssue({
        code: "custom",
        message: "A complete passing check set cannot produce FAIL",
        path: ["status"],
      });
    }
  });

export type StructuralValidationReceipt = z.infer<typeof structuralValidationReceiptSchema>;

/** Candidate binding only; never use this helper as a SAFE/VALIDATED authorization gate. */
export function assertStructuralValidationReceiptBinding(
  receiptInput: StructuralValidationReceipt,
  candidateInput: MigrationCandidate,
): void {
  const receipt = structuralValidationReceiptSchema.parse(receiptInput);
  const candidate = migrationCandidateSchema.parse(candidateInput);
  if (receipt.candidateFingerprint !== migrationCandidateFingerprint(candidate)) {
    throw new Error("Validation receipt is bound to a different migration candidate");
  }
  const candidatePaths = candidate.artifacts.map((artifact) => artifact.path).sort();
  if (JSON.stringify(receipt.artifactPaths) !== JSON.stringify(candidatePaths)) {
    throw new Error("Validation receipt does not cover the exact candidate artifact set");
  }
  const candidateArtifacts = new Map(
    candidate.artifacts.map((artifact) => [artifact.path, artifact]),
  );
  for (const observation of receipt.artifactObservations) {
    const artifact = candidateArtifacts.get(observation.path);
    if (
      !artifact ||
      observation.candidateArtifactFingerprint !== migrationArtifactFingerprint(artifact) ||
      observation.materializedSha256 !== sha256(artifact.content)
    ) {
      throw new Error(`Artifact observation does not match candidate bytes: ${observation.path}`);
    }
  }
  const allowedKinds = {
    SQL_MIGRATION: new Set<MigrationArtifact["kind"]>(["SQL_MIGRATION"]),
    BACKFILL_EQUALITY: new Set<MigrationArtifact["kind"]>(["SQL_MIGRATION"]),
    DBT_PARSE: new Set<MigrationArtifact["kind"]>(["DBT_MODEL", "DBT_TEST"]),
    DBT_COMPILE: new Set<MigrationArtifact["kind"]>(["DBT_MODEL", "DBT_TEST"]),
    DBT_TEST: new Set<MigrationArtifact["kind"]>(["DBT_MODEL", "DBT_TEST"]),
    OLD_CONSUMER_COMPATIBILITY: new Set<MigrationArtifact["kind"]>([
      "SQL_MIGRATION",
      "DBT_MODEL",
      "DBT_TEST",
    ]),
    NEW_CONSUMER_COMPATIBILITY: new Set<MigrationArtifact["kind"]>([
      "SQL_MIGRATION",
      "DBT_MODEL",
      "DBT_TEST",
    ]),
    ROLLBACK: new Set<MigrationArtifact["kind"]>(["ROLLBACK_SQL"]),
  } as const;
  for (const check of receipt.checks) {
    const actualPaths = [...check.artifactPaths].sort();
    const expectedPaths = candidate.artifacts
      .filter((artifact) => allowedKinds[check.check].has(artifact.kind))
      .map((artifact) => artifact.path)
      .sort();
    if (JSON.stringify(actualPaths) !== JSON.stringify(expectedPaths)) {
      throw new Error(`Validation check ${check.check} does not cover exact applicable artifacts`);
    }
  }
}
