import { createHash } from "node:crypto";
import type { GitHubReviewOutput } from "@lineageguard/agent";

interface GitHubArtifact {
  path: string;
  content: string;
}

export interface ReconcileGitHubEffectOptions {
  token: string;
  apiBase: string;
  owner: string;
  repo: string;
  branchName: string;
  baseSha: string;
  artifacts: readonly GitHubArtifact[];
}

interface CommitResponse {
  parents?: Array<{ sha?: string }>;
  tree?: { sha?: string };
}

interface PullRequestResponse {
  html_url?: string;
  number?: number;
  draft?: boolean;
}

class GitHubReadError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

async function requestJson<T>(options: ReconcileGitHubEffectOptions, path: string): Promise<T> {
  const response = await fetch(`${options.apiBase}/repos/${options.owner}/${options.repo}${path}`, {
    headers: {
      Accept: "application/vnd.github+json",
      Authorization: `Bearer ${options.token}`,
      "X-GitHub-Api-Version": "2022-11-28",
    },
  });
  if (!response.ok) {
    const detail = await response.text().catch(() => "");
    throw new GitHubReadError(
      response.status,
      `GitHub API ${String(response.status)}: ${detail.slice(0, 200)}`,
    );
  }
  return (await response.json()) as T;
}

async function readHeadSha(options: ReconcileGitHubEffectOptions): Promise<string | undefined> {
  try {
    const ref = await requestJson<{ object?: { sha?: string } }>(
      options,
      `/git/ref/heads/${options.branchName}`,
    );
    if (!ref.object?.sha) throw new Error("GitHub ref response has no head SHA");
    return ref.object.sha;
  } catch (error) {
    if (error instanceof GitHubReadError && error.status === 404) return undefined;
    throw error;
  }
}

async function readCommit(
  options: ReconcileGitHubEffectOptions,
  sha: string,
): Promise<CommitResponse> {
  return requestJson<CommitResponse>(options, `/git/commits/${sha}`);
}

async function readTree(
  options: ReconcileGitHubEffectOptions,
  treeSha: string,
): Promise<Map<string, string>> {
  const response = await requestJson<{
    tree?: Array<{ path?: string; sha?: string; type?: string }>;
  }>(options, `/git/trees/${treeSha}?recursive=1`);
  const blobs = new Map<string, string>();
  for (const entry of response.tree ?? []) {
    if (entry.type !== "blob") continue;
    if (!entry.path || !entry.sha || blobs.has(entry.path)) {
      throw new Error("GitHub tree contains a malformed or duplicate blob entry");
    }
    blobs.set(entry.path, entry.sha);
  }
  return blobs;
}

function assertExactTreeDelta(
  baseBlobs: ReadonlyMap<string, string>,
  headBlobs: ReadonlyMap<string, string>,
  artifacts: readonly GitHubArtifact[],
): void {
  const expected = new Set(artifacts.map((artifact) => artifact.path));
  if (expected.size !== artifacts.length)
    throw new Error("Generated artifact paths are duplicated");
  const changed = new Set<string>();
  for (const [path, sha] of headBlobs) {
    if (baseBlobs.get(path) !== sha) changed.add(path);
  }
  for (const path of baseBlobs.keys()) {
    if (!headBlobs.has(path)) changed.add(path);
  }
  const unexpected = [...changed].filter((path) => !expected.has(path));
  const absent = [...expected].filter((path) => !changed.has(path));
  if (unexpected.length > 0 || absent.length > 0) {
    throw new Error(
      `Existing GitHub tree delta is not exact (unexpected: ${unexpected.join(", ") || "none"}; absent: ${absent.join(", ") || "none"})`,
    );
  }
}

async function assertExactArtifactBytes(
  options: ReconcileGitHubEffectOptions,
  headBlobs: ReadonlyMap<string, string>,
): Promise<void> {
  for (const artifact of options.artifacts) {
    const blobSha = headBlobs.get(artifact.path);
    if (!blobSha) throw new Error(`Existing GitHub artifact is missing: ${artifact.path}`);
    const blob = await requestJson<{ content?: string; encoding?: string }>(
      options,
      `/git/blobs/${blobSha}`,
    );
    if (blob.encoding !== "base64" || !blob.content) {
      throw new Error(`Existing GitHub blob is unreadable: ${artifact.path}`);
    }
    const actual = Buffer.from(blob.content.replace(/\r?\n/g, ""), "base64").toString("utf8");
    if (actual !== artifact.content) {
      throw new Error(`Existing GitHub blob bytes differ: ${artifact.path}`);
    }
  }
}

async function readExactDraftPullRequest(
  options: ReconcileGitHubEffectOptions,
): Promise<{ prUrl: string; prNumber: number }> {
  const pulls = await requestJson<PullRequestResponse[]>(
    options,
    `/pulls?state=open&head=${options.owner}:${options.branchName}`,
  );
  if (pulls.length !== 1) {
    throw new Error("Existing GitHub effect requires exactly one open draft pull request");
  }
  const pull = pulls[0]!;
  if (pull.draft !== true || !pull.html_url || !pull.number) {
    throw new Error("Existing GitHub effect does not have a valid draft pull request");
  }
  return { prUrl: pull.html_url, prNumber: pull.number };
}

function requireTreeSha(commit: CommitResponse, label: string): string {
  if (!commit.tree?.sha) throw new Error(`${label} GitHub commit has no tree SHA`);
  return commit.tree.sha;
}

export async function reconcileGitHubEffect(
  options: ReconcileGitHubEffectOptions,
): Promise<{ kind: "MISSING" } | { kind: "EXACT"; receipt: GitHubReviewOutput }> {
  const headSha = await readHeadSha(options);
  if (headSha === undefined) return { kind: "MISSING" };
  const headCommit = await readCommit(options, headSha);
  if (headCommit.parents?.length !== 1 || headCommit.parents[0]?.sha !== options.baseSha) {
    throw new Error("Existing GitHub commit is not parented on the expected base");
  }
  const baseCommit = await readCommit(options, options.baseSha);
  const headBlobs = await readTree(options, requireTreeSha(headCommit, "Head"));
  const baseBlobs = await readTree(options, requireTreeSha(baseCommit, "Base"));
  assertExactTreeDelta(baseBlobs, headBlobs, options.artifacts);
  await assertExactArtifactBytes(options, headBlobs);
  const pull = await readExactDraftPullRequest(options);
  const receiptFingerprint = createHash("sha256")
    .update(JSON.stringify({ prUrl: pull.prUrl, headSha }))
    .digest("hex");
  return {
    kind: "EXACT",
    receipt: {
      ...pull,
      headSha,
      headBranch: options.branchName,
      baseSha: options.baseSha,
      receiptFingerprint,
      outcome: "SKIPPED_EXACT",
    },
  };
}
