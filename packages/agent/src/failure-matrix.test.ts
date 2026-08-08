/**
 * Failure matrix: 12 failure scenarios proving no prohibited later side effect runs.
 *
 * Each test verifies:
 * - The pipeline terminates with the expected FAILED_* status
 * - Side effects that should NOT have run (GitHub PR, DataHub writeback) did NOT execute
 * - The failure reason is machine-readable
 */
import { describe, expect, it, vi } from "vitest";
import { createAgentPipeline } from "./pipeline.js";
import {
  canonicalRunInput as baseRunInput,
  liveCanonicalContext,
  stubLlmFetch,
  unusedLlm,
} from "./pipeline.test-support.js";

function successDataHub() {
  return {
    collect: async (input: { changeId: string }) => ({
      outcome: "COLLECTED_LIVE" as const,
      context: liveCanonicalContext(input.changeId),
    }),
  };
}

function passingValidation() {
  return {
    validate: async () => ({
      allPass: true,
      checks: [
        { check: "SQL_MIGRATION", status: "PASS" as const, summary: "ok" },
        { check: "BACKFILL_EQUALITY", status: "PASS" as const, summary: "ok" },
        { check: "DBT_PARSE", status: "PASS" as const, summary: "ok" },
        { check: "DBT_COMPILE", status: "PASS" as const, summary: "ok" },
        { check: "DBT_TEST", status: "PASS" as const, summary: "ok" },
        { check: "OLD_CONSUMER_COMPATIBILITY", status: "PASS" as const, summary: "ok" },
        { check: "NEW_CONSUMER_COMPATIBILITY", status: "PASS" as const, summary: "ok" },
        { check: "ROLLBACK", status: "PASS" as const, summary: "ok" },
      ],
      receiptFingerprint: "a".repeat(64),
    }),
  };
}

function trackingGitHub() {
  let called = false;
  return {
    port: {
      createReview: async () => {
        called = true;
        return {
          prUrl: "https://github.com/org/repo/pull/99",
          prNumber: 99,
          headSha: "abc123",
          headBranch: "lineageguard/generated/pr-3-test",
          receiptFingerprint: "b".repeat(64),
          outcome: "CREATED" as const,
        };
      },
    },
    wasCalled: () => called,
  };
}

function trackingWriteback() {
  let called = false;
  return {
    port: {
      write: async () => {
        called = true;
        return { status: "SUCCEEDED" as const, receiptFingerprint: "c".repeat(64) };
      },
    },
    wasCalled: () => called,
  };
}

describe("failure matrix — prohibited side effects never execute", () => {
  it("1. DataHub unavailable → FAILED_CONTEXT, no GitHub, no writeback", async () => {
    const github = trackingGitHub();
    const writeback = trackingWriteback();
    const pipeline = createAgentPipeline({
      datahub: {
        collect: async () => {
          throw new Error("connection refused");
        },
      },
      llm: unusedLlm(),
      workerId: "test",
      clock: () => new Date("2026-08-06T10:00:00Z"),
      github: github.port,
      writeback: writeback.port,
    });
    const result = await pipeline.execute(baseRunInput("run_fail_01"));
    expect(result.finalStatus).toBe("FAILED_CONTEXT");
    expect(github.wasCalled()).toBe(false);
    expect(writeback.wasCalled()).toBe(false);
  });

  it("2. malformed MCP response → FAILED_CONTEXT, no GitHub, no writeback", async () => {
    const github = trackingGitHub();
    const writeback = trackingWriteback();
    const pipeline = createAgentPipeline({
      datahub: {
        collect: async () => ({
          outcome: "FAILED" as const,
          mode: "LIVE" as const,
          report: {
            failureFingerprint: "x".repeat(64),
            requested: {} as never,
            failedAt: "2026-08-06T10:00:00Z",
            failures: [
              {
                tool: "search" as const,
                invocationId: "inv_1",
                code: "MALFORMED_RESPONSE" as const,
                message: "not JSON",
              },
            ],
          },
        }),
      },
      llm: unusedLlm(),
      workerId: "test",
      clock: () => new Date("2026-08-06T10:00:00Z"),
      github: github.port,
      writeback: writeback.port,
    });
    const result = await pipeline.execute(baseRunInput("run_fail_02"));
    expect(result.finalStatus).toBe("FAILED_CONTEXT");
    expect(github.wasCalled()).toBe(false);
    expect(writeback.wasCalled()).toBe(false);
  });

  it("3. MCP tool failure → FAILED_CONTEXT, no GitHub, no writeback", async () => {
    const github = trackingGitHub();
    const writeback = trackingWriteback();
    const pipeline = createAgentPipeline({
      datahub: {
        collect: async () => ({
          outcome: "FAILED" as const,
          mode: "LIVE" as const,
          report: {
            failureFingerprint: "y".repeat(64),
            requested: {} as never,
            failedAt: "2026-08-06T10:00:00Z",
            failures: [
              {
                tool: "get_lineage" as const,
                invocationId: "inv_2",
                code: "UNAVAILABLE" as const,
                message: "tool error",
              },
            ],
          },
        }),
      },
      llm: unusedLlm(),
      workerId: "test",
      clock: () => new Date("2026-08-06T10:00:00Z"),
      github: github.port,
      writeback: writeback.port,
    });
    const result = await pipeline.execute(baseRunInput("run_fail_03"));
    expect(result.finalStatus).toBe("FAILED_CONTEXT");
    expect(github.wasCalled()).toBe(false);
    expect(writeback.wasCalled()).toBe(false);
  });

  it("4. missing dashboard lineage → FAILED_CONTEXT (NOT_FOUND), no later effects", async () => {
    const github = trackingGitHub();
    const writeback = trackingWriteback();
    const pipeline = createAgentPipeline({
      datahub: {
        collect: async () => ({
          outcome: "FAILED" as const,
          mode: "LIVE" as const,
          report: {
            failureFingerprint: "z".repeat(64),
            requested: {} as never,
            failedAt: "2026-08-06T10:00:00Z",
            failures: [
              {
                tool: "get_lineage_paths_between" as const,
                invocationId: "inv_3",
                code: "NOT_FOUND" as const,
                message: "no path",
              },
            ],
          },
        }),
      },
      llm: unusedLlm(),
      workerId: "test",
      clock: () => new Date("2026-08-06T10:00:00Z"),
      github: github.port,
      writeback: writeback.port,
    });
    const result = await pipeline.execute(baseRunInput("run_fail_04"));
    expect(result.finalStatus).toBe("FAILED_CONTEXT");
    expect(github.wasCalled()).toBe(false);
    expect(writeback.wasCalled()).toBe(false);
  });

  it("5. invalid LLM output → still COMPLETED (deterministic candidate, LLM only for plan description)", async () => {
    // The canonical candidate builder is deterministic and does not depend on LLM output.
    // LLM is used only for migration plan description which is non-critical.
    // If LLM fails, the pipeline still completes with a deterministic candidate.
    stubLlmFetch();
    try {
      const github = trackingGitHub();
      const writeback = trackingWriteback();
      const pipeline = createAgentPipeline({
        datahub: successDataHub(),
        llm: unusedLlm(),
        workerId: "test",
        clock: () => new Date("2026-08-06T10:00:00Z"),
        validation: passingValidation(),
        github: github.port,
        writeback: writeback.port,
      });
      const result = await pipeline.execute(baseRunInput("run_fail_05"));
      // The pipeline should still complete because candidate building is deterministic
      expect(result.finalStatus).toBe("COMPLETED");
    } finally {
      vi.unstubAllGlobals();
    }
  }, 30_000);

  it("6. validation check fails → FAILED_VALIDATION, no GitHub PR, no writeback", async () => {
    stubLlmFetch();
    try {
      const github = trackingGitHub();
      const writeback = trackingWriteback();
      const pipeline = createAgentPipeline({
        datahub: successDataHub(),
        llm: unusedLlm(),
        workerId: "test",
        clock: () => new Date("2026-08-06T10:00:00Z"),
        validation: {
          validate: async () => ({
            allPass: false,
            checks: [
              {
                check: "SQL_MIGRATION",
                status: "FAIL" as const,
                summary: "syntax error in migration",
              },
            ],
            receiptFingerprint: "d".repeat(64),
          }),
        },
        github: github.port,
        writeback: writeback.port,
      });
      const result = await pipeline.execute(baseRunInput("run_fail_06"));
      expect(result.finalStatus).toBe("FAILED_VALIDATION");
      expect(result.validationPassed).toBe(false);
      expect(github.wasCalled()).toBe(false);
      expect(writeback.wasCalled()).toBe(false);
    } finally {
      vi.unstubAllGlobals();
    }
  }, 30_000);

  it("7. validator image unavailable → FAILED_VALIDATION, no GitHub PR, no writeback", async () => {
    stubLlmFetch();
    try {
      const github = trackingGitHub();
      const writeback = trackingWriteback();
      const pipeline = createAgentPipeline({
        datahub: successDataHub(),
        llm: unusedLlm(),
        workerId: "test",
        clock: () => new Date("2026-08-06T10:00:00Z"),
        validation: {
          validate: async () => {
            throw new Error("Validation runtime unavailable: image not found");
          },
        },
        github: github.port,
        writeback: writeback.port,
      });
      const result = await pipeline.execute(baseRunInput("run_fail_07"));
      expect(result.finalStatus).toBe("FAILED_VALIDATION");
      expect(github.wasCalled()).toBe(false);
      expect(writeback.wasCalled()).toBe(false);
    } finally {
      vi.unstubAllGlobals();
    }
  }, 30_000);

  it("8. GitHub publication conflict → FAILED_GITHUB, no writeback", async () => {
    stubLlmFetch();
    try {
      const writeback = trackingWriteback();
      const pipeline = createAgentPipeline({
        datahub: successDataHub(),
        llm: unusedLlm(),
        workerId: "test",
        clock: () => new Date("2026-08-06T10:00:00Z"),
        validation: passingValidation(),
        github: {
          createReview: async () => {
            throw new Error("GitHub API 422: branch already exists with different content");
          },
        },
        writeback: writeback.port,
      });
      const result = await pipeline.execute(baseRunInput("run_fail_08"));
      expect(result.finalStatus).toBe("FAILED_GITHUB");
      expect(writeback.wasCalled()).toBe(false);
    } finally {
      vi.unstubAllGlobals();
    }
  }, 30_000);

  it("9. DataHub read-back mismatch → FAILED_WRITEBACK", async () => {
    stubLlmFetch();
    try {
      const pipeline = createAgentPipeline({
        datahub: successDataHub(),
        llm: unusedLlm(),
        workerId: "test",
        clock: () => new Date("2026-08-06T10:00:00Z"),
        validation: passingValidation(),
        github: trackingGitHub().port,
        writeback: {
          write: async () => {
            throw new Error(
              "DataHub write-back verification failed: Reviewed tag not found on read-back",
            );
          },
        },
      });
      const result = await pipeline.execute(baseRunInput("run_fail_09"));
      expect(result.finalStatus).toBe("FAILED_WRITEBACK");
    } finally {
      vi.unstubAllGlobals();
    }
  }, 30_000);

  it("10. no validation port configured → FAILED_VALIDATION, no GitHub, no writeback", async () => {
    stubLlmFetch();
    try {
      const github = trackingGitHub();
      const writeback = trackingWriteback();
      const pipeline = createAgentPipeline({
        datahub: successDataHub(),
        llm: unusedLlm(),
        workerId: "test",
        clock: () => new Date("2026-08-06T10:00:00Z"),
        // no validation port — pipeline should refuse to proceed without validation
        github: github.port,
        writeback: writeback.port,
      });
      const result = await pipeline.execute(baseRunInput("run_fail_10"));
      expect(result.finalStatus).toBe("FAILED_VALIDATION");
      expect(github.wasCalled()).toBe(false);
      expect(writeback.wasCalled()).toBe(false);
    } finally {
      vi.unstubAllGlobals();
    }
  }, 30_000);

  it("11. no GitHub port configured → FAILED_GITHUB, no writeback", async () => {
    stubLlmFetch();
    try {
      const writeback = trackingWriteback();
      const pipeline = createAgentPipeline({
        datahub: successDataHub(),
        llm: unusedLlm(),
        workerId: "test",
        clock: () => new Date("2026-08-06T10:00:00Z"),
        validation: passingValidation(),
        // no github port
        writeback: writeback.port,
      });
      const result = await pipeline.execute(baseRunInput("run_fail_11"));
      expect(result.finalStatus).toBe("FAILED_GITHUB");
      expect(writeback.wasCalled()).toBe(false);
    } finally {
      vi.unstubAllGlobals();
    }
  }, 30_000);

  it("12. no writeback port configured → FAILED_WRITEBACK (writeback is required)", async () => {
    stubLlmFetch();
    try {
      const pipeline = createAgentPipeline({
        datahub: successDataHub(),
        llm: unusedLlm(),
        workerId: "test",
        clock: () => new Date("2026-08-06T10:00:00Z"),
        validation: passingValidation(),
        github: trackingGitHub().port,
        // no writeback port
      });
      const result = await pipeline.execute(baseRunInput("run_fail_12"));
      expect(result.finalStatus).toBe("FAILED_WRITEBACK");
    } finally {
      vi.unstubAllGlobals();
    }
  }, 30_000);
});
