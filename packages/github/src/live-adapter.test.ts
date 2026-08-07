import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";
import {
  type GitHubEffectAuthorityPort,
  GitHubEffectError,
  type GitHubHttpRequest,
  type GitHubHttpResponse,
  type GitHubHttpTransport,
  type GitHubReviewRequest,
  githubEffectFingerprint,
  LiveGitHubPort,
  sha256Bytes,
} from "./index.js";

const fixture = JSON.parse(
  await readFile(new URL("./fixtures/github-contract.json", import.meta.url), "utf8"),
) as Record<string, unknown>;

const hex = (character: string) => character.repeat(64);
const sha = (character: string) => character.repeat(40);

function request(): GitHubReviewRequest {
  const content = "select customer_id as buyer_id\n";
  const input: GitHubReviewRequest = {
    effectReservationId: "reservation_0123456789abcdef0123456789abcdef",
    runId: "run_0123456789abcdef01234567",
    effectKind: "GITHUB_WRITE",
    target: `https://api.github.com/repos/lineageguard/demo/git/ref/heads/main#${sha("a")}`,
    idempotencyKey: "github:run_0123456789abcdef01234567:review",
    intentFingerprint: hex("1"),
    inputFingerprint: hex("0"),
    repository: "lineageguard/demo",
    baseBranch: "main",
    baseSha: sha("a"),
    candidateFingerprint: hex("2"),
    artifactSetFingerprint: hex("3"),
    validationReceiptFingerprint: hex("4"),
    approvalFingerprint: hex("6"),
    validation: {
      runId: "run_0123456789abcdef01234567",
      candidateFingerprint: hex("2"),
      artifactSetFingerprint: hex("3"),
      receiptFingerprint: hex("4"),
      artifacts: [
        {
          path: "walkthrough/models/orders.sql",
          candidateArtifactFingerprint: hex("5"),
          materializedSha256: sha256Bytes(content),
        },
      ],
    },
    artifacts: [
      {
        path: "walkthrough/models/orders.sql",
        content,
        candidateArtifactFingerprint: hex("5"),
        operation: "MODIFY",
        expectedBaseBlobSha: sha("9"),
      },
    ],
    title: "Safe customer identifier migration",
    body: {
      summary: "Expand, migrate, and contract safely.",
      reasonEvidenceIds: ["ev_0123456789abcdef01234567"],
      rolloutSteps: ["Deploy additive field", "Migrate consumers"],
      rollbackSteps: ["Run the validated rollback artifact"],
    },
  };
  input.inputFingerprint = githubEffectFingerprint(input);
  return input;
}

function createExistingPathRequest(path = "walkthrough/models/orders.sql"): GitHubReviewRequest {
  const input = request();
  const artifact = input.artifacts[0];
  const observation = input.validation.artifacts[0];
  if (!artifact || !observation) throw new Error("test fixture is missing its artifact");
  input.artifacts = [
    {
      path,
      content: artifact.content,
      candidateArtifactFingerprint: artifact.candidateArtifactFingerprint,
      operation: "CREATE",
    },
  ];
  input.validation = {
    ...input.validation,
    artifacts: [{ ...observation, path }],
  };
  input.inputFingerprint = githubEffectFingerprint(input);
  return input;
}

class TrustedAuthority implements GitHubEffectAuthorityPort {
  readonly calls: string[] = [];
  constructor(
    private readonly fingerprint = request().inputFingerprint,
    private readonly state: "RESERVED" | "CONSUMED" = "RESERVED",
  ) {}
  async verifyCurrentEffectReservation(_input: {
    canonicalEffectFingerprint: string;
    signal: AbortSignal;
  }) {
    this.calls.push("verify");
    return {
      reservationId: request().effectReservationId,
      canonicalEffectFingerprint: this.fingerprint,
      state: this.state,
      invokeBy: new Date(Date.now() + 60_000).toISOString(),
    };
  }
  async consumeCurrentEffect(input: { canonicalEffectFingerprint: string; signal: AbortSignal }) {
    this.calls.push("consume");
    return {
      canonicalEffectFingerprint: input.canonicalEffectFingerprint,
      invokeBy: new Date(Date.now() + 60_000).toISOString(),
      attemptFence: "fence_0123456789abcdef0123456789abcdef",
    };
  }
}

class ScriptedTransport implements GitHubHttpTransport {
  readonly calls: GitHubHttpRequest[] = [];
  constructor(private readonly responses: Array<GitHubHttpResponse | Error>) {}
  async request(input: GitHubHttpRequest): Promise<GitHubHttpResponse> {
    this.calls.push(structuredClone(input));
    const next = this.responses.shift();
    if (!next) throw new Error(`unexpected request ${input.method} ${input.url}`);
    if (next instanceof Error) throw next;
    return structuredClone(next);
  }
}

const response = (status: number, body: unknown): GitHubHttpResponse => ({
  status,
  headers: {},
  body,
});

function createPort(
  transport: GitHubHttpTransport,
  authority: GitHubEffectAuthorityPort = new TrustedAuthority(),
) {
  return new LiveGitHubPort({
    owner: "lineageguard",
    repository: "demo",
    baseBranch: "main",
    apiBaseUrl: "https://api.github.com",
    token: "test-sensitive-value",
    timeoutMs: 2_000,
    maxAttempts: 2,
    authority,
    transport,
  });
}

function successScript(): Array<GitHubHttpResponse | Error> {
  return [
    response(200, fixture.repository),
    response(200, fixture.baseRef),
    response(404, fixture.notFound),
    response(200, fixture.baseCommit),
    response(200, fixture.baseTree),
    response(201, fixture.blob),
    response(201, fixture.tree),
    response(201, fixture.commit),
    response(201, fixture.ref),
    response(200, fixture.noPulls),
    response(201, fixture.pull),
  ];
}

function reconcileScript(
  overrides: { commit?: unknown; headTree?: unknown; headBlob?: unknown; pulls?: unknown } = {},
): Array<GitHubHttpResponse | Error> {
  return [
    response(200, fixture.repository),
    response(200, fixture.baseRef),
    response(200, fixture.ref),
    response(200, overrides.commit ?? fixture.commit),
    response(200, fixture.baseCommit),
    response(200, fixture.baseTree),
    response(200, overrides.headTree ?? fixture.headTree),
    response(200, overrides.headBlob ?? fixture.headBlob),
    response(200, overrides.pulls ?? fixture.pullList),
  ];
}

describe("LiveGitHubPort", () => {
  it("creates only validated bytes on a deterministic non-force branch and one draft PR", async () => {
    const transport = new ScriptedTransport(successScript());
    const receipt = await createPort(transport).createMigrationReview(request());

    expect(receipt).toMatchObject({
      mode: "LIVE",
      repository: "lineageguard/demo",
      baseBranch: "main",
      baseSha: sha("a"),
      headBranch: "lineageguard/generated/222222222222",
      headSha: sha("e"),
      prNumber: 17,
      prUrl: "https://github.com/lineageguard/demo/pull/17",
      prState: "OPEN_DRAFT",
      candidateFingerprint: hex("2"),
      artifactSetFingerprint: hex("3"),
      validationReceiptFingerprint: hex("4"),
      inputFingerprint: request().inputFingerprint,
    });
    expect(transport.calls.map(({ method, url }) => `${method} ${url}`)).toEqual([
      "GET https://api.github.com/repos/lineageguard/demo",
      "GET https://api.github.com/repos/lineageguard/demo/git/ref/heads/main",
      "GET https://api.github.com/repos/lineageguard/demo/git/ref/heads/lineageguard%2Fgenerated%2F222222222222",
      `GET https://api.github.com/repos/lineageguard/demo/git/commits/${sha("a")}`,
      `GET https://api.github.com/repos/lineageguard/demo/git/trees/${sha("b")}?recursive=1`,
      "POST https://api.github.com/repos/lineageguard/demo/git/blobs",
      "POST https://api.github.com/repos/lineageguard/demo/git/trees",
      "POST https://api.github.com/repos/lineageguard/demo/git/commits",
      "POST https://api.github.com/repos/lineageguard/demo/git/refs",
      "GET https://api.github.com/repos/lineageguard/demo/pulls?state=all&head=lineageguard%3Alineageguard%2Fgenerated%2F222222222222&base=main&per_page=2",
      "POST https://api.github.com/repos/lineageguard/demo/pulls",
    ]);
    expect(transport.calls.find((call) => call.url.endsWith("/git/refs"))?.body).toEqual({
      ref: "refs/heads/lineageguard/generated/222222222222",
      sha: sha("e"),
    });
    expect(
      transport.calls.find((call) => call.url.endsWith("/pulls") && call.method === "POST")?.body,
    ).toMatchObject({
      draft: true,
      base: "main",
      head: "lineageguard/generated/222222222222",
    });
  });

  it.each([
    ["wrong repository", { repository: "attacker/demo" }],
    ["wrong base", { baseBranch: "release" }],
    ["wrong target", { target: "github:lineageguard/demo:release" }],
  ])("fails closed for %s before network", async (_name, change) => {
    const transport = new ScriptedTransport([]);
    await expect(
      createPort(transport).createMigrationReview({ ...request(), ...change }),
    ).rejects.toMatchObject({ code: "POLICY_REJECTED", retry: "NEVER" });
    expect(transport.calls).toHaveLength(0);
  });

  it("rejects artifact bytes that do not match the validated observation", async () => {
    const transport = new ScriptedTransport([]);
    const input = request();
    const artifact = input.artifacts[0];
    if (!artifact) throw new Error("test fixture is missing its artifact");
    input.artifacts[0] = { ...artifact, content: "tampered\n" };
    await expect(createPort(transport).createMigrationReview(input)).rejects.toMatchObject({
      code: "VALIDATION_BINDING_MISMATCH",
      retry: "NEVER",
    });
    expect(transport.calls).toHaveLength(0);
  });

  it("rejects a malformed runtime request with a classified error before network", async () => {
    const transport = new ScriptedTransport([]);
    const malformed = { ...request(), body: null } as unknown as GitHubReviewRequest;
    await expect(createPort(transport).createMigrationReview(malformed)).rejects.toMatchObject({
      code: "INVALID_INPUT",
      retry: "NEVER",
    });
    expect(transport.calls).toHaveLength(0);
  });

  it("rejects oversized and cyclic runtime requests before authority or network", async () => {
    const transport = new ScriptedTransport([]);
    const oversized = request();
    oversized.body.reasonEvidenceIds = Array.from(
      { length: 201 },
      () => "ev_0123456789abcdef01234567",
    );
    await expect(createPort(transport).createMigrationReview(oversized)).rejects.toMatchObject({
      code: "INVALID_INPUT",
    });
    const cyclic = request() as GitHubReviewRequest & { self?: unknown };
    cyclic.self = cyclic;
    await expect(createPort(transport).createMigrationReview(cyclic)).rejects.toMatchObject({
      code: "INVALID_INPUT",
    });
    const nestedCycle = request();
    const evidence = nestedCycle.body.reasonEvidenceIds as string[] & { self?: unknown };
    evidence.self = evidence;
    await expect(createPort(transport).createMigrationReview(nestedCycle)).rejects.toMatchObject({
      code: "INVALID_INPUT",
    });
    expect(transport.calls).toHaveLength(0);
  });

  it("rejects a handcrafted self-consistent PASS-shaped request before network", async () => {
    const transport = new ScriptedTransport([]);
    const input = request();
    input.approvalFingerprint = hex("f");
    input.inputFingerprint = githubEffectFingerprint(input);
    await expect(createPort(transport).createMigrationReview(input)).rejects.toMatchObject({
      code: "AUTHORIZATION_REJECTED",
      retry: "NEVER",
    });
    expect(transport.calls).toHaveLength(0);
  });

  it("does not consume authority or write when the exact base blob differs", async () => {
    const authority = new TrustedAuthority();
    const changedTree = {
      ...(fixture.baseTree as Record<string, unknown>),
      tree: [
        {
          path: "walkthrough/models/orders.sql",
          mode: "100644",
          type: "blob",
          sha: sha("8"),
        },
      ],
    };
    const transport = new ScriptedTransport([
      response(200, fixture.repository),
      response(200, fixture.baseRef),
      response(404, fixture.notFound),
      response(200, fixture.baseCommit),
      response(200, changedTree),
    ]);
    await expect(
      createPort(transport, authority).createMigrationReview(request()),
    ).rejects.toMatchObject({
      code: "REMOTE_CONFLICT",
      retry: "NEVER",
    });
    expect(authority.calls).toEqual(["verify"]);
    expect(transport.calls.every((call) => call.method === "GET")).toBe(true);
  });

  it.each([
    [
      "CREATE with a missing tree that could hide an existing path",
      createExistingPathRequest,
      { sha: sha("b"), truncated: false },
    ],
    [
      "MODIFY with a non-array tree",
      request,
      { sha: sha("b"), truncated: false, tree: { hidden: fixture.baseTree } },
    ],
  ])("rejects malformed base-tree preflight for %s", async (_name, makeRequest, treeBody) => {
    const input = makeRequest();
    const authority = new TrustedAuthority(input.inputFingerprint);
    const transport = new ScriptedTransport([
      response(200, fixture.repository),
      response(200, fixture.baseRef),
      response(404, fixture.notFound),
      response(200, fixture.baseCommit),
      response(200, treeBody),
    ]);
    await expect(
      createPort(transport, authority).createMigrationReview(input),
    ).rejects.toMatchObject({
      code: "REMOTE_FAILURE",
      operation: "READ_BASE_COMMIT",
      retry: "NEVER",
    });
    expect(authority.calls).toEqual(["verify"]);
    expect(transport.calls.every((call) => call.method === "GET")).toBe(true);
  });

  it.each([
    [
      "an exact existing tree",
      {
        path: "docs/migrations/new.md",
        mode: "040000",
        type: "tree",
        sha: sha("7"),
      },
    ],
    [
      "a non-tree ancestor",
      {
        path: "docs/migrations",
        mode: "100644",
        type: "blob",
        sha: sha("7"),
      },
    ],
    [
      "an existing descendant subtree entry",
      {
        path: "docs/migrations/new.md/hidden.sql",
        mode: "100644",
        type: "blob",
        sha: sha("7"),
      },
    ],
  ])("rejects CREATE collision with %s before consume or POST", async (_name, treeEntry) => {
    const input = createExistingPathRequest("docs/migrations/new.md");
    const authority = new TrustedAuthority(input.inputFingerprint);
    const treeBody = {
      sha: sha("b"),
      truncated: false,
      tree: [treeEntry],
    };
    const transport = new ScriptedTransport([
      response(200, fixture.repository),
      response(200, fixture.baseRef),
      response(404, fixture.notFound),
      response(200, fixture.baseCommit),
      response(200, treeBody),
    ]);
    await expect(
      createPort(transport, authority).createMigrationReview(input),
    ).rejects.toMatchObject({
      code: "REMOTE_CONFLICT",
      operation: "READ_BASE_COMMIT",
      retry: "NEVER",
    });
    expect(authority.calls).toEqual(["verify"]);
    expect(transport.calls.every((call) => call.method === "GET")).toBe(true);
  });

  it("rejects redirects without following them", async () => {
    const transport = new ScriptedTransport([response(302, { location: "https://evil.invalid" })]);
    await expect(createPort(transport).createMigrationReview(request())).rejects.toMatchObject({
      code: "REDIRECT_REJECTED",
      retry: "NEVER",
    });
    expect(transport.calls[0]?.redirect).toBe("error");
  });

  it("retries safe reads only within the configured attempt bound", async () => {
    const transport = new ScriptedTransport([
      response(503, fixture.notFound),
      ...reconcileScript(),
    ]);
    await expect(createPort(transport).createMigrationReview(request())).resolves.toMatchObject({
      prNumber: 17,
      reconciled: true,
    });
    expect(
      transport.calls.filter(
        (call) => call.url === "https://api.github.com/repos/lineageguard/demo",
      ),
    ).toHaveLength(2);
  });

  it("enforces its own bounded deadline even when an injected transport stalls", async () => {
    const transport: GitHubHttpTransport = {
      request: async () => new Promise<GitHubHttpResponse>(() => undefined),
    };
    const port = new LiveGitHubPort({
      owner: "lineageguard",
      repository: "demo",
      baseBranch: "main",
      apiBaseUrl: "https://api.github.com",
      token: "test-sensitive-value",
      timeoutMs: 100,
      maxAttempts: 1,
      authority: new TrustedAuthority(),
      transport,
    });
    const startedAt = Date.now();
    await expect(port.createMigrationReview(request())).rejects.toMatchObject({
      code: "TRANSPORT_RETRYABLE",
      retry: "RETRY",
    });
    expect(Date.now() - startedAt).toBeLessThan(1_000);
  });

  it("aborts a stalled authority verification before network", async () => {
    let aborted = false;
    const authority: GitHubEffectAuthorityPort = {
      verifyCurrentEffectReservation: async ({ signal }) =>
        new Promise((_resolve, reject) => {
          signal.addEventListener("abort", () => {
            aborted = true;
            reject(new Error("secret authority detail"));
          });
        }),
      consumeCurrentEffect: async () => {
        throw new Error("unexpected consume");
      },
    };
    const transport = new ScriptedTransport([]);
    const port = new LiveGitHubPort({
      owner: "lineageguard",
      repository: "demo",
      baseBranch: "main",
      apiBaseUrl: "https://api.github.com",
      token: "test-sensitive-value",
      timeoutMs: 100,
      maxAttempts: 1,
      authority,
      transport,
    });
    await expect(port.createMigrationReview(request())).rejects.toMatchObject({
      code: "AUTHORIZATION_REJECTED",
      retry: "NEVER",
    });
    expect(aborted).toBe(true);
    expect(transport.calls).toHaveLength(0);
  });

  it("uses an immutable request snapshot across authority and remote awaits", async () => {
    const initial = request();
    const authority: GitHubEffectAuthorityPort = {
      verifyCurrentEffectReservation: async () => {
        await new Promise((resolve) => setTimeout(resolve, 5));
        return {
          reservationId: initial.effectReservationId,
          canonicalEffectFingerprint: initial.inputFingerprint,
          state: "RESERVED",
          invokeBy: new Date(Date.now() + 60_000).toISOString(),
        };
      },
      consumeCurrentEffect: async ({ canonicalEffectFingerprint }) => ({
        canonicalEffectFingerprint,
        invokeBy: new Date(Date.now() + 60_000).toISOString(),
        attemptFence: "fence_0123456789abcdef0123456789abcdef",
      }),
    };
    const transport = new ScriptedTransport(successScript());
    const pending = createPort(transport, authority).createMigrationReview(initial);
    initial.title = "Attacker-mutated title";
    const artifact = initial.artifacts[0];
    if (artifact) artifact.content = "tampered after invocation\n";
    await expect(pending).resolves.toMatchObject({ prNumber: 17 });
    expect(
      transport.calls.find((call) => call.method === "POST" && call.url.endsWith("/pulls"))?.body,
    ).toMatchObject({ title: "Safe customer identifier migration" });
  });

  it("reconciles an existing exact branch and PR before creating anything", async () => {
    const transport = new ScriptedTransport(reconcileScript());
    const receipt = await createPort(transport).createMigrationReview(request());
    expect(receipt.reconciled).toBe(true);
    expect(transport.calls.every((call) => call.method === "GET")).toBe(true);
  });

  it.each([
    [
      "an unrelated altered tree entry",
      {
        headTree: {
          ...(fixture.headTree as Record<string, unknown>),
          tree: [
            ...((fixture.headTree as { tree: unknown[] }).tree ?? []),
            {
              path: "docs/migrations/unapproved.md",
              mode: "100644",
              type: "blob",
              sha: sha("8"),
            },
          ],
        },
      },
    ],
    [
      "altered authorized blob bytes",
      {
        headBlob: {
          ...(fixture.headBlob as Record<string, unknown>),
          size: 9,
          content: Buffer.from("tampered\n", "utf8").toString("base64"),
        },
      },
    ],
  ])("rejects reconciliation with the same marker and parent but %s", async (_name, overrides) => {
    const transport = new ScriptedTransport(reconcileScript(overrides));
    await expect(createPort(transport).createMigrationReview(request())).rejects.toMatchObject({
      code: "REMOTE_CONFLICT",
      operation: "RECONCILE",
      retry: "NEVER",
    });
    expect(transport.calls.every((call) => call.method === "GET")).toBe(true);
  });

  it("rejects an oversized base64 blob before decoding it", async () => {
    const oversizedBlob = {
      ...(fixture.headBlob as Record<string, unknown>),
      size: 100_001,
      content: "A".repeat(133_340),
    };
    const transport = new ScriptedTransport(reconcileScript({ headBlob: oversizedBlob }));
    await expect(createPort(transport).createMigrationReview(request())).rejects.toMatchObject({
      code: "REMOTE_CONFLICT",
      retry: "NEVER",
    });
    expect(transport.calls.every((call) => call.method === "GET")).toBe(true);
  });

  it("uses the same strict parser for recursive reconciliation tree envelopes", async () => {
    const malformedHeadTree = {
      ...(fixture.headTree as Record<string, unknown>),
      unexpected: "untrusted extra field",
    };
    const transport = new ScriptedTransport(reconcileScript({ headTree: malformedHeadTree }));
    await expect(createPort(transport).createMigrationReview(request())).rejects.toMatchObject({
      code: "REMOTE_CONFLICT",
      operation: "RECONCILE",
      retry: "NEVER",
    });
    expect(transport.calls.every((call) => call.method === "GET")).toBe(true);
  });

  it("rejects a marker-matching merge commit with more than the authorized base parent", async () => {
    const commit = {
      ...(fixture.commit as Record<string, unknown>),
      parents: [{ sha: sha("a") }, { sha: sha("7") }],
    };
    const transport = new ScriptedTransport(reconcileScript({ commit }));
    await expect(createPort(transport).createMigrationReview(request())).rejects.toMatchObject({
      code: "REMOTE_CONFLICT",
      operation: "RECONCILE",
      retry: "NEVER",
    });
  });

  it.each([
    ["edited title", { title: "Edited after authorization" }],
    ["edited body with marker retained", { body: `${(fixture.pull as { body: string }).body}\n` }],
    [
      "removed rollback field",
      {
        body: (fixture.pull as { body: string }).body.replace(
          "\nRollback\n- Run the validated rollback artifact",
          "",
        ),
      },
    ],
  ])("rejects reconciliation when the PR has an %s", async (_name, pullChange) => {
    const pull = { ...(fixture.pull as Record<string, unknown>), ...pullChange };
    const transport = new ScriptedTransport(reconcileScript({ pulls: [pull] }));
    await expect(createPort(transport).createMigrationReview(request())).rejects.toMatchObject({
      code: "REMOTE_CONFLICT",
      operation: "RECONCILE",
      retry: "NEVER",
    });
  });

  it("rejects a PR whose head repository is not the single allowlisted repository", async () => {
    const original = fixture.pull as Record<string, unknown>;
    const head = {
      ...(original.head as Record<string, unknown>),
      repo: { full_name: "fork/demo" },
    };
    const transport = new ScriptedTransport(reconcileScript({ pulls: [{ ...original, head }] }));
    await expect(createPort(transport).createMigrationReview(request())).rejects.toMatchObject({
      code: "REMOTE_CONFLICT",
      operation: "RECONCILE",
      retry: "NEVER",
    });
  });

  it("reconciles after an ambiguous PR response and never creates a second PR", async () => {
    const ambiguous = new GitHubEffectError({
      code: "TRANSPORT_AMBIGUOUS",
      operation: "CREATE_PULL_REQUEST",
      retry: "RECONCILE",
      message: "response status is unknown",
    });
    const script = successScript();
    script[10] = ambiguous;
    const transport = new ScriptedTransport([...script, ...reconcileScript().slice(2)]);
    const receipt = await createPort(transport).createMigrationReview(request());
    expect(receipt.reconciled).toBe(true);
    expect(
      transport.calls.filter((call) => call.method === "POST" && call.url.endsWith("/pulls")),
    ).toHaveLength(1);
  });

  it("polls for a delayed PR after an ambiguous POST and never sends it again", async () => {
    const ambiguous = new GitHubEffectError({
      code: "TRANSPORT_AMBIGUOUS",
      operation: "CREATE_PULL_REQUEST",
      retry: "RECONCILE",
      message: "response status is unknown",
    });
    const script = successScript();
    script[10] = ambiguous;
    const transport = new ScriptedTransport([
      ...script,
      ...reconcileScript({ pulls: fixture.noPulls }).slice(2),
      ...reconcileScript().slice(2),
    ]);
    await expect(createPort(transport).createMigrationReview(request())).resolves.toMatchObject({
      reconciled: true,
      prNumber: 17,
    });
    expect(
      transport.calls.filter((call) => call.method === "POST" && call.url.endsWith("/pulls")),
    ).toHaveLength(1);
  });

  it("never resends an ambiguous blob POST and returns durable ambiguity", async () => {
    const ambiguous = new GitHubEffectError({
      code: "TRANSPORT_AMBIGUOUS",
      operation: "CREATE_BLOB",
      retry: "RECONCILE",
      message: "response status is unknown",
    });
    const script = successScript();
    script[5] = ambiguous;
    const transport = new ScriptedTransport([
      ...script.slice(0, 6),
      response(404, fixture.notFound),
      response(404, fixture.notFound),
    ]);
    await expect(createPort(transport).createMigrationReview(request())).rejects.toMatchObject({
      code: "TRANSPORT_AMBIGUOUS",
      retry: "RECONCILE",
    });
    expect(
      transport.calls.filter((call) => call.method === "POST" && call.url.endsWith("/git/blobs")),
    ).toHaveLength(1);
  });

  it("treats a malformed successful POST body as ambiguous and never resends", async () => {
    const script = successScript();
    script[5] = response(201, "malformed blob receipt");
    const transport = new ScriptedTransport([
      ...script.slice(0, 6),
      response(404, fixture.notFound),
      response(404, fixture.notFound),
    ]);
    await expect(createPort(transport).createMigrationReview(request())).rejects.toMatchObject({
      code: "TRANSPORT_AMBIGUOUS",
      retry: "RECONCILE",
    });
    expect(
      transport.calls.filter((call) => call.method === "POST" && call.url.endsWith("/git/blobs")),
    ).toHaveLength(1);
  });

  it("treats a malformed post-consume acknowledgement as ambiguous without writing", async () => {
    const valid = request();
    const authority: GitHubEffectAuthorityPort = {
      verifyCurrentEffectReservation: async () => ({
        reservationId: valid.effectReservationId,
        canonicalEffectFingerprint: valid.inputFingerprint,
        state: "RESERVED",
        invokeBy: new Date(Date.now() + 60_000).toISOString(),
      }),
      consumeCurrentEffect: async () => null as never,
    };
    const transport = new ScriptedTransport([
      ...successScript().slice(0, 5),
      response(404, fixture.notFound),
      response(404, fixture.notFound),
    ]);
    await expect(
      createPort(transport, authority).createMigrationReview(valid),
    ).rejects.toMatchObject({
      code: "TRANSPORT_AMBIGUOUS",
      retry: "RECONCILE",
    });
    expect(transport.calls.every((call) => call.method === "GET")).toBe(true);
  });

  it("reconciles first and never writes when the reservation was already consumed", async () => {
    const authority = new TrustedAuthority(request().inputFingerprint, "CONSUMED");
    const transport = new ScriptedTransport([
      response(200, fixture.repository),
      response(200, fixture.baseRef),
      response(404, fixture.notFound),
    ]);
    await expect(
      createPort(transport, authority).createMigrationReview(request()),
    ).rejects.toMatchObject({
      code: "TRANSPORT_AMBIGUOUS",
      retry: "RECONCILE",
    });
    expect(transport.calls.every((call) => call.method === "GET")).toBe(true);
    expect(authority.calls).toEqual(["verify"]);
  });

  it("fails closed when an ambiguous branch creation resolves to an altered remote tree", async () => {
    const ambiguous = new GitHubEffectError({
      code: "TRANSPORT_AMBIGUOUS",
      operation: "CREATE_REF",
      retry: "RECONCILE",
      message: "response status is unknown",
    });
    const script = successScript();
    script[8] = ambiguous;
    const alteredTree = {
      ...(fixture.headTree as Record<string, unknown>),
      tree: [
        ...((fixture.headTree as { tree: unknown[] }).tree ?? []),
        { path: "docs/migrations/unapproved.md", mode: "100644", type: "blob", sha: sha("8") },
      ],
    };
    const transport = new ScriptedTransport([
      ...script.slice(0, 9),
      ...reconcileScript({ headTree: alteredTree }).slice(2),
    ]);
    await expect(createPort(transport).createMigrationReview(request())).rejects.toMatchObject({
      code: "REMOTE_CONFLICT",
      operation: "RECONCILE",
      retry: "NEVER",
    });
    expect(
      transport.calls.filter((call) => call.method === "POST" && call.url.endsWith("/git/refs")),
    ).toHaveLength(1);
  });

  it("fails closed when an ambiguous PR response reconciles to multiple branch PRs", async () => {
    const ambiguous = new GitHubEffectError({
      code: "TRANSPORT_AMBIGUOUS",
      operation: "CREATE_PULL_REQUEST",
      retry: "RECONCILE",
      message: "response status is unknown",
    });
    const script = successScript();
    script[10] = ambiguous;
    const pull = fixture.pull as Record<string, unknown>;
    const transport = new ScriptedTransport([
      ...script,
      ...reconcileScript({ pulls: [pull, { ...pull, number: 18 }] }).slice(2),
    ]);
    await expect(createPort(transport).createMigrationReview(request())).rejects.toMatchObject({
      code: "REMOTE_CONFLICT",
      operation: "RECONCILE",
      retry: "NEVER",
    });
    expect(
      transport.calls.filter((call) => call.method === "POST" && call.url.endsWith("/pulls")),
    ).toHaveLength(1);
  });

  it("returns structured secret-safe permission failures", async () => {
    const transport = new ScriptedTransport([
      response(403, { message: "credential sensitive-value denied" }),
    ]);
    let failure: unknown;
    try {
      await createPort(transport).createMigrationReview(request());
    } catch (error) {
      failure = error;
    }
    expect(failure).toBeInstanceOf(GitHubEffectError);
    expect(failure).toMatchObject({ code: "PERMISSION_DENIED", retry: "NEVER", status: 403 });
    expect(JSON.stringify(failure)).not.toContain("sensitive-value");
    expect((failure as Error).message).not.toContain("sensitive-value");
  });
});
