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
  .superRefine((input, refinement) => {
    if (input.baseSha === input.headSha) {
      refinement.addIssue({
        code: "custom",
        message: "Base and head IDs must differ",
        path: ["headSha"],
      });
    }
    if (input.baseSha.length !== input.headSha.length) {
      refinement.addIssue({
        code: "custom",
        message: "Base and head must use the same hash algorithm",
        path: ["headSha"],
      });
    }
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
    if (change.baseSha.length !== change.headSha.length) {
      refinement.addIssue({
        code: "custom",
        message: "Base and head must use the same hash algorithm",
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

type ChangeClassification = { kind: "SUCCESS" } | { kind: ParseErrorCode };

function classifyFixture(path: string, patch: string): ChangeClassification {
  if (!migrationPathPattern.test(path)) return { kind: "INVALID_INPUT" };
  const occurrences = patch.split(canonicalSql).length - 1;
  if (occurrences > 1 && patch.replaceAll(canonicalSql, "").trim() === "") {
    return { kind: "MULTIPLE_SUPPORTED_CHANGES" };
  }
  if (occurrences === 1) {
    return patch === canonicalSql ? { kind: "SUCCESS" } : { kind: "AMBIGUOUS_CHANGE" };
  }
  return /customer_id|buyer_id/i.test(patch)
    ? { kind: "UNSUPPORTED_CHANGE" }
    : { kind: "NO_SUPPORTED_CHANGE" };
}

/**
 * Classifies a real GitHub unified diff against a migration file
 * (`walkthrough/migrations/*.sql`), as produced by the canonical source PR:
 * a new SQL file containing comment lines plus exactly one canonical
 * `ALTER TABLE ... RENAME COLUMN` statement. Unlike `classifyGitDiff` (which
 * validates in-place edits to dbt model files), this accepts the git
 * "new file" hunk shape (`@@ -0,0 +N,M @@`) since the migration file is newly
 * added by the source PR, and classifies based on the added SQL statement
 * lines (ignoring `--` SQL comment lines as non-semantic context).
 */
function classifyMigrationGitDiff(path: string, patch: string): ChangeClassification {
  if (patch.includes("\r") || patch.includes("Binary files")) return { kind: "INVALID_INPUT" };
  const lines = patch.split("\n");
  if (lines.at(-1) === "") lines.pop();
  let cursor = 0;
  if (lines[cursor] !== `diff --git a/${path} b/${path}`) return { kind: "INVALID_INPUT" };
  cursor += 1;
  while (
    (lines[cursor] ?? "").startsWith("new file mode ") ||
    (lines[cursor] ?? "").startsWith("deleted file mode ") ||
    (lines[cursor] ?? "").startsWith("index ")
  ) {
    cursor += 1;
  }
  const oldHeaderLine = lines[cursor];
  const newHeaderLine = lines[cursor + 1];
  const isNewFile = oldHeaderLine === "--- /dev/null";
  const isDeletedFile = newHeaderLine === "+++ /dev/null";
  const oldHeaderValid = isNewFile || oldHeaderLine === `--- a/${path}`;
  const newHeaderValid = isDeletedFile || newHeaderLine === `+++ b/${path}`;
  if (!oldHeaderValid || !newHeaderValid) return { kind: "INVALID_INPUT" };
  cursor += 2;
  const header = hunkHeaderPattern.exec(lines[cursor] ?? "");
  if (!header) return { kind: "INVALID_INPUT" };
  const oldStart = Number(header[1]);
  const oldCount = Number(header[2] ?? 1);
  const newStart = Number(header[3]);
  const newCount = Number(header[4] ?? 1);
  if (newStart < 1) return { kind: "INVALID_INPUT" };
  if (isNewFile) {
    if (oldStart !== 0 || oldCount !== 0) return { kind: "INVALID_INPUT" };
  } else if (oldStart < 1) {
    return { kind: "INVALID_INPUT" };
  }
  cursor += 1;
  const body = lines.slice(cursor);
  if (body.length === 0 || body.some((line) => !/^[ +-]/.test(line) || line.startsWith("@@"))) {
    return { kind: "INVALID_INPUT" };
  }
  const observedOld = body.filter((line) => line.startsWith(" ") || line.startsWith("-")).length;
  const observedNew = body.filter((line) => line.startsWith(" ") || line.startsWith("+")).length;
  if (observedOld !== oldCount || observedNew !== newCount) return { kind: "INVALID_INPUT" };

  const addedLines = body.filter((line) => line.startsWith("+")).map((line) => line.slice(1));
  const removedLines = body.filter((line) => line.startsWith("-")).map((line) => line.slice(1));
  const codeLines = addedLines.filter((line) => {
    const trimmed = line.trim();
    return trimmed !== "" && !trimmed.startsWith("--");
  });
  const joinedCode = codeLines.map((line) => line.trim()).join(" ");
  const occurrences = joinedCode.split(canonicalSql).length - 1;
  if (occurrences > 1) return { kind: "MULTIPLE_SUPPORTED_CHANGES" };
  if (occurrences === 1) {
    return joinedCode === canonicalSql ? { kind: "SUCCESS" } : { kind: "AMBIGUOUS_CHANGE" };
  }
  return [...addedLines, ...removedLines].some((line) => /customer_id|buyer_id/i.test(line))
    ? { kind: "UNSUPPORTED_CHANGE" }
    : { kind: "NO_SUPPORTED_CHANGE" };
}

function classifyGitDiff(path: string, patch: string): ChangeClassification {
  if (migrationPathPattern.test(path)) return classifyMigrationGitDiff(path, patch);
  if (!modelPathPattern.test(path) || patch.includes("\r")) return { kind: "INVALID_INPUT" };
  const lines = patch.split("\n");
  if (lines.at(-1) === "") lines.pop();
  let cursor = 0;
  if (lines[cursor] !== `diff --git a/${path} b/${path}`) return { kind: "INVALID_INPUT" };
  cursor += 1;
  if ((lines[cursor] ?? "").startsWith("index ")) {
    const index =
      /^index ([a-f0-9]{40}|[a-f0-9]{64})\.\.([a-f0-9]{40}|[a-f0-9]{64})(?: [0-7]{6})?$/.exec(
        lines[cursor] ?? "",
      );
    if (!index || index[1] === index[2] || index[1]?.length !== index[2]?.length) {
      return { kind: "INVALID_INPUT" };
    }
    cursor += 1;
  }
  if (lines[cursor] !== `--- a/${path}` || lines[cursor + 1] !== `+++ b/${path}`) {
    return { kind: "INVALID_INPUT" };
  }
  cursor += 2;
  const header = hunkHeaderPattern.exec(lines[cursor] ?? "");
  if (!header || Number(header[1]) < 1 || Number(header[3]) < 1) return { kind: "INVALID_INPUT" };
  cursor += 1;
  const body = lines.slice(cursor);
  if (body.length === 0 || body.some((line) => !/^[ +-]/.test(line) || line.startsWith("@@"))) {
    return { kind: "INVALID_INPUT" };
  }
  const oldCount = Number(header[2] ?? 1);
  const newCount = Number(header[4] ?? 1);
  const observedOld = body.filter((line) => line.startsWith(" ") || line.startsWith("-")).length;
  const observedNew = body.filter((line) => line.startsWith(" ") || line.startsWith("+")).length;
  if (observedOld !== oldCount || observedNew !== newCount) return { kind: "INVALID_INPUT" };
  const removed = body.filter((line) => line.startsWith("-"));
  const added = body.filter((line) => line.startsWith("+"));
  let canonicalCount = 0;
  for (let index = 0; index < Math.min(removed.length, added.length); index += 1) {
    if (
      removed[index]?.slice(1).trim() === "customer_id::bigint as customer_id," &&
      added[index]?.slice(1).trim() === "buyer_id::bigint as buyer_id,"
    )
      canonicalCount += 1;
  }
  if (canonicalCount > 1) return { kind: "MULTIPLE_SUPPORTED_CHANGES" };
  if (canonicalCount === 1) {
    return removed.length === 1 && added.length === 1
      ? { kind: "SUCCESS" }
      : { kind: "AMBIGUOUS_CHANGE" };
  }
  return [...removed, ...added].some((line) => /customer_id|buyer_id/i.test(line))
    ? { kind: "UNSUPPORTED_CHANGE" }
    : { kind: "NO_SUPPORTED_CHANGE" };
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
  if (!file) {
    return {
      ok: false,
      error: { code: "INVALID_INPUT", message: "Missing changed file", filePaths: [] },
    };
  }
  const classification =
    input.source === "FIXTURE"
      ? classifyFixture(file.path, file.patch)
      : classifyGitDiff(file.path, file.patch);
  if (classification.kind !== "SUCCESS") {
    return {
      ok: false,
      error: {
        code: classification.kind,
        message: `Canonical change classification: ${classification.kind}`,
        filePaths: [file.path],
      },
    };
  }
  return { ok: true, value: buildProposedChange(input) };
}
