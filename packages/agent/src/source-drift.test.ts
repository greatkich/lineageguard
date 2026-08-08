import {
  buildCanonicalSourceEnvelope,
  type SourceAllowlistInput,
  type SourceChangeEnvelope,
} from "@lineageguard/domain";
import { describe, expect, it, vi } from "vitest";
import { createAgentPipeline, type RunInput } from "./pipeline.js";
import {
  canonicalPipelineConfig,
  canonicalRunInput,
  stubLlmFetch,
} from "./pipeline.test-support.js";

const canonicalPatch = [
  "@@ -0,0 +1,2 @@",
  "+ALTER TABLE commerce.orders RENAME COLUMN customer_id TO buyer_id;",
  "+",
].join("\n");

function envelopeInput(overrides: Partial<SourceAllowlistInput> = {}): SourceAllowlistInput {
  return {
    repository: "greatkich/lineageguard",
    expectedRepository: "greatkich/lineageguard",
    prNumber: 3,
    prUrl: "https://github.com/greatkich/lineageguard/pull/3",
    prState: "open",
    baseSha: "a".repeat(40),
    headSha: "b".repeat(40),
    files: [{ path: "walkthrough/migrations/001_rename.sql", patch: canonicalPatch }],
    ...overrides,
  };
}

const analysed: SourceChangeEnvelope = buildCanonicalSourceEnvelope(envelopeInput());

function runInputWithSource(
  runId: string,
  reattest: () => Promise<SourceChangeEnvelope>,
): RunInput {
  return { ...canonicalRunInput(runId), sourceEnvelope: analysed, reattestSource: reattest };
}

describe("source drift checkpoints", () => {
  it("completes when the live source still matches the analysed identity", async () => {
    stubLlmFetch();
    try {
      const reattest = vi.fn(async () => buildCanonicalSourceEnvelope(envelopeInput()));
      const pipeline = createAgentPipeline(canonicalPipelineConfig());

      const result = await pipeline.execute(
        runInputWithSource("run_drift_none_000000000001", reattest),
      );

      expect(result.finalStatus).toBe("COMPLETED");
      // Once before validation, once before publication.
      expect(reattest).toHaveBeenCalledTimes(2);
    } finally {
      vi.unstubAllGlobals();
    }
  }, 30_000);

  it("fails validation when the head SHA moves before validation", async () => {
    stubLlmFetch();
    try {
      const moved = buildCanonicalSourceEnvelope(envelopeInput({ headSha: "c".repeat(40) }));
      const reattest = vi.fn(async () => moved);
      const pipeline = createAgentPipeline(canonicalPipelineConfig());

      const result = await pipeline.execute(
        runInputWithSource("run_drift_validate_00000001", reattest),
      );

      expect(result.finalStatus).toBe("FAILED_VALIDATION");
      expect(result.prUrl).toBeFalsy();
      expect(result.writebackStatus).toBeFalsy();
      expect(reattest).toHaveBeenCalledTimes(1);
    } finally {
      vi.unstubAllGlobals();
    }
  }, 30_000);

  it("does not publish when the patch changes between validation and publication", async () => {
    stubLlmFetch();
    try {
      const drifted = buildCanonicalSourceEnvelope(
        envelopeInput({
          files: [
            {
              path: "walkthrough/migrations/001_rename.sql",
              patch: `${canonicalPatch}\n+-- an unexpected extra line`,
            },
          ],
        }),
      );
      let call = 0;
      const reattest = vi.fn(async () => {
        call += 1;
        return call === 1 ? buildCanonicalSourceEnvelope(envelopeInput()) : drifted;
      });
      const createReview = vi.fn(async () => ({
        prUrl: "https://github.com/org/walkthrough/pull/99",
        prNumber: 99,
        headSha: "c".repeat(40),
        headBranch: "lineageguard/buyer-id-migration",
        receiptFingerprint: "sha256:gh-receipt",
        outcome: "CREATED" as const,
      }));
      const pipeline = createAgentPipeline({
        ...canonicalPipelineConfig(),
        github: { createReview },
      });

      const result = await pipeline.execute(
        runInputWithSource("run_drift_publish_000000001", reattest),
      );

      expect(result.finalStatus).toBe("FAILED_GITHUB");
      expect(createReview).not.toHaveBeenCalled();
      expect(result.validationPassed).toBe(true);
      expect(reattest).toHaveBeenCalledTimes(2);
    } finally {
      vi.unstubAllGlobals();
    }
  }, 30_000);

  it("skips the checkpoints for a fixture run with no bound source", async () => {
    stubLlmFetch();
    try {
      const reattest = vi.fn(async () => analysed);
      const pipeline = createAgentPipeline(canonicalPipelineConfig());

      const result = await pipeline.execute(canonicalRunInput("run_drift_fixture_00000001"));

      expect(result.finalStatus).toBe("COMPLETED");
      expect(reattest).not.toHaveBeenCalled();
    } finally {
      vi.unstubAllGlobals();
    }
  }, 30_000);
});
