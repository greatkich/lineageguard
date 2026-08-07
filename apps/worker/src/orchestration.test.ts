import { afterEach, describe, expect, it, vi } from "vitest";
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

describe("createGitHubPort", () => {
  it("returns undefined when GITHUB_TOKEN/OWNER/REPO are not configured", () => {
    delete process.env.GITHUB_TOKEN;
    delete process.env.GITHUB_OWNER;
    delete process.env.GITHUB_REPO;
    expect(createGitHubPort()).toBeUndefined();
  });

  it("finds and returns the existing PR when creation fails because one is already open", async () => {
    githubEnv();
    const calls: Array<{ url: string; method: string }> = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string, init?: RequestInit) => {
        const method = init?.method ?? "GET";
        calls.push({ url, method });
        if (url.endsWith("/git/ref/heads/main"))
          return jsonResponse({ object: { sha: "a".repeat(40) } });
        if (url.endsWith("/git/blobs")) return jsonResponse({ sha: "blob-sha" });
        if (url.includes("/git/commits/") && method === "GET")
          return jsonResponse({ tree: { sha: "tree-sha" } });
        if (url.endsWith("/git/trees")) return jsonResponse({ sha: "new-tree-sha" });
        if (url.endsWith("/git/commits") && method === "POST")
          return jsonResponse({ sha: "c".repeat(40) });
        if (url.endsWith("/git/refs") && method === "POST")
          return jsonResponse({ ref: "refs/heads/lineageguard/run-run_test_0000000000000001" });
        if (url.endsWith("/pulls") && method === "POST") {
          // Simulate GitHub rejecting creation because a PR for this head already exists.
          return jsonResponse({ message: "A pull request already exists" }, 422);
        }
        if (url.includes("/pulls?state=open")) {
          return jsonResponse([
            { html_url: "https://github.com/org/walkthrough/pull/7", number: 7 },
          ]);
        }
        throw new Error(`Unexpected fetch: ${method} ${url}`);
      }),
    );

    const port = createGitHubPort();
    if (!port) throw new Error("GitHub port should be configured");
    const result = await port.createReview(reviewInput());

    expect(result.prUrl).toBe("https://github.com/org/walkthrough/pull/7");
    expect(result.prNumber).toBe(7);
    // Exactly one POST to /pulls (the failed create) — no duplicate creation retry.
    expect(calls.filter((c) => c.url.endsWith("/pulls") && c.method === "POST")).toHaveLength(1);
  });

  it("propagates a clear error when PR creation fails and no existing PR can be found", async () => {
    githubEnv();
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string, init?: RequestInit) => {
        const method = init?.method ?? "GET";
        if (url.endsWith("/git/ref/heads/main"))
          return jsonResponse({ object: { sha: "a".repeat(40) } });
        if (url.endsWith("/git/blobs")) return jsonResponse({ sha: "blob-sha" });
        if (url.includes("/git/commits/") && method === "GET")
          return jsonResponse({ tree: { sha: "tree-sha" } });
        if (url.endsWith("/git/trees")) return jsonResponse({ sha: "new-tree-sha" });
        if (url.endsWith("/git/commits") && method === "POST")
          return jsonResponse({ sha: "c".repeat(40) });
        if (url.endsWith("/git/refs") && method === "POST")
          return jsonResponse({ ref: "refs/heads/x" });
        if (url.endsWith("/pulls") && method === "POST") {
          return jsonResponse({ message: "Validation failed" }, 422);
        }
        if (url.includes("/pulls?state=open")) {
          return jsonResponse([]); // no existing PR — genuine failure, not idempotency
        }
        throw new Error(`Unexpected fetch: ${method} ${url}`);
      }),
    );

    const port = createGitHubPort();
    if (!port) throw new Error("GitHub port should be configured");

    await expect(port.createReview(reviewInput())).rejects.toThrow(
      /GitHub PR creation failed and no existing PR found/,
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

  it("is idempotent: skips re-writing when the decision marker and tag already exist", async () => {
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
            aspect: {
              value: JSON.stringify({
                elements: [
                  {
                    description: "lineageguard:decision:v1:candidate-46c580779287ba5f",
                  },
                ],
              }),
            },
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
});
