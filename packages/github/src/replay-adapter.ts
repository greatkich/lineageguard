import { GitHubEffectError } from "./errors.js";
import type { GitHubReviewReceipt } from "./types.js";

// Deliberately not exported from the package root. This is only a structural parser for a future
// committed, externally authenticated live fixture. It does not establish authenticity and must
// not be wired into a production composition root.
export function parseUntrustedReplayReceipts(
  values: readonly unknown[],
  expected: {
    repository: string;
    baseBranch: string;
    baseSha: string;
    target: string;
    effectKind: "GITHUB_WRITE";
    intentFingerprint: string;
    idempotencyKey: string;
    inputFingerprint: string;
    candidateFingerprint: string;
    artifactSetFingerprint: string;
    validationReceiptFingerprint: string;
    approvalFingerprint: string;
  },
): readonly GitHubReviewReceipt[] {
  if (values.length < 1 || values.length > 100) reject("Replay fixture receipt count is invalid");
  const receipts = values.map(parseReceipt);
  const identities = new Set<string>();
  for (const receipt of receipts) {
    if (
      receipt.repository !== expected.repository ||
      receipt.baseBranch !== expected.baseBranch ||
      receipt.baseSha !== expected.baseSha ||
      receipt.target !== expected.target ||
      receipt.effectKind !== expected.effectKind ||
      receipt.intentFingerprint !== expected.intentFingerprint ||
      receipt.idempotencyKey !== expected.idempotencyKey ||
      receipt.inputFingerprint !== expected.inputFingerprint ||
      receipt.candidateFingerprint !== expected.candidateFingerprint ||
      receipt.artifactSetFingerprint !== expected.artifactSetFingerprint ||
      receipt.validationReceiptFingerprint !== expected.validationReceiptFingerprint ||
      receipt.approvalFingerprint !== expected.approvalFingerprint
    )
      reject("Replay receipt is not bound to the exact authorized target and intent");
    const identity = `${receipt.effectKind}:${receipt.idempotencyKey}:${receipt.intentFingerprint}`;
    if (identities.has(identity)) reject("Replay fixture contains duplicate effect receipts");
    identities.add(identity);
  }
  return receipts;
}

function reject(message: string): never {
  throw new GitHubEffectError({
    code: "INVALID_INPUT",
    operation: "RECONCILE",
    retry: "NEVER",
    message,
  });
}

const fingerprint = /^[a-f0-9]{64}$/;
const sha = /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/;
const runHead = /^lineageguard\/run_[a-f0-9]{24}$/;
const repository = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;

function parseReceipt(value: unknown): GitHubReviewReceipt {
  if (!value || typeof value !== "object" || Array.isArray(value))
    reject("Replay receipt is malformed");
  const receipt = value as GitHubReviewReceipt;
  const expectedUrl = `https://github.com/${receipt.repository}/pull/${receipt.prNumber}`;
  const canonicalTimestamp = (timestamp: string) => {
    const time = Date.parse(timestamp);
    return Number.isFinite(time) && new Date(time).toISOString() === timestamp;
  };
  if (
    receipt.schemaVersion !== 1 ||
    receipt.mode !== "LIVE" ||
    receipt.effectKind !== "GITHUB_WRITE" ||
    typeof receipt.target !== "string" ||
    receipt.target.length > 500 ||
    !repository.test(receipt.repository) ||
    typeof receipt.baseBranch !== "string" ||
    receipt.baseBranch.length > 240 ||
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
    !fingerprint.test(receipt.approvalFingerprint) ||
    !fingerprint.test(receipt.intentFingerprint) ||
    !fingerprint.test(receipt.inputFingerprint) ||
    typeof receipt.idempotencyKey !== "string" ||
    receipt.idempotencyKey.length > 240 ||
    typeof receipt.reconciled !== "boolean" ||
    !["CREATED", "UPDATED", "SKIPPED_EXACT"].includes(receipt.outcome)
  )
    reject("Replay receipt is not normalized");
  return structuredClone(receipt);
}
