import { describe, expect, it } from "vitest";
import { parseUntrustedReplayReceipts } from "./replay-adapter.js";
import type { GitHubReviewReceipt } from "./types.js";

const sha = (value: string) => value.repeat(40);
const fp = (value: string) => value.repeat(64);
const target = `https://api.github.com/repos/lineageguard/demo/git/ref/heads/main#${sha("a")}`;
const receipt: GitHubReviewReceipt = {
  schemaVersion: 1,
  mode: "LIVE",
  effectKind: "GITHUB_WRITE",
  target,
  repository: "lineageguard/demo",
  baseBranch: "main",
  baseSha: sha("a"),
  headBranch: "lineageguard/run_0123456789abcdef01234567",
  headSha: sha("e"),
  prNumber: 17,
  prUrl: "https://github.com/lineageguard/demo/pull/17",
  prState: "OPEN_DRAFT",
  createdAt: "2026-08-04T12:00:00.000Z",
  updatedAt: "2026-08-04T12:00:00.000Z",
  candidateFingerprint: fp("2"),
  artifactSetFingerprint: fp("3"),
  validationReceiptFingerprint: fp("4"),
  approvalFingerprint: fp("6"),
  intentFingerprint: fp("1"),
  idempotencyKey: "github:run_0123456789abcdef01234567:review",
  inputFingerprint: fp("7"),
  reconciled: false,
  outcome: "CREATED",
};
const expected = {
  repository: receipt.repository,
  baseBranch: receipt.baseBranch,
  baseSha: receipt.baseSha,
  target: receipt.target,
  effectKind: receipt.effectKind,
  intentFingerprint: receipt.intentFingerprint,
  idempotencyKey: receipt.idempotencyKey,
  inputFingerprint: receipt.inputFingerprint,
  candidateFingerprint: receipt.candidateFingerprint,
  artifactSetFingerprint: receipt.artifactSetFingerprint,
  validationReceiptFingerprint: receipt.validationReceiptFingerprint,
  approvalFingerprint: receipt.approvalFingerprint,
};

describe("staged replay receipt parser", () => {
  it("parses one exact target-bound live receipt without exposing a replay port", () => {
    expect(parseUntrustedReplayReceipts([receipt], expected)).toEqual([receipt]);
  });

  it.each([
    ["tamper", { approvalFingerprint: fp("f") }, { ...expected }],
    ["wrong target", {}, { ...expected, target: `${target}-wrong` }],
  ])("rejects %s", (_name, change, binding) => {
    expect(() => parseUntrustedReplayReceipts([{ ...receipt, ...change }], binding)).toThrow();
  });

  it("rejects duplicate exact effect receipts", () => {
    expect(() => parseUntrustedReplayReceipts([receipt, receipt], expected)).toThrow();
  });
});
