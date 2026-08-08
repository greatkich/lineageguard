import { afterEach, describe, expect, it, vi } from "vitest";
import { reconcileGitHubEffect } from "./github-effect-reconciler.js";

const baseSha = "b".repeat(40);
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
  pullRequests?: Array<{ html_url: string; number: number; draft: boolean }>;
}

function jsonResponse(value: unknown, status = 200): Response {
  return new Response(JSON.stringify(value), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function installHttpFake(overrides: FakeOverrides = {}): RecordedRequest[] {
  const requests: RecordedRequest[] = [];
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
      return jsonResponse({ parents: [{ sha: baseSha }], tree: { sha: headTreeSha } });
    }
    if (url.endsWith(`/git/commits/${baseSha}`)) {
      return jsonResponse({ tree: { sha: baseTreeSha } });
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
    if (url.includes(`/pulls?state=open&head=owner:${branchName}`)) {
      return jsonResponse(
        overrides.pullRequests ?? [
          { html_url: "https://github.com/owner/repo/pull/41", number: 41, draft: true },
        ],
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
      pullRequests: [
        { html_url: "https://github.com/owner/repo/pull/41", number: 41, draft: false },
      ],
    });

    await expect(reconcile()).rejects.toThrow("draft pull request");
  });

  it("rejects duplicate open pull requests", async () => {
    installHttpFake({
      pullRequests: [
        { html_url: "https://github.com/owner/repo/pull/41", number: 41, draft: true },
        { html_url: "https://github.com/owner/repo/pull/42", number: 42, draft: true },
      ],
    });

    await expect(reconcile()).rejects.toThrow("exactly one open draft pull request");
  });
});
