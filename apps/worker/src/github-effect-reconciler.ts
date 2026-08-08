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

interface TreeEntry {
  path: string;
  mode: string;
  type: string;
  sha: string;
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
): Promise<Map<string, TreeEntry>> {
  const response = await requestJson<{
    tree?: unknown;
    truncated?: unknown;
  }>(options, `/git/trees/${treeSha}?recursive=1`);
  if (response.truncated !== false) throw new Error("GitHub recursive tree response is truncated");
  if (!Array.isArray(response.tree)) throw new Error("GitHub recursive tree payload is malformed");
  const entries = new Map<string, TreeEntry>();
  for (const value of response.tree) {
    const entry = value as Partial<TreeEntry>;
    if (!entry.path || !entry.mode || !entry.type || !entry.sha || entries.has(entry.path)) {
      throw new Error("GitHub tree payload contains a malformed or duplicate entry");
    }
    entries.set(entry.path, entry as TreeEntry);
  }
  return entries;
}

function treeIdentity(entry: TreeEntry | undefined): string | undefined {
  return entry && `${entry.mode}:${entry.type}:${entry.sha}`;
}

function isAuthorizedTreeAncestor(
  path: string,
  baseEntry: TreeEntry | undefined,
  headEntry: TreeEntry | undefined,
  artifactPaths: ReadonlySet<string>,
): boolean {
  const present = [baseEntry, headEntry].filter((entry) => entry !== undefined);
  return (
    present.length > 0 &&
    present.every((entry) => entry.type === "tree" && entry.mode === "040000") &&
    [...artifactPaths].some((artifactPath) => artifactPath.startsWith(`${path}/`))
  );
}

function assertExactTreeDelta(
  baseEntries: ReadonlyMap<string, TreeEntry>,
  headEntries: ReadonlyMap<string, TreeEntry>,
  artifacts: readonly GitHubArtifact[],
): void {
  const expected = new Set(artifacts.map((artifact) => artifact.path));
  if (expected.size !== artifacts.length)
    throw new Error("Generated artifact paths are duplicated");
  const changed = new Set<string>();
  for (const [path, entry] of headEntries) {
    if (treeIdentity(baseEntries.get(path)) !== treeIdentity(entry)) changed.add(path);
  }
  for (const path of baseEntries.keys()) {
    if (!headEntries.has(path)) changed.add(path);
  }
  const unexpected = [...changed].filter(
    (path) =>
      !expected.has(path) &&
      !isAuthorizedTreeAncestor(path, baseEntries.get(path), headEntries.get(path), expected),
  );
  const absent = [...expected].filter((path) => !changed.has(path));
  if (unexpected.length > 0 || absent.length > 0) {
    throw new Error(
      `Existing GitHub tree delta is not exact (unexpected: ${unexpected.join(", ") || "none"}; absent: ${absent.join(", ") || "none"})`,
    );
  }
}

async function assertExactArtifactBytes(
  options: ReconcileGitHubEffectOptions,
  headEntries: ReadonlyMap<string, TreeEntry>,
): Promise<void> {
  for (const artifact of options.artifacts) {
    const entry = headEntries.get(artifact.path);
    if (!entry || entry.type !== "blob" || entry.mode !== "100644") {
      throw new Error(
        `Existing GitHub artifact is missing or not a regular blob: ${artifact.path}`,
      );
    }
    const blob = await requestJson<{ content?: string; encoding?: string }>(
      options,
      `/git/blobs/${entry.sha}`,
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
  const headEntries = await readTree(options, requireTreeSha(headCommit, "Head"));
  const baseEntries = await readTree(options, requireTreeSha(baseCommit, "Base"));
  assertExactTreeDelta(baseEntries, headEntries, options.artifacts);
  await assertExactArtifactBytes(options, headEntries);
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
