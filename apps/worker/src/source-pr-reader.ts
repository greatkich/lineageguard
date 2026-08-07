/**
 * Source PR reader — fetches real base/head SHAs and metadata from a GitHub PR.
 * Used when SOURCE_PR_NUMBER is set to analyse a real unsafe PR.
 */
import { createHash } from "node:crypto";
import type { SourceChange } from "@lineageguard/domain";

export interface SourcePRInfo {
  prNumber: number;
  prUrl: string;
  baseSha: string;
  headSha: string;
  baseBranch: string;
  headBranch: string;
  diffFingerprint: string;
  changedFiles: string[];
  patches: Array<{ filename: string; patch: string }>;
}

export async function readSourcePR(options: {
  owner: string;
  repo: string;
  token: string;
  prNumber: number;
}): Promise<SourcePRInfo> {
  const { owner, repo, token, prNumber } = options;
  const apiBase = "https://api.github.com";

  // Fetch PR metadata
  const prRes = await fetch(`${apiBase}/repos/${owner}/${repo}/pulls/${prNumber}`, {
    headers: {
      Accept: "application/vnd.github+json",
      Authorization: `Bearer ${token}`,
      "X-GitHub-Api-Version": "2022-11-28",
    },
  });
  if (!prRes.ok) {
    const text = await prRes.text().catch(() => "");
    throw new Error(
      `Failed to read source PR #${prNumber}: HTTP ${prRes.status} — ${text.slice(0, 200)}`,
    );
  }
  const pr = (await prRes.json()) as {
    number: number;
    html_url: string;
    base: { sha: string; ref: string };
    head: { sha: string; ref: string };
  };

  // Fetch changed files
  const filesRes = await fetch(
    `${apiBase}/repos/${owner}/${repo}/pulls/${prNumber}/files?per_page=100`,
    {
      headers: {
        Accept: "application/vnd.github+json",
        Authorization: `Bearer ${token}`,
        "X-GitHub-Api-Version": "2022-11-28",
      },
    },
  );
  if (!filesRes.ok) {
    throw new Error(`Failed to read source PR files: HTTP ${filesRes.status}`);
  }
  const files = (await filesRes.json()) as Array<{ filename: string; patch?: string }>;

  // Compute diff fingerprint from patches
  const patchContent = files.map((f) => `${f.filename}:${f.patch ?? ""}`).join("\n");
  const diffFingerprint = createHash("sha256").update(patchContent).digest("hex");

  return {
    prNumber: pr.number,
    prUrl: pr.html_url,
    baseSha: pr.base.sha,
    headSha: pr.head.sha,
    baseBranch: pr.base.ref,
    headBranch: pr.head.ref,
    diffFingerprint,
    changedFiles: files.map((f) => f.filename),
    patches: files.map((f) => ({ filename: f.filename, patch: f.patch ?? "" })),
  };
}

/**
 * Builds a typed SourceChange from raw PR info for the canonical scenario.
 * Finds the single SQL migration file containing the supported rename,
 * and reconstructs the full unified diff format that the domain parser expects
 * (GitHub API returns patches without the `diff --git` / `---` / `+++` headers).
 *
 * Returns null if no single canonical SQL file is found.
 */
export function buildSourceChange(info: SourcePRInfo, repository: string): SourceChange | null {
  const renamePattern = /RENAME\s+COLUMN\s+customer_id\s+TO\s+buyer_id/i;
  const sqlPatches = info.patches.filter(
    (p) => p.filename.endsWith(".sql") && renamePattern.test(p.patch),
  );
  if (sqlPatches.length !== 1) return null;

  const file = sqlPatches[0]!;
  // GitHub API patch starts at the @@ hunk header.
  // The domain parser expects full unified diff: diff --git, ---, +++, then hunks.
  // Detect new-file vs edit from the hunk header.
  const isNewFile = file.patch.startsWith("@@ -0,0");
  const fullDiff = [
    `diff --git a/${file.filename} b/${file.filename}`,
    ...(isNewFile ? ["new file mode 100644", "index 0000000..1234567"] : []),
    isNewFile ? "--- /dev/null" : `--- a/${file.filename}`,
    `+++ b/${file.filename}`,
    file.patch,
  ].join("\n");

  const fingerprint = createHash("sha256").update(fullDiff).digest("hex");

  return {
    source: "GITHUB",
    repository,
    pullRequestNumber: info.prNumber,
    pullRequestUrl: info.prUrl,
    baseSha: info.baseSha,
    headSha: info.headSha,
    filePath: file.filename,
    unifiedDiff: fullDiff,
    diffFingerprint: `sha256:${fingerprint}`,
  };
}
