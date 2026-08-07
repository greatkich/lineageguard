/**
 * Production orchestrator: wires all real adapters into the agent pipeline.
 *
 * Phases B–F:
 *   B: Real DataHub MCP adapter (full ImpactContext via official stdio)
 *   C: Real 5-rule risk engine (wired via pipeline's decideRisk step)
 *   D: Real validation executor (Docker-based 8-check validation)
 *   E: Real GitHub PR creation (LiveGitHubPort)
 *   F: Real DataHub writeback (LiveDataHubWritebackPort)
 */
import {
  type AgentGitHubPort,
  agentLLMConfigFromEnv,
  type AgentValidationPort,
  type AgentWritebackPort,
  createAgentModel,
  createAgentPipeline,
  type GitHubReviewInput,
  type GitHubReviewOutput,
  type ValidationOutput,
  type WritebackInput,
  type WritebackOutput,
} from "@lineageguard/agent";
import type { SimpleRunStore, SimpleRunUpdateExtra } from "@lineageguard/db";
import { canonicalBaseFixtureSql } from "./canonical-base-fixture.js";

// ---------------------------------------------------------------------------
// Phase B: DataHub context port (MCP stdio → full ImpactContext)
// ---------------------------------------------------------------------------

async function createDataHubPort() {
  const gmsUrl = process.env.DATAHUB_GMS_URL ?? "http://127.0.0.1:8080";
  const readToken = process.env.DATAHUB_READ_TOKEN ?? process.env.DATAHUB_TOKEN ?? "";
  const uvxPath = process.env.UVX_PATH ?? process.env.HOME + "/.local/bin/uvx";
  const uvCacheDir = process.env.UV_CACHE_DIR ?? process.env.HOME + "/.cache/uv";

  if (readToken.length <= 8) {
    console.warn(
      "[orchestration] DataHub not configured (token missing or too short) — collection will fail at runtime",
    );
    return {
      async collect(_input: { changeId: string; request?: unknown }) {
        throw new Error(
          "DataHub is not configured: DATAHUB_READ_TOKEN (or DATAHUB_TOKEN) must be set and longer than 8 characters",
        );
      },
    };
  }

  const { createOfficialLiveDataHubContextPort } = await import("@lineageguard/datahub");
  const port = createOfficialLiveDataHubContextPort({
    dataHubGmsUrl: gmsUrl,
    readToken,
    uvxPath,
    uvCacheDir,
  });
  console.log("[orchestration] Using REAL DataHub MCP stdio context port (no fallback)");

  return {
    async collect(input: { changeId: string; request?: unknown }) {
      try {
        return await port.collect(input as any);
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err);
        console.error(`[orchestration] DataHub collect error: ${msg}`);
        throw err;
      }
    },
  };
}

// ---------------------------------------------------------------------------
// Phase D: Validation port adapter
// ---------------------------------------------------------------------------

function createValidationPort(workerId: string): AgentValidationPort | undefined {
  const validationEnabled = process.env.VALIDATION_ENABLED !== "false";

  if (!validationEnabled) {
    console.log("[orchestration] Validation disabled (VALIDATION_ENABLED=false)");
    return undefined;
  }

  const dockerExecutable = process.env.VALIDATION_DOCKER_EXECUTABLE ?? "/usr/bin/docker";
  const runnerImageId = process.env.VALIDATION_RUNNER_IMAGE_ID ?? "";
  const postgresImageId = process.env.VALIDATION_POSTGRES_IMAGE_ID ?? "";
  const baseFixturePath = process.env.VALIDATION_BASE_FIXTURE_PATH ?? "";

  return {
    async validate(candidate: unknown, context?: { runId: string }): Promise<ValidationOutput> {
      const { createHash } = await import("node:crypto");
      const { readFile, access } = await import("node:fs/promises");
      const { migrationCandidateSchema } = await import("@lineageguard/domain");

      const runId = context?.runId ?? `run_${Date.now().toString(16).padStart(24, "0")}`;

      // Strict schema validation first — rejects malformed candidates
      const parsed = migrationCandidateSchema.parse(candidate);

      // Check Docker availability
      try {
        await access(dockerExecutable);
      } catch {
        throw new Error(
          `Validation runtime unavailable: Docker executable not found at ${dockerExecutable}. ` +
            `Set VALIDATION_DOCKER_EXECUTABLE or install Docker.`,
        );
      }

      // Check required image IDs
      if (!runnerImageId || !postgresImageId) {
        throw new Error(
          "Validation runtime unavailable: VALIDATION_RUNNER_IMAGE_ID and VALIDATION_POSTGRES_IMAGE_ID must be set. " +
            "These are content-addressed image digests (sha256:...) for the validation containers.",
        );
      }

      // Attempt to use the real validation pipeline
      try {
        const { materializeCandidate } = await import("@lineageguard/validation");
        const { executeValidationInOwnedDatabase } = await import("@lineageguard/validation");
        const { resolve } = await import("node:path");

        const repositoryPath = resolve(process.cwd());
        const sandboxRoot = process.env.VALIDATION_SANDBOX_ROOT ?? "/tmp";
        const baseSha =
          parsed.artifacts.find((a) => a.operation === "MODIFY")?.expectedBaseSha ?? "HEAD";
        const sandboxId = `validation-${Date.now()}`;
        const worktreeId = `lineageguard/validation/${sandboxId}`;

        // Read base fixture SQL — must include existing rows for backfill verification.
        let baseFixtureSql = canonicalBaseFixtureSql;
        if (baseFixturePath) {
          try {
            baseFixtureSql = await readFile(baseFixturePath, "utf8");
          } catch {
            console.warn(
              `[orchestration] Could not read base fixture from ${baseFixturePath}, using default`,
            );
          }
        }

        const handle = await materializeCandidate(parsed, {
          repositoryPath,
          sandboxRoot,
          baseSha,
          sandboxId,
          worktreeId,
        });

        try {
          const { sqlDriverDigest } = await import("@lineageguard/validation");

          const sqlDriverImpl = "lineageguard:postgres-driver:v1";
          const sqlDriverVer = "8.16.3";
          const dbtImpl = "lineageguard:dbt-runner:v1";
          const dbtVer = "1.8.0";
          const dbtDigest = runnerImageId.startsWith("sha256:")
            ? runnerImageId.slice("sha256:".length)
            : createHash("sha256").update(runnerImageId).digest("hex");

          const validators = [
            {
              check: "SQL_MIGRATION",
              commandId: "VALIDATE_SQL_MIGRATION_V1",
              impl: sqlDriverImpl,
              ver: sqlDriverVer,
              dig: sqlDriverDigest,
            },
            {
              check: "BACKFILL_EQUALITY",
              commandId: "VALIDATE_BACKFILL_EQUALITY_V1",
              impl: sqlDriverImpl,
              ver: sqlDriverVer,
              dig: sqlDriverDigest,
            },
            {
              check: "DBT_PARSE",
              commandId: "VALIDATE_DBT_PARSE_V1",
              impl: dbtImpl,
              ver: dbtVer,
              dig: dbtDigest,
            },
            {
              check: "DBT_COMPILE",
              commandId: "VALIDATE_DBT_COMPILE_V1",
              impl: dbtImpl,
              ver: dbtVer,
              dig: dbtDigest,
            },
            {
              check: "DBT_TEST",
              commandId: "VALIDATE_DBT_TEST_V1",
              impl: dbtImpl,
              ver: dbtVer,
              dig: dbtDigest,
            },
            {
              check: "OLD_CONSUMER_COMPATIBILITY",
              commandId: "VALIDATE_OLD_CONSUMER_V1",
              impl: sqlDriverImpl,
              ver: sqlDriverVer,
              dig: sqlDriverDigest,
            },
            {
              check: "NEW_CONSUMER_COMPATIBILITY",
              commandId: "VALIDATE_NEW_CONSUMER_V1",
              impl: sqlDriverImpl,
              ver: sqlDriverVer,
              dig: sqlDriverDigest,
            },
            {
              check: "ROLLBACK",
              commandId: "VALIDATE_ROLLBACK_V1",
              impl: sqlDriverImpl,
              ver: sqlDriverVer,
              dig: sqlDriverDigest,
            },
          ] as const;

          const evidence = await executeValidationInOwnedDatabase(
            parsed,
            handle,
            {
              schemaVersion: 1,
              purpose: "LINEAGEGUARD_EXPECTED_VALIDATION_EXECUTION",
              runId: runId as any,
              sandboxId,
              worktreeId,
              leaseId: `lease_${createHash("sha256")
                .update(runId + sandboxId)
                .digest("hex")
                .slice(0, 24)}` as any,
              workerId,
              generation: 1,
              validators: validators.map((v) => ({
                check: v.check as any,
                commandId: v.commandId as any,
                implementationId: v.impl,
                version: v.ver,
                digest: v.dig,
              })),
            },
            {
              baseFixtureSql,
              dockerExecutable,
              validationRunnerImageId: runnerImageId,
              postgresImageId,
              sqlDriverImplementationId: sqlDriverImpl,
              sqlDriverVersion: sqlDriverVer,
              dbtImplementationId: dbtImpl,
              dbtVersion: dbtVer,
              timeoutMs: 90_000,
              maxOutputBytes: 256_000,
            },
          );

          const checks: ValidationOutput["checks"] = evidence.checks.map((c) => ({
            check: c.check,
            status: c.status,
            summary: c.summary,
          }));

          const allPass = checks.every((c) => c.status === "PASS");
          const receiptFingerprint = createHash("sha256")
            .update(JSON.stringify(evidence))
            .digest("hex");

          return { allPass, checks, receiptFingerprint };
        } finally {
          await handle.cleanup();
        }
      } catch (err: unknown) {
        const message = err instanceof Error ? err.message : String(err);

        // If the error is about missing Docker infrastructure, surface it clearly
        if (
          message.includes("trusted system git") ||
          message.includes("MISSING_TOOL") ||
          message.includes("content-addressed validation image") ||
          message.includes("docker") ||
          message.includes("Docker")
        ) {
          throw new Error(`Validation runtime unavailable: ${message.slice(0, 300)}`);
        }

        // For other validation errors (bad SQL, dbt parse failures, etc.),
        // report as check failures
        throw err;
      }
    },
  };
}

// ---------------------------------------------------------------------------
// Phase E: GitHub PR port adapter
// ---------------------------------------------------------------------------

export function createGitHubPort(): AgentGitHubPort | undefined {
  const token = process.env.GITHUB_TOKEN;
  const owner = process.env.GITHUB_OWNER;
  const repo = process.env.GITHUB_REPO;

  if (!token || !owner || !repo) {
    console.log("[orchestration] GitHub PR disabled (GITHUB_TOKEN/OWNER/REPO not set)");
    return undefined;
  }

  return {
    async createReview(input: GitHubReviewInput): Promise<GitHubReviewOutput> {
      const { createHash } = await import("node:crypto");
      const branchName = `lineageguard/run-${input.runId}`;
      const baseBranch = process.env.GITHUB_BASE_BRANCH ?? "main";
      const apiBase = "https://api.github.com";

      // Get current base SHA
      const baseRef = await ghFetch(
        token,
        `${apiBase}/repos/${owner}/${repo}/git/ref/heads/${baseBranch}`,
      );
      const baseSha = (baseRef as { object?: { sha?: string } })?.object?.sha;
      if (!baseSha) throw new Error("Cannot resolve base branch SHA");

      // Create tree with artifacts
      const treeEntries: Array<{ path: string; mode: string; type: string; sha: string }> = [];
      const artifacts =
        (input.candidate as { artifacts?: Array<{ path: string; content: string }> }).artifacts ??
        [];
      for (const artifact of artifacts) {
        const blob = (await ghFetch(token, `${apiBase}/repos/${owner}/${repo}/git/blobs`, {
          method: "POST",
          body: { content: artifact.content, encoding: "utf-8" },
        })) as { sha: string };
        treeEntries.push({ path: artifact.path, mode: "100644", type: "blob", sha: blob.sha });
      }

      // Create tree
      const baseCommit = (await ghFetch(
        token,
        `${apiBase}/repos/${owner}/${repo}/git/commits/${baseSha}`,
      )) as { tree: { sha: string } };
      const tree = (await ghFetch(token, `${apiBase}/repos/${owner}/${repo}/git/trees`, {
        method: "POST",
        body: { base_tree: baseCommit.tree.sha, tree: treeEntries },
      })) as { sha: string };

      // Create commit
      const commit = (await ghFetch(token, `${apiBase}/repos/${owner}/${repo}/git/commits`, {
        method: "POST",
        body: {
          message: `LineageGuard migration for ${input.runId}\n\nSafe migration: customer_id → buyer_id (expand-migrate-contract)`,
          tree: tree.sha,
          parents: [baseSha],
        },
      })) as { sha: string };

      // Create or update branch
      try {
        await ghFetch(token, `${apiBase}/repos/${owner}/${repo}/git/refs`, {
          method: "POST",
          body: { ref: `refs/heads/${branchName}`, sha: commit.sha },
        });
      } catch {
        await ghFetch(token, `${apiBase}/repos/${owner}/${repo}/git/refs/heads/${branchName}`, {
          method: "PATCH",
          body: { sha: commit.sha, force: true },
        });
      }

      // Create draft PR
      let pr: { html_url: string; number: number };
      try {
        pr = (await ghFetch(token, `${apiBase}/repos/${owner}/${repo}/pulls`, {
          method: "POST",
          body: {
            title: `LineageGuard: safe migration for customer_id → buyer_id`,
            body: buildPrBody(input),
            head: branchName,
            base: baseBranch,
            draft: true,
          },
        })) as { html_url: string; number: number };
      } catch (createErr: unknown) {
        // PR creation failed — check if one already exists (idempotency)
        const prs = (await ghFetch(
          token,
          `${apiBase}/repos/${owner}/${repo}/pulls?state=open&head=${owner}:${branchName}`,
        )) as Array<{ html_url: string; number: number }>;
        if (prs.length > 0 && prs[0]!.number > 0) {
          pr = prs[0]!;
        } else {
          const msg = createErr instanceof Error ? createErr.message : String(createErr);
          throw new Error(
            `GitHub PR creation failed and no existing PR found: ${msg.slice(0, 200)}`,
          );
        }
      }

      const receiptFingerprint = createHash("sha256")
        .update(JSON.stringify({ prUrl: pr.html_url, headSha: commit.sha }))
        .digest("hex");

      return {
        prUrl: pr.html_url,
        prNumber: pr.number,
        headSha: commit.sha,
        headBranch: branchName,
        receiptFingerprint,
      };
    },
  };
}

async function ghFetch(
  token: string,
  url: string,
  options?: { method?: string; body?: unknown },
): Promise<unknown> {
  const res = await fetch(url, {
    method: options?.method ?? "GET",
    headers: {
      Accept: "application/vnd.github+json",
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
      "X-GitHub-Api-Version": "2022-11-28",
    },
    ...(options?.body ? { body: JSON.stringify(options.body) } : {}),
  });
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`GitHub API ${res.status}: ${text.slice(0, 200)}`);
  }
  return res.json();
}

function buildPrBody(input: GitHubReviewInput): string {
  const rules = input.comparison.triggeredRuleIds ?? [];
  const evidenceCount = (input.context as { evidence?: unknown[] }).evidence?.length ?? 0;
  return [
    "## LineageGuard Safe Migration",
    "",
    `**Run:** \`${input.runId}\``,
    `**Transition:** ${input.comparison.transition}`,
    `**Triggered rules:** ${rules.join(", ") || "none"}`,
    `**Evidence items:** ${evidenceCount}`,
    "",
    "### Strategy: Expand-Migrate-Contract",
    "",
    "This migration safely renames `customer_id` → `buyer_id` using the expand-migrate-contract pattern:",
    "",
    "1. **Expand:** Add `buyer_id` column with sync trigger",
    "2. **Migrate:** Update controlled consumers (dbt models)",
    "3. **Contract:** Deprecate `customer_id` after observation window",
    "",
    "### Generated Artifacts",
    "",
    ...(
      (input.candidate as { artifacts?: Array<{ path: string; kind: string }> }).artifacts ?? []
    ).map((a) => `- \`${a.path}\` (${a.kind})`),
    "",
    "---",
    "_Generated by LineageGuard_",
  ].join("\n");
}

// ---------------------------------------------------------------------------
// Phase F: DataHub writeback port adapter
// ---------------------------------------------------------------------------

export function createWritebackPort(): AgentWritebackPort | undefined {
  const mutationToken = process.env.DATAHUB_MUTATION_TOKEN;
  const gmsUrl = process.env.DATAHUB_GMS_URL ?? "http://127.0.0.1:8080";
  const writebackEnabled = process.env.WRITEBACK_ENABLED !== "false";

  if (!mutationToken || !writebackEnabled) {
    console.log(
      "[orchestration] DataHub writeback disabled (DATAHUB_MUTATION_TOKEN not set or WRITEBACK_ENABLED=false)",
    );
    return undefined;
  }

  return {
    async write(input: WritebackInput): Promise<WritebackOutput> {
      const { createHash } = await import("node:crypto");
      const datasetUrn =
        "urn:li:dataset:(urn:li:dataPlatform:postgres,lineageguard-canonical.lineageguard.commerce.orders,PROD)";

      // Separate read/mutation credentials — the read token must be genuinely
      // distinct from the mutation token (least-privilege: a read-only
      // credential must never be silently promoted to mutation-token scope,
      // and reads must never run under a fallback that is actually the
      // mutation token). See AGENTS.md: "Keep DataHub MCP mutations off by
      // default" / README: "separate read/mutation tokens".
      const readToken = process.env.DATAHUB_READ_TOKEN ?? process.env.DATAHUB_TOKEN;
      if (!readToken) {
        throw new Error(
          "DataHub writeback requires DATAHUB_READ_TOKEN (or DATAHUB_TOKEN) to be set separately " +
            "from DATAHUB_MUTATION_TOKEN — refusing to read using the mutation credential.",
        );
      }
      if (readToken === mutationToken) {
        throw new Error(
          "DataHub writeback requires DATAHUB_READ_TOKEN to differ from DATAHUB_MUTATION_TOKEN " +
            "(least-privilege credential separation) — refusing to proceed with a shared token.",
        );
      }
      const readHeaders = { Authorization: `Bearer ${readToken}` };
      const writeHeaders = {
        "Content-Type": "application/json",
        Authorization: `Bearer ${mutationToken}`,
      };

      async function gmsRead(path: string): Promise<unknown> {
        const res = await fetch(`${gmsUrl}${path}`, { headers: readHeaders });
        if (!res.ok) return null;
        return res.json();
      }

      const documentContent = [
        `Marker: lineageguard:decision:v1:lineageguard-${input.runId}`,
        `Decision: ${input.comparison.grounded.decision}`,
        `Run: ${input.runId}`,
        `Source field: customer_id`,
        `Replacement field: buyer_id`,
        `Compatibility window: 30 days`,
        `Reasons: ${input.comparison.triggeredRuleIds.join(", ")}`,
        `Candidate: ${(input.candidate as { strategy?: string }).strategy ?? "EXPAND_MIGRATE_CONTRACT"}`,
        `Validation receipt: ${input.validationReceiptFingerprint.slice(0, 16)}`,
        `GitHub review: ${input.githubPrUrl}`,
        `GitHub receipt: ${input.githubReceiptFingerprint.slice(0, 16)}`,
        `Rollback: walkthrough/migrations/001_rollback.sql`,
      ].join("\n");

      try {
        // --- Read existing state (before snapshot) ---
        const beforeTags = (await gmsRead(
          `/aspects/${encodeURIComponent(datasetUrn)}?aspect=globalTags&version=0`,
        )) as { aspect?: { value?: string } } | null;
        const beforeMemory = (await gmsRead(
          `/aspects/${encodeURIComponent(datasetUrn)}?aspect=institutionalMemory&version=0`,
        )) as { aspect?: { value?: string } } | null;

        // Parse existing tags to preserve unrelated ones
        const existingTagsRaw = beforeTags?.aspect?.value ?? "{}";
        const existingTags = JSON.parse(
          typeof existingTagsRaw === "string" ? existingTagsRaw : JSON.stringify(existingTagsRaw),
        ) as { tags?: Array<{ tag: string }> };
        const existingTagList = existingTags.tags ?? [];

        // Merge: keep existing tags, add/ensure LineageGuard tags
        const lgTags = new Set([
          "urn:li:tag:lineageguard-canonical.Reviewed",
          "urn:li:tag:lineageguard-canonical.Critical",
          "urn:li:tag:lineageguard-canonical.Production",
        ]);
        const mergedTags = [
          ...existingTagList.filter((t) => !lgTags.has(t.tag)),
          ...[...lgTags].map((tag) => ({ tag })),
        ];

        // Parse existing institutional memory to preserve unrelated elements
        const existingMemoryRaw = beforeMemory?.aspect?.value ?? "{}";
        const existingMemory = JSON.parse(
          typeof existingMemoryRaw === "string"
            ? existingMemoryRaw
            : JSON.stringify(existingMemoryRaw),
        ) as { elements?: Array<{ url?: string; description?: string; createStamp?: unknown }> };
        const existingElements = existingMemory.elements ?? [];

        // Check idempotency: if our marker already exists, skip write
        const markerPhrase = `lineageguard:decision:v1:lineageguard-${input.runId}`;
        const alreadyWritten = existingElements.some((el) =>
          el.description?.includes(markerPhrase),
        );
        const reviewedTagExists = existingTagList.some(
          (t) => t.tag === "urn:li:tag:lineageguard-canonical.Reviewed",
        );

        if (alreadyWritten && reviewedTagExists) {
          console.log("[orchestration] DataHub write-back: idempotent — already written");
          const receiptFingerprint = createHash("sha256")
            .update(
              JSON.stringify({ documentContent, datasetUrn, runId: input.runId, idempotent: true }),
            )
            .digest("hex");
          return { status: "SUCCEEDED", receiptFingerprint };
        }

        // --- Write tags (preserving existing) ---
        const tagPayload = {
          proposal: {
            entityType: "dataset",
            entityUrn: datasetUrn,
            aspectName: "globalTags",
            changeType: "UPSERT",
            aspect: {
              value: JSON.stringify({ tags: mergedTags }),
              contentType: "application/json",
            },
          },
        };
        const tagRes = await fetch(`${gmsUrl}/aspects?action=ingestProposal`, {
          method: "POST",
          headers: writeHeaders,
          body: JSON.stringify(tagPayload),
        });
        if (!tagRes.ok) {
          throw new Error(`DataHub tag writeback failed: HTTP ${tagRes.status}`);
        }

        // --- Write decision document (preserving existing elements) ---
        const newElement = {
          url: input.githubPrUrl || `https://lineageguard.local/runs/${input.runId}`,
          description: documentContent,
          createStamp: { time: Date.now(), actor: "urn:li:corpuser:lineageguard" },
        };
        const preservedElements = existingElements.filter(
          (el) => !el.description?.includes("lineageguard:decision:v1:"),
        );
        const mergedElements = [...preservedElements, newElement];

        const docPayload = {
          proposal: {
            entityType: "dataset",
            entityUrn: datasetUrn,
            aspectName: "institutionalMemory",
            changeType: "UPSERT",
            aspect: {
              value: JSON.stringify({ elements: mergedElements }),
              contentType: "application/json",
            },
          },
        };
        const docRes = await fetch(`${gmsUrl}/aspects?action=ingestProposal`, {
          method: "POST",
          headers: writeHeaders,
          body: JSON.stringify(docPayload),
        });
        if (!docRes.ok) {
          throw new Error(`DataHub document writeback failed: HTTP ${docRes.status}`);
        }

        // --- Exact read-back verification (using read token) ---
        const afterTags = (await gmsRead(
          `/aspects/${encodeURIComponent(datasetUrn)}?aspect=globalTags&version=0`,
        )) as { aspect?: { value?: string } } | null;
        const afterTagsRaw = afterTags?.aspect?.value ?? "{}";
        const afterTagData = JSON.parse(
          typeof afterTagsRaw === "string" ? afterTagsRaw : JSON.stringify(afterTagsRaw),
        ) as { tags?: Array<{ tag: string }> };
        const reviewedPresent = (afterTagData.tags ?? []).some(
          (t) => t.tag === "urn:li:tag:lineageguard-canonical.Reviewed",
        );
        if (!reviewedPresent) {
          throw new Error(
            "DataHub write-back verification failed: Reviewed tag not found on read-back",
          );
        }

        const afterMemory = (await gmsRead(
          `/aspects/${encodeURIComponent(datasetUrn)}?aspect=institutionalMemory&version=0`,
        )) as { aspect?: { value?: string } } | null;
        const afterMemoryRaw = afterMemory?.aspect?.value ?? "{}";
        const afterMemoryData = JSON.parse(
          typeof afterMemoryRaw === "string" ? afterMemoryRaw : JSON.stringify(afterMemoryRaw),
        ) as { elements?: Array<{ description?: string }> };
        const docVerified = (afterMemoryData.elements ?? []).some((el) =>
          el.description?.includes(markerPhrase),
        );
        if (!docVerified) {
          throw new Error(
            "DataHub write-back verification failed: decision document not found on read-back",
          );
        }

        // Verify existing metadata preserved
        const preservedTagCount = existingTagList.filter((t) => !lgTags.has(t.tag)).length;
        const afterNonLgTags = (afterTagData.tags ?? []).filter((t) => !lgTags.has(t.tag)).length;
        if (afterNonLgTags < preservedTagCount) {
          throw new Error(
            "DataHub write-back verification failed: existing tags were not preserved",
          );
        }

        console.log(
          "[orchestration] DataHub write-back verified: tag ✓, document ✓, preservation ✓",
        );

        const receiptFingerprint = createHash("sha256")
          .update(
            JSON.stringify({ documentContent, datasetUrn, runId: input.runId, verified: true }),
          )
          .digest("hex");

        return { status: "SUCCEEDED", receiptFingerprint };
      } catch (err: unknown) {
        const message = err instanceof Error ? err.message : String(err);
        console.error(`[orchestration] Writeback error: ${message.slice(0, 200)}`);
        throw new Error(`DataHub writeback failed: ${message.slice(0, 300)}`);
      }
    },
  };
}

// ---------------------------------------------------------------------------
// Main orchestrator factory
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// Narrows the agent pipeline's untyped onStatusChange `extra` payload down to
// the known, persistable SimpleRunUpdateExtra fields. Avoids an `as any` cast
// on this store-write boundary: unrecognized keys are silently dropped rather
// than blindly trusted.
// ---------------------------------------------------------------------------
const SIMPLE_RUN_UPDATE_EXTRA_KEYS = [
  "baselineDecision",
  "groundedDecision",
  "consumersFound",
  "evidenceItems",
  "artifactsGenerated",
  "triggeredRules",
  "prUrl",
  "prNumber",
  "writebackStatus",
  "validationReceiptFingerprint",
  "githubReceiptFingerprint",
  "writebackReceiptFingerprint",
  "contextJson",
  "candidateJson",
  "comparisonJson",
  "sourcePrUrl",
  "failedChecks",
] as const satisfies readonly (keyof SimpleRunUpdateExtra)[];

function pickSimpleRunUpdateExtra(
  extra: Record<string, unknown> | undefined,
): Partial<SimpleRunUpdateExtra> | undefined {
  if (!extra) return undefined;
  const picked: Partial<SimpleRunUpdateExtra> = {};
  for (const key of SIMPLE_RUN_UPDATE_EXTRA_KEYS) {
    if (extra[key] !== undefined) {
      (picked as Record<string, unknown>)[key] = extra[key];
    }
  }
  return picked;
}

export async function createOrchestrator(workerId: string, store: SimpleRunStore) {
  const llmConfig = agentLLMConfigFromEnv();
  const llm = createAgentModel(llmConfig);

  const datahub = await createDataHubPort();
  const validation = createValidationPort(workerId);
  const github = createGitHubPort();
  const writeback = createWritebackPort();

  console.log("[orchestration] Ports configured:");
  console.log(`  DataHub:    ✓`);
  console.log(`  Validation: ${validation ? "✓" : "✗ (disabled)"}`);
  console.log(`  GitHub:     ${github ? "✓" : "✗ (no token)"}`);
  console.log(`  Writeback:  ${writeback ? "✓" : "✗ (disabled)"}`);

  return createAgentPipeline({
    datahub: datahub as any,
    llm,
    workerId,
    clock: () => new Date(),
    validation,
    github,
    writeback,
    onStatusChange: async (runId: string, status: string, extra?: Record<string, unknown>) => {
      await store.update(runId, status, pickSimpleRunUpdateExtra(extra));
    },
  });
}
