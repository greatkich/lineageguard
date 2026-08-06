import { canonicalDatasetRef, parseProposedChange } from "@lineageguard/domain";
import type { ParseChangeResult, StepContext } from "./index.js";

export interface ParseChangeInput {
  repository: string;
  baseSha: string;
  headSha: string;
  patch: string;
  /** When set, the change was read from a real GitHub PR */
  source?: "GITHUB" | "FIXTURE" | undefined;
  /** Original file path from the PR diff */
  sourcePath?: string | undefined;
}

export async function parseChange(
  _ctx: StepContext,
  input: ParseChangeInput,
): Promise<ParseChangeResult> {
  const source = input.source ?? "FIXTURE";
  const filePath = input.sourcePath ?? "walkthrough/migrations/001_rename_customer_id.sql";

  const result = parseProposedChange({
    source,
    repository: input.repository,
    baseSha: input.baseSha,
    headSha: input.headSha,
    files: [
      {
        path: filePath,
        datasetRef: canonicalDatasetRef,
        patch: input.patch,
      },
    ],
  });

  if (!result.ok) {
    throw new Error(`Failed to parse proposed change: ${result.error.message}`);
  }

  return { change: result.value };
}
