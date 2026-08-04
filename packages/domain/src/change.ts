import { z } from "zod";
import { sha256, stableId } from "./hash.js";

const boundedText = (maximum: number) => z.string().min(1).max(maximum);
const shaSchema = z
  .string()
  .regex(/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/, "Expected a lowercase full Git object ID");
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
    files: z.array(repositoryChangeFileSchema).length(1),
  })
  .strict()
  .refine((input) => input.baseSha !== input.headSha, {
    message: "Base and head object IDs must differ",
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
    files: z.array(safeRepositoryPathSchema).length(1),
  })
  .strict()
  .superRefine((change, refinement) => {
    if (change.baseSha === change.headSha) {
      refinement.addIssue({
        code: "custom",
        message: "Base and head must differ",
        path: ["headSha"],
      });
    }
    const identity = {
      source: change.source,
      repository: change.repository,
      baseSha: change.baseSha,
      headSha: change.headSha,
      datasetRef: change.datasetRef,
      operation: change.operation,
      field: change.field,
      before: change.before,
      after: change.after,
      files: change.files,
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

const canonicalSql = "ALTER TABLE commerce.orders RENAME COLUMN customer_id TO buyer_id;";
const migrationPathPattern = /^walkthrough\/migrations\/[A-Za-z0-9._-]+\.sql$/;
const modelPathPattern = /^walkthrough\/models\/[A-Za-z0-9_./-]+\.sql$/;
const hunkHeaderPattern = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@(?: .*)?$/;

function isExactFixtureSql(input: RepositoryChangeInput, path: string, patch: string): boolean {
  return input.source === "FIXTURE" && migrationPathPattern.test(path) && patch === canonicalSql;
}

function isExactGitUnifiedDiff(path: string, patch: string): boolean {
  if (!modelPathPattern.test(path) || patch.includes("\r")) return false;
  const lines = patch.split("\n");
  if (lines.at(-1) === "") lines.pop();
  let cursor = 0;
  if (lines[cursor] !== `diff --git a/${path} b/${path}`) return false;
  cursor += 1;
  if (/^index [a-f0-9]{7,64}\.\.[a-f0-9]{7,64}(?: [0-7]{6})?$/.test(lines[cursor] ?? "")) {
    cursor += 1;
  }
  if (lines[cursor] !== `--- a/${path}` || lines[cursor + 1] !== `+++ b/${path}`) return false;
  cursor += 2;
  const header = hunkHeaderPattern.exec(lines[cursor] ?? "");
  if (!header) return false;
  cursor += 1;
  const body = lines.slice(cursor);
  if (body.length === 0 || body.some((line) => !/^[ +-]/.test(line) || line.startsWith("@@"))) {
    return false;
  }
  const oldCount = Number(header[2] ?? 1);
  const newCount = Number(header[4] ?? 1);
  const observedOld = body.filter((line) => line.startsWith(" ") || line.startsWith("-")).length;
  const observedNew = body.filter((line) => line.startsWith(" ") || line.startsWith("+")).length;
  if (observedOld !== oldCount || observedNew !== newCount) return false;
  const removed = body.filter((line) => line.startsWith("-"));
  const added = body.filter((line) => line.startsWith("+"));
  return (
    removed.length === 1 &&
    added.length === 1 &&
    removed[0]?.slice(1).trim() === "customer_id::bigint as customer_id," &&
    added[0]?.slice(1).trim() === "buyer_id::bigint as buyer_id,"
  );
}

function buildProposedChange(input: RepositoryChangeInput): ProposedChange {
  const file = input.files[0];
  if (!file) throw new Error("Validated repository input has no file");
  const sourcePatchFingerprint = sha256([
    { path: file.path, patchFingerprint: sha256(file.patch) },
  ]);
  const identity = {
    source: input.source,
    repository: input.repository,
    baseSha: input.baseSha,
    headSha: input.headSha,
    datasetRef: canonicalDatasetRef,
    operation: "RENAME_FIELD" as const,
    field: "customer_id" as const,
    before: { field: "customer_id" as const },
    after: { field: "buyer_id" as const },
    files: [file.path],
    sourcePatchFingerprint,
  };
  return proposedChangeSchema.parse({
    ...identity,
    id: stableId("chg", identity),
    fingerprint: sha256(identity),
  });
}

export function parseProposedChange(untrustedInput: unknown): ParseProposedChangeResult {
  const parsed = repositoryChangeInputSchema.safeParse(untrustedInput);
  if (!parsed.success) {
    return {
      ok: false,
      error: {
        code: "INVALID_INPUT",
        message: "Repository input failed strict validation",
        filePaths: [],
      },
    };
  }
  const input = parsed.data;
  const file = input.files[0];
  if (
    !file ||
    (!isExactFixtureSql(input, file.path, file.patch) &&
      !isExactGitUnifiedDiff(file.path, file.patch))
  ) {
    return {
      ok: false,
      error: {
        code: "UNSUPPORTED_CHANGE",
        message: "The changed file is not the exact supported canonical rename",
        filePaths: file ? [file.path] : [],
      },
    };
  }
  return { ok: true, value: buildProposedChange(input) };
}
