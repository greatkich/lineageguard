import { execFile } from "node:child_process";
import { promisify } from "node:util";

export interface AcceptanceCodeState {
  applicationCodeSha: string;
  porcelain: string;
}

export type AcceptanceGitExecutor = (
  executable: string,
  args: readonly string[],
) => Promise<string>;

export type AcceptanceCodeStateErrorCode =
  | "GIT_UNAVAILABLE"
  | "INVALID_HEAD"
  | "DIRTY_WORKTREE"
  | "CODE_SHA_CHANGED";

export class AcceptanceCodeStateError extends Error {
  readonly code: AcceptanceCodeStateErrorCode;

  constructor(code: AcceptanceCodeStateErrorCode, message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "AcceptanceCodeStateError";
    this.code = code;
  }
}

const execFileAsync = promisify(execFile);
const shaPattern = /^[0-9a-f]{40}$/;

const executeGit: AcceptanceGitExecutor = async (executable, args) => {
  const { stdout } = await execFileAsync(executable, [...args], { encoding: "utf8" });
  return stdout;
};

export async function readAcceptanceCodeState(
  execute: AcceptanceGitExecutor = executeGit,
): Promise<AcceptanceCodeState> {
  let headOutput: string;
  let porcelain: string;
  try {
    headOutput = await execute("git", ["rev-parse", "HEAD"]);
    porcelain = await execute("git", ["status", "--porcelain"]);
  } catch (cause) {
    throw new AcceptanceCodeStateError(
      "GIT_UNAVAILABLE",
      "ACCEPTANCE_CODE_STATE_UNAVAILABLE: git HEAD or status could not be read",
      { cause },
    );
  }
  const applicationCodeSha = headOutput.trim();
  if (!shaPattern.test(applicationCodeSha)) {
    throw new AcceptanceCodeStateError(
      "INVALID_HEAD",
      `ACCEPTANCE_CODE_STATE_INVALID_HEAD: ${applicationCodeSha || "empty"}`,
    );
  }
  if (porcelain.length > 0) {
    throw new AcceptanceCodeStateError(
      "DIRTY_WORKTREE",
      "ACCEPTANCE_CODE_STATE_DIRTY: acceptance requires an empty git status --porcelain",
    );
  }
  return { applicationCodeSha, porcelain };
}

export function assertAcceptanceCodeState(
  expected: AcceptanceCodeState,
  observed: AcceptanceCodeState,
): void {
  if (expected.porcelain.length > 0 || observed.porcelain.length > 0) {
    throw new AcceptanceCodeStateError(
      "DIRTY_WORKTREE",
      "ACCEPTANCE_CODE_STATE_DIRTY: acceptance state must remain clean",
    );
  }
  if (expected.applicationCodeSha !== observed.applicationCodeSha) {
    throw new AcceptanceCodeStateError(
      "CODE_SHA_CHANGED",
      `ACCEPTANCE_CODE_SHA_CHANGED: code changed from ${expected.applicationCodeSha} to ${observed.applicationCodeSha}`,
    );
  }
}
