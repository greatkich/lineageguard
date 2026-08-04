export type DataHubAdapterErrorCode =
  | "AMBIGUOUS"
  | "CONFIGURATION"
  | "CURSOR_CYCLE"
  | "MALFORMED_RESPONSE"
  | "NOT_FOUND"
  | "PAGINATION_LIMIT"
  | "REPLAY_INVALID"
  | "RESPONSE_LIMIT"
  | "TIMEOUT"
  | "TOOL_FAILURE"
  | "TOOL_MISSING"
  | "TOOL_POLICY_VIOLATION"
  | "UNAVAILABLE";

export type DataHubAdapterDiagnostic = Readonly<{
  code: DataHubAdapterErrorCode;
  invocationId?: string;
  message: string;
  retryable: boolean;
  tool?: string;
}>;

type ErrorOptions = Readonly<{
  invocationId?: string;
  retryable?: boolean;
  tool?: string;
}>;

/**
 * An intentionally secret-safe adapter failure. Raw MCP errors and content are never retained.
 */
export class DataHubAdapterError extends Error {
  readonly code: DataHubAdapterErrorCode;
  readonly invocationId: string | undefined;
  readonly retryable: boolean;
  readonly tool: string | undefined;

  constructor(code: DataHubAdapterErrorCode, message: string, options: ErrorOptions = {}) {
    super(message);
    this.name = "DataHubAdapterError";
    this.code = code;
    this.invocationId = options.invocationId;
    this.retryable = options.retryable ?? false;
    this.tool = options.tool;
  }

  diagnostic(): DataHubAdapterDiagnostic {
    return Object.freeze({
      code: this.code,
      ...(this.invocationId === undefined ? {} : { invocationId: this.invocationId }),
      message: this.message,
      retryable: this.retryable,
      ...(this.tool === undefined ? {} : { tool: this.tool }),
    });
  }

  toJSON(): DataHubAdapterDiagnostic {
    return this.diagnostic();
  }
}
