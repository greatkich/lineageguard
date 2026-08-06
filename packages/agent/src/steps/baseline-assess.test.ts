import { canonicalDatasetRef, parseProposedChange } from "@lineageguard/domain";
import { describe, expect, it } from "vitest";
import { baselineAssess } from "./baseline-assess.js";
import type { StepContext } from "./index.js";

const mockCtx: StepContext = {
  runId: "run_000000000000000000000001",
  workerId: "test-worker",
  llm: {} as StepContext["llm"],
  datahub: {} as StepContext["datahub"],
  clock: () => new Date("2026-08-06T10:00:00Z"),
};

function fixtureChange() {
  const result = parseProposedChange({
    source: "FIXTURE",
    repository: "greatkich/lineageguard",
    baseSha: "a".repeat(40),
    headSha: "b".repeat(40),
    files: [
      {
        path: "walkthrough/migrations/001_rename_customer_id.sql",
        datasetRef: canonicalDatasetRef,
        patch: "ALTER TABLE commerce.orders RENAME COLUMN customer_id TO buyer_id;",
      },
    ],
  });
  if (!result.ok) throw new Error("Fixture change failed to parse");
  return result.value;
}

describe("baselineAssess", () => {
  it("returns ALLOW with LOW risk for repo-only context", async () => {
    const change = fixtureChange();
    const result = await baselineAssess(mockCtx, change);
    expect(result.baseline.decision).toBe("ALLOW");
    expect(result.baseline.risk).toBe("LOW");
    expect(result.baseline.contextMode).toBe("REPOSITORY_ONLY");
    expect(result.baseline.reasons).toHaveLength(0);
  });
});
