import { z } from "zod";
import { sha256, stableId } from "./hash.js";
import {
  assertStructuralValidationReceiptBinding,
  type MigrationCandidate,
  migrationCandidateSchema,
  structuralValidationReceiptSchema,
  validationCheckNameSchema,
} from "./migration.js";

const fingerprintSchema = z.string().regex(/^[a-f0-9]{64}$/);
const isoDateTimeSchema = z.iso.datetime({ offset: true });
const runIdSchema = z.string().regex(/^run_[a-f0-9]{24}$/);
const leaseIdSchema = z.string().regex(/^lease_[a-f0-9]{24}$/);
const validationCheckNames = validationCheckNameSchema.options;
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

const artifactObservationSchema = z
  .object({
    path: z.string().min(1).max(240),
    candidateArtifactFingerprint: fingerprintSchema,
    materializedSha256: fingerprintSchema,
  })
  .strict();

const executionProvenanceSchema = z
  .object({
    validatorImplementationId: z.string().min(1).max(160),
    validatorVersion: z.string().min(1).max(80),
    validatorDigest: fingerprintSchema,
    commandId: validatorCommandIdSchema,
    exitCode: z.number().int().min(0).max(255),
    startedAt: isoDateTimeSchema,
    finishedAt: isoDateTimeSchema,
    runId: runIdSchema,
    sandboxId: z.string().min(1).max(160),
    worktreeId: z.string().min(1).max(240),
    leaseId: leaseIdSchema,
    workerId: z.string().min(1).max(160),
    generation: z.number().int().positive().max(1_000_000),
    stdoutFingerprint: fingerprintSchema,
    stderrFingerprint: fingerprintSchema,
    outputFingerprint: fingerprintSchema,
    artifactSetFingerprint: fingerprintSchema,
  })
  .strict();

const executedValidationCheckSchema = z
  .object({
    check: validationCheckNameSchema,
    status: z.enum(["PASS", "FAIL"]),
    startedAt: isoDateTimeSchema,
    completedAt: isoDateTimeSchema,
    summary: z.string().min(1).max(1_000),
    artifactPaths: z.array(z.string().min(1).max(240)).min(1).max(20),
    execution: executionProvenanceSchema,
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
    if (check.execution.commandId !== commandForCheck[check.check]) {
      refinement.addIssue({
        code: "custom",
        message: "Validation check must use its allowlisted command ID",
        path: ["execution", "commandId"],
      });
    }
    if (
      check.execution.startedAt !== check.startedAt ||
      check.execution.finishedAt !== check.completedAt
    ) {
      refinement.addIssue({
        code: "custom",
        message: "Execution provenance timestamps must match the check envelope",
        path: ["execution"],
      });
    }
  });

const attestationBase = {
  keyId: z.string().min(1).max(160),
  issuer: z.string().min(1).max(240),
  payloadFingerprint: fingerprintSchema,
};
export const validationAttestationSchema = z.discriminatedUnion("algorithm", [
  z
    .object({
      ...attestationBase,
      algorithm: z.literal("HMAC-SHA256"),
      signature: z.string().regex(/^[A-Za-z0-9_-]{43}$/),
    })
    .strict(),
  z
    .object({
      ...attestationBase,
      algorithm: z.literal("ED25519"),
      signature: z.string().regex(/^[A-Za-z0-9_-]{86}$/),
    })
    .strict(),
]);

/** Authenticated transport shape; still not authoritative until accepted by the gate below. */
export const executedValidationReceiptSchema = z
  .object({
    candidateFingerprint: fingerprintSchema,
    status: z.enum(["PASS", "FAIL"]),
    artifactPaths: z.array(z.string().min(1).max(240)).min(1).max(20),
    artifactObservations: z.array(artifactObservationSchema).min(1).max(20),
    checks: z.array(executedValidationCheckSchema).min(1).max(20),
    completedAt: isoDateTimeSchema,
    executionMode: z.enum(["LIVE", "REPLAY"]),
    authenticatedOriginalLiveReceiptFingerprint: fingerprintSchema.optional(),
    attestation: validationAttestationSchema,
  })
  .strict()
  .superRefine((receipt, refinement) => {
    const names = receipt.checks.map((check) => check.check);
    if (new Set(names).size !== names.length) {
      refinement.addIssue({
        code: "custom",
        message: "Validation checks must be unique",
        path: ["checks"],
      });
    }
    if (receipt.status === "PASS") {
      if (
        names.length !== validationCheckNames.length ||
        names.some((name, index) => name !== validationCheckNames[index]) ||
        receipt.checks.some((check) => check.status !== "PASS" || check.execution.exitCode !== 0)
      ) {
        refinement.addIssue({
          code: "custom",
          message: "PASS requires the exact canonical successful executed check set",
          path: ["checks"],
        });
      }
    }
    if (
      (receipt.executionMode === "LIVE" &&
        receipt.authenticatedOriginalLiveReceiptFingerprint !== undefined) ||
      (receipt.executionMode === "REPLAY" &&
        receipt.authenticatedOriginalLiveReceiptFingerprint === undefined)
    ) {
      refinement.addIssue({
        code: "custom",
        message: "Replay must reference an authenticated original live receipt",
        path: ["authenticatedOriginalLiveReceiptFingerprint"],
      });
    }
  });

export type ExecutedValidationReceipt = z.infer<typeof executedValidationReceiptSchema>;

export function validationAttestationPayloadFingerprint(
  receiptInput: ExecutedValidationReceipt,
): string {
  const receipt = executedValidationReceiptSchema.parse(receiptInput);
  const { attestation: _attestation, ...payload } = receipt;
  return sha256(payload);
}

export interface ExpectedValidationExecution {
  runId: string;
  sandboxId: string;
  worktreeId: string;
  leaseId: string;
  workerId: string;
  generation: number;
  validators: Record<
    ValidationCheckName,
    { implementationId: string; version: string; digest: string }
  >;
}

export interface ValidationAttestationVerifier {
  verify(
    attestation: z.infer<typeof validationAttestationSchema>,
    payloadFingerprint: string,
  ): boolean;
  isAuthenticatedOriginalLiveReceipt(receiptFingerprint: string): boolean;
}

declare const acceptedValidationReceiptBrand: unique symbol;
export type AcceptedExecutedValidationReceipt = Readonly<
  ExecutedValidationReceipt & { receiptId: string }
> & { readonly [acceptedValidationReceiptBrand]: true };

function deepFreeze<T extends object>(value: T): Readonly<T> {
  for (const nested of Object.values(value)) {
    if (typeof nested === "object" && nested !== null && !Object.isFrozen(nested)) {
      deepFreeze(nested);
    }
  }
  return Object.freeze(value);
}

export function acceptExecutedValidationReceipt(
  receiptInput: ExecutedValidationReceipt,
  candidateInput: MigrationCandidate,
  expected: ExpectedValidationExecution,
  verifier: ValidationAttestationVerifier,
): AcceptedExecutedValidationReceipt {
  const receipt = executedValidationReceiptSchema.parse(receiptInput);
  const candidate = migrationCandidateSchema.parse(candidateInput);
  if (receipt.status !== "PASS") throw new Error("Only a passing execution can be accepted");
  const structuralReceipt = structuralValidationReceiptSchema.parse({
    candidateFingerprint: receipt.candidateFingerprint,
    status: receipt.status,
    artifactPaths: receipt.artifactPaths,
    artifactObservations: receipt.artifactObservations,
    checks: receipt.checks.map(({ execution: _execution, ...check }) => check),
    completedAt: receipt.completedAt,
  });
  assertStructuralValidationReceiptBinding(structuralReceipt, candidate);

  const expectedScope = {
    runId: expected.runId,
    sandboxId: expected.sandboxId,
    worktreeId: expected.worktreeId,
    leaseId: expected.leaseId,
    workerId: expected.workerId,
    generation: expected.generation,
  };
  for (const check of receipt.checks) {
    const execution = check.execution;
    const actualScope = {
      runId: execution.runId,
      sandboxId: execution.sandboxId,
      worktreeId: execution.worktreeId,
      leaseId: execution.leaseId,
      workerId: execution.workerId,
      generation: execution.generation,
    };
    const validator = expected.validators[check.check];
    if (JSON.stringify(actualScope) !== JSON.stringify(expectedScope)) {
      throw new Error(`Validation check ${check.check} is outside the trusted execution fence`);
    }
    if (
      execution.validatorImplementationId !== validator.implementationId ||
      execution.validatorVersion !== validator.version ||
      execution.validatorDigest !== validator.digest
    ) {
      throw new Error(
        `Validation check ${check.check} used an unexpected validator implementation`,
      );
    }
    const observations = receipt.artifactObservations.filter((observation) =>
      check.artifactPaths.includes(observation.path),
    );
    if (execution.artifactSetFingerprint !== sha256(observations)) {
      throw new Error(`Validation check ${check.check} is not bound to its exact artifact hashes`);
    }
  }

  const payloadFingerprint = validationAttestationPayloadFingerprint(receipt);
  if (
    receipt.attestation.payloadFingerprint !== payloadFingerprint ||
    !verifier.verify(receipt.attestation, payloadFingerprint)
  ) {
    throw new Error("Validation execution attestation is not trusted");
  }
  if (
    receipt.executionMode === "REPLAY" &&
    (!receipt.authenticatedOriginalLiveReceiptFingerprint ||
      !verifier.isAuthenticatedOriginalLiveReceipt(
        receipt.authenticatedOriginalLiveReceiptFingerprint,
      ))
  ) {
    throw new Error("Replay does not reference an authenticated original live receipt");
  }
  return deepFreeze({
    ...receipt,
    receiptId: stableId("val", receipt),
  }) as AcceptedExecutedValidationReceipt;
}
