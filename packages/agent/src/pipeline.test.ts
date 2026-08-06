import { describe, expect, it, vi } from "vitest";
import { createAgentPipeline } from "./pipeline.js";

describe("createAgentPipeline", () => {
  it("returns a pipeline object with an execute function", () => {
    const mockDatahub = {
      collect: vi.fn(async () => ({
        outcome: "COLLECTED_LIVE",
        context: {
          evidence: [
            {
              entityUrn: "urn:li:dataset:test",
              kind: "DOWNSTREAM_DATASET",
              criticality: "CRITICAL",
              entityName: "Test",
            },
          ],
          fingerprint: "a".repeat(64),
        },
      })),
    };
    const mockLlm = {} as any;

    const pipeline = createAgentPipeline({
      datahub: mockDatahub as any,
      llm: mockLlm,
      workerId: "test",
      clock: () => new Date("2026-08-06T10:00:00Z"),
    });

    expect(pipeline).toBeDefined();
    expect(typeof pipeline.execute).toBe("function");
  });
});
