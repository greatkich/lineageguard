import { renderPullRequestBody, resolveAuthorization, validInvokeBy } from "./authorization.js";
import { GitHubEffectError } from "./errors.js";
import { sha256Buffer } from "./hash.js";
import { FetchGitHubTransport } from "./transport.js";
import type {
  GitHubHttpRequest,
  GitHubHttpResponse,
  GitHubOperation,
  GitHubPort,
  GitHubReviewReceipt,
  GitHubReviewRequest,
  LiveGitHubOptions,
} from "./types.js";
import { deterministicHead, validateOptions, validateRequest } from "./validation.js";

type Json = Record<string, unknown>;

function object(value: unknown): Json | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Json)
    : undefined;
}
function text(value: unknown): string | undefined {
  return typeof value === "string" && Buffer.byteLength(value, "utf8") <= 200_000
    ? value
    : undefined;
}
function integer(value: unknown): number | undefined {
  return Number.isSafeInteger(value) && (value as number) > 0 ? (value as number) : undefined;
}
const gitObjectId = /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/;

interface TreeEntry {
  path: string;
  mode: string;
  type: string;
  sha: string;
}

function decodedBase64(value: unknown): Buffer | undefined {
  const encoded = text(value);
  if (!encoded || encoded.length > 133_336) return undefined;
  const compact = encoded.replace(/\r?\n/g, "");
  if (!/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(compact))
    return undefined;
  const decoded = Buffer.from(compact, "base64");
  if (decoded.byteLength > 100_000) return undefined;
  if (decoded.toString("base64") !== compact) return undefined;
  return decoded;
}

export class LiveGitHubPort implements GitHubPort<GitHubReviewRequest> {
  readonly #transport;
  readonly #options: LiveGitHubOptions;
  constructor(options: LiveGitHubOptions) {
    validateOptions(options);
    const { transport: _transport, ...safeOptions } = options;
    this.#options = safeOptions;
    this.#transport = options.transport ?? new FetchGitHubTransport();
  }

  async createMigrationReview(input: GitHubReviewRequest): Promise<GitHubReviewReceipt> {
    validateRequest(input, this.#options);
    const authorization = await resolveAuthorization(input, this.#options);
    await this.verifyRepositoryAndBase(input);
    const reconciled = await this.reconcile(input);
    if (reconciled) return reconciled;
    if (authorization.state === "CONSUMED") {
      throw this.ambiguous("The authorized effect was already consumed and is not yet observable");
    }
    try {
      return await this.create(input, authorization.canonicalEffectFingerprint);
    } catch (error) {
      const failure = this.normalizeTransportError(error, "RECONCILE", "RECONCILE");
      if (failure.retry === "NEVER") throw failure;
      for (let attempt = 1; attempt <= this.#options.maxAttempts; attempt += 1) {
        const found = await this.reconcile(input, true);
        if (found) return found;
        if (attempt < this.#options.maxAttempts)
          await new Promise((resolve) => setTimeout(resolve, 1));
      }
      throw this.ambiguous("GitHub write outcome remains unknown after bounded reconciliation");
    }
  }

  private ambiguous(message: string): GitHubEffectError {
    return new GitHubEffectError({
      code: "TRANSPORT_AMBIGUOUS",
      operation: "RECONCILE",
      retry: "RECONCILE",
      message,
    });
  }

  private endpoint(path: string): string {
    return `${this.#options.apiBaseUrl}/repos/${encodeURIComponent(this.#options.owner)}/${encodeURIComponent(this.#options.repository)}${path}`;
  }

  private async call(
    method: "GET" | "POST",
    path: string,
    operation: GitHubOperation,
    body?: unknown,
    accepted: readonly number[] = [200, 201],
  ): Promise<GitHubHttpResponse> {
    const attempts = method === "GET" ? this.#options.maxAttempts : 1;
    let last: GitHubEffectError | undefined;
    for (let attempt = 1; attempt <= attempts; attempt += 1) {
      try {
        const response = await this.invokeTransport({
          method,
          operation,
          url: this.endpoint(path),
          headers: {
            accept: "application/vnd.github+json",
            authorization: `Bearer ${this.#options.token}`,
            "content-type": "application/json",
            "x-github-api-version": "2022-11-28",
          },
          ...(body === undefined ? {} : { body }),
          timeoutMs: this.#options.timeoutMs,
          redirect: "error",
        });
        if (response.status >= 300 && response.status < 400)
          throw new GitHubEffectError({
            code: "REDIRECT_REJECTED",
            operation,
            retry: "NEVER",
            status: response.status,
            message: "GitHub redirect was rejected",
          });
        if (!accepted.includes(response.status)) throw this.statusError(response.status, operation);
        return response;
      } catch (error) {
        const failure = this.normalizeTransportError(
          error,
          operation,
          method === "POST" ? "RECONCILE" : "RETRY",
        );
        last = failure;
        if (failure.retry !== "RETRY" || attempt === attempts) throw failure;
      }
    }
    throw (
      last ??
      new GitHubEffectError({
        code: "REMOTE_FAILURE",
        operation,
        retry: "NEVER",
        message: "GitHub request failed",
      })
    );
  }

  private async invokeTransport(request: GitHubHttpRequest): Promise<GitHubHttpResponse> {
    let timeout: ReturnType<typeof setTimeout> | undefined;
    const deadline = new Promise<never>((_resolve, reject) => {
      timeout = setTimeout(
        () =>
          reject(
            new GitHubEffectError({
              code: request.method === "POST" ? "TRANSPORT_AMBIGUOUS" : "TRANSPORT_RETRYABLE",
              operation: request.method === "POST" ? "RECONCILE" : "VERIFY_REPOSITORY",
              retry: request.method === "POST" ? "RECONCILE" : "RETRY",
              message: "GitHub transport exceeded its deadline",
            }),
          ),
        request.timeoutMs,
      );
    });
    try {
      return await Promise.race([this.#transport.request(request), deadline]);
    } finally {
      if (timeout) clearTimeout(timeout);
    }
  }

  private normalizeTransportError(
    error: unknown,
    operation: GitHubOperation,
    retry: "RETRY" | "RECONCILE",
  ): GitHubEffectError {
    if (error instanceof GitHubEffectError) {
      return new GitHubEffectError({
        code: error.code,
        operation: error.operation,
        retry: error.retry,
        ...(error.status === undefined ? {} : { status: error.status }),
        message: "GitHub operation failed with a classified error",
      });
    }
    return new GitHubEffectError({
      code: retry === "RECONCILE" ? "TRANSPORT_AMBIGUOUS" : "TRANSPORT_RETRYABLE",
      operation,
      retry,
      message: "GitHub transport failed",
    });
  }

  private statusError(status: number, operation: GitHubOperation): GitHubEffectError {
    if (status === 401 || status === 403)
      return new GitHubEffectError({
        code: "PERMISSION_DENIED",
        operation,
        retry: "NEVER",
        status,
        message: "GitHub credential is not authorized for this operation",
      });
    if (status === 404)
      return new GitHubEffectError({
        code: "NOT_FOUND",
        operation,
        retry: "NEVER",
        status,
        message: "Allowlisted GitHub resource was not found",
      });
    if (status === 409 || status === 422)
      return new GitHubEffectError({
        code: "REMOTE_CONFLICT",
        operation,
        retry: "RECONCILE",
        status,
        message: "GitHub state conflicts with the requested effect",
      });
    if (status === 408 || status === 429)
      return new GitHubEffectError({
        code: "RATE_LIMITED",
        operation,
        retry: "RETRY",
        status,
        message: "GitHub request is temporarily unavailable",
      });
    if (status >= 500)
      return new GitHubEffectError({
        code: "REMOTE_FAILURE",
        operation,
        retry: "RETRY",
        status,
        message: "GitHub returned a temporary server failure",
      });
    return new GitHubEffectError({
      code: "REMOTE_FAILURE",
      operation,
      retry: "NEVER",
      status,
      message: "GitHub rejected the request",
    });
  }

  private async verifyRepositoryAndBase(input: GitHubReviewRequest): Promise<void> {
    const repository = object((await this.call("GET", "", "VERIFY_REPOSITORY")).body);
    const permissions = object(repository?.permissions);
    if (
      text(repository?.full_name) !== input.repository ||
      permissions?.push !== true ||
      permissions?.pull !== true ||
      permissions?.admin === true
    ) {
      throw new GitHubEffectError({
        code: "PERMISSION_DENIED",
        operation: "VERIFY_REPOSITORY",
        retry: "NEVER",
        message:
          "Repository identity or least-privilege credential capabilities do not match policy",
      });
    }
    const base = object(
      (
        await this.call(
          "GET",
          `/git/ref/heads/${encodeURIComponent(input.baseBranch)}`,
          "VERIFY_BASE",
        )
      ).body,
    );
    const baseObject = object(base?.object);
    if (
      text(base?.ref) !== `refs/heads/${input.baseBranch}` ||
      text(baseObject?.type) !== "commit" ||
      text(baseObject?.sha) !== input.baseSha ||
      !gitObjectId.test(input.baseSha)
    ) {
      throw new GitHubEffectError({
        code: "REMOTE_CONFLICT",
        operation: "VERIFY_BASE",
        retry: "NEVER",
        message: "Base branch no longer points at the validated base commit",
      });
    }
  }

  private commitMessage(input: GitHubReviewRequest): string {
    return `LineageGuard migration for ${input.runId}\n\nLineageGuard-Effect: ${input.intentFingerprint}`;
  }
  private pullBody(input: GitHubReviewRequest): string {
    return renderPullRequestBody(input);
  }

  private async readTree(treeSha: string): Promise<Map<string, TreeEntry>> {
    const response = object(
      (await this.call("GET", `/git/trees/${treeSha}?recursive=1`, "RECONCILE")).body,
    );
    const entries = Array.isArray(response?.tree) ? response.tree : undefined;
    if (
      text(response?.sha) !== treeSha ||
      response?.truncated !== false ||
      !entries ||
      entries.length > 20_000
    ) {
      throw new GitHubEffectError({
        code: "REMOTE_CONFLICT",
        operation: "RECONCILE",
        retry: "NEVER",
        message: "Remote commit tree cannot be reconciled completely",
      });
    }
    const result = new Map<string, TreeEntry>();
    for (const raw of entries) {
      const entry = object(raw);
      const path = text(entry?.path);
      const mode = text(entry?.mode);
      const type = text(entry?.type);
      const sha = text(entry?.sha);
      if (
        !path ||
        path.length > 240 ||
        !mode ||
        mode.length > 12 ||
        !type ||
        type.length > 16 ||
        !sha ||
        !gitObjectId.test(sha) ||
        result.has(path)
      ) {
        throw new GitHubEffectError({
          code: "REMOTE_CONFLICT",
          operation: "RECONCILE",
          retry: "NEVER",
          message: "Remote commit tree contains malformed or duplicate entries",
        });
      }
      if (type !== "tree") result.set(path, { path, mode, type, sha });
    }
    return result;
  }

  private async verifyReconciledArtifacts(
    input: GitHubReviewRequest,
    headTreeSha: string,
  ): Promise<void> {
    const baseCommit = object(
      (await this.call("GET", `/git/commits/${input.baseSha}`, "RECONCILE")).body,
    );
    const baseTreeSha = text(object(baseCommit?.tree)?.sha);
    if (text(baseCommit?.sha) !== input.baseSha || !baseTreeSha || !gitObjectId.test(baseTreeSha)) {
      throw new GitHubEffectError({
        code: "REMOTE_CONFLICT",
        operation: "RECONCILE",
        retry: "NEVER",
        message: "Validated base commit cannot be reconciled",
      });
    }
    const [baseTree, headTree] = await Promise.all([
      this.readTree(baseTreeSha),
      this.readTree(headTreeSha),
    ]);
    const artifacts = new Map(input.artifacts.map((artifact) => [artifact.path, artifact]));
    const observations = new Map(
      input.validation.artifacts.map((observation) => [observation.path, observation]),
    );
    const paths = new Set([...baseTree.keys(), ...headTree.keys()]);
    for (const path of paths) {
      if (artifacts.has(path)) continue;
      const base = baseTree.get(path);
      const head = headTree.get(path);
      if (
        !base ||
        !head ||
        base.mode !== head.mode ||
        base.type !== head.type ||
        base.sha !== head.sha
      ) {
        throw new GitHubEffectError({
          code: "REMOTE_CONFLICT",
          operation: "RECONCILE",
          retry: "NEVER",
          message: "Remote commit contains an unauthorized tree delta",
        });
      }
    }
    for (const artifact of input.artifacts) {
      const base = baseTree.get(artifact.path);
      const head = headTree.get(artifact.path);
      if (
        (artifact.operation === "CREATE" && base !== undefined) ||
        (artifact.operation === "MODIFY" && base?.type !== "blob") ||
        !head ||
        head.type !== "blob" ||
        head.mode !== "100644"
      ) {
        throw new GitHubEffectError({
          code: "REMOTE_CONFLICT",
          operation: "RECONCILE",
          retry: "NEVER",
          message: "Remote commit does not contain the exact authorized artifact delta",
        });
      }
      const blob = object((await this.call("GET", `/git/blobs/${head.sha}`, "RECONCILE")).body);
      const bytes = decodedBase64(blob?.content);
      const expectedBytes = Buffer.from(artifact.content, "utf8");
      const observation = observations.get(artifact.path);
      if (
        text(blob?.sha) !== head.sha ||
        text(blob?.encoding) !== "base64" ||
        integer(blob?.size) !== expectedBytes.length ||
        !bytes ||
        !bytes.equals(expectedBytes) ||
        !observation ||
        sha256Buffer(bytes) !== observation.materializedSha256
      ) {
        throw new GitHubEffectError({
          code: "REMOTE_CONFLICT",
          operation: "RECONCILE",
          retry: "NEVER",
          message: "Remote blob bytes do not match signed validation",
        });
      }
    }
  }

  private async getHead(input: GitHubReviewRequest): Promise<Json | undefined> {
    const head = deterministicHead(input.runId);
    const response = await this.call(
      "GET",
      `/git/ref/heads/${encodeURIComponent(head)}`,
      "RECONCILE",
      undefined,
      [200, 404],
    );
    return response.status === 404 ? undefined : object(response.body);
  }

  private async pulls(input: GitHubReviewRequest): Promise<unknown[]> {
    const head = deterministicHead(input.runId);
    const query = `?state=all&head=${encodeURIComponent(`${this.#options.owner}:${head}`)}&base=${encodeURIComponent(input.baseBranch)}&per_page=2`;
    const response = await this.call("GET", `/pulls${query}`, "RECONCILE");
    if (!Array.isArray(response.body) || response.body.length > 2)
      throw new GitHubEffectError({
        code: "REMOTE_FAILURE",
        operation: "RECONCILE",
        retry: "NEVER",
        message: "GitHub pull response is malformed",
      });
    return response.body;
  }

  private receipt(
    input: GitHubReviewRequest,
    pull: Json,
    headSha: string,
    reconciled: boolean,
  ): GitHubReviewReceipt {
    const base = object(pull.base);
    const head = object(pull.head);
    const baseRepository = object(base?.repo);
    const headRepository = object(head?.repo);
    const number = integer(pull.number);
    const url = text(pull.html_url);
    const createdAt = text(pull.created_at);
    const updatedAt = text(pull.updated_at);
    const createdTime = createdAt ? Date.parse(createdAt) : Number.NaN;
    const updatedTime = updatedAt ? Date.parse(updatedAt) : Number.NaN;
    if (
      !number ||
      url !== `https://github.com/${input.repository}/pull/${number}` ||
      pull.state !== "open" ||
      pull.draft !== true ||
      text(pull.title) !== input.title ||
      text(pull.body) !== this.pullBody(input) ||
      text(base?.ref) !== input.baseBranch ||
      text(base?.sha) !== input.baseSha ||
      text(baseRepository?.full_name) !== input.repository ||
      text(head?.ref) !== deterministicHead(input.runId) ||
      text(head?.sha) !== headSha ||
      text(headRepository?.full_name) !== input.repository ||
      !Number.isFinite(createdTime) ||
      !Number.isFinite(updatedTime)
    ) {
      throw new GitHubEffectError({
        code: "REMOTE_CONFLICT",
        operation: "RECONCILE",
        retry: "NEVER",
        message: "Existing pull request does not exactly match the authorized draft review",
      });
    }
    return {
      schemaVersion: 1,
      mode: "LIVE",
      effectKind: input.effectKind,
      target: input.target,
      repository: input.repository,
      baseBranch: input.baseBranch,
      baseSha: input.baseSha,
      headBranch: deterministicHead(input.runId),
      headSha,
      prNumber: number,
      prUrl: url,
      prState: "OPEN_DRAFT",
      createdAt: new Date(createdTime).toISOString(),
      updatedAt: new Date(updatedTime).toISOString(),
      candidateFingerprint: input.candidateFingerprint,
      artifactSetFingerprint: input.artifactSetFingerprint,
      validationReceiptFingerprint: input.validationReceiptFingerprint,
      approvalFingerprint: input.approvalFingerprint,
      intentFingerprint: input.intentFingerprint,
      idempotencyKey: input.idempotencyKey,
      inputFingerprint: input.inputFingerprint,
      reconciled,
    };
  }

  private async reconcile(
    input: GitHubReviewRequest,
    allowIncomplete = false,
  ): Promise<GitHubReviewReceipt | undefined> {
    const ref = await this.getHead(input);
    if (!ref) return undefined;
    const refObject = object(ref.object);
    const headSha = text(refObject?.sha);
    if (
      text(ref.ref) !== `refs/heads/${deterministicHead(input.runId)}` ||
      text(refObject?.type) !== "commit" ||
      !headSha ||
      !gitObjectId.test(headSha)
    )
      throw new GitHubEffectError({
        code: "REMOTE_CONFLICT",
        operation: "RECONCILE",
        retry: "NEVER",
        message: "Deterministic branch is malformed",
      });
    const commit = object((await this.call("GET", `/git/commits/${headSha}`, "RECONCILE")).body);
    const parents = Array.isArray(commit?.parents) ? commit.parents : [];
    const headTreeSha = text(object(commit?.tree)?.sha);
    if (
      text(commit?.sha) !== headSha ||
      text(commit?.message) !== this.commitMessage(input) ||
      parents.length !== 1 ||
      !headTreeSha ||
      !gitObjectId.test(headTreeSha) ||
      text(object(parents[0])?.sha) !== input.baseSha
    )
      throw new GitHubEffectError({
        code: "REMOTE_CONFLICT",
        operation: "RECONCILE",
        retry: "NEVER",
        message: "Deterministic branch was not created by this exact authorized effect",
      });
    await this.verifyReconciledArtifacts(input, headTreeSha);
    const pulls = await this.pulls(input);
    if (pulls.length > 1)
      throw new GitHubEffectError({
        code: "REMOTE_CONFLICT",
        operation: "RECONCILE",
        retry: "NEVER",
        message: "More than one pull request exists for the deterministic branch",
      });
    if (pulls.length === 0) {
      if (allowIncomplete) return undefined;
      throw this.ambiguous("Authorized branch exists but pull request is not observable");
    }
    const pull = object(pulls[0]);
    if (!pull)
      throw new GitHubEffectError({
        code: "REMOTE_FAILURE",
        operation: "RECONCILE",
        retry: "NEVER",
        message: "GitHub pull response is malformed",
      });
    return this.receipt(input, pull, headSha, true);
  }

  private async create(
    input: GitHubReviewRequest,
    canonicalEffectFingerprint: string,
  ): Promise<GitHubReviewReceipt> {
    const baseCommit = object(
      (await this.call("GET", `/git/commits/${input.baseSha}`, "READ_BASE_COMMIT")).body,
    );
    const baseTree = text(object(baseCommit?.tree)?.sha);
    if (text(baseCommit?.sha) !== input.baseSha || !baseTree || !gitObjectId.test(baseTree))
      throw new GitHubEffectError({
        code: "REMOTE_CONFLICT",
        operation: "READ_BASE_COMMIT",
        retry: "NEVER",
        message: "Validated base commit is unavailable",
      });
    const baseTreeResponse = object(
      (await this.call("GET", `/git/trees/${baseTree}?recursive=1`, "READ_BASE_COMMIT")).body,
    );
    const baseEntries = Array.isArray(baseTreeResponse?.tree) ? baseTreeResponse.tree : [];
    if (
      text(baseTreeResponse?.sha) !== baseTree ||
      baseTreeResponse?.truncated !== false ||
      baseEntries.length > 20_000
    )
      throw new GitHubEffectError({
        code: "REMOTE_FAILURE",
        operation: "READ_BASE_COMMIT",
        retry: "NEVER",
        message: "Base tree cannot be checked completely",
      });
    const basePaths = new Map<string, { type: string; sha: string }>();
    for (const entry of baseEntries) {
      const item = object(entry);
      const path = text(item?.path);
      const type = text(item?.type);
      const sha = text(item?.sha);
      if (
        !path ||
        path.length > 240 ||
        !type ||
        type.length > 16 ||
        !sha ||
        !gitObjectId.test(sha) ||
        basePaths.has(path)
      )
        throw new GitHubEffectError({
          code: "REMOTE_FAILURE",
          operation: "READ_BASE_COMMIT",
          retry: "NEVER",
          message: "Base tree contains malformed or duplicate entries",
        });
      basePaths.set(path, { type, sha });
    }
    for (const artifact of input.artifacts) {
      const existing = basePaths.get(artifact.path);
      if (
        (artifact.operation === "CREATE" && existing !== undefined) ||
        (artifact.operation === "MODIFY" &&
          (existing?.type !== "blob" || existing.sha !== artifact.expectedBaseBlobSha))
      )
        throw new GitHubEffectError({
          code: "REMOTE_CONFLICT",
          operation: "READ_BASE_COMMIT",
          retry: "NEVER",
          message: "Validated artifact operation or base blob does not match the exact base tree",
        });
    }
    let consumed: {
      canonicalEffectFingerprint: string;
      invokeBy: string;
      attemptFence: string;
    };
    try {
      consumed = await this.#options.authority.consumeCurrentEffect({
        canonicalEffectFingerprint,
      });
    } catch {
      throw new GitHubEffectError({
        code: "AUTHORIZATION_REJECTED",
        operation: "RECONCILE",
        retry: "NEVER",
        message: "Trusted effect reservation could not be consumed",
      });
    }
    if (
      consumed.canonicalEffectFingerprint !== canonicalEffectFingerprint ||
      !validInvokeBy(consumed.invokeBy) ||
      !/^[A-Za-z0-9_-]{32,200}$/.test(consumed.attemptFence)
    )
      throw new GitHubEffectError({
        code: "AUTHORIZATION_REJECTED",
        operation: "RECONCILE",
        retry: "NEVER",
        message: "Trusted effect authority consumed a different canonical effect",
      });
    const treeEntries: Array<Record<string, string>> = [];
    for (const artifact of input.artifacts) {
      const blob = object(
        (
          await this.call("POST", "/git/blobs", "CREATE_BLOB", {
            content: artifact.content,
            encoding: "utf-8",
          })
        ).body,
      );
      const blobSha = text(blob?.sha);
      if (!blobSha || !gitObjectId.test(blobSha))
        throw new GitHubEffectError({
          code: "REMOTE_FAILURE",
          operation: "CREATE_BLOB",
          retry: "RECONCILE",
          message: "GitHub blob receipt is malformed",
        });
      treeEntries.push({ path: artifact.path, mode: "100644", type: "blob", sha: blobSha });
    }
    const tree = object(
      (
        await this.call("POST", "/git/trees", "CREATE_TREE", {
          base_tree: baseTree,
          tree: treeEntries,
        })
      ).body,
    );
    const treeSha = text(tree?.sha);
    if (!treeSha || !gitObjectId.test(treeSha))
      throw new GitHubEffectError({
        code: "REMOTE_FAILURE",
        operation: "CREATE_TREE",
        retry: "RECONCILE",
        message: "GitHub tree receipt is malformed",
      });
    const commit = object(
      (
        await this.call("POST", "/git/commits", "CREATE_COMMIT", {
          message: this.commitMessage(input),
          tree: treeSha,
          parents: [input.baseSha],
        })
      ).body,
    );
    const headSha = text(commit?.sha);
    const commitTree = text(object(commit?.tree)?.sha);
    const commitParents = Array.isArray(commit?.parents) ? commit.parents : [];
    if (
      !headSha ||
      !gitObjectId.test(headSha) ||
      text(commit?.message) !== this.commitMessage(input) ||
      commitTree !== treeSha ||
      commitParents.length !== 1 ||
      text(object(commitParents[0])?.sha) !== input.baseSha
    )
      throw new GitHubEffectError({
        code: "REMOTE_FAILURE",
        operation: "CREATE_COMMIT",
        retry: "RECONCILE",
        message: "GitHub commit receipt is malformed",
      });
    const createdRef = object(
      (
        await this.call("POST", "/git/refs", "CREATE_REF", {
          ref: `refs/heads/${deterministicHead(input.runId)}`,
          sha: headSha,
        })
      ).body,
    );
    if (
      text(createdRef?.ref) !== `refs/heads/${deterministicHead(input.runId)}` ||
      text(object(createdRef?.object)?.sha) !== headSha
    )
      throw new GitHubEffectError({
        code: "REMOTE_FAILURE",
        operation: "CREATE_REF",
        retry: "RECONCILE",
        message: "GitHub branch receipt is malformed",
      });
    return this.createPull(input, headSha, false);
  }

  private async createPull(
    input: GitHubReviewRequest,
    headSha: string,
    reconciled: boolean,
  ): Promise<GitHubReviewReceipt> {
    const existing = await this.pulls(input);
    if (existing.length > 1)
      throw new GitHubEffectError({
        code: "REMOTE_CONFLICT",
        operation: "CREATE_PULL_REQUEST",
        retry: "NEVER",
        message: "More than one pull request exists for the deterministic branch",
      });
    if (existing.length === 1) {
      const pull = object(existing[0]);
      if (!pull)
        throw new GitHubEffectError({
          code: "REMOTE_FAILURE",
          operation: "CREATE_PULL_REQUEST",
          retry: "NEVER",
          message: "GitHub pull response is malformed",
        });
      return this.receipt(input, pull, headSha, true);
    }
    const pull = object(
      (
        await this.call("POST", "/pulls", "CREATE_PULL_REQUEST", {
          title: input.title,
          body: this.pullBody(input),
          head: deterministicHead(input.runId),
          base: input.baseBranch,
          draft: true,
        })
      ).body,
    );
    if (!pull)
      throw new GitHubEffectError({
        code: "REMOTE_FAILURE",
        operation: "CREATE_PULL_REQUEST",
        retry: "RECONCILE",
        message: "GitHub pull receipt is malformed",
      });
    return this.receipt(input, pull, headSha, reconciled);
  }
}
