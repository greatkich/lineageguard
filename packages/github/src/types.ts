export type GitHubOperation =
  | "VERIFY_REPOSITORY"
  | "VERIFY_BASE"
  | "RECONCILE"
  | "READ_BASE_COMMIT"
  | "CREATE_BLOB"
  | "CREATE_TREE"
  | "CREATE_COMMIT"
  | "CREATE_REF"
  | "CREATE_PULL_REQUEST";

export type GitHubRetry = "NEVER" | "RETRY" | "RECONCILE";

export interface GitHubHttpRequest {
  method: "GET" | "POST";
  operation: GitHubOperation;
  url: string;
  headers: Readonly<Record<string, string>>;
  body?: unknown;
  timeoutMs: number;
  redirect: "error";
}

export interface GitHubHttpResponse {
  status: number;
  headers: Readonly<Record<string, string | undefined>>;
  body: unknown;
}

export interface GitHubHttpTransport {
  request(input: GitHubHttpRequest): Promise<GitHubHttpResponse>;
}

export interface ValidatedArtifactBinding {
  path: string;
  candidateArtifactFingerprint: string;
  materializedSha256: string;
}

interface GitHubArtifactBase {
  path: string;
  content: string;
  candidateArtifactFingerprint: string;
}

export type GitHubArtifact =
  | (GitHubArtifactBase & { operation: "CREATE" })
  | (GitHubArtifactBase & { operation: "MODIFY"; expectedBaseBlobSha: string });

export interface GitHubValidationBinding {
  runId: string;
  candidateFingerprint: string;
  artifactSetFingerprint: string;
  receiptFingerprint: string;
  artifacts: readonly ValidatedArtifactBinding[];
}

export interface GitHubReviewRequest {
  effectReservationId: string;
  runId: string;
  effectKind: "GITHUB_WRITE";
  target: string;
  idempotencyKey: string;
  intentFingerprint: string;
  inputFingerprint: string;
  repository: string;
  baseBranch: string;
  baseSha: string;
  candidateFingerprint: string;
  /** Source PR number, used only to make the generated branch name human-readable. */
  sourcePrNumber?: number;
  artifactSetFingerprint: string;
  validationReceiptFingerprint: string;
  approvalFingerprint: string;
  validation: GitHubValidationBinding;
  artifacts: GitHubArtifact[];
  title: string;
  body: {
    summary: string;
    reasonEvidenceIds: string[];
    rolloutSteps: string[];
    rollbackSteps: string[];
  };
}

export interface CanonicalGitHubEffect {
  schemaVersion: 1;
  reservationId: string;
  runId: string;
  effectKind: "GITHUB_WRITE";
  apiBaseUrl: "https://api.github.com";
  repository: string;
  baseBranch: string;
  baseSha: string;
  headBranch: string;
  target: string;
  idempotencyKey: string;
  intentFingerprint: string;
  candidateFingerprint: string;
  artifactSetFingerprint: string;
  validationReceiptFingerprint: string;
  approvalFingerprint: string;
  artifacts: readonly {
    path: string;
    operation: "CREATE" | "MODIFY";
    expectedBaseBlobSha: string | null;
    candidateArtifactFingerprint: string;
    materializedSha256: string;
  }[];
  pullRequest: { title: string; body: string };
}

export interface GitHubEffectAuthorization {
  reservationId: string;
  canonicalEffectFingerprint: string;
  state: "RESERVED" | "CONSUMED";
  invokeBy: string;
}

export interface GitHubEffectAuthorityPort {
  verifyCurrentEffectReservation(input: {
    canonicalEffectFingerprint: string;
    signal: AbortSignal;
  }): Promise<GitHubEffectAuthorization>;
  consumeCurrentEffect(input: {
    canonicalEffectFingerprint: string;
    signal: AbortSignal;
  }): Promise<{
    canonicalEffectFingerprint: string;
    invokeBy: string;
    attemptFence: string;
  }>;
}

/**
 * How this call arrived at its receipt.
 *
 * - `SKIPPED_EXACT`: the deterministic branch and its PR already existed with exactly the
 *   authorized content before this call did anything. No GitHub write was issued.
 * - `CREATED`: this call authored the commit, branch, and/or PR (directly, or indirectly via a
 *   post-ambiguity reconciliation of a write it just attempted).
 * - `UPDATED`: reserved by the effect-identity contract, but unreachable under content-addressed
 *   branch naming. A branch name is derived from the candidate fingerprint, so two different
 *   candidates never contend for the same branch; if a same-named branch's content ever diverges
 *   from the authorized bytes, `verifyReconciledArtifacts` fails closed with `REMOTE_CONFLICT`
 *   instead of force-updating it.
 */
export type EffectOutcome = "CREATED" | "UPDATED" | "SKIPPED_EXACT";

export interface GitHubReviewReceipt {
  schemaVersion: 1;
  mode: "LIVE" | "REPLAY";
  effectKind: "GITHUB_WRITE";
  target: string;
  repository: string;
  baseBranch: string;
  baseSha: string;
  headBranch: string;
  headSha: string;
  prNumber: number;
  prUrl: string;
  prState: "OPEN_DRAFT";
  createdAt: string;
  updatedAt: string;
  candidateFingerprint: string;
  artifactSetFingerprint: string;
  validationReceiptFingerprint: string;
  approvalFingerprint: string;
  intentFingerprint: string;
  idempotencyKey: string;
  inputFingerprint: string;
  reconciled: boolean;
  outcome: EffectOutcome;
}

export interface GitHubPort<TRequest = GitHubReviewRequest> {
  createMigrationReview(input: TRequest): Promise<GitHubReviewReceipt>;
}

export interface LiveGitHubOptions {
  owner: string;
  repository: string;
  baseBranch: string;
  apiBaseUrl: "https://api.github.com";
  token: string;
  timeoutMs: number;
  maxAttempts: 1 | 2 | 3;
  authority: GitHubEffectAuthorityPort;
  transport?: GitHubHttpTransport;
}
