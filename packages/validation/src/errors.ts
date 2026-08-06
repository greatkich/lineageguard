export type ValidationErrorCode =
  | "INVALID_SANDBOX_ROOT"
  | "INVALID_PATH"
  | "SYMLINK"
  | "DUPLICATE_TARGET"
  | "WRONG_BASE_SHA"
  | "OVERSIZE"
  | "NON_UTF8"
  | "ARTIFACT_CONFLICT"
  | "PATCH_INVALID"
  | "COMMAND_FAILED"
  | "COMMAND_TIMEOUT"
  | "OUTPUT_LIMIT"
  | "MISSING_TOOL"
  | "ATTESTATION_INVALID"
  | "CLEANUP_FAILED";

export class ValidationError extends Error {
  readonly code: ValidationErrorCode;
  readonly diagnostic: string;

  constructor(code: ValidationErrorCode, diagnostic: string) {
    super(`Validation boundary rejected input: ${code}`);
    this.name = "ValidationError";
    this.code = code;
    this.diagnostic = diagnostic.slice(0, 240);
  }
}
