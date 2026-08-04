import { z } from "zod";
import { sha256 } from "./hash.js";
import { migrationArtifactPathSchema, validationCheckNameSchema } from "./migration.js";

const fingerprintSchema = z.string().regex(/^[a-f0-9]{64}$/);
const isoDateTimeSchema = z.iso.datetime({ offset: true });
const runIdSchema = z.string().regex(/^run_[a-f0-9]{24}$/);
const leaseIdSchema = z.string().regex(/^lease_[a-f0-9]{24}$/);
const checkNames = validationCheckNameSchema.options;
export type ValidationCheckName = z.infer<typeof validationCheckNameSchema>;

export const validatorCommandIdSchema = z.enum([
  "VALIDATE_SQL_MIGRATION_V1",
  "VALIDATE_BACKFILL_EQUALITY_V1",
  "VALIDATE_DBT_PARSE_V1",
  "VALIDATE_DBT_COMPILE_V1",
  "VALIDATE_DBT_TEST_V1",
  "VALIDATE_OLD_CONSUMER_V1",
  "VALIDATE_NEW_CONSUMER_V1",
  "VALIDATE_ROLLBACK_V1",
]);
export type ValidatorCommandId = z.infer<typeof validatorCommandIdSchema>;

const commandForCheck: Record<ValidationCheckName, ValidatorCommandId> = {
  SQL_MIGRATION: "VALIDATE_SQL_MIGRATION_V1",
  BACKFILL_EQUALITY: "VALIDATE_BACKFILL_EQUALITY_V1",
  DBT_PARSE: "VALIDATE_DBT_PARSE_V1",
  DBT_COMPILE: "VALIDATE_DBT_COMPILE_V1",
  DBT_TEST: "VALIDATE_DBT_TEST_V1",
  OLD_CONSUMER_COMPATIBILITY: "VALIDATE_OLD_CONSUMER_V1",
  NEW_CONSUMER_COMPATIBILITY: "VALIDATE_NEW_CONSUMER_V1",
  ROLLBACK: "VALIDATE_ROLLBACK_V1",
};

export const executedArtifactObservationSchema = z
  .object({
    path: migrationArtifactPathSchema,
    candidateArtifactFingerprint: fingerprintSchema,
    materializedSha256: fingerprintSchema,
  })
  .strict();
export type ExecutedArtifactObservation = z.infer<typeof executedArtifactObservationSchema>;

const canonicalObservations = (observations: readonly ExecutedArtifactObservation[]) =>
  [...observations].sort((left, right) => left.path.localeCompare(right.path));

export function validationArtifactSetFingerprint(
  observationsInput: readonly ExecutedArtifactObservation[],
): string {
  const observations = z
    .array(executedArtifactObservationSchema)
    .min(1)
    .max(20)
    .parse(observationsInput);
  return sha256({
    domain: "lineageguard.validation.artifact-set.v1",
    observations: canonicalObservations(observations),
  });
}

export const validationOutputEnvelopeSchema = z
  .object({
    schemaVersion: z.literal(1),
    purpose: z.literal("LINEAGEGUARD_VALIDATOR_OUTPUT"),
    check: validationCheckNameSchema,
    exitCode: z.number().int().min(0).max(255),
    stdoutFingerprint: fingerprintSchema,
    stderrFingerprint: fingerprintSchema,
    artifactObservations: z.array(executedArtifactObservationSchema).min(1).max(20),
  })
  .strict();
export type ValidationOutputEnvelope = z.infer<typeof validationOutputEnvelopeSchema>;

/** Canonical data preparation only; this hash does not attest that a validator ran. */
export function validationOutputFingerprint(input: ValidationOutputEnvelope): string {
  return sha256(validationOutputEnvelopeSchema.parse(input));
}

const executionFenceShape = {
  runId: runIdSchema,
  sandboxId: z.string().min(1).max(160),
  worktreeId: z.string().min(1).max(240),
  leaseId: leaseIdSchema,
  workerId: z.string().min(1).max(160),
  generation: z.number().int().positive().max(1_000_000),
};

const executedValidationCheckSchema = z
  .object({
    check: validationCheckNameSchema,
    status: z.literal("PASS"),
    artifactPaths: z.array(migrationArtifactPathSchema).min(1).max(20),
    artifactObservations: z.array(executedArtifactObservationSchema).min(1).max(20),
    artifactSetFingerprint: fingerprintSchema,
    validatorImplementationId: z.string().min(1).max(160),
    validatorVersion: z.string().min(1).max(80),
    validatorDigest: fingerprintSchema,
    commandId: validatorCommandIdSchema,
    exitCode: z.literal(0),
    startedAt: isoDateTimeSchema,
    finishedAt: isoDateTimeSchema,
    stdoutFingerprint: fingerprintSchema,
    stderrFingerprint: fingerprintSchema,
    outputFingerprint: fingerprintSchema,
    ...executionFenceShape,
  })
  .strict()
  .superRefine((check, refinement) => {
    if (check.commandId !== commandForCheck[check.check]) {
      refinement.addIssue({
        code: "custom",
        message: "Validation check must use its allowlisted command ID",
        path: ["commandId"],
      });
    }
    if (new Date(check.finishedAt).getTime() < new Date(check.startedAt).getTime()) {
      refinement.addIssue({
        code: "custom",
        message: "Validation check cannot finish before it starts",
        path: ["finishedAt"],
      });
    }
    const paths = check.artifactObservations.map((observation) => observation.path);
    if (
      new Set(paths).size !== paths.length ||
      JSON.stringify(paths) !== JSON.stringify([...paths].sort()) ||
      JSON.stringify(paths) !== JSON.stringify(check.artifactPaths)
    ) {
      refinement.addIssue({
        code: "custom",
        message: "Check observations must exactly cover canonical artifact paths",
        path: ["artifactObservations"],
      });
    }
    if (
      check.artifactSetFingerprint !== validationArtifactSetFingerprint(check.artifactObservations)
    ) {
      refinement.addIssue({
        code: "custom",
        message: "Check artifact-set fingerprint is not canonical",
        path: ["artifactSetFingerprint"],
      });
    }
    const output = {
      schemaVersion: 1,
      purpose: "LINEAGEGUARD_VALIDATOR_OUTPUT",
      check: check.check,
      exitCode: check.exitCode,
      stdoutFingerprint: check.stdoutFingerprint,
      stderrFingerprint: check.stderrFingerprint,
      artifactObservations: check.artifactObservations,
    } as const;
    if (check.outputFingerprint !== validationOutputFingerprint(output)) {
      refinement.addIssue({
        code: "custom",
        message: "Validator output fingerprint is not canonical",
        path: ["outputFingerprint"],
      });
    }
  });

const expectedValidatorSchema = z
  .object({
    check: validationCheckNameSchema,
    commandId: validatorCommandIdSchema,
    implementationId: z.string().min(1).max(160),
    version: z.string().min(1).max(80),
    digest: fingerprintSchema,
  })
  .strict();

/** Strict runtime configuration data. Authentication remains a server-layer responsibility. */
export const expectedValidationExecutionSchema = z
  .object({
    schemaVersion: z.literal(1),
    purpose: z.literal("LINEAGEGUARD_EXPECTED_VALIDATION_EXECUTION"),
    ...executionFenceShape,
    validators: z.array(expectedValidatorSchema).length(checkNames.length),
  })
  .strict()
  .superRefine((expected, refinement) => {
    const actual = expected.validators.map((validator) => validator.check);
    if (actual.some((check, index) => check !== checkNames[index])) {
      refinement.addIssue({
        code: "custom",
        message: "Expected validators must exactly cover checks in canonical order",
        path: ["validators"],
      });
    }
    for (const [index, validator] of expected.validators.entries()) {
      if (validator.commandId !== commandForCheck[validator.check]) {
        refinement.addIssue({
          code: "custom",
          message: "Expected validator command is not allowlisted for its check",
          path: ["validators", index, "commandId"],
        });
      }
    }
  });
export type ExpectedValidationExecution = z.infer<typeof expectedValidationExecutionSchema>;

export const liveValidationProtectedHeadersSchema = z
  .object({
    schemaVersion: z.literal(1),
    purpose: z.literal("LINEAGEGUARD_VALIDATION_LIVE"),
    algorithm: z.enum(["ED25519", "HMAC-SHA256"]),
    issuer: z.string().min(1).max(240),
    keyId: z.string().min(1).max(160),
    candidateFingerprint: fingerprintSchema,
    changeFingerprint: fingerprintSchema,
    impactContextFingerprint: fingerprintSchema,
    authoritativeGroundedAssessmentFingerprint: fingerprintSchema,
    authoritativeGroundedDecision: z.literal("BLOCK"),
    authorizedRunEventStreamFingerprint: fingerprintSchema,
    leaseAcquiredAt: isoDateTimeSchema,
    leaseExpiresAt: isoDateTimeSchema,
    ...executionFenceShape,
  })
  .strict();

export const liveValidationPayloadSchema = z
  .object({
    status: z.literal("PASS"),
    artifactPaths: z.array(migrationArtifactPathSchema).min(1).max(20),
    artifactObservations: z.array(executedArtifactObservationSchema).min(1).max(20),
    artifactSetFingerprint: fingerprintSchema,
    checks: z.array(executedValidationCheckSchema).length(checkNames.length),
    completedAt: isoDateTimeSchema,
  })
  .strict();

export const liveValidationUnsignedEnvelopeSchema = z
  .object({
    protectedHeaders: liveValidationProtectedHeadersSchema,
    payload: liveValidationPayloadSchema,
  })
  .strict();
export type LiveValidationUnsignedEnvelope = z.infer<typeof liveValidationUnsignedEnvelopeSchema>;

/** Domain-separated canonical bytes/fingerprint preparation; it performs no signing or trust check. */
export function liveValidationSignedPayloadFingerprint(
  input: LiveValidationUnsignedEnvelope,
): string {
  return hashLiveValidationUnsignedEnvelope(liveValidationUnsignedEnvelopeSchema.parse(input));
}

function hashLiveValidationUnsignedEnvelope(input: LiveValidationUnsignedEnvelope): string {
  return sha256({
    domain: "lineageguard.validation.signed-live-envelope.v1",
    envelope: input,
  });
}

/**
 * Signed LIVE receipt data contract only. Parsing proves canonical structure, never signature trust.
 */
export const signedLiveValidationReceiptSchema = z
  .object({
    protectedHeaders: liveValidationProtectedHeadersSchema,
    payload: liveValidationPayloadSchema,
    signedPayloadFingerprint: fingerprintSchema,
    signature: z.string().regex(/^[A-Za-z0-9_-]{43,86}$/),
  })
  .strict()
  .superRefine((receipt, refinement) => {
    const protectedHeaders = receipt.protectedHeaders;
    const payload = receipt.payload;
    const globalPaths = payload.artifactObservations.map((observation) => observation.path);
    if (
      new Set(globalPaths).size !== globalPaths.length ||
      JSON.stringify(globalPaths) !== JSON.stringify([...globalPaths].sort()) ||
      JSON.stringify(globalPaths) !== JSON.stringify(payload.artifactPaths)
    ) {
      refinement.addIssue({
        code: "custom",
        message: "Receipt observations must exactly cover canonical artifact paths",
        path: ["payload", "artifactObservations"],
      });
    }
    if (
      payload.artifactSetFingerprint !==
      validationArtifactSetFingerprint(payload.artifactObservations)
    ) {
      refinement.addIssue({
        code: "custom",
        message: "Receipt artifact-set fingerprint is not canonical",
        path: ["payload", "artifactSetFingerprint"],
      });
    }
    const actualChecks = payload.checks.map((check) => check.check);
    if (actualChecks.some((check, index) => check !== checkNames[index])) {
      refinement.addIssue({
        code: "custom",
        message: "Live receipt requires the exact canonical check order",
        path: ["payload", "checks"],
      });
    }
    for (const [index, check] of payload.checks.entries()) {
      for (const field of [
        "runId",
        "sandboxId",
        "worktreeId",
        "leaseId",
        "workerId",
        "generation",
      ] as const) {
        if (check[field] !== protectedHeaders[field]) {
          refinement.addIssue({
            code: "custom",
            message: "Per-check execution fence must match protected headers",
            path: ["payload", "checks", index, field],
          });
        }
      }
      const expectedObservations = payload.artifactObservations.filter((observation) =>
        check.artifactPaths.includes(observation.path),
      );
      if (JSON.stringify(check.artifactObservations) !== JSON.stringify(expectedObservations)) {
        refinement.addIssue({
          code: "custom",
          message: "Per-check artifact hashes must match the signed global artifact set",
          path: ["payload", "checks", index, "artifactObservations"],
        });
      }
    }
    const acquiredAt = new Date(protectedHeaders.leaseAcquiredAt).getTime();
    const expiresAt = new Date(protectedHeaders.leaseExpiresAt).getTime();
    const completedAt = new Date(payload.completedAt).getTime();
    if (acquiredAt >= expiresAt || completedAt < acquiredAt || completedAt >= expiresAt) {
      refinement.addIssue({
        code: "custom",
        message: "Live validation completion must occur inside the protected lease interval",
        path: ["payload", "completedAt"],
      });
    }
    if (
      payload.checks.some(
        (check) =>
          new Date(check.startedAt).getTime() < acquiredAt ||
          new Date(check.finishedAt).getTime() > completedAt,
      )
    ) {
      refinement.addIssue({
        code: "custom",
        message: "All check execution must remain inside the protected live interval",
        path: ["payload", "checks"],
      });
    }
    const expectedSignatureLength = protectedHeaders.algorithm === "ED25519" ? 86 : 43;
    if (receipt.signature.length !== expectedSignatureLength) {
      refinement.addIssue({
        code: "custom",
        message: "Signature byte length does not match the protected algorithm",
        path: ["signature"],
      });
    }
    if (
      receipt.signedPayloadFingerprint !==
      hashLiveValidationUnsignedEnvelope({ protectedHeaders, payload })
    ) {
      refinement.addIssue({
        code: "custom",
        message: "Signed payload fingerprint is not canonical",
        path: ["signedPayloadFingerprint"],
      });
    }
  });
export type SignedLiveValidationReceipt = z.infer<typeof signedLiveValidationReceiptSchema>;

export function signedLiveValidationReceiptFingerprint(input: SignedLiveValidationReceipt): string {
  return sha256({
    domain: "lineageguard.validation.signed-live-receipt.v1",
    receipt: signedLiveValidationReceiptSchema.parse(input),
  });
}

/** Presentation data only. Servers must authenticate the embedded original LIVE signature. */
export const validationReplayPresentationSchema = z
  .object({
    schemaVersion: z.literal(1),
    purpose: z.literal("LINEAGEGUARD_VALIDATION_REPLAY_PRESENTATION"),
    originalLiveReceipt: signedLiveValidationReceiptSchema,
    originalLiveReceiptFingerprint: fingerprintSchema,
    candidateFingerprint: fingerprintSchema,
    artifactSetFingerprint: fingerprintSchema,
  })
  .strict()
  .superRefine((replay, refinement) => {
    if (
      replay.originalLiveReceiptFingerprint !==
      signedLiveValidationReceiptFingerprint(replay.originalLiveReceipt)
    ) {
      refinement.addIssue({
        code: "custom",
        message: "Replay must retain the exact original signed LIVE receipt",
        path: ["originalLiveReceiptFingerprint"],
      });
    }
    if (
      replay.candidateFingerprint !==
      replay.originalLiveReceipt.protectedHeaders.candidateFingerprint
    ) {
      refinement.addIssue({
        code: "custom",
        message: "Replay candidate cannot differ from the original LIVE candidate",
        path: ["candidateFingerprint"],
      });
    }
    if (
      replay.artifactSetFingerprint !== replay.originalLiveReceipt.payload.artifactSetFingerprint
    ) {
      refinement.addIssue({
        code: "custom",
        message: "Replay artifacts cannot differ from the original LIVE artifact set",
        path: ["artifactSetFingerprint"],
      });
    }
  });
export type ValidationReplayPresentation = z.infer<typeof validationReplayPresentationSchema>;
