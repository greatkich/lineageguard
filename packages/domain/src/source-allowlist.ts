import { sha256 } from "./hash.js";
import {
  canonicalNormalizedChange,
  createSourceChangeEnvelope,
  SourceChangeRejectedError,
  type SourceChangeEnvelope,
  type SourceRejectionCode,
} from "./source-envelope.js";

/** Only migrations under this prefix may carry the canonical change. */
const allowedMigrationPrefix = "walkthrough/migrations/";

/**
 * Files a canonical PR may contain besides the migration. Documentation and fixtures cannot alter
 * behaviour, so they are tolerated; anything executable is not.
 */
const inertExtensions = [".md", ".txt", ".csv", ".json", ".yml", ".yaml"] as const;

const renameStatement =
  /alter\s+table\s+(?:commerce\.)?orders\s+rename\s+column\s+customer_id\s+to\s+buyer_id/giu;
const anyRenameColumn = /rename\s+column\s+(\w+)\s+to\s+(\w+)/giu;

export type SourceFileInput = Readonly<{
  path: string;
  patch: string;
  blobSha?: string;
}>;

export type SourceAllowlistInput = Readonly<{
  repository: string;
  expectedRepository: string;
  prNumber: number;
  prUrl: string;
  prState: string;
  baseSha: string;
  headSha: string;
  files: readonly SourceFileInput[];
}>;

function reject(code: SourceRejectionCode, detail: string): never {
  throw new SourceChangeRejectedError(code, detail);
}

function isInert(path: string): boolean {
  const lower = path.toLowerCase();
  return inertExtensions.some((extension) => lower.endsWith(extension));
}

function countMatches(patch: string, pattern: RegExp): number {
  return [...patch.matchAll(new RegExp(pattern.source, pattern.flags))].length;
}

/** Added lines only. A rename appearing in a removed line is not a proposed change. */
function addedText(patch: string): string {
  return patch
    .split("\n")
    .filter((line) => line.startsWith("+") && !line.startsWith("+++"))
    .map((line) => line.slice(1))
    .join("\n");
}

function assertRepository(input: SourceAllowlistInput): void {
  if (input.repository !== input.expectedRepository) {
    reject(
      "REPOSITORY_MISMATCH",
      `expected ${input.expectedRepository}, observed ${input.repository}`,
    );
  }
}

function assertOpen(input: SourceAllowlistInput): void {
  if (input.prState !== "open") {
    reject("PR_NOT_OPEN", `PR #${String(input.prNumber)} state is ${input.prState}`);
  }
}

function assertNoUnrelatedExecutables(files: readonly SourceFileInput[]): void {
  const offenders = files
    .filter((file) => !file.path.endsWith(".sql") && !isInert(file.path))
    .map((file) => file.path);
  if (offenders.length > 0) {
    reject(
      "UNRELATED_CHANGES",
      `executable changes outside the migration: ${offenders.join(", ")}`,
    );
  }
}

function selectMigration(files: readonly SourceFileInput[]): SourceFileInput {
  const sqlFiles = files.filter((file) => file.path.endsWith(".sql"));
  if (sqlFiles.length === 0) reject("NO_SUPPORTED_CHANGE", "no .sql migration file present");
  if (sqlFiles.length > 1) {
    reject("AMBIGUOUS_CHANGE", `multiple .sql files: ${sqlFiles.map((f) => f.path).join(", ")}`);
  }
  const migration = sqlFiles[0];
  if (!migration) reject("NO_SUPPORTED_CHANGE", "no .sql migration file present");
  if (!migration.path.startsWith(allowedMigrationPrefix)) {
    reject(
      "UNRELATED_CHANGES",
      `migration must live under ${allowedMigrationPrefix}, observed ${migration.path}`,
    );
  }
  if (migration.patch.trim().length === 0) reject("MALFORMED_PATCH", "migration patch is empty");
  return migration;
}

function assertExactlyOneCanonicalRename(migration: SourceFileInput): void {
  const added = addedText(migration.patch);
  // A deletion-only patch parses fine; it simply proposes no forward change we support.
  if (added.trim().length === 0) reject("NO_SUPPORTED_CHANGE", "migration patch adds no lines");

  const allRenames = countMatches(added, anyRenameColumn);
  if (allRenames === 0) reject("NO_SUPPORTED_CHANGE", "no RENAME COLUMN statement was added");

  const canonical = countMatches(added, renameStatement);
  if (canonical === 0) {
    reject(
      "UNSUPPORTED_RENAME",
      "the added RENAME COLUMN does not match commerce.orders customer_id -> buyer_id",
    );
  }
  if (canonical > 1) reject("AMBIGUOUS_CHANGE", `${String(canonical)} canonical rename statements`);
  if (allRenames > canonical) {
    reject(
      "AMBIGUOUS_CHANGE",
      `${String(allRenames)} RENAME COLUMN statements, expected exactly 1`,
    );
  }
}

/**
 * Accepts only the canonical scenario and returns the bound envelope.
 *
 * Rejections are typed so the pipeline can distinguish "this PR is not the demo" from "this PR is
 * malformed", and so the failure surfaces a reason instead of a bare null.
 */
export function buildCanonicalSourceEnvelope(input: SourceAllowlistInput): SourceChangeEnvelope {
  assertRepository(input);
  assertOpen(input);
  assertNoUnrelatedExecutables(input.files);
  const migration = selectMigration(input.files);
  assertExactlyOneCanonicalRename(migration);

  const files = [...input.files]
    .map((file) => ({
      path: file.path,
      patchSha256: sha256(file.patch),
      ...(file.blobSha === undefined ? {} : { blobSha: file.blobSha }),
    }))
    .sort((left, right) => left.path.localeCompare(right.path));

  return createSourceChangeEnvelope({
    origin: "GITHUB_PR",
    repository: input.repository,
    prNumber: input.prNumber,
    prUrl: input.prUrl,
    prState: "open",
    baseSha: input.baseSha,
    headSha: input.headSha,
    files,
    selectedPath: migration.path,
    normalizedChange: { ...canonicalNormalizedChange },
  });
}
