import { z } from "zod";
import { sha256 } from "./hash.js";

const shaSchema = z.string().regex(/^[0-9a-f]{40}$/);
const digestSchema = z.string().regex(/^[0-9a-f]{64}$/);
const repositorySchema = z
  .string()
  .min(3)
  .max(140)
  .regex(/^[A-Za-z0-9._-]+\/[A-Za-z0-9._-]+$/u, "repository must be owner/name");

/** The one schema change this MVP supports. Anything else is refused before analysis. */
export const canonicalNormalizedChange = Object.freeze({
  schema: "commerce",
  table: "orders",
  operation: "RENAME_COLUMN",
  fromColumn: "customer_id",
  toColumn: "buyer_id",
} as const);

export const normalizedChangeSchema = z
  .object({
    schema: z.literal("commerce"),
    table: z.literal("orders"),
    operation: z.literal("RENAME_COLUMN"),
    fromColumn: z.literal("customer_id"),
    toColumn: z.literal("buyer_id"),
  })
  .strict();

const envelopeFileSchema = z
  .object({
    path: z.string().min(1).max(400),
    patchSha256: digestSchema,
    blobSha: z
      .string()
      .regex(/^[0-9a-f]{40}$/)
      .optional(),
  })
  .strict();

/**
 * The exact source bytes a run analysed. Raw patch identity (`files[].patchSha256`) is kept
 * separate from normalized semantics (`normalizedChange`) so a reviewer can tell "these bytes"
 * apart from "this interpretation of them".
 */
export const sourceChangeEnvelopeSchema = z
  .object({
    origin: z.literal("GITHUB_PR"),
    repository: repositorySchema,
    prNumber: z.number().int().positive(),
    prUrl: z.string().url().max(500),
    prState: z.literal("open"),
    baseSha: shaSchema,
    headSha: shaSchema,
    files: z.array(envelopeFileSchema).min(1).max(50),
    selectedPath: z.string().min(1).max(400),
    normalizedChange: normalizedChangeSchema,
    sourceFingerprint: digestSchema,
  })
  .strict()
  .superRefine((envelope, refinement) => {
    if (!envelope.files.some((file) => file.path === envelope.selectedPath)) {
      refinement.addIssue({
        code: "custom",
        message: "selectedPath must name one of the envelope's files",
        path: ["selectedPath"],
      });
    }
    const paths = envelope.files.map((file) => file.path);
    if (new Set(paths).size !== paths.length) {
      refinement.addIssue({
        code: "custom",
        message: "envelope file paths must be unique",
        path: ["files"],
      });
    }
    const sorted = [...paths].sort();
    if (paths.some((path, index) => path !== sorted[index])) {
      refinement.addIssue({
        code: "custom",
        message: "envelope files must use canonical path order",
        path: ["files"],
      });
    }
    if (envelope.baseSha === envelope.headSha) {
      refinement.addIssue({
        code: "custom",
        message: "baseSha and headSha must differ",
        path: ["headSha"],
      });
    }
    const { sourceFingerprint, ...identity } = envelope;
    if (sourceFingerprint !== computeSourceFingerprint(identity)) {
      refinement.addIssue({
        code: "custom",
        message: "source fingerprint is invalid",
        path: ["sourceFingerprint"],
      });
    }
  });

export type SourceChangeEnvelope = z.infer<typeof sourceChangeEnvelopeSchema>;
export type SourceChangeEnvelopeIdentity = Omit<SourceChangeEnvelope, "sourceFingerprint">;

export function computeSourceFingerprint(identity: SourceChangeEnvelopeIdentity): string {
  return sha256(identity);
}

export function createSourceChangeEnvelope(
  identity: SourceChangeEnvelopeIdentity,
): SourceChangeEnvelope {
  return sourceChangeEnvelopeSchema.parse({
    ...identity,
    sourceFingerprint: computeSourceFingerprint(identity),
  });
}

export const sourceRejectionCodes = [
  "AMBIGUOUS_CHANGE",
  "MALFORMED_PATCH",
  "NO_SUPPORTED_CHANGE",
  "PR_NOT_OPEN",
  "REPOSITORY_MISMATCH",
  "UNRELATED_CHANGES",
  "UNSUPPORTED_RENAME",
] as const;
export type SourceRejectionCode = (typeof sourceRejectionCodes)[number];

export class SourceChangeRejectedError extends Error {
  readonly code: SourceRejectionCode;
  readonly detail: string;

  constructor(code: SourceRejectionCode, detail: string) {
    super(`Source change rejected: ${code}`);
    this.name = "SourceChangeRejectedError";
    this.code = code;
    this.detail = detail.slice(0, 300);
  }
}

/**
 * Raised when the source identity changes after analysis. Later authoritative effects must never
 * run against stale analysis, so this is fatal rather than a retry.
 */
export class SourceDriftError extends Error {
  readonly code = "SOURCE_DRIFT" as const;
  readonly checkpoint: string;
  readonly expected: string;
  readonly observed: string;

  constructor(checkpoint: string, field: string, expected: string, observed: string) {
    super(`SOURCE_DRIFT at ${checkpoint}: ${field} changed`);
    this.name = "SourceDriftError";
    this.checkpoint = checkpoint;
    this.expected = `${field}=${expected}`;
    this.observed = `${field}=${observed}`;
  }
}

/**
 * Re-attests that a freshly read source still matches what was analysed. Compares the whole
 * fingerprint plus the individual fields, so the failure names what moved.
 */
export function assertNoSourceDrift(
  checkpoint: string,
  analysed: SourceChangeEnvelope,
  observed: SourceChangeEnvelope,
): void {
  const fields: ReadonlyArray<[string, string, string]> = [
    ["repository", analysed.repository, observed.repository],
    ["prNumber", String(analysed.prNumber), String(observed.prNumber)],
    ["prState", analysed.prState, observed.prState],
    ["baseSha", analysed.baseSha, observed.baseSha],
    ["headSha", analysed.headSha, observed.headSha],
    ["selectedPath", analysed.selectedPath, observed.selectedPath],
  ];
  for (const [field, expected, actual] of fields) {
    if (expected !== actual) throw new SourceDriftError(checkpoint, field, expected, actual);
  }
  const analysedPatch = analysed.files.find((file) => file.path === analysed.selectedPath);
  const observedPatch = observed.files.find((file) => file.path === observed.selectedPath);
  if (analysedPatch?.patchSha256 !== observedPatch?.patchSha256) {
    throw new SourceDriftError(
      checkpoint,
      "patchSha256",
      analysedPatch?.patchSha256 ?? "absent",
      observedPatch?.patchSha256 ?? "absent",
    );
  }
  if (analysed.sourceFingerprint !== observed.sourceFingerprint) {
    throw new SourceDriftError(
      checkpoint,
      "sourceFingerprint",
      analysed.sourceFingerprint,
      observed.sourceFingerprint,
    );
  }
}
