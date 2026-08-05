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
    authorized = await withAuthorityDeadline(
      (signal) =>
        options.authority.verifyCurrentEffectReservation({
          canonicalEffectFingerprint: computed,
          signal,
        }),
      options.timeoutMs,
    );
  } catch {
    throw new GitHubEffectError({
      code: "AUTHORIZATION_REJECTED",
      operation: "VERIFY_REPOSITORY",
      retry: "NEVER",
      message: "Trusted effect reservation could not be resolved",
    });
  }
  if (
    !isVerifiedAuthorization(authorized) ||
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

function exactDataObject(
  value: unknown,
  keys: readonly string[],
): value is Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) return false;
  const ownKeys = Reflect.ownKeys(value);
  return (
    ownKeys.length === keys.length &&
    ownKeys.every((key) => {
      if (typeof key !== "string" || !keys.includes(key)) return false;
      const descriptor = Object.getOwnPropertyDescriptor(value, key);
      return descriptor !== undefined && "value" in descriptor;
    })
  );
}

function isVerifiedAuthorization(value: unknown): value is GitHubEffectAuthorization {
  return (
    exactDataObject(value, ["reservationId", "canonicalEffectFingerprint", "state", "invokeBy"]) &&
    typeof value.reservationId === "string" &&
    typeof value.canonicalEffectFingerprint === "string" &&
    (value.state === "RESERVED" || value.state === "CONSUMED") &&
    typeof value.invokeBy === "string"
  );
}

export function isConsumedAuthorization(value: unknown): value is {
  canonicalEffectFingerprint: string;
  invokeBy: string;
  attemptFence: string;
} {
  return (
    exactDataObject(value, ["canonicalEffectFingerprint", "invokeBy", "attemptFence"]) &&
    typeof value.canonicalEffectFingerprint === "string" &&
    typeof value.invokeBy === "string" &&
    typeof value.attemptFence === "string"
  );
}

export async function withAuthorityDeadline<T>(
  operation: (signal: AbortSignal) => Promise<T>,
  timeoutMs: number,
): Promise<T> {
  const controller = new AbortController();
  let timeout: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<never>((_resolve, reject) => {
    timeout = setTimeout(() => {
      controller.abort();
      reject(new Error("authority deadline exceeded"));
    }, timeoutMs);
  });
  try {
    return await Promise.race([operation(controller.signal), deadline]);
  } finally {
    if (timeout) clearTimeout(timeout);
  }
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
