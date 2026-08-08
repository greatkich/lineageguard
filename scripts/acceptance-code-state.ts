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

export const goldenEvidenceRoots = [
  "examples/canonical-run",
  "artifacts/demo-readiness",
  "artifacts/demo-runs",
] as const;

export type AcceptanceEvidenceRoot = (typeof goldenEvidenceRoots)[number];

export type AcceptanceCodeStateReader = (
  ignoredPathRoots?: readonly string[],
) => Promise<AcceptanceCodeState>;

export interface AcceptanceCodeStateOperation<T> {
  expectedApplicationCodeSha?: string;
  allowedDirtyPathsAtStart?: readonly string[];
  allowedDirtyPathsAfterAction?: readonly string[];
  readState?: AcceptanceCodeStateReader;
  action: (accepted: AcceptanceCodeState) => Promise<T>;
}

export type AcceptanceCodeStateErrorCode =
  | "GIT_UNAVAILABLE"
  | "INVALID_HEAD"
  | "INVALID_EVIDENCE_ROOT"
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
const approvedEvidenceRoots = new Set<string>(goldenEvidenceRoots);

const executeGit: AcceptanceGitExecutor = async (executable, args) => {
  const { stdout } = await execFileAsync(executable, [...args], { encoding: "utf8" });
  return stdout;
};

function validateEvidenceRoots(roots: readonly string[]): readonly AcceptanceEvidenceRoot[] {
  for (const root of roots) {
    if (!approvedEvidenceRoots.has(root)) {
      throw new AcceptanceCodeStateError(
        "INVALID_EVIDENCE_ROOT",
        `ACCEPTANCE_CODE_STATE_INVALID_EVIDENCE_ROOT: ${root} is not an approved evidence root`,
      );
    }
  }
  return roots as readonly AcceptanceEvidenceRoot[];
}

function statusArgs(ignoredPathRoots: readonly AcceptanceEvidenceRoot[]): readonly string[] {
  if (ignoredPathRoots.length === 0) return ["status", "--porcelain"];
  return [
    "status",
    "--porcelain",
    "--",
    ".",
    ...ignoredPathRoots.map((root) => `:(exclude)${root}`),
  ];
}

export async function readAcceptanceCodeState(
  execute: AcceptanceGitExecutor = executeGit,
  ignoredPathRoots: readonly string[] = [],
): Promise<AcceptanceCodeState> {
  const validatedRoots = validateEvidenceRoots(ignoredPathRoots);
  let headOutput: string;
  let porcelain: string;
  try {
    headOutput = await execute("git", ["rev-parse", "HEAD"]);
    porcelain = await execute("git", statusArgs(validatedRoots));
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

export async function withAcceptanceCodeState<T>(
  options: AcceptanceCodeStateOperation<T>,
): Promise<{ accepted: AcceptanceCodeState; value: T }> {
  const readState: AcceptanceCodeStateReader =
    options.readState ?? ((roots) => readAcceptanceCodeState(executeGit, roots));
  const allowedAtStart = validateEvidenceRoots(options.allowedDirtyPathsAtStart ?? []);
  const allowedAfterAction = validateEvidenceRoots(options.allowedDirtyPathsAfterAction ?? []);
  const accepted = await readState(allowedAtStart);
  if (options.expectedApplicationCodeSha !== undefined) {
    assertAcceptanceCodeState(
      { applicationCodeSha: options.expectedApplicationCodeSha, porcelain: "" },
      accepted,
    );
  } else {
    assertAcceptanceCodeState(accepted, accepted);
  }
  const value = await options.action(accepted);
  assertAcceptanceCodeState(accepted, await readState(allowedAfterAction));
  return { accepted, value };
}
