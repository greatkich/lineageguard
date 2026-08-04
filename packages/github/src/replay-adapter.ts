import { GitHubEffectError } from "./errors.js";
import type { GitHubPort, GitHubReplayRequest, GitHubReviewReceipt } from "./types.js";

export class ReplayGitHubPort implements GitHubPort<GitHubReplayRequest> {
  private readonly receipts: readonly GitHubReviewReceipt[];
  constructor(receipts: readonly GitHubReviewReceipt[]) {
    this.receipts = structuredClone(receipts);
    for (const receipt of this.receipts) validateReplayReceipt(receipt);
  }
  async createMigrationReview(input: GitHubReplayRequest): Promise<GitHubReviewReceipt> {
    const found = this.receipts.find(
      (receipt) =>
        receipt.mode === "LIVE" &&
        receipt.headBranch === `lineageguard/${input.runId}` &&
        receipt.inputFingerprint === input.inputFingerprint &&
        receipt.candidateFingerprint === input.candidateFingerprint &&
        receipt.artifactSetFingerprint === input.artifactSetFingerprint &&
        receipt.validationReceiptFingerprint === input.validationReceiptFingerprint,
    );
    if (!found)
      throw new GitHubEffectError({
        code: "REPLAY_RECEIPT_NOT_FOUND",
        operation: "RECONCILE",
        retry: "NEVER",
        message: "No exact validated live GitHub receipt exists for replay",
      });
    return { ...structuredClone(found), mode: "REPLAY", reconciled: true };
  }
}

const fingerprint = /^[a-f0-9]{64}$/;
const sha = /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/;
const runHead = /^lineageguard\/run_[a-f0-9]{24}$/;
const repository = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;

function canonicalTimestamp(value: string): boolean {
  const timestamp = Date.parse(value);
  return Number.isFinite(timestamp) && new Date(timestamp).toISOString() === value;
}

function validateReplayReceipt(receipt: GitHubReviewReceipt): void {
  const expectedUrl = `https://github.com/${receipt.repository}/pull/${receipt.prNumber}`;
  if (
    receipt.schemaVersion !== 1 ||
    receipt.mode !== "LIVE" ||
    !repository.test(receipt.repository) ||
    !receipt.baseBranch ||
    !sha.test(receipt.baseSha) ||
    !runHead.test(receipt.headBranch) ||
    !sha.test(receipt.headSha) ||
    !Number.isSafeInteger(receipt.prNumber) ||
    receipt.prNumber <= 0 ||
    receipt.prUrl !== expectedUrl ||
    receipt.prState !== "OPEN_DRAFT" ||
    !canonicalTimestamp(receipt.createdAt) ||
    !canonicalTimestamp(receipt.updatedAt) ||
    !fingerprint.test(receipt.candidateFingerprint) ||
    !fingerprint.test(receipt.artifactSetFingerprint) ||
    !fingerprint.test(receipt.validationReceiptFingerprint) ||
    !fingerprint.test(receipt.inputFingerprint) ||
    typeof receipt.reconciled !== "boolean"
  ) {
    throw new GitHubEffectError({
      code: "INVALID_INPUT",
      operation: "RECONCILE",
      retry: "NEVER",
      message: "Committed GitHub replay receipt is not normalized",
    });
  }
}
