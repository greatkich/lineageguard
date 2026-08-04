import { z } from "zod";

const evidenceIdSchema = z.string().regex(/^ev_[a-f0-9]{24}$/);
const isoDateTimeSchema = z.iso.datetime({ offset: true });

export const migrationArtifactPathSchema = z
  .string()
  .min(1)
  .max(240)
  .refine((path) => !path.startsWith("/") && !path.includes("\\"), "Artifact path must be relative")
  .refine(
    (path) =>
      path.split("/").every((segment) => segment !== "" && segment !== "." && segment !== ".."),
    "Artifact path must be normalized",
  )
  .refine(
    (path) => path.startsWith("walkthrough/") || path.startsWith("docs/migrations/"),
    "Artifact path must stay under an approved root",
  );

export const migrationArtifactSchema = z
  .object({
    path: migrationArtifactPathSchema,
    kind: z.enum(["SQL_MIGRATION", "DBT_MODEL", "DBT_TEST", "MIGRATION_DOCUMENT"]),
    content: z.string().min(1).max(100_000),
  })
  .strict();

export type MigrationArtifact = z.infer<typeof migrationArtifactSchema>;

export const migrationPhaseSchema = z.enum(["EXPAND", "MIGRATE", "CONTRACT"]);

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

export const migrationCandidateSchema = z
  .object({
    strategy: z.literal("EXPAND_MIGRATE_CONTRACT"),
    summary: z.string().min(1).max(2_000),
    steps: z.array(migrationStepSchema).min(3).max(20),
    artifacts: z.array(migrationArtifactSchema).min(1).max(20),
    requiredReviewers: z
      .array(
        z
          .object({
            ownerUrn: z.string().min(8).max(1_000).startsWith("urn:li:"),
            reason: z.string().min(1).max(500),
          })
          .strict(),
      )
      .min(1)
      .max(20),
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
        message: "Migration phases must be ordered EXPAND, MIGRATE, CONTRACT",
        path: ["steps"],
      });
    }

    const artifactPaths = new Set(candidate.artifacts.map((artifact) => artifact.path));
    if (artifactPaths.size !== candidate.artifacts.length) {
      refinement.addIssue({
        code: "custom",
        message: "Artifact paths must be unique",
        path: ["artifacts"],
      });
    }
    const stepIds = new Set(candidate.steps.map((step) => step.id));
    if (stepIds.size !== candidate.steps.length) {
      refinement.addIssue({ code: "custom", message: "Step IDs must be unique", path: ["steps"] });
    }
    for (const [stepIndex, step] of candidate.steps.entries()) {
      for (const target of step.artifactTargets) {
        if (!artifactPaths.has(target)) {
          refinement.addIssue({
            code: "custom",
            message: `Step target is not present in artifacts: ${target}`,
            path: ["steps", stepIndex, "artifactTargets"],
          });
        }
      }
    }
  });

export type MigrationCandidate = z.infer<typeof migrationCandidateSchema>;

export const validationCheckSchema = z
  .object({
    check: z.enum([
      "SQL_MIGRATION",
      "BACKFILL_EQUALITY",
      "DBT_COMPILE",
      "DBT_TEST",
      "OLD_CONSUMER_COMPATIBILITY",
      "ROLLBACK",
    ]),
    status: z.enum(["PASS", "FAIL"]),
    startedAt: isoDateTimeSchema,
    completedAt: isoDateTimeSchema,
    summary: z.string().min(1).max(1_000),
    artifactPaths: z.array(migrationArtifactPathSchema).max(20),
  })
  .strict()
  .refine((check) => new Date(check.completedAt).getTime() >= new Date(check.startedAt).getTime(), {
    message: "Validation check cannot complete before it starts",
    path: ["completedAt"],
  });

export const validationReceiptSchema = z
  .object({
    receiptId: z.string().regex(/^val_[a-f0-9]{24}$/),
    candidateFingerprint: z.string().regex(/^[a-f0-9]{64}$/),
    status: z.enum(["PASS", "FAIL"]),
    checks: z.array(validationCheckSchema).min(1).max(20),
    completedAt: isoDateTimeSchema,
  })
  .strict()
  .superRefine((receipt, refinement) => {
    const checkNames = new Set(receipt.checks.map((check) => check.check));
    if (checkNames.size !== receipt.checks.length) {
      refinement.addIssue({
        code: "custom",
        message: "Validation check names must be unique",
        path: ["checks"],
      });
    }
    const derivedStatus = receipt.checks.every((check) => check.status === "PASS")
      ? "PASS"
      : "FAIL";
    if (receipt.status !== derivedStatus) {
      refinement.addIssue({
        code: "custom",
        message: "Receipt status must be derived from its checks",
        path: ["status"],
      });
    }
  });

export type ValidationReceipt = z.infer<typeof validationReceiptSchema>;
