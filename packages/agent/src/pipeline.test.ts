import { describe, expect, it, vi } from "vitest";
import { createAgentPipeline } from "./pipeline.js";
import {
  canonicalPipelineConfig,
  canonicalRunInput as baseRunInput,
  liveCanonicalContext,
  passingValidationChecks,
  stubLlmFetch,
  unusedLlm,
} from "./pipeline.test-support.js";

describe("Full pipeline to COMPLETED", () => {
  it("reaches COMPLETED with mocked external ports", async () => {
    stubLlmFetch();
    try {
      const events: Array<{ status: string; extra?: Record<string, unknown> }> = [];
      const pipeline = createAgentPipeline({
        datahub: {
          collect: async (input) => ({
            outcome: "COLLECTED_LIVE",
            context: liveCanonicalContext(input.changeId),
          }),
        },
        llm: unusedLlm(),
        workerId: "test-worker",
        clock: () => new Date("2026-08-06T10:00:00.000Z"),
        validation: {
          validate: async () => ({
            allPass: true,
            checks: [
              "SQL_MIGRATION",
              "BACKFILL_EQUALITY",
              "DBT_PARSE",
              "DBT_COMPILE",
              "DBT_TEST",
              "OLD_CONSUMER_COMPATIBILITY",
              "NEW_CONSUMER_COMPATIBILITY",
              "ROLLBACK",
            ].map((check) => ({ check, status: "PASS" as const, summary: `${check} passed` })),
            receiptFingerprint: "sha256:val-receipt",
          }),
        },
        github: {
          createReview: async () => ({
            prUrl: "https://github.com/org/walkthrough/pull/99",
            prNumber: 99,
            headSha: "c".repeat(40),
            headBranch: "lineageguard/buyer-id-migration",
            receiptFingerprint: "sha256:gh-receipt",
          }),
        },
        writeback: {
          write: async () => ({ status: "SUCCEEDED", receiptFingerprint: "sha256:wb-receipt" }),
        },
        onStatusChange: async (_runId, status, extra) => {
          events.push({ status, ...(extra !== undefined ? { extra } : {}) });
        },
      });

      const result = await pipeline.execute(baseRunInput("run_e2e_completed_0000000001"));

      expect(result.finalStatus).toBe("COMPLETED");
      expect(result.baselineDecision).toBe("ALLOW");
      expect(result.groundedDecision).toBe("BLOCK");
      expect(result.consumersFound).toBe(4);
      expect(result.validationPassed).toBe(true);
      expect(result.prUrl).toBe("https://github.com/org/walkthrough/pull/99");
      expect(result.writebackStatus).toBe("SUCCEEDED");
      expect(events.map((event) => event.status)).toEqual([
        "CHANGE_PARSED",
        "BASELINE_ASSESSED",
        "CONTEXT_COLLECTING",
        "CONTEXT_COLLECTED",
        "RISK_DECIDED",
        "MIGRATION_PLANNED",
        "PATCH_GENERATED",
        "VALIDATED",
        "REVIEW_ARTIFACT_CREATED",
        "WRITEBACK_PENDING",
        "COMPLETED",
      ]);
    } finally {
      vi.unstubAllGlobals();
    }
  }, 30_000);

  it("returns FAILED_CONTEXT when the DataHub port throws", async () => {
    const pipeline = createAgentPipeline({
      datahub: {
        collect: async () => {
          throw new Error("DataHub is unreachable");
        },
      },
      llm: unusedLlm(),
      workerId: "test-worker",
      clock: () => new Date("2026-08-06T10:00:00.000Z"),
    });

    const result = await pipeline.execute(baseRunInput("run_e2e_failed_context_00001"));

    expect(result.finalStatus).toBe("FAILED_CONTEXT");
  });

  it("returns FAILED_VALIDATION when a validation check fails", async () => {
    stubLlmFetch();
    try {
      const pipeline = createAgentPipeline({
        datahub: {
          collect: async (input) => ({
            outcome: "COLLECTED_LIVE",
            context: liveCanonicalContext(input.changeId),
          }),
        },
        llm: unusedLlm(),
        workerId: "test-worker",
        clock: () => new Date("2026-08-06T10:00:00.000Z"),
        validation: {
          validate: async () => ({
            allPass: false,
            checks: [{ check: "SQL_MIGRATION", status: "FAIL" as const, summary: "syntax error" }],
            receiptFingerprint: "sha256:failed-receipt",
          }),
        },
      });

      const result = await pipeline.execute(baseRunInput("run_e2e_failed_validation_001"));

      expect(result.finalStatus).toBe("FAILED_VALIDATION");
      expect(result.validationPassed).toBe(false);
    } finally {
      vi.unstubAllGlobals();
    }
  }, 30_000);

  it("returns FAILED_GITHUB when no GitHub port is configured", async () => {
    stubLlmFetch();
    try {
      const pipeline = createAgentPipeline({
        datahub: {
          collect: async (input) => ({
            outcome: "COLLECTED_LIVE",
            context: liveCanonicalContext(input.changeId),
          }),
        },
        llm: unusedLlm(),
        workerId: "test-worker",
        clock: () => new Date("2026-08-06T10:00:00.000Z"),
        validation: {
          validate: async () => ({
            allPass: true,
            checks: [{ check: "SQL_MIGRATION", status: "PASS" as const, summary: "ok" }],
            receiptFingerprint: "sha256:val-receipt",
          }),
        },
      });

      const result = await pipeline.execute(baseRunInput("run_e2e_failed_github_00001"));

      expect(result.finalStatus).toBe("FAILED_GITHUB");
    } finally {
      vi.unstubAllGlobals();
    }
  }, 30_000);
});
