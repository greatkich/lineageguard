import { afterEach, describe, expect, it, vi } from "vitest";
import { reconcileGitHubEffect } from "./github-effect-reconciler.js";

const baseSha = "b".repeat(40);
const olderBaseSha = "1".repeat(40);
const headSha = "h".repeat(40);
const baseTreeSha = "t".repeat(40);
const headTreeSha = "u".repeat(40);
const branchName = "lineageguard/pr-7-candidate";
const artifacts = Array.from({ length: 8 }, (_, index) => ({
  path: `artifacts/generated-${String(index + 1)}.sql`,
  content: `select ${String(index + 1)};\n`,
}));

interface RecordedRequest {
  method: string;
  url: string;
}

interface PullRequestFixture {
  html_url: string;
  number: number;
  draft: boolean;
  base: { ref: string; sha: string; repo: { full_name: string } };
  head: { ref: string; sha: string; repo: { full_name: string } };
}

interface FakeOverrides {
  refStatus?: number;
  headTreeTruncated?: boolean;
  missingHeadTree?: boolean;
  malformedHeadTree?: boolean;
  missingBasePath?: boolean;
  mismatchedBlob?: boolean;
  modeOnlyChange?: boolean;
  submoduleChange?: boolean;
  treeAncestorChanges?: boolean;
  publicationBaseSha?: string;
  compareResponse?: unknown;
  pullRequests?: PullRequestFixture[];
}

function pullRequestFixture(
  overrides: Partial<{
    number: number;
    draft: boolean;
    baseRef: string;
    baseSha: string;
    baseRepo: string;
    headRef: string;
    headSha: string;
    headRepo: string;
  }> = {},
): PullRequestFixture {
  const number = overrides.number ?? 41;
  return {
    html_url: `https://github.com/owner/repo/pull/${String(number)}`,
    number,
    draft: overrides.draft ?? true,
    base: {
      ref: overrides.baseRef ?? "main",
      sha: overrides.baseSha ?? baseSha,
      repo: { full_name: overrides.baseRepo ?? "owner/repo" },
    },
    head: {
      ref: overrides.headRef ?? branchName,
      sha: overrides.headSha ?? headSha,
      repo: { full_name: overrides.headRepo ?? "owner/repo" },
    },
  };
}

function jsonResponse(value: unknown, status = 200): Response {
  return new Response(JSON.stringify(value), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function installHttpFake(overrides: FakeOverrides = {}): RecordedRequest[] {
  const requests: RecordedRequest[] = [];
  const publicationBaseSha = overrides.publicationBaseSha ?? baseSha;
  const baseEntries = [
    { path: "README.md", mode: "100644", type: "blob", sha: "base-readme" },
    ...(overrides.missingBasePath
      ? [
          {
            path: "deleted-from-head.sql",
            mode: "100644",
            type: "blob",
            sha: "base-deleted",
          },
        ]
      : []),
    ...(overrides.submoduleChange
      ? [{ path: "vendor/tool", mode: "160000", type: "commit", sha: "base-submodule" }]
      : []),
    ...(overrides.treeAncestorChanges
      ? [{ path: "artifacts", mode: "040000", type: "tree", sha: "base-artifacts-tree" }]
      : []),
  ];
  const headEntries = [
    {
      path: "README.md",
      mode: overrides.modeOnlyChange ? "100755" : "100644",
      type: "blob",
      sha: "base-readme",
    },
    ...artifacts.map((artifact, index) => ({
      path: artifact.path,
      mode: "100644",
      type: "blob",
      sha: `artifact-${String(index + 1)}`,
    })),
    ...(overrides.submoduleChange
      ? [{ path: "vendor/tool", mode: "160000", type: "commit", sha: "head-submodule" }]
      : []),
    ...(overrides.treeAncestorChanges
      ? [{ path: "artifacts", mode: "040000", type: "tree", sha: "head-artifacts-tree" }]
      : []),
  ];
  vi.stubGlobal("fetch", async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    requests.push({ method: init?.method ?? "GET", url });
    if (url.endsWith(`/git/ref/heads/${branchName}`)) {
      return overrides.refStatus
        ? jsonResponse({ message: "ref read failed" }, overrides.refStatus)
        : jsonResponse({ object: { sha: headSha } });
    }
    if (url.endsWith(`/git/commits/${headSha}`)) {
      return jsonResponse({ parents: [{ sha: publicationBaseSha }], tree: { sha: headTreeSha } });
    }
    if (url.endsWith(`/git/commits/${publicationBaseSha}`)) {
      return jsonResponse({ tree: { sha: baseTreeSha } });
    }
    if (url.includes(`/compare/${publicationBaseSha}...${baseSha}`)) {
      return jsonResponse(
        overrides.compareResponse ?? {
          status: publicationBaseSha === baseSha ? "identical" : "ahead",
          ahead_by: publicationBaseSha === baseSha ? 0 : 1,
          behind_by: 0,
          base_commit: { sha: publicationBaseSha },
          merge_base_commit: { sha: publicationBaseSha },
        },
      );
    }
    if (url.endsWith(`/git/trees/${headTreeSha}?recursive=1`)) {
      if (overrides.missingHeadTree) return jsonResponse({ truncated: false });
      if (overrides.malformedHeadTree)
        return jsonResponse({ tree: "not-an-array", truncated: false });
      return jsonResponse({ tree: headEntries, truncated: overrides.headTreeTruncated ?? false });
    }
    if (url.endsWith(`/git/trees/${baseTreeSha}?recursive=1`)) {
      return jsonResponse({ tree: baseEntries, truncated: false });
    }
    const blobIndex = artifacts.findIndex((_artifact, index) =>
      url.endsWith(`/git/blobs/artifact-${String(index + 1)}`),
    );
    if (blobIndex >= 0) {
      const content =
        overrides.mismatchedBlob && blobIndex === 0
          ? "select 999;\n"
          : artifacts[blobIndex]!.content;
      return jsonResponse({ encoding: "base64", content: Buffer.from(content).toString("base64") });
    }
    if (url.includes("/pulls?")) {
      return jsonResponse(
        overrides.pullRequests ?? [pullRequestFixture({ baseSha: publicationBaseSha })],
      );
    }
    return jsonResponse({ message: `Unhandled fake request: ${url}` }, 500);
  });
  return requests;
}

function reconcile(): ReturnType<typeof reconcileGitHubEffect> {
  return reconcileGitHubEffect({
    token: "test-token",
    apiBase: "https://api.github.test",
    owner: "owner",
    repo: "repo",
    branchName,
    baseBranch: "main",
    baseSha,
    artifacts,
  });
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("reconcileGitHubEffect", () => {
  it("returns the exact receipt without making mutation requests", async () => {
    const requests = installHttpFake();

    const result = await reconcile();

    expect(result).toMatchObject({ kind: "EXACT", receipt: { outcome: "SKIPPED_EXACT" } });
    expect(requests.filter((request) => request.method !== "GET")).toEqual([]);
    expect(
      requests.some((request) => request.url.includes(`/compare/${baseSha}...${baseSha}`)),
    ).toBe(true);
    expect(requests.find((request) => request.url.includes("/pulls?"))?.url).toBe(
      `https://api.github.test/repos/owner/repo/pulls?state=open&head=owner%3A${encodeURIComponent(branchName)}&base=main&per_page=2`,
    );
  });

  it("accepts an exact publication whose base is an ancestor of advanced main", async () => {
    const publicationBaseSha = olderBaseSha;
    const requests = installHttpFake({ publicationBaseSha });

    const result = await reconcile();

    expect(result).toMatchObject({ kind: "EXACT", receipt: { baseSha: publicationBaseSha } });
    expect(requests.filter((request) => request.method !== "GET")).toEqual([]);
    expect(requests.some((request) => request.url.endsWith("?per_page=1&page=1"))).toBe(true);
  });

  it.each([
    {
      name: "diverged",
      compareResponse: {
        status: "diverged",
        ahead_by: 1,
        behind_by: 1,
        base_commit: { sha: olderBaseSha },
        merge_base_commit: { sha: "a".repeat(40) },
      },
    },
    {
      name: "behind",
      compareResponse: {
        status: "behind",
        ahead_by: 0,
        behind_by: 1,
        base_commit: { sha: olderBaseSha },
        merge_base_commit: { sha: olderBaseSha },
      },
    },
    {
      name: "unrelated",
      compareResponse: {
        status: "ahead",
        ahead_by: 1,
        behind_by: 0,
        base_commit: { sha: olderBaseSha },
        merge_base_commit: { sha: "a".repeat(40) },
      },
    },
    { name: "malformed", compareResponse: { status: "ahead", ahead_by: "1" } },
  ])("rejects a $name publication-base comparison", async ({ compareResponse }) => {
    installHttpFake({ publicationBaseSha: olderBaseSha, compareResponse });

    await expect(reconcile()).rejects.toThrow("publication base");
  });

  it("treats only a 404 ref as missing", async () => {
    installHttpFake({ refStatus: 404 });

    await expect(reconcile()).resolves.toEqual({ kind: "MISSING" });
  });

  it("rejects a non-404 ref read failure", async () => {
    installHttpFake({ refStatus: 503 });

    await expect(reconcile()).rejects.toThrow("GitHub API 503");
  });

  it("rejects a base path deleted from the generated tree", async () => {
    installHttpFake({ missingBasePath: true });

    await expect(reconcile()).rejects.toThrow("tree delta");
  });

  it("rejects a truncated recursive tree response", async () => {
    installHttpFake({ headTreeTruncated: true });

    await expect(reconcile()).rejects.toThrow("truncated");
  });

  it("rejects a missing recursive tree payload", async () => {
    installHttpFake({ missingHeadTree: true });

    await expect(reconcile()).rejects.toThrow("tree payload");
  });

  it("rejects a malformed recursive tree payload", async () => {
    installHttpFake({ malformedHeadTree: true });

    await expect(reconcile()).rejects.toThrow("tree payload");
  });

  it("rejects a mode-only change outside the authorized artifacts", async () => {
    installHttpFake({ modeOnlyChange: true });

    await expect(reconcile()).rejects.toThrow("tree delta");
  });

  it("rejects a changed submodule outside the authorized artifacts", async () => {
    installHttpFake({ submoduleChange: true });

    await expect(reconcile()).rejects.toThrow("tree delta");
  });

  it("allows changed tree entries that are ancestors of authorized artifacts", async () => {
    installHttpFake({ treeAncestorChanges: true });

    await expect(reconcile()).resolves.toMatchObject({ kind: "EXACT" });
  });

  it("rejects a generated blob whose bytes differ", async () => {
    installHttpFake({ mismatchedBlob: true });

    await expect(reconcile()).rejects.toThrow("blob bytes differ");
  });

  it("rejects a non-draft pull request", async () => {
    installHttpFake({
      pullRequests: [pullRequestFixture({ draft: false })],
    });

    await expect(reconcile()).rejects.toThrow("draft pull request");
  });

  it("rejects duplicate open pull requests", async () => {
    installHttpFake({
      pullRequests: [pullRequestFixture(), pullRequestFixture({ number: 42 })],
    });

    await expect(reconcile()).rejects.toThrow("exactly one open draft pull request");
  });

  it.each([
    { name: "base ref", pull: pullRequestFixture({ baseRef: "release" }) },
    { name: "base sha", pull: pullRequestFixture({ baseSha: "x".repeat(40) }) },
    { name: "head ref", pull: pullRequestFixture({ headRef: "other-branch" }) },
    { name: "head sha", pull: pullRequestFixture({ headSha: "x".repeat(40) }) },
    { name: "base repository", pull: pullRequestFixture({ baseRepo: "other/repo" }) },
    { name: "head repository", pull: pullRequestFixture({ headRepo: "other/repo" }) },
  ])("rejects a pull request with mismatched $name binding", async ({ pull }) => {
    installHttpFake({ pullRequests: [pull] });

    await expect(reconcile()).rejects.toThrow("pull request binding");
  });
});
