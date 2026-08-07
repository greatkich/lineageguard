import { describe, expect, it } from "vitest";
import { parseUntrustedReplayReceipts } from "./replay-adapter.js";
import type { GitHubReviewReceipt } from "./types.js";
import { deterministicHead } from "./validation.js";

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
  headBranch: deterministicHead(fp("2"), 17),
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

  // Regression: the parser enforced the pre-content-addressing `lineageguard/run_<id>` head, so it
  // rejected every head the live adapter actually emits. Both shapes must be accepted.
  it.each([
    ["with a source PR segment", deterministicHead(fp("2"), 17)],
    ["without a source PR segment", deterministicHead(fp("2"))],
  ])("accepts the content-addressed generated head %s", (_label, headBranch) => {
    expect(parseUntrustedReplayReceipts([{ ...receipt, headBranch }], expected)).toEqual([
      { ...receipt, headBranch },
    ]);
  });

  it.each([
    ["a run-scoped head", "lineageguard/run_0123456789abcdef01234567"],
    ["a foreign namespace", "attacker/generated/222222222222"],
    ["a non-hex prefix", "lineageguard/generated/zzzzzzzzzzzz"],
    ["a traversal segment", "lineageguard/generated/../222222222222"],
  ])("rejects %s", (_label, headBranch) => {
    expect(() => parseUntrustedReplayReceipts([{ ...receipt, headBranch }], expected)).toThrow();
  });

  it.each(["CREATED", "UPDATED", "SKIPPED_EXACT"] as const)("accepts outcome %s", (outcome) => {
    expect(parseUntrustedReplayReceipts([{ ...receipt, outcome }], expected)).toEqual([
      { ...receipt, outcome },
    ]);
  });

  it.each([["missing", undefined], ["unknown", "DELETED"]] as const)(
    "rejects %s outcome",
    (_label, outcome) => {
      expect(() =>
        parseUntrustedReplayReceipts(
          [{ ...receipt, outcome: outcome as never }],
          expected,
        ),
      ).toThrow();
    },
  );
});
