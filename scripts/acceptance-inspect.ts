/**
 * Read-only inspection primitives for the acceptance harness.
 *
 * Every function returns an explicit `Inspection` result. A failure to inspect is never collapsed
 * into an empty list or a null: acceptance must be able to distinguish "the remote system says the
 * effect is absent" from "we could not ask". The second is a failed acceptance check, because a
 * harness that silently degrades to `[]` reports PASS for a system it never looked at.
 *
 * Nothing here mutates. These helpers are shared by demo:verify and demo:repeat so both commands
 * derive identical facts from identical reads.
 */
import {
  buildCanonicalSourceEnvelope,
  decisionMarker,
  sha256Bytes,
  type SourceFileInput,
} from "@lineageguard/domain";
import { expectedRepository, gmsUrl, readToken, run } from "./demo-support.js";

export type Inspection<T> = Readonly<{ ok: true; value: T } | { ok: false; reason: string }>;

export function inspected<T>(value: T): Inspection<T> {
  return { ok: true, value };
}

export function uninspectable<T>(reason: string): Inspection<T> {
  return { ok: false, reason };
}

const requestTimeoutMs = 15_000;

// ─── GitHub (read-only) ──────────────────────────────────────────────────────

export const canonicalDatasetUrn =
  "urn:li:dataset:(urn:li:dataPlatform:postgres,lineageguard-canonical.lineageguard.commerce.orders,PROD)";

export const canonicalReviewedTagUrn = "urn:li:tag:lineageguard-canonical.Reviewed";

function githubToken(): string {
  return process.env.GITHUB_TOKEN ?? "";
}

export function hasGitHubToken(): boolean {
  return githubToken().length >= 8;
}

/** GETs a GitHub API path under the expected repository. Never mutates. */
export async function githubGet<T>(path: string): Promise<Inspection<T>> {
  const token = githubToken();
  if (token.length < 8) return uninspectable("no GitHub token available to read with");
  const url = `https://api.github.com/repos/${expectedRepository()}${path}`;
  try {
    const response = await fetch(url, {
      headers: {
        Accept: "application/vnd.github+json",
        Authorization: `Bearer ${token}`,
        "X-GitHub-Api-Version": "2022-11-28",
      },
      signal: AbortSignal.timeout(requestTimeoutMs),
    });
    if (!response.ok) return uninspectable(`GET ${path} → HTTP ${String(response.status)}`);
    return inspected((await response.json()) as T);
  } catch (error) {
    return uninspectable(`GET ${path} → ${error instanceof Error ? error.message : String(error)}`);
  }
}

export type PullRequestView = Readonly<{
  number: number;
  state: string;
  draft: boolean;
  headRef: string;
  headSha: string;
  baseRef: string;
  baseSha: string;
  body: string;
}>;

export async function readPullRequest(prNumber: number): Promise<Inspection<PullRequestView>> {
  const raw = await githubGet<{
    number: number;
    state: string;
    draft?: boolean;
    body?: string | null;
    head: { ref: string; sha: string };
    base: { ref: string; sha: string };
  }>(`/pulls/${String(prNumber)}`);
  if (!raw.ok) return raw;
  const pr = raw.value;
  if (
    typeof pr.state !== "string" ||
    typeof pr.head?.ref !== "string" ||
    typeof pr.head?.sha !== "string" ||
    typeof pr.base?.ref !== "string" ||
    typeof pr.base?.sha !== "string"
  ) {
    return uninspectable(`pull request #${String(prNumber)} response is malformed`);
  }
  return inspected({
    number: pr.number,
    state: pr.state,
    draft: pr.draft === true,
    headRef: pr.head.ref,
    headSha: pr.head.sha,
    baseRef: pr.base.ref,
    baseSha: pr.base.sha,
    body: pr.body ?? "",
  });
}

export type CommitView = Readonly<{ sha: string; treeSha: string; parents: readonly string[] }>;

export async function readCommit(sha: string): Promise<Inspection<CommitView>> {
  const raw = await githubGet<{
    sha: string;
    tree: { sha: string };
    parents: Array<{ sha: string }>;
  }>(`/git/commits/${sha}`);
  if (!raw.ok) return raw;
  const commit = raw.value;
  if (typeof commit.tree?.sha !== "string" || !Array.isArray(commit.parents)) {
    return uninspectable(`commit ${sha.slice(0, 12)} response is malformed`);
  }
  return inspected({
    sha: commit.sha,
    treeSha: commit.tree.sha,
    parents: commit.parents.map((parent) => parent.sha),
  });
}

/** path → blob sha, for every blob reachable from a tree. Refuses a truncated listing. */
export async function readTreeBlobs(
  treeSha: string,
): Promise<Inspection<ReadonlyMap<string, string>>> {
  const raw = await githubGet<{
    truncated?: boolean;
    tree: Array<{ path: string; type: string; sha: string }>;
  }>(`/git/trees/${treeSha}?recursive=1`);
  if (!raw.ok) return raw;
  if (raw.value.truncated === true) {
    return uninspectable(`tree ${treeSha.slice(0, 12)} listing was truncated by the API`);
  }
  if (!Array.isArray(raw.value.tree)) {
    return uninspectable(`tree ${treeSha.slice(0, 12)} response is malformed`);
  }
  const blobs = new Map<string, string>();
  for (const entry of raw.value.tree) {
    if (entry.type === "blob") blobs.set(entry.path, entry.sha);
  }
  return inspected(blobs);
}

/** The exact bytes of a blob, decoded from the API's base64 payload. */
export async function readBlobBytes(blobSha: string): Promise<Inspection<string>> {
  const raw = await githubGet<{ content?: string; encoding?: string }>(`/git/blobs/${blobSha}`);
  if (!raw.ok) return raw;
  if (raw.value.encoding !== "base64" || typeof raw.value.content !== "string") {
    return uninspectable(`blob ${blobSha.slice(0, 12)} is not base64-encoded content`);
  }
  try {
    return inspected(Buffer.from(raw.value.content, "base64").toString("utf8"));
  } catch {
    return uninspectable(`blob ${blobSha.slice(0, 12)} could not be decoded`);
  }
}

/** The file content at a path on a ref, as exact bytes. */
export async function readFileAtRef(path: string, ref: string): Promise<Inspection<string>> {
  const raw = await githubGet<{ content?: string; encoding?: string }>(
    `/contents/${path.split("/").map(encodeURIComponent).join("/")}?ref=${encodeURIComponent(ref)}`,
  );
  if (!raw.ok) return raw;
  if (raw.value.encoding !== "base64" || typeof raw.value.content !== "string") {
    return uninspectable(`${path}@${ref.slice(0, 12)} is not base64-encoded content`);
  }
  return inspected(Buffer.from(raw.value.content, "base64").toString("utf8"));
}

/**
 * Re-derives a pull request's canonical source-envelope identity straight from GitHub.
 *
 * The run store's `sourceDiffFingerprint` is the envelope identity digest — `sha256` over the whole
 * bound identity (repository, PR, base/head SHAs, every file's path and patch, the selected path,
 * and the normalized change) — not a hash of any single patch or file.
 *
 * So this re-reads the live PR and rebuilds the envelope through `buildCanonicalSourceEnvelope`,
 * the same domain function the worker binds runs with. Re-implementing the derivation here would
 * create a second definition of source identity that is free to drift from the one that matters.
 */
export async function readPullRequestSourceIdentity(
  prNumber: number,
  repository: string = expectedRepository(),
): Promise<
  Inspection<{ sourceFingerprint: string; selectedPath: string; files: readonly string[] }>
> {
  const pr = await readPullRequest(prNumber);
  if (!pr.ok) return pr;

  const filesPerPage = 100;
  const maxPages = 5;
  const files: SourceFileInput[] = [];
  let complete = false;
  for (let page = 1; page <= maxPages && !complete; page += 1) {
    const batch = await githubGet<Array<{ filename?: string; patch?: string; sha?: string }>>(
      `/pulls/${String(prNumber)}/files?per_page=${String(filesPerPage)}&page=${String(page)}`,
    );
    if (!batch.ok) return batch;
    if (!Array.isArray(batch.value)) {
      return uninspectable(`pull request #${String(prNumber)} files response is malformed`);
    }
    for (const file of batch.value) {
      if (typeof file.filename !== "string") {
        return uninspectable(`pull request #${String(prNumber)} file entry is malformed`);
      }
      files.push({
        path: file.filename,
        patch: file.patch ?? "",
        ...(typeof file.sha === "string" ? { blobSha: file.sha } : {}),
      });
    }
    if (batch.value.length < filesPerPage) complete = true;
  }
  if (!complete) {
    return uninspectable(`pull request #${String(prNumber)} has more files than the reader pages`);
  }

  try {
    const envelope = buildCanonicalSourceEnvelope({
      repository,
      expectedRepository: repository,
      prNumber: pr.value.number,
      prUrl: `https://github.com/${repository}/pull/${String(pr.value.number)}`,
      prState: pr.value.state,
      baseSha: pr.value.baseSha,
      headSha: pr.value.headSha,
      files,
    });
    return inspected({
      sourceFingerprint: envelope.sourceFingerprint,
      selectedPath: envelope.selectedPath,
      files: files.map((file) => file.path),
    });
  } catch (error) {
    return uninspectable(
      `live source PR no longer binds to the canonical envelope: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
  }
}

// ─── DataHub (read-only) ─────────────────────────────────────────────────────

export type DataHubDecisionState = Readonly<{
  /** Unique semantic decision identities present in institutional memory. */
  markers: readonly string[];
  /** How many memory elements carry a LineageGuard decision marker. */
  decisionElementCount: number;
  totalElementCount: number;
  /** Parsed `Key: value` lines from the single LineageGuard decision element. */
  fields: ReadonlyMap<string, string>;
  /** LineageGuard-owned tags currently attached to the dataset. */
  lineageguardTags: readonly string[];
  /** True when the same LineageGuard tag URN appears more than once. */
  duplicateTags: boolean;
}>;

async function gmsGet<T>(path: string): Promise<Inspection<T>> {
  const token = readToken();
  if (token.length < 8) return uninspectable("no DataHub read token available");
  try {
    const response = await fetch(`${gmsUrl()}${path}`, {
      headers: { Authorization: `Bearer ${token}` },
      signal: AbortSignal.timeout(requestTimeoutMs),
    });
    if (!response.ok) return uninspectable(`GMS ${path} → HTTP ${String(response.status)}`);
    return inspected((await response.json()) as T);
  } catch (error) {
    return uninspectable(`GMS ${path} → ${error instanceof Error ? error.message : String(error)}`);
  }
}

/** Unwraps the GMS `{ aspect: { "com.linkedin.…": value } }` envelope. */
function aspectValue(response: unknown): unknown {
  const envelope = response as { aspect?: Record<string, unknown> } | null;
  if (!envelope?.aspect) return null;
  const classKeys = Object.keys(envelope.aspect).filter((key) => key.startsWith("com."));
  if (classKeys.length === 1 && classKeys[0] !== undefined) return envelope.aspect[classKeys[0]];
  if ("value" in envelope.aspect) return envelope.aspect.value;
  return envelope.aspect;
}

function parseDecisionFields(description: string): Map<string, string> {
  const fields = new Map<string, string>();
  for (const line of description.split("\n")) {
    const separator = line.indexOf(": ");
    if (separator <= 0) continue;
    fields.set(line.slice(0, separator), line.slice(separator + 2));
  }
  return fields;
}

/**
 * The exact institutional-memory and tag state for the canonical dataset.
 *
 * A missing aspect is reported as an inspected empty state — DataHub answered and the effect is
 * genuinely absent. An unreachable GMS is reported as uninspectable.
 */
export async function readDataHubDecisionState(
  datasetUrn: string = canonicalDatasetUrn,
): Promise<Inspection<DataHubDecisionState>> {
  const encoded = encodeURIComponent(datasetUrn);
  const memory = await gmsGet<unknown>(`/aspects/${encoded}?aspect=institutionalMemory&version=0`);
  if (!memory.ok) return memory;
  const tags = await gmsGet<unknown>(`/aspects/${encoded}?aspect=globalTags&version=0`);
  if (!tags.ok) return tags;

  const memoryValue = aspectValue(memory.value) as {
    elements?: Array<{ description?: string }>;
  } | null;
  const elements = Array.isArray(memoryValue?.elements) ? memoryValue.elements : [];
  const decisionElements = elements.filter((element) =>
    element.description?.includes("lineageguard:decision:v1:"),
  );
  const markers = [
    ...new Set(
      decisionElements.flatMap((element) =>
        [...(element.description ?? "").matchAll(/lineageguard:decision:v1:[A-Za-z0-9-]+/g)].map(
          (match) => match[0],
        ),
      ),
    ),
  ];
  const fields =
    decisionElements.length === 1
      ? parseDecisionFields(decisionElements[0]?.description ?? "")
      : new Map<string, string>();

  const tagsValue = aspectValue(tags.value) as { tags?: Array<{ tag?: string }> } | null;
  const tagList = (Array.isArray(tagsValue?.tags) ? tagsValue.tags : [])
    .map((entry) => entry.tag)
    .filter((tag): tag is string => typeof tag === "string");
  const lineageguardTags = tagList.filter((tag) => tag.includes("lineageguard"));

  return inspected({
    markers,
    decisionElementCount: decisionElements.length,
    totalElementCount: elements.length,
    fields,
    lineageguardTags,
    duplicateTags: new Set(lineageguardTags).size !== lineageguardTags.length,
  });
}

// ─── Local sandbox hygiene ───────────────────────────────────────────────────

/**
 * Validator containers currently present.
 *
 * Distinguishes "docker answered, nothing is running" from "docker could not be queried"; the
 * previous harness returned `[]` for both and therefore reported zero leaks when Docker was down.
 */
export async function listValidatorContainers(): Promise<Inspection<readonly string[]>> {
  try {
    const { stdout } = await run("docker", ["ps", "-a", "--format", "{{.Names}}"]);
    return inspected(
      stdout
        .split("\n")
        .map((name) => name.trim())
        .filter((name) => name.startsWith("lineageguard") && name.includes("validation")),
    );
  } catch (error) {
    return uninspectable(
      `docker ps failed: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}

export async function listValidationWorktrees(): Promise<Inspection<readonly string[]>> {
  try {
    const { stdout } = await run("git", ["worktree", "list", "--porcelain"]);
    return inspected(
      stdout
        .split("\n")
        .filter((line) => line.startsWith("worktree "))
        .map((line) => line.slice("worktree ".length))
        .filter((path) => path.includes("validation") || path.includes("sandbox")),
    );
  } catch (error) {
    return uninspectable(
      `git worktree list failed: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}

// ─── Candidate helpers ───────────────────────────────────────────────────────

export type CandidateArtifact = Readonly<{ path: string; content: string; operation?: string }>;

export type CandidateView = Readonly<{
  strategy: string;
  artifacts: readonly CandidateArtifact[];
  sourceChangeFingerprint: string;
  sourcePatchFingerprint: string;
  sourceImpactContextFingerprint: string;
}>;

/** Reads the persisted candidate defensively; acceptance must not assume its own writer's shape. */
export function candidateView(candidateJson: unknown): Inspection<CandidateView> {
  if (!candidateJson || typeof candidateJson !== "object") {
    return uninspectable("no persisted candidate to inspect");
  }
  const candidate = candidateJson as Record<string, unknown>;
  const artifacts = candidate.artifacts;
  if (!Array.isArray(artifacts) || artifacts.length === 0) {
    return uninspectable("persisted candidate carries no artifacts");
  }
  const mapped: CandidateArtifact[] = [];
  for (const entry of artifacts) {
    if (!entry || typeof entry !== "object")
      return uninspectable("candidate artifact is malformed");
    const artifact = entry as Record<string, unknown>;
    if (typeof artifact.path !== "string" || typeof artifact.content !== "string") {
      return uninspectable("candidate artifact is missing path or content");
    }
    mapped.push({
      path: artifact.path,
      content: artifact.content,
      ...(typeof artifact.operation === "string" ? { operation: artifact.operation } : {}),
    });
  }
  const strings = (key: string): string =>
    typeof candidate[key] === "string" ? (candidate[key] as string) : "";
  return inspected({
    strategy: strings("strategy"),
    artifacts: mapped,
    sourceChangeFingerprint: strings("sourceChangeFingerprint"),
    sourcePatchFingerprint: strings("sourcePatchFingerprint"),
    sourceImpactContextFingerprint: strings("sourceImpactContextFingerprint"),
  });
}

/** The semantic decision identity this candidate must own in DataHub. */
export function expectedDecisionMarker(candidateFingerprint: string): string {
  return decisionMarker(candidateFingerprint);
}

export { sha256Bytes };
