import { afterEach, describe, expect, it, vi } from "vitest";
import {
  canonicalCandidateFingerprint,
  decisionMarker,
  generatedBranchName,
} from "./effect-identity.js";
import { createGitHubPort, createWritebackPort } from "./orchestration.js";

const ORIGINAL_ENV = { ...process.env };

afterEach(() => {
  vi.unstubAllGlobals();
  for (const key of Object.keys(process.env)) {
    if (!(key in ORIGINAL_ENV)) delete process.env[key];
  }
  for (const [key, value] of Object.entries(ORIGINAL_ENV)) {
    process.env[key] = value;
  }
});

function githubEnv() {
  process.env.GITHUB_TOKEN = "test-github-token";
  process.env.GITHUB_OWNER = "org";
  process.env.GITHUB_REPO = "walkthrough";
}

function jsonResponse(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function reviewInput(
  overrides: Partial<
    Parameters<NonNullable<ReturnType<typeof createGitHubPort>>["createReview"]>[0]
  > = {},
) {
  return {
    runId: "run_test_0000000000000001",
    candidate: {
      strategy: "EXPAND_MIGRATE_CONTRACT",
      sourceChangeFingerprint: "1".repeat(64),
      sourcePatchFingerprint: "2".repeat(64),
      sourceImpactContextFingerprint: "3".repeat(64),
      sourceDecision: "BLOCK",
      sourceEvidenceIds: ["ev_0123456789abcdef01234567"],
      artifacts: [
        {
          path: "docs/migrations/customer-id.md",
          kind: "MIGRATION_DOCUMENT",
          content: "# Migration\n",
        },
      ],
    } as never,
    comparison: { transition: "ALLOW→BLOCK", triggeredRuleIds: ["LG001"] } as never,
    context: { evidence: [{ kind: "SCHEMA" }] } as never,
    ...overrides,
  };
}

type RecoveryPull = { html_url: string; number: number; draft: boolean };

interface RecoveryFakeState {
  pulls: RecoveryPull[];
  calls: Array<{ url: string; method: string }>;
  branchName: string;
  baseSha: string;
  localCommitSha: string;
  remoteHeadSha: string;
  branchCreated: boolean;
}

function recoveryReadResponse(state: RecoveryFakeState, url: string): Response {
  if (url.endsWith("/git/ref/heads/main")) return jsonResponse({ object: { sha: state.baseSha } });
  if (url.endsWith(`/git/ref/heads/${state.branchName}`)) {
    return state.branchCreated
      ? jsonResponse({ object: { sha: state.remoteHeadSha } })
      : jsonResponse({ message: "Not Found" }, 404);
  }
  if (url.endsWith("/git/blobs/blob-sha")) {
    return jsonResponse({
      encoding: "base64",
      content: Buffer.from("# Migration\n").toString("base64"),
    });
  }
  if (url.endsWith(`/git/commits/${state.baseSha}`))
    return jsonResponse({ tree: { sha: "base-tree-sha" } });
  if (url.endsWith(`/git/commits/${state.remoteHeadSha}`)) {
    return jsonResponse({
      parents: [{ sha: state.baseSha }],
      tree: { sha: "head-tree-sha" },
    });
  }
  if (url.endsWith("/git/trees/base-tree-sha?recursive=1"))
    return jsonResponse({ truncated: false, tree: [] });
  if (url.endsWith("/git/trees/head-tree-sha?recursive=1")) {
    return jsonResponse({
      truncated: false,
      tree: [
        {
          path: "docs/migrations/customer-id.md",
          mode: "100644",
          type: "blob",
          sha: "blob-sha",
        },
      ],
    });
  }
  if (url.includes(`/pulls?state=open&head=org:${state.branchName}`))
    return jsonResponse(state.pulls);
  throw new Error(`Unexpected fetch: GET ${url}`);
}

function recoveryWriteResponse(state: RecoveryFakeState, url: string): Response {
  if (url.endsWith("/git/blobs")) return jsonResponse({ sha: "blob-sha" });
  if (url.endsWith("/git/trees")) return jsonResponse({ sha: "head-tree-sha" });
  if (url.endsWith("/git/commits")) return jsonResponse({ sha: state.localCommitSha });
  if (url.endsWith("/git/refs")) {
    state.branchCreated = true;
    return jsonResponse({ ref: `refs/heads/${state.branchName}` });
  }
  if (url.endsWith("/pulls")) {
    return jsonResponse({ message: "Response lost after creation" }, 502);
  }
  throw new Error(`Unexpected fetch: POST ${url}`);
}

function installPrRecoveryFake(options: { pulls: RecoveryPull[]; remoteHeadSha?: string }) {
  const input = reviewInput();
  const state: RecoveryFakeState = {
    pulls: options.pulls,
    calls: [],
    branchName: generatedBranchName(canonicalCandidateFingerprint(input.candidate)),
    baseSha: "a".repeat(40),
    localCommitSha: "c".repeat(40),
    remoteHeadSha: options.remoteHeadSha ?? "c".repeat(40),
    branchCreated: false,
  };
  vi.stubGlobal("fetch", async (url: string, init?: RequestInit) => {
    const method = init?.method ?? "GET";
    state.calls.push({ url, method });
    return method === "GET" ? recoveryReadResponse(state, url) : recoveryWriteResponse(state, url);
  });
  return { calls: state.calls, input };
}

describe("createGitHubPort", () => {
  it("returns undefined when GITHUB_TOKEN/OWNER/REPO are not configured", () => {
    delete process.env.GITHUB_TOKEN;
    delete process.env.GITHUB_OWNER;
    delete process.env.GITHUB_REPO;
    expect(createGitHubPort()).toBeUndefined();
  });

  it("recovers an exact lost PR-create response without issuing a second write", async () => {
    githubEnv();
    const { calls, input } = installPrRecoveryFake({
      pulls: [{ html_url: "https://github.com/org/walkthrough/pull/7", number: 7, draft: true }],
    });

    const port = createGitHubPort();
    if (!port) throw new Error("GitHub port should be configured");
    const result = await port.createReview(input);

    expect(result).toMatchObject({ prNumber: 7, outcome: "CREATED" });
    expect(calls.filter((c) => c.url.endsWith("/pulls") && c.method === "POST")).toHaveLength(1);
    expect(calls.filter((call) => call.method !== "GET")).toHaveLength(5);
    expect(calls.some((call) => call.method === "PATCH")).toBe(false);
  });

  it("rejects lost-response recovery when the remote head moved from the local commit", async () => {
    githubEnv();
    const { input } = installPrRecoveryFake({
      pulls: [{ html_url: "https://github.com/org/walkthrough/pull/7", number: 7, draft: true }],
      remoteHeadSha: "d".repeat(40),
    });
    const port = createGitHubPort();
    if (!port) throw new Error("GitHub port should be configured");

    await expect(port.createReview(input)).rejects.toThrow(/exact recovery failed.*head/i);
  });

  it.each([
    {
      name: "duplicate",
      pulls: [
        { html_url: "https://github.com/org/walkthrough/pull/7", number: 7, draft: true },
        { html_url: "https://github.com/org/walkthrough/pull/8", number: 8, draft: true },
      ],
    },
    {
      name: "non-draft",
      pulls: [{ html_url: "https://github.com/org/walkthrough/pull/7", number: 7, draft: false }],
    },
  ])("rejects $name PR-create recovery", async ({ pulls }) => {
    githubEnv();
    const { input } = installPrRecoveryFake({ pulls });
    const port = createGitHubPort();
    if (!port) throw new Error("GitHub port should be configured");

    await expect(port.createReview(input)).rejects.toThrow("GitHub PR creation failed");
  });

  it("propagates a clear error when PR creation fails and no existing PR can be found", async () => {
    githubEnv();
    const { input } = installPrRecoveryFake({ pulls: [] });

    const port = createGitHubPort();
    if (!port) throw new Error("GitHub port should be configured");

    await expect(port.createReview(input)).rejects.toThrow(
      /GitHub PR creation failed and exact recovery failed/,
    );
  });

  it("propagates the underlying error when the base branch cannot be resolved", async () => {
    githubEnv();
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => jsonResponse({ message: "Not Found" }, 404)),
    );

    const port = createGitHubPort();
    if (!port) throw new Error("GitHub port should be configured");

    await expect(port.createReview(reviewInput())).rejects.toThrow();
  });
});

function writebackEnv() {
  process.env.DATAHUB_MUTATION_TOKEN = "mutation-token-value";
  process.env.DATAHUB_READ_TOKEN = "read-token-value";
  process.env.WRITEBACK_ENABLED = "true";
}

function writebackInput() {
  return {
    runId: "run_test_0000000000000002",
    comparison: { grounded: { decision: "BLOCK" }, triggeredRuleIds: ["LG001"] } as never,
    context: { evidence: [] } as never,
    candidate: {
      strategy: "EXPAND_MIGRATE_CONTRACT",
      sourceChangeFingerprint: "1".repeat(64),
      sourcePatchFingerprint: "2".repeat(64),
      sourceImpactContextFingerprint: "3".repeat(64),
      sourceDecision: "BLOCK",
      sourceEvidenceIds: ["ev_0123456789abcdef01234567"],
      artifacts: [],
    } as never,
    githubPrUrl: "https://github.com/org/walkthrough/pull/1",
    githubReceiptFingerprint: "f".repeat(64),
    validationReceiptFingerprint: "e".repeat(64),
  };
}

/**
 * The exact institutional-memory description the writeback port composes for an input.
 *
 * Derived here from the same inputs and the same identity function rather than hardcoded, so the
 * idempotency tests below distinguish "byte-identical decision" from "same decision, newer run".
 */
function expectedDecisionDocument(input: ReturnType<typeof writebackInput>): string {
  const candidate = input.candidate as unknown as Parameters<
    typeof canonicalCandidateFingerprint
  >[0];
  return [
    `Marker: ${decisionMarker(canonicalCandidateFingerprint(candidate))}`,
    "Decision: BLOCK",
    `Latest verified run: ${input.runId}`,
    "Source field: customer_id",
    "Replacement field: buyer_id",
    "Compatibility window: 30 days",
    "Reasons: LG001",
    "Candidate: EXPAND_MIGRATE_CONTRACT",
    `Validation receipt: ${input.validationReceiptFingerprint.slice(0, 16)}`,
    `GitHub review: ${input.githubPrUrl}`,
    `GitHub receipt: ${input.githubReceiptFingerprint.slice(0, 16)}`,
    "Rollback: walkthrough/migrations/001_rollback.sql",
  ].join("\n");
}

describe("createWritebackPort", () => {
  it("returns undefined when DATAHUB_MUTATION_TOKEN is not configured", () => {
    delete process.env.DATAHUB_MUTATION_TOKEN;
    expect(createWritebackPort()).toBeUndefined();
  });

  it("returns undefined when WRITEBACK_ENABLED=false even with a token set", () => {
    process.env.DATAHUB_MUTATION_TOKEN = "mutation-token-value";
    process.env.WRITEBACK_ENABLED = "false";
    expect(createWritebackPort()).toBeUndefined();
  });

  it("refuses to read using the mutation token when no separate read token is set", async () => {
    process.env.DATAHUB_MUTATION_TOKEN = "mutation-token-value";
    delete process.env.DATAHUB_READ_TOKEN;
    delete process.env.DATAHUB_TOKEN;
    process.env.WRITEBACK_ENABLED = "true";

    const port = createWritebackPort();
    if (!port) throw new Error("Writeback port should be configured");

    await expect(port.write(writebackInput())).rejects.toThrow(
      /DATAHUB_READ_TOKEN.*separately from DATAHUB_MUTATION_TOKEN/,
    );
  });

  it("refuses to proceed when DATAHUB_READ_TOKEN equals DATAHUB_MUTATION_TOKEN", async () => {
    process.env.DATAHUB_MUTATION_TOKEN = "shared-token-value";
    process.env.DATAHUB_READ_TOKEN = "shared-token-value";
    process.env.WRITEBACK_ENABLED = "true";

    const port = createWritebackPort();
    if (!port) throw new Error("Writeback port should be configured");

    await expect(port.write(writebackInput())).rejects.toThrow(
      /DATAHUB_READ_TOKEN to differ from DATAHUB_MUTATION_TOKEN/,
    );
  });

  it("fails when the write mutation itself is rejected by DataHub", async () => {
    writebackEnv();
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string, init?: RequestInit) => {
        const method = init?.method ?? "GET";
        if (method === "GET") return jsonResponse(null, 404); // no existing aspects
        if (url.includes("ingestProposal")) return jsonResponse({ message: "server error" }, 500);
        throw new Error(`Unexpected fetch: ${method} ${url}`);
      }),
    );

    const port = createWritebackPort();
    if (!port) throw new Error("Writeback port should be configured");

    await expect(port.write(writebackInput())).rejects.toThrow(/tag writeback failed/);
  });

  it("fails when read-after-write does not show the expected tag (verification mismatch)", async () => {
    writebackEnv();
    let ingestCalls = 0;
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string, init?: RequestInit) => {
        const method = init?.method ?? "GET";
        if (url.includes("ingestProposal")) {
          ingestCalls += 1;
          return jsonResponse({ status: "ok" });
        }
        if (method === "GET") {
          // Every read (before AND after) returns empty — write never actually lands.
          return jsonResponse(null, 404);
        }
        throw new Error(`Unexpected fetch: ${method} ${url}`);
      }),
    );

    const port = createWritebackPort();
    if (!port) throw new Error("Writeback port should be configured");

    await expect(port.write(writebackInput())).rejects.toThrow(
      /Reviewed tag not found on read-back/,
    );
    expect(ingestCalls).toBe(2); // tags + document — both attempted before verification caught the mismatch
  });

  it("preserves unrelated existing tags and institutional-memory elements on write", async () => {
    writebackEnv();
    const existingTagsAspect = {
      aspect: { value: JSON.stringify({ tags: [{ tag: "urn:li:tag:team-finance" }] }) },
    };
    const existingMemoryAspect = {
      aspect: {
        value: JSON.stringify({
          elements: [{ url: "https://example.invalid", description: "unrelated note" }],
        }),
      },
    };
    let tagBody: { proposal?: { aspect?: { value?: string } } } | undefined;
    let readCount = 0;
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string, init?: RequestInit) => {
        const method = init?.method ?? "GET";
        if (method === "GET" && url.includes("aspect=globalTags")) {
          readCount += 1;
          // First read = before-snapshot (has the pre-existing tag).
          // Second read = after-snapshot (must reflect the merged write).
          if (readCount === 1) return jsonResponse(existingTagsAspect);
          return jsonResponse({
            aspect: {
              value: JSON.stringify({
                tags: [
                  { tag: "urn:li:tag:team-finance" },
                  { tag: "urn:li:tag:lineageguard-canonical.Reviewed" },
                  { tag: "urn:li:tag:lineageguard-canonical.Critical" },
                  { tag: "urn:li:tag:lineageguard-canonical.Production" },
                ],
              }),
            },
          });
        }
        if (method === "GET" && url.includes("aspect=institutionalMemory")) {
          return jsonResponse({
            aspect: {
              value: JSON.stringify({
                elements: [
                  { url: "https://example.invalid", description: "unrelated note" },
                  {
                    url: "https://github.com/org/walkthrough/pull/1",
                    description: "lineageguard:decision:v1:candidate-46c580779287ba5f",
                  },
                ],
              }),
            },
          });
        }
        if (url.includes("ingestProposal")) {
          const body = JSON.parse((init?.body as string) ?? "{}") as {
            proposal?: { aspectName?: string; aspect?: { value?: string } };
          };
          if (body.proposal?.aspectName === "globalTags") tagBody = body;
          return jsonResponse({ status: "ok" });
        }
        throw new Error(`Unexpected fetch: ${method} ${url}`);
      }),
    );

    const port = createWritebackPort();
    if (!port) throw new Error("Writeback port should be configured");
    const result = await port.write(writebackInput());

    expect(result.status).toBe("SUCCEEDED");
    const writtenTags = JSON.parse(tagBody?.proposal?.aspect?.value ?? "{}") as {
      tags?: Array<{ tag: string }>;
    };
    expect(writtenTags.tags?.some((t) => t.tag === "urn:li:tag:team-finance")).toBe(true);
    expect(
      writtenTags.tags?.some((t) => t.tag === "urn:li:tag:lineageguard-canonical.Reviewed"),
    ).toBe(true);
  });

  it("is idempotent: performs no mutation when the remembered decision is already current", async () => {
    writebackEnv();
    let ingestCalls = 0;
    const current = expectedDecisionDocument(writebackInput());
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string, init?: RequestInit) => {
        const method = init?.method ?? "GET";
        if (url.includes("ingestProposal")) {
          ingestCalls += 1;
          return jsonResponse({ status: "ok" });
        }
        if (method === "GET" && url.includes("aspect=globalTags")) {
          return jsonResponse({
            aspect: {
              value: JSON.stringify({
                tags: [{ tag: "urn:li:tag:lineageguard-canonical.Reviewed" }],
              }),
            },
          });
        }
        if (method === "GET" && url.includes("aspect=institutionalMemory")) {
          return jsonResponse({
            aspect: { value: JSON.stringify({ elements: [{ description: current }] }) },
          });
        }
        throw new Error(`Unexpected fetch: ${method} ${url}`);
      }),
    );

    const port = createWritebackPort();
    if (!port) throw new Error("Writeback port should be configured");
    const result = await port.write(writebackInput());

    expect(result.status).toBe("SUCCEEDED");
    expect(ingestCalls).toBe(0); // no mutation performed — idempotent short-circuit
  });

  it("refreshes the one decision document when the same decision names an older run", async () => {
    writebackEnv();
    const staleRunId = "run_test_0000000000000001";
    const stale = expectedDecisionDocument(writebackInput()).replace(
      `Latest verified run: ${writebackInput().runId}`,
      `Latest verified run: ${staleRunId}`,
    );
    const documentWrites: string[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string, init?: RequestInit) => {
        const method = init?.method ?? "GET";
        if (url.includes("ingestProposal")) {
          const body = JSON.parse(String(init?.body ?? "{}")) as {
            proposal?: { aspectName?: string; aspect?: { value?: string } };
          };
          if (body.proposal?.aspectName === "institutionalMemory") {
            documentWrites.push(body.proposal.aspect?.value ?? "");
          }
          return jsonResponse({ status: "ok" });
        }
        if (method === "GET" && url.includes("aspect=globalTags")) {
          return jsonResponse({
            aspect: {
              value: JSON.stringify({
                tags: [{ tag: "urn:li:tag:lineageguard-canonical.Reviewed" }],
              }),
            },
          });
        }
        if (method === "GET" && url.includes("aspect=institutionalMemory")) {
          // Read-after-write verification re-reads; serve the refreshed document once written.
          const latest = documentWrites.at(-1);
          if (latest !== undefined) return jsonResponse({ aspect: { value: latest } });
          return jsonResponse({
            aspect: { value: JSON.stringify({ elements: [{ description: stale }] }) },
          });
        }
        throw new Error(`Unexpected fetch: ${method} ${url}`);
      }),
    );

    const port = createWritebackPort();
    if (!port) throw new Error("Writeback port should be configured");
    const result = await port.write(writebackInput());

    expect(result.status).toBe("SUCCEEDED");
    expect(documentWrites.length).toBe(1);
    const written = JSON.parse(documentWrites[0] ?? "{}") as {
      elements?: Array<{ description?: string }>;
    };
    const decisions = (written.elements ?? []).filter((element) =>
      element.description?.includes("lineageguard:decision:v1:"),
    );
    // Exactly one decision element survives, and it names the current run — the identity is stable
    // while the verified-run reference is not allowed to go stale.
    expect(decisions.length).toBe(1);
    expect(decisions[0]?.description).toContain(`Latest verified run: ${writebackInput().runId}`);
    expect(decisions[0]?.description).not.toContain(staleRunId);
  });
});
