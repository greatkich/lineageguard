import type { GitHubOperation, GitHubRetry } from "./types.js";

export type GitHubEffectErrorCode =
  | "INVALID_INPUT"
  | "POLICY_REJECTED"
  | "AUTHORIZATION_REJECTED"
  | "VALIDATION_BINDING_MISMATCH"
  | "PERMISSION_DENIED"
  | "NOT_FOUND"
  | "REMOTE_CONFLICT"
  | "REDIRECT_REJECTED"
  | "RATE_LIMITED"
  | "REMOTE_FAILURE"
  | "TRANSPORT_RETRYABLE"
  | "TRANSPORT_AMBIGUOUS"
  | "REPLAY_RECEIPT_NOT_FOUND";

export class GitHubEffectError extends Error {
  readonly code: GitHubEffectErrorCode;
  readonly operation: GitHubOperation;
  readonly retry: GitHubRetry;
  readonly status?: number;

  constructor(input: {
    code: GitHubEffectErrorCode;
    operation: GitHubOperation;
    retry: GitHubRetry;
    message: string;
    status?: number;
  }) {
    super(input.message);
    this.name = "GitHubEffectError";
    this.code = input.code;
    this.operation = input.operation;
    this.retry = input.retry;
    if (input.status !== undefined) this.status = input.status;
  }

  toJSON(): Record<string, unknown> {
    return {
      name: this.name,
      code: this.code,
      operation: this.operation,
      retry: this.retry,
      ...(this.status === undefined ? {} : { status: this.status }),
      message: this.message,
    };
  }
}
