import { GitHubEffectError } from "./errors.js";
import { sha256Bytes } from "./hash.js";
import type { GitHubReviewRequest, LiveGitHubOptions } from "./types.js";

const fingerprint = /^[a-f0-9]{64}$/;
const gitSha = /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/;
const runId = /^run_[a-f0-9]{24}$/;
const name = /^[A-Za-z0-9_.-]+$/;
const branch = /^[A-Za-z0-9._/-]+$/;
const evidenceId = /^ev_[a-f0-9]{24}$/;
const opaqueReservation = /^[A-Za-z0-9_-]{32,200}$/;
const idempotencyKey = /^[A-Za-z0-9:._/-]{16,240}$/;

function reject(
  message: string,
  code: "INVALID_INPUT" | "POLICY_REJECTED" | "VALIDATION_BINDING_MISMATCH" = "INVALID_INPUT",
): never {
  throw new GitHubEffectError({ code, operation: "VERIFY_REPOSITORY", retry: "NEVER", message });
}

export function validateOptions(options: LiveGitHubOptions): void {
  if (
    !options ||
    typeof options !== "object" ||
    typeof options.owner !== "string" ||
    typeof options.repository !== "string" ||
    typeof options.baseBranch !== "string" ||
    typeof options.apiBaseUrl !== "string" ||
    typeof options.token !== "string" ||
    !name.test(options.owner) ||
    !name.test(options.repository)
  )
    reject("invalid repository allowlist");
  if (
    !branch.test(options.baseBranch) ||
    options.baseBranch.includes("..") ||
    options.baseBranch.startsWith("lineageguard/")
  )
    reject("invalid base branch allowlist");
  if (options.apiBaseUrl !== "https://api.github.com")
    reject("GitHub API host is not allowlisted", "POLICY_REJECTED");
  if (!options.token.trim()) reject("GitHub credential is missing");
  if (
    !Number.isSafeInteger(options.timeoutMs) ||
    options.timeoutMs < 100 ||
    options.timeoutMs > 30_000
  )
    reject("timeout must be between 100 and 30000 ms");
  if (![1, 2, 3].includes(options.maxAttempts)) reject("max attempts must be between 1 and 3");
  if (
    !options.authority ||
    typeof options.authority.verifyCurrentEffectReservation !== "function" ||
    typeof options.authority.consumeCurrentEffect !== "function"
  )
    reject("trusted effect authority is required", "POLICY_REJECTED");
}

function hasRuntimeRequestShape(input: GitHubReviewRequest): boolean {
  if (
    !plainExact(input, [
      "effectReservationId",
      "runId",
      "effectKind",
      "target",
      "idempotencyKey",
      "intentFingerprint",
      "inputFingerprint",
      "repository",
      "baseBranch",
      "baseSha",
      "candidateFingerprint",
      "artifactSetFingerprint",
      "validationReceiptFingerprint",
      "approvalFingerprint",
      "validation",
      "artifacts",
      "title",
      "body",
    ])
  )
    return false;
  const strings = [
    input.effectReservationId,
    input.runId,
    input.effectKind,
    input.target,
    input.idempotencyKey,
    input.intentFingerprint,
    input.inputFingerprint,
    input.repository,
    input.baseBranch,
    input.baseSha,
    input.candidateFingerprint,
    input.artifactSetFingerprint,
    input.validationReceiptFingerprint,
    input.approvalFingerprint,
    input.title,
  ];
  if (strings.some((value) => typeof value !== "string")) return false;
  if (!plainExact(input.body, ["summary", "reasonEvidenceIds", "rolloutSteps", "rollbackSteps"]))
    return false;
  if (
    typeof input.body.summary !== "string" ||
    !plainArray(input.body.reasonEvidenceIds) ||
    !plainArray(input.body.rolloutSteps) ||
    !plainArray(input.body.rollbackSteps) ||
    input.body.reasonEvidenceIds.length > 200 ||
    input.body.rolloutSteps.length > 20 ||
    input.body.rollbackSteps.length > 20 ||
    input.body.reasonEvidenceIds.some((value) => typeof value !== "string") ||
    input.body.rolloutSteps.some((value) => typeof value !== "string") ||
    input.body.rollbackSteps.some((value) => typeof value !== "string")
  )
    return false;
  if (
    !plainExact(input.validation, [
      "runId",
      "candidateFingerprint",
      "artifactSetFingerprint",
      "receiptFingerprint",
      "artifacts",
    ]) ||
    typeof input.validation.runId !== "string" ||
    typeof input.validation.candidateFingerprint !== "string" ||
    typeof input.validation.artifactSetFingerprint !== "string" ||
    typeof input.validation.receiptFingerprint !== "string" ||
    !plainArray(input.validation.artifacts) ||
    input.validation.artifacts.length > 20 ||
    input.validation.artifacts.some(
      (artifact) =>
        !plainExact(artifact, ["path", "candidateArtifactFingerprint", "materializedSha256"]) ||
        typeof artifact.path !== "string" ||
        typeof artifact.candidateArtifactFingerprint !== "string" ||
        typeof artifact.materializedSha256 !== "string",
    )
  )
    return false;
  return (
    plainArray(input.artifacts) &&
    input.artifacts.length <= 20 &&
    input.artifacts.every((artifact) => {
      if (!artifact || typeof artifact !== "object" || Array.isArray(artifact)) return false;
      const operation = Object.getOwnPropertyDescriptor(artifact, "operation");
      const value = operation && "value" in operation ? operation.value : undefined;
      return (
        plainExact(
          artifact,
          value === "MODIFY"
            ? [
                "path",
                "content",
                "candidateArtifactFingerprint",
                "operation",
                "expectedBaseBlobSha",
              ]
            : ["path", "content", "candidateArtifactFingerprint", "operation"],
        ) &&
        typeof artifact.path === "string" &&
        typeof artifact.content === "string" &&
        typeof artifact.candidateArtifactFingerprint === "string" &&
        (artifact.operation === "CREATE" ||
          (artifact.operation === "MODIFY" && typeof artifact.expectedBaseBlobSha === "string"))
      );
    })
  );
}

function plainArray(value: unknown): value is unknown[] {
  return Array.isArray(value) && Object.getPrototypeOf(value) === Array.prototype;
}

function plainExact(
  value: unknown,
  expectedKeys: readonly string[],
): value is Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) return false;
  const keys = Reflect.ownKeys(value);
  if (
    keys.length !== expectedKeys.length ||
    keys.some((key) => typeof key !== "string" || !expectedKeys.includes(key))
  )
    return false;
  return keys.every((key) => {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    return descriptor !== undefined && "value" in descriptor;
  });
}

export function immutableRequestSnapshot(input: GitHubReviewRequest): GitHubReviewRequest {
  const snapshot = structuredClone(input);
  const freeze = (value: unknown): void => {
    if (!value || typeof value !== "object" || Object.isFrozen(value)) return;
    for (const child of Object.values(value)) freeze(child);
    Object.freeze(value);
  };
  freeze(snapshot);
  return snapshot;
}

function safePath(path: string): boolean {
  if (
    path.length < 1 ||
    path.length > 240 ||
    path.startsWith("/") ||
    path.includes("\\") ||
    !path.split("/").every((segment) => segment !== "" && segment !== "." && segment !== "..")
  )
    return false;
  return [
    /^walkthrough\/migrations\/[A-Za-z0-9._-]+\.sql$/,
    /^walkthrough\/models\/[A-Za-z0-9_./-]+\.sql$/,
    /^walkthrough\/tests\/[A-Za-z0-9_./-]+\.sql$/,
    /^docs\/migrations\/[A-Za-z0-9._-]+\.md$/,
  ].some((pattern) => pattern.test(path));
}

export function validateRequest(input: GitHubReviewRequest, options: LiveGitHubOptions): void {
  try {
    validateRequestRuntime(input, options);
  } catch (error) {
    if (error instanceof GitHubEffectError) throw error;
    reject("GitHub effect request is malformed");
  }
}

function validateRequestRuntime(input: GitHubReviewRequest, options: LiveGitHubOptions): void {
  if (!hasRuntimeRequestShape(input)) reject("GitHub effect request is malformed");
  const expectedRepository = `${options.owner}/${options.repository}`;
  const expectedTarget = `${options.apiBaseUrl}/repos/${expectedRepository}/git/ref/heads/${encodeURIComponent(options.baseBranch)}#${input.baseSha}`;
  if (
    input.repository !== expectedRepository ||
    input.baseBranch !== options.baseBranch ||
    input.target !== expectedTarget ||
    input.effectKind !== "GITHUB_WRITE"
  ) {
    reject(
      "effect target is outside the exact repository, owner, or base allowlist",
      "POLICY_REJECTED",
    );
  }
  if (!runId.test(input.runId) || !gitSha.test(input.baseSha))
    reject("invalid run or base commit identity");
  if (
    !opaqueReservation.test(input.effectReservationId) ||
    !idempotencyKey.test(input.idempotencyKey)
  )
    reject("invalid effect reservation or idempotency identity");
  for (const value of [
    input.inputFingerprint,
    input.intentFingerprint,
    input.candidateFingerprint,
    input.artifactSetFingerprint,
    input.validationReceiptFingerprint,
    input.approvalFingerprint,
  ]) {
    if (!fingerprint.test(value)) reject("invalid effect fingerprint");
  }
  if (
    input.validation.runId !== input.runId ||
    input.validation.candidateFingerprint !== input.candidateFingerprint ||
    input.validation.artifactSetFingerprint !== input.artifactSetFingerprint ||
    input.validation.receiptFingerprint !== input.validationReceiptFingerprint
  ) {
    reject(
      "validation receipt is not bound to this run, candidate, artifact set, and effect",
      "VALIDATION_BINDING_MISMATCH",
    );
  }
  if (
    !input.title.trim() ||
    input.title.length > 160 ||
    !input.body.summary.trim() ||
    input.body.summary.length > 2_000
  )
    reject("invalid review title or summary");
  if (
    input.body.reasonEvidenceIds.length < 1 ||
    input.body.reasonEvidenceIds.length > 200 ||
    input.body.reasonEvidenceIds.some((id) => !evidenceId.test(id)) ||
    new Set(input.body.reasonEvidenceIds).size !== input.body.reasonEvidenceIds.length
  )
    reject("review must cite valid evidence IDs");
  if (
    input.body.rolloutSteps.length < 1 ||
    input.body.rolloutSteps.length > 20 ||
    input.body.rollbackSteps.length < 1 ||
    input.body.rollbackSteps.length > 20 ||
    [...input.body.rolloutSteps, ...input.body.rollbackSteps].some(
      (step) => !step.trim() || step.length > 1_000,
    )
  )
    reject("review requires bounded rollout and rollback steps");
  if (
    input.artifacts.length < 1 ||
    input.artifacts.length > 20 ||
    input.validation.artifacts.length !== input.artifacts.length
  )
    reject("artifact set is incomplete", "VALIDATION_BINDING_MISMATCH");
  const observed = new Map(input.validation.artifacts.map((artifact) => [artifact.path, artifact]));
  if (observed.size !== input.validation.artifacts.length)
    reject("validated artifact paths must be unique", "VALIDATION_BINDING_MISMATCH");
  const seen = new Set<string>();
  const validatedPaths = input.validation.artifacts.map((artifact) => artifact.path);
  if (JSON.stringify(validatedPaths) !== JSON.stringify([...validatedPaths].sort()))
    reject("validated artifact paths must be canonical", "VALIDATION_BINDING_MISMATCH");
  for (const artifact of input.artifacts) {
    if (
      !safePath(artifact.path) ||
      artifact.content.length < 1 ||
      Buffer.byteLength(artifact.content, "utf8") > 100_000 ||
      !fingerprint.test(artifact.candidateArtifactFingerprint) ||
      (artifact.operation !== "CREATE" && artifact.operation !== "MODIFY") ||
      (artifact.operation === "MODIFY" && !gitSha.test(artifact.expectedBaseBlobSha)) ||
      seen.has(artifact.path)
    )
      reject("artifact input is invalid");
    seen.add(artifact.path);
    const observation = observed.get(artifact.path);
    if (
      !observation ||
      observation.candidateArtifactFingerprint !== artifact.candidateArtifactFingerprint ||
      observation.materializedSha256 !== sha256Bytes(artifact.content)
    ) {
      reject(
        "artifact bytes or candidate fingerprint differ from signed validation",
        "VALIDATION_BINDING_MISMATCH",
      );
    }
  }
  if (seen.size !== observed.size)
    reject("artifact paths differ from signed validation", "VALIDATION_BINDING_MISMATCH");
  if (
    JSON.stringify(input.artifacts.map((artifact) => artifact.path)) !==
    JSON.stringify(validatedPaths)
  )
    reject("artifact order differs from signed validation", "VALIDATION_BINDING_MISMATCH");
}

export function deterministicHead(run: string): string {
  if (!runId.test(run)) reject("invalid run identity");
  return `lineageguard/${run}`;
}
