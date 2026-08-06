import { canonicalDatasetRef, parseProposedChange } from "@lineageguard/domain";
import type { ParseChangeResult, StepContext } from "./index.js";

export interface ParseChangeInput {
  repository: string;
  baseSha: string;
  headSha: string;
  patch: string;
}

export async function parseChange(
  _ctx: StepContext,
  input: ParseChangeInput,
): Promise<ParseChangeResult> {
  const result = parseProposedChange({
    source: "FIXTURE",
    repository: input.repository,
    baseSha: input.baseSha,
    headSha: input.headSha,
    files: [
      {
        path: "walkthrough/migrations/001_rename_customer_id.sql",
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
