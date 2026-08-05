import { GitHubEffectError } from "./errors.js";
import { sha256Bytes, sha256CanonicalJson } from "./hash.js";
import type {
  CanonicalGitHubEffect,
  GitHubEffectAuthorization,
  GitHubReviewRequest,
  LiveGitHubOptions,
} from "./types.js";
import { deterministicHead } from "./validation.js";

export function renderPullRequestBody(input: GitHubReviewRequest): string {
  return [
    `<!-- lineageguard-effect:${input.intentFingerprint} -->`,
    input.body.summary,
    "",
    `Candidate: ${input.candidateFingerprint}`,
    `Validated artifacts: ${input.artifactSetFingerprint}`,
    `Validation receipt: ${input.validationReceiptFingerprint}`,
    "",
    "Evidence",
    ...input.body.reasonEvidenceIds.map((id) => `- ${id}`),
    "",
    "Rollout",
    ...input.body.rolloutSteps.map((step) => `- ${step}`),
    "",
    "Rollback",
    ...input.body.rollbackSteps.map((step) => `- ${step}`),
  ].join("\n");
}

export function canonicalGitHubEffect(
  input: GitHubReviewRequest,
  apiBaseUrl: "https://api.github.com" = "https://api.github.com",
): CanonicalGitHubEffect {
  const observations = new Map(
    input.validation.artifacts.map((artifact) => [artifact.path, artifact]),
  );
  return {
    schemaVersion: 1,
    reservationId: input.effectReservationId,
    runId: input.runId,
    effectKind: input.effectKind,
    apiBaseUrl,
    repository: input.repository,
    baseBranch: input.baseBranch,
    baseSha: input.baseSha,
    headBranch: deterministicHead(input.runId),
    target: input.target,
    idempotencyKey: input.idempotencyKey,
    intentFingerprint: input.intentFingerprint,
    candidateFingerprint: input.candidateFingerprint,
    artifactSetFingerprint: input.artifactSetFingerprint,
    validationReceiptFingerprint: input.validationReceiptFingerprint,
    approvalFingerprint: input.approvalFingerprint,
    artifacts: input.artifacts.map((artifact) => ({
      path: artifact.path,
      operation: artifact.operation,
      expectedBaseBlobSha: artifact.operation === "MODIFY" ? artifact.expectedBaseBlobSha : null,
      candidateArtifactFingerprint: artifact.candidateArtifactFingerprint,
      materializedSha256:
        observations.get(artifact.path)?.materializedSha256 ?? sha256Bytes(artifact.content),
    })),
    pullRequest: { title: input.title, body: renderPullRequestBody(input) },
  };
}

export function githubEffectFingerprint(
  input: GitHubReviewRequest,
  apiBaseUrl: "https://api.github.com" = "https://api.github.com",
): string {
  return sha256CanonicalJson(canonicalGitHubEffect(input, apiBaseUrl));
}

export async function resolveAuthorization(input: GitHubReviewRequest, options: LiveGitHubOptions) {
  const computed = githubEffectFingerprint(input, options.apiBaseUrl);
  let authorized: GitHubEffectAuthorization;
  try {
    authorized = await options.authority.verifyCurrentEffectReservation({
      canonicalEffectFingerprint: computed,
    });
  } catch {
    throw new GitHubEffectError({
      code: "AUTHORIZATION_REJECTED",
      operation: "VERIFY_REPOSITORY",
      retry: "NEVER",
      message: "Trusted effect reservation could not be resolved",
    });
  }
  if (
    authorized.reservationId !== input.effectReservationId ||
    authorized.canonicalEffectFingerprint !== computed ||
    (authorized.state !== "RESERVED" && authorized.state !== "CONSUMED") ||
    !validInvokeBy(authorized.invokeBy) ||
    input.inputFingerprint !== computed
  ) {
    throw new GitHubEffectError({
      code: "AUTHORIZATION_REJECTED",
      operation: "VERIFY_REPOSITORY",
      retry: "NEVER",
      message: "Trusted effect reservation does not authorize this canonical GitHub effect",
    });
  }
  return authorized;
}

export function validInvokeBy(value: string): boolean {
  const invokeBy = Date.parse(value);
  return (
    Number.isFinite(invokeBy) &&
    new Date(invokeBy).toISOString() === value &&
    invokeBy >= Date.now() &&
    invokeBy <= Date.now() + 300_000
  );
}
