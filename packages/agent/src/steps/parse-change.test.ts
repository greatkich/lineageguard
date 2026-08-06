import { describe, expect, it } from "vitest";
import type { StepContext } from "./index.js";
import { parseChange } from "./parse-change.js";

const mockCtx: StepContext = {
  runId: "run_000000000000000000000001",
  workerId: "test-worker",
  llm: {} as StepContext["llm"],
  datahub: {} as StepContext["datahub"],
  clock: () => new Date("2026-08-06T10:00:00Z"),
};

describe("parseChange", () => {
  it("parses a valid rename patch into ProposedChange", async () => {
    const result = await parseChange(mockCtx, {
      repository: "greatkich/lineageguard",
      baseSha: "a".repeat(40),
      headSha: "b".repeat(40),
      patch: "ALTER TABLE commerce.orders RENAME COLUMN customer_id TO buyer_id;",
    });
    expect(result.change.files).toHaveLength(1);
    expect(result.change.source).toBe("FIXTURE");
  });

  it("rejects invalid repository format", async () => {
    await expect(
      parseChange(mockCtx, {
        repository: "invalid",
        baseSha: "a".repeat(40),
        headSha: "b".repeat(40),
        patch: "ALTER TABLE commerce.orders RENAME COLUMN customer_id TO buyer_id;",
      }),
    ).rejects.toThrow();
  });
});
