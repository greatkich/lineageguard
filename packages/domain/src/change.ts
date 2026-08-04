import { z } from "zod";
import { sha256, stableId } from "./hash.js";

const boundedText = (maximum: number) => z.string().min(1).max(maximum);
const shaSchema = z.string().regex(/^[a-f0-9]{7,64}$/i, "Expected a Git SHA");
const repositorySchema = z
  .string()
  .min(3)
  .max(200)
  .regex(/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/, "Expected owner/repository");
const safeRepositoryPathSchema = z
  .string()
  .min(1)
  .max(240)
  .refine((path) => !path.startsWith("/") && !path.includes("\\"), "Path must be relative")
  .refine(
    (path) =>
      path.split("/").every((segment) => segment !== "" && segment !== "." && segment !== ".."),
    "Path must be normalized",
  );

export const datasetRefSchema = z
  .object({
    platform: z.literal("postgres"),
    environment: z.literal("PROD"),
    schema: z.literal("commerce"),
    dataset: z.literal("orders"),
  })
  .strict();

export type DatasetRef = z.infer<typeof datasetRefSchema>;

export const canonicalDatasetRef = Object.freeze({
  platform: "postgres",
  environment: "PROD",
  schema: "commerce",
  dataset: "orders",
} satisfies DatasetRef);

export const repositoryChangeFileSchema = z
  .object({
    path: safeRepositoryPathSchema,
    datasetRef: datasetRefSchema,
    patch: boundedText(32_000),
  })
  .strict();

export const repositoryChangeInputSchema = z
  .object({
    source: z.enum(["GITHUB", "FIXTURE"]),
    repository: repositorySchema,
    baseSha: shaSchema,
    headSha: shaSchema,
    files: z.array(repositoryChangeFileSchema).min(1).max(20),
  })
  .strict()
  .refine((input) => input.baseSha !== input.headSha, {
    message: "Base and head SHA must differ",
    path: ["headSha"],
  });

export type RepositoryChangeInput = z.infer<typeof repositoryChangeInputSchema>;

export const proposedChangeSchema = z
  .object({
    id: z.string().regex(/^chg_[a-f0-9]{24}$/),
    fingerprint: z.string().regex(/^[a-f0-9]{64}$/),
    sourcePatchFingerprint: z.string().regex(/^[a-f0-9]{64}$/),
    source: z.enum(["GITHUB", "FIXTURE"]),
    repository: repositorySchema,
    baseSha: shaSchema,
    headSha: shaSchema,
    datasetRef: datasetRefSchema,
    operation: z.literal("RENAME_FIELD"),
    field: z.literal("customer_id"),
    before: z.object({ field: z.literal("customer_id") }).strict(),
    after: z.object({ field: z.literal("buyer_id") }).strict(),
    files: z.array(safeRepositoryPathSchema).min(1).max(20),
  })
  .strict()
  .superRefine((change, refinement) => {
    const identity = {
      source: change.source,
      repository: change.repository,
      baseSha: change.baseSha.toLowerCase(),
      headSha: change.headSha.toLowerCase(),
      datasetRef: change.datasetRef,
      operation: change.operation,
      field: change.field,
      before: change.before,
      after: change.after,
      files: [...change.files].sort(),
      sourcePatchFingerprint: change.sourcePatchFingerprint,
    };
    if (change.fingerprint !== sha256(identity)) {
      refinement.addIssue({
        code: "custom",
        message: "Change fingerprint is invalid",
        path: ["fingerprint"],
      });
    }
    if (change.id !== stableId("chg", identity)) {
      refinement.addIssue({ code: "custom", message: "Change ID is invalid", path: ["id"] });
    }
  });

export type ProposedChange = z.infer<typeof proposedChangeSchema>;

export const parseErrorCodeSchema = z.enum([
  "INVALID_INPUT",
  "NO_SUPPORTED_CHANGE",
  "MULTIPLE_SUPPORTED_CHANGES",
  "AMBIGUOUS_CHANGE",
  "UNSUPPORTED_CHANGE",
]);

export type ParseErrorCode = z.infer<typeof parseErrorCodeSchema>;

export const parseErrorSchema = z
  .object({
    code: parseErrorCodeSchema,
    message: z.string().min(1).max(500),
    filePaths: z.array(safeRepositoryPathSchema).max(20),
  })
  .strict();

export type ParseError = z.infer<typeof parseErrorSchema>;

export type ParseProposedChangeResult =
  | { ok: true; value: ProposedChange }
  | { error: ParseError; ok: false };

const canonicalSqlPattern =
  /^\s*ALTER\s+TABLE\s+commerce\.orders\s+RENAME\s+COLUMN\s+customer_id\s+TO\s+buyer_id\s*;\s*$/i;
const canonicalSqlStatementPattern =
  /\bALTER\s+TABLE\s+commerce\.orders\s+RENAME\s+COLUMN\s+customer_id\s+TO\s+buyer_id\s*;/gi;
const anyRenamePattern = /\bALTER\s+TABLE\b[\s\S]*?\bRENAME\s+COLUMN\b/gi;
const canonicalMigrationPathPattern = /^walkthrough\/migrations\/[A-Za-z0-9._-]+\.sql$/;
const canonicalModelPathPattern = /^walkthrough\/models\/[A-Za-z0-9_./-]+\.sql$/;
const fullDiffPattern =
  /^diff --git a\/(.+) b\/(.+)\n(?:index [a-f0-9]+\.\.[a-f0-9]+(?: [0-7]{6})?\n)?--- a\/(.+)\n\+\+\+ b\/(.+)\n(@@[^\n]*@@\n[\s\S]+)$/;
const hunkPattern = /^@@[^\n]*@@\n[\s\S]+$/;

function isCanonicalSqlPatch(path: string, patch: string): boolean {
  return canonicalMigrationPathPattern.test(path) && canonicalSqlPattern.test(patch);
}

function isCanonicalUnifiedDiff(path: string, patch: string): boolean {
  if (!canonicalModelPathPattern.test(path)) {
    return false;
  }
  const fullMatch = fullDiffPattern.exec(patch);
  if (
    fullMatch &&
    (fullMatch[1] !== path ||
      fullMatch[2] !== path ||
      fullMatch[3] !== path ||
      fullMatch[4] !== path)
  ) {
    return false;
  }
  const hunk = fullMatch?.[5] ?? (hunkPattern.test(patch) ? patch : undefined);
  if (!hunk) return false;
  const body = hunk.slice(hunk.indexOf("\n") + 1);

  const changedLines = body
    .split("\n")
    .filter((line) => line.startsWith("+") || line.startsWith("-"));
  if (
    changedLines.length !== 2 ||
    !changedLines[0]?.startsWith("-") ||
    !changedLines[1]?.startsWith("+")
  ) {
    return false;
  }

  const before = changedLines[0].slice(1);
  const after = changedLines[1].slice(1);
  const unsafeText = /--|\/\*|\*\/|['"`]/;
  if (unsafeText.test(before) || unsafeText.test(after)) {
    return false;
  }
  if (!/\bcustomer_id\b/.test(before) || /\bcustomer_id\b/.test(after)) {
    return false;
  }
  if (!/\bbuyer_id\b/.test(after) || /\bbuyer_id\b/.test(before)) {
    return false;
  }

  const canonicalSqlLine =
    /^\s*(?:customer_id(?:\s*::\s*[a-z][a-z0-9_]*(?:\s+as\s+customer_id)?|\s+[a-z][a-z0-9_]*(?:\([^)]*\))?(?:\s+not\s+null)?)?)[,;]?\s*$/i;
  return canonicalSqlLine.test(before) && before.replace(/\bcustomer_id\b/g, "buyer_id") === after;
}

function containsUnsupportedRename(patch: string): boolean {
  const renameCount = patch.match(anyRenamePattern)?.length ?? 0;
  return renameCount > 0;
}

function buildProposedChange(input: RepositoryChangeInput): ProposedChange {
  const canonicalSources = input.files
    .map((file) => ({ path: file.path, patchFingerprint: sha256(file.patch) }))
    .sort((left, right) => left.path.localeCompare(right.path));
  const sourcePatchFingerprint = sha256(canonicalSources);
  const identity = {
    source: input.source,
    repository: input.repository,
    baseSha: input.baseSha.toLowerCase(),
    headSha: input.headSha.toLowerCase(),
    datasetRef: canonicalDatasetRef,
    operation: "RENAME_FIELD" as const,
    field: "customer_id" as const,
    before: { field: "customer_id" as const },
    after: { field: "buyer_id" as const },
    files: input.files.map((file) => file.path).sort(),
    sourcePatchFingerprint,
  };
  const fingerprint = sha256(identity);
  return proposedChangeSchema.parse({
    ...identity,
    id: stableId("chg", identity),
    fingerprint,
  });
}

export function parseProposedChange(untrustedInput: unknown): ParseProposedChangeResult {
  const parsedInput = repositoryChangeInputSchema.safeParse(untrustedInput);
  if (!parsedInput.success) {
    return {
      ok: false,
      error: {
        code: "INVALID_INPUT",
        message: "Repository change input failed schema validation",
        filePaths: [],
      },
    };
  }

  const input = parsedInput.data;
  const supportedFiles: string[] = [];
  const unsupportedFiles: string[] = [];
  const multipleFiles: string[] = [];
  for (const file of input.files) {
    const canonicalSqlCount = file.patch.match(canonicalSqlStatementPattern)?.length ?? 0;
    if (canonicalSqlCount > 1) {
      multipleFiles.push(file.path);
    } else if (
      isCanonicalSqlPatch(file.path, file.patch) ||
      isCanonicalUnifiedDiff(file.path, file.patch)
    ) {
      supportedFiles.push(file.path);
    } else if (
      containsUnsupportedRename(file.patch) ||
      /\bcustomer_id\b/.test(file.patch) ||
      /\bbuyer_id\b/.test(file.patch)
    ) {
      unsupportedFiles.push(file.path);
    }
  }

  if (supportedFiles.length > 1 || multipleFiles.length > 0) {
    return {
      ok: false,
      error: {
        code: "MULTIPLE_SUPPORTED_CHANGES",
        message: "Exactly one canonical field rename is supported",
        filePaths: [...supportedFiles, ...multipleFiles].sort(),
      },
    };
  }
  if (supportedFiles.length === 1 && unsupportedFiles.length > 0) {
    return {
      ok: false,
      error: {
        code: "AMBIGUOUS_CHANGE",
        message: "Canonical rename appears alongside another field change",
        filePaths: [...supportedFiles, ...unsupportedFiles].sort(),
      },
    };
  }
  if (supportedFiles.length === 0 && unsupportedFiles.length > 0) {
    return {
      ok: false,
      error: {
        code: "UNSUPPORTED_CHANGE",
        message:
          "The repository change resembles a field rename but is not the supported canonical form",
        filePaths: unsupportedFiles.sort(),
      },
    };
  }
  if (supportedFiles.length === 0) {
    return {
      ok: false,
      error: {
        code: "NO_SUPPORTED_CHANGE",
        message: "No supported canonical field rename was found",
        filePaths: input.files.map((file) => file.path).sort(),
      },
    };
  }

  return { ok: true, value: buildProposedChange(input) };
}
