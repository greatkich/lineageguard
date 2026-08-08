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
  missingBasePath?: boolean;
  mismatchedBlob?: boolean;
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
    { path: "README.md", type: "blob", sha: "base-readme" },
    ...(overrides.missingBasePath
      ? [{ path: "deleted-from-head.sql", type: "blob", sha: "base-deleted" }]
      : []),
  ];
  const headEntries = [
    { path: "README.md", type: "blob", sha: "base-readme" },
    ...artifacts.map((artifact, index) => ({
      path: artifact.path,
      type: "blob",
      sha: `artifact-${String(index + 1)}`,
    })),
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
      return jsonResponse({ tree: headEntries });
    }
    if (url.endsWith(`/git/trees/${baseTreeSha}?recursive=1`)) {
      return jsonResponse({ tree: baseEntries });
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
