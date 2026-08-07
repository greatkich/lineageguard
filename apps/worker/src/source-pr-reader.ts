/**
 * Source PR reader — reads the real canonical PR and binds the run to its exact bytes.
 *
 * Every later authoritative effect is attested against the envelope this produces, so the reader
 * must not paper over an unexpected PR: it either returns the canonical envelope or throws a typed
 * rejection naming why the PR is not the supported scenario.
 */
import { createHash } from "node:crypto";
import {
  buildCanonicalSourceEnvelope,
  type SourceChange,
  type SourceChangeEnvelope,
  type SourceFileInput,
} from "@lineageguard/domain";

const GITHUB_API = "https://api.github.com";
const MAX_FILE_PAGES = 5;
const FILES_PER_PAGE = 100;

export interface SourcePRInfo {
  prNumber: number;
  prUrl: string;
  prState: string;
  baseSha: string;
  headSha: string;
  baseBranch: string;
  headBranch: string;
  diffFingerprint: string;
  changedFiles: string[];
  patches: Array<{ filename: string; patch: string; blobSha?: string }>;
}

export type SourcePRRequest = Readonly<{
  owner: string;
  repo: string;
  token: string;
  prNumber: number;
}>;

type PullRequestResponse = Readonly<{
  number: number;
  html_url: string;
  state: string;
  merged?: boolean;
  draft?: boolean;
  base: { sha: string; ref: string };
  head: { sha: string; ref: string };
}>;

type PullRequestFile = Readonly<{ filename: string; patch?: string; sha?: string }>;

function headers(token: string): Record<string, string> {
  return {
    Accept: "application/vnd.github+json",
    Authorization: `Bearer ${token}`,
    "X-GitHub-Api-Version": "2022-11-28",
  };
}

async function getJson<T>(url: string, token: string, what: string): Promise<T> {
  const response = await fetch(url, { headers: headers(token) });
  if (!response.ok) {
    // The body may echo request context; keep it out of the message.
    throw new Error(`Failed to read ${what}: HTTP ${String(response.status)}`);
  }
  return (await response.json()) as T;
}

/** Pages the file list so a PR cannot hide an unrelated change past the first page. */
async function readAllFiles(request: SourcePRRequest): Promise<PullRequestFile[]> {
  const { owner, repo, prNumber, token } = request;
  const collected: PullRequestFile[] = [];
  for (let page = 1; page <= MAX_FILE_PAGES; page += 1) {
    const url = `${GITHUB_API}/repos/${owner}/${repo}/pulls/${String(prNumber)}/files?per_page=${String(FILES_PER_PAGE)}&page=${String(page)}`;
    const batch = await getJson<PullRequestFile[]>(url, token, "source PR files");
    collected.push(...batch);
    if (batch.length < FILES_PER_PAGE) return collected;
  }
  throw new Error(
    `Source PR #${String(prNumber)} has more files than the reader will page (${String(MAX_FILE_PAGES * FILES_PER_PAGE)})`,
  );
}

export async function readSourcePR(request: SourcePRRequest): Promise<SourcePRInfo> {
  const { owner, repo, prNumber, token } = request;
  const pr = await getJson<PullRequestResponse>(
    `${GITHUB_API}/repos/${owner}/${repo}/pulls/${String(prNumber)}`,
    token,
    `source PR #${String(prNumber)}`,
  );
  const files = await readAllFiles(request);

  const patchContent = files.map((file) => `${file.filename}:${file.patch ?? ""}`).join("\n");
  const diffFingerprint = createHash("sha256").update(patchContent).digest("hex");

  return {
    prNumber: pr.number,
    prUrl: pr.html_url,
    // GitHub reports "closed" for a merged PR, so fold merged into a non-open state explicitly.
    prState: pr.merged === true ? "merged" : pr.state,
    baseSha: pr.base.sha,
    headSha: pr.head.sha,
    baseBranch: pr.base.ref,
    headBranch: pr.head.ref,
    diffFingerprint,
    changedFiles: files.map((file) => file.filename),
    patches: files.map((file) => ({
      filename: file.filename,
      patch: file.patch ?? "",
      ...(file.sha === undefined ? {} : { blobSha: file.sha }),
    })),
  };
}

function envelopeFiles(info: SourcePRInfo): SourceFileInput[] {
  return info.patches.map((patch) => ({
    path: patch.filename,
    patch: patch.patch,
    ...(patch.blobSha === undefined ? {} : { blobSha: patch.blobSha }),
  }));
}

/**
 * Binds raw PR bytes to the canonical envelope. Throws `SourceChangeRejectedError` when the PR is
 * not the supported scenario.
 */
export function buildSourceEnvelope(
  info: SourcePRInfo,
  expectedRepository: string,
): SourceChangeEnvelope {
  return buildCanonicalSourceEnvelope({
    repository: expectedRepository,
    expectedRepository,
    prNumber: info.prNumber,
    prUrl: info.prUrl,
    prState: info.prState,
    baseSha: info.baseSha,
    headSha: info.headSha,
    files: envelopeFiles(info),
  });
}

/** Re-reads the PR and rebuilds the envelope so a drift checkpoint can compare identities. */
export async function reattestSourceEnvelope(
  request: SourcePRRequest,
  expectedRepository: string,
): Promise<SourceChangeEnvelope> {
  return buildSourceEnvelope(await readSourcePR(request), expectedRepository);
}

/**
 * Reconstructs the unified diff the domain change parser expects. The GitHub API returns patches
 * starting at the `@@` hunk header, without `diff --git` / `---` / `+++`.
 */
export function buildSourceChange(info: SourcePRInfo, repository: string): SourceChange | null {
  const envelope = (() => {
    try {
      return buildSourceEnvelope(info, repository);
    } catch {
      return undefined;
    }
  })();
  if (!envelope) return null;

  const selected = info.patches.find((patch) => patch.filename === envelope.selectedPath);
  if (!selected) return null;

  const isNewFile = selected.patch.startsWith("@@ -0,0");
  const fullDiff = [
    `diff --git a/${selected.filename} b/${selected.filename}`,
    ...(isNewFile ? ["new file mode 100644", "index 0000000..1234567"] : []),
    isNewFile ? "--- /dev/null" : `--- a/${selected.filename}`,
    `+++ b/${selected.filename}`,
    selected.patch,
  ].join("\n");

  return {
    source: "GITHUB",
    repository,
    pullRequestNumber: info.prNumber,
    pullRequestUrl: info.prUrl,
    baseSha: info.baseSha,
    headSha: info.headSha,
    filePath: selected.filename,
    unifiedDiff: fullDiff,
    diffFingerprint: `sha256:${createHash("sha256").update(fullDiff).digest("hex")}`,
  };
}
