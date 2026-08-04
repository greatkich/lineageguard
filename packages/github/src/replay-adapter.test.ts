import { describe, expect, it } from "vitest";
import { type GitHubReviewReceipt, ReplayGitHubPort } from "./index.js";

const receipt: GitHubReviewReceipt = {
  schemaVersion: 1,
  mode: "LIVE",
  repository: "lineageguard/demo",
  baseBranch: "main",
  baseSha: "a".repeat(40),
  headBranch: "lineageguard/run_0123456789abcdef01234567",
  headSha: "e".repeat(40),
  prNumber: 17,
  prUrl: "https://github.com/lineageguard/demo/pull/17",
  prState: "OPEN_DRAFT",
  createdAt: "2026-08-04T12:00:00.000Z",
  updatedAt: "2026-08-04T12:00:00.000Z",
  candidateFingerprint: "2".repeat(64),
  artifactSetFingerprint: "3".repeat(64),
  validationReceiptFingerprint: "4".repeat(64),
  inputFingerprint: "1".repeat(64),
  reconciled: false,
};

describe("ReplayGitHubPort", () => {
  it("returns only the exact committed live receipt with zero network dependency", async () => {
    const replay = new ReplayGitHubPort([receipt]);
    await expect(
      replay.createMigrationReview({
        runId: "run_0123456789abcdef01234567",
        inputFingerprint: "1".repeat(64),
        candidateFingerprint: "2".repeat(64),
        artifactSetFingerprint: "3".repeat(64),
        validationReceiptFingerprint: "4".repeat(64),
      }),
    ).resolves.toEqual({ ...receipt, mode: "REPLAY", reconciled: true });
  });

  it("fails closed when replay binding differs", async () => {
    const replay = new ReplayGitHubPort([receipt]);
    await expect(
      replay.createMigrationReview({
        runId: "run_0123456789abcdef01234567",
        inputFingerprint: "f".repeat(64),
        candidateFingerprint: "2".repeat(64),
        artifactSetFingerprint: "3".repeat(64),
        validationReceiptFingerprint: "4".repeat(64),
      }),
    ).rejects.toMatchObject({ code: "REPLAY_RECEIPT_NOT_FOUND", retry: "NEVER" });
  });

  it("rejects a non-draft or malformed committed receipt at construction", () => {
    expect(
      () => new ReplayGitHubPort([{ ...receipt, prState: "OPEN" as "OPEN_DRAFT" }]),
    ).toThrowError(expect.objectContaining({ code: "INVALID_INPUT", retry: "NEVER" }));
  });
});
