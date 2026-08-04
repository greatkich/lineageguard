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
  | (GitHubArtifactBase & { operation: "MODIFY"; expectedBaseSha: string });

export interface GitHubValidationBinding {
  runId: string;
  status: "PASS";
  candidateFingerprint: string;
  artifactSetFingerprint: string;
  receiptFingerprint: string;
  artifacts: readonly ValidatedArtifactBinding[];
}

export interface GitHubReviewRequest {
  runId: string;
  effectKind: "GITHUB_WRITE";
  target: string;
  inputFingerprint: string;
  repository: string;
  baseBranch: string;
  baseSha: string;
  candidateFingerprint: string;
  artifactSetFingerprint: string;
  validationReceiptFingerprint: string;
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

export interface GitHubReplayRequest {
  runId: string;
  inputFingerprint: string;
  candidateFingerprint: string;
  artifactSetFingerprint: string;
  validationReceiptFingerprint: string;
}

export interface GitHubReviewReceipt {
  schemaVersion: 1;
  mode: "LIVE" | "REPLAY";
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
  inputFingerprint: string;
  reconciled: boolean;
}

export interface GitHubPort<TRequest = GitHubReviewRequest | GitHubReplayRequest> {
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
  transport?: GitHubHttpTransport;
}
