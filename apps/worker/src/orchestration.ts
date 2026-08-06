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
import { updateRunStatus } from "./simple-store.js";

// ---------------------------------------------------------------------------
// Phase B: DataHub context port (MCP stdio → full ImpactContext)
// ---------------------------------------------------------------------------

async function createDataHubPort() {
  const gmsUrl = process.env.DATAHUB_GMS_URL ?? "http://127.0.0.1:8080";
  const readToken = process.env.DATAHUB_READ_TOKEN ?? process.env.DATAHUB_TOKEN ?? "";
  const uvxPath = process.env.UVX_PATH ?? process.env.HOME + "/.local/bin/uvx";
  const uvCacheDir = process.env.UV_CACHE_DIR ?? process.env.HOME + "/.cache/uv";

  if (readToken.length <= 8) {
    console.warn("[orchestration] DataHub not configured (token missing or too short) — collection will fail at runtime");
    return {
      async collect(_input: { changeId: string; request?: unknown }) {
        throw new Error("DataHub is not configured: DATAHUB_READ_TOKEN (or DATAHUB_TOKEN) must be set and longer than 8 characters");
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
      return await port.collect(input as any);
    },
  };
}

// ---------------------------------------------------------------------------
// Phase D: Validation port adapter
// ---------------------------------------------------------------------------

function createValidationPort(): AgentValidationPort | undefined {
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
    async validate(candidate: unknown): Promise<ValidationOutput> {
      const { createHash } = await import("node:crypto");
      const { readFile, access } = await import("node:fs/promises");
      const { migrationCandidateSchema } = await import("@lineageguard/domain");

      // Strict schema validation first — rejects malformed candidates
      const parsed = migrationCandidateSchema.parse(candidate);

      // Check Docker availability
      try {
        await access(dockerExecutable);
      } catch {
        throw new Error(
          `Validation runtime unavailable: Docker executable not found at ${dockerExecutable}. ` +
          `Set VALIDATION_DOCKER_EXECUTABLE or install Docker.`
        );
      }

      // Check required image IDs
      if (!runnerImageId || !postgresImageId) {
        throw new Error(
          "Validation runtime unavailable: VALIDATION_RUNNER_IMAGE_ID and VALIDATION_POSTGRES_IMAGE_ID must be set. " +
          "These are content-addressed image digests (sha256:...) for the validation containers."
        );
      }

      // Attempt to use the real validation pipeline
      try {
        const { materializeCandidate } = await import("@lineageguard/validation");
        const { executeValidationInOwnedDatabase } = await import("@lineageguard/validation");
        const { resolve } = await import("node:path");

        const repositoryPath = resolve(process.cwd());
        const sandboxRoot = process.env.VALIDATION_SANDBOX_ROOT ?? "/tmp";
        const baseSha = parsed.artifacts.find((a) => a.operation === "MODIFY")?.expectedBaseSha ?? "HEAD";
        const sandboxId = `validation-${Date.now()}`;
        const worktreeId = `lineageguard/validation/${sandboxId}`;

        // Read base fixture SQL
        let baseFixtureSql = "CREATE SCHEMA IF NOT EXISTS commerce; CREATE TABLE commerce.orders (order_id BIGINT PRIMARY KEY, customer_id BIGINT NOT NULL, order_total NUMERIC(10,2), ordered_at TIMESTAMPTZ DEFAULT now());";
        if (baseFixturePath) {
          try {
            baseFixtureSql = await readFile(baseFixturePath, "utf8");
          } catch {
            console.warn(`[orchestration] Could not read base fixture from ${baseFixturePath}, using default`);
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
          const evidence = await executeValidationInOwnedDatabase(
            parsed,
            handle,
            {
              schemaVersion: 1,
              purpose: "LINEAGEGUARD_EXPECTED_VALIDATION_EXECUTION",
              runId: `run_${"0".repeat(24)}`,
              sandboxId,
              worktreeId,
              leaseId: `lease_${"0".repeat(24)}`,
              workerId: "validation-worker",
              generation: 1,
              validators: [
                "SQL_MIGRATION", "BACKFILL_EQUALITY", "DBT_PARSE", "DBT_COMPILE",
                "DBT_TEST", "OLD_CONSUMER_COMPATIBILITY", "NEW_CONSUMER_COMPATIBILITY", "ROLLBACK",
              ].map((check) => ({
                check: check as any,
                commandId: `VALIDATE_${check}_V1` as any,
                implementationId: "lineageguard:postgres-driver:v1",
                version: "1.0.0",
                digest: createHash("sha256").update(check).digest("hex"),
              })),
            },
            {
              baseFixtureSql,
              dockerExecutable,
              validationRunnerImageId: runnerImageId,
              postgresImageId,
              sqlDriverImplementationId: "lineageguard:postgres-driver:v1",
              sqlDriverVersion: "8.16.3",
              dbtImplementationId: "lineageguard:dbt-runner:v1",
              dbtVersion: "1.8.0",
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

function createGitHubPort(): AgentGitHubPort | undefined {
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
      const baseRef = await ghFetch(token, `${apiBase}/repos/${owner}/${repo}/git/ref/heads/${baseBranch}`);
      const baseSha = (baseRef as { object?: { sha?: string } })?.object?.sha;
      if (!baseSha) throw new Error("Cannot resolve base branch SHA");

      // Create tree with artifacts
      const treeEntries: Array<{ path: string; mode: string; type: string; sha: string }> = [];
      const artifacts = (input.candidate as { artifacts?: Array<{ path: string; content: string }> }).artifacts ?? [];
      for (const artifact of artifacts) {
        const blob = await ghFetch(token, `${apiBase}/repos/${owner}/${repo}/git/blobs`, {
          method: "POST",
          body: { content: artifact.content, encoding: "utf-8" },
        }) as { sha: string };
        treeEntries.push({ path: artifact.path, mode: "100644", type: "blob", sha: blob.sha });
      }

      // Create tree
      const baseCommit = await ghFetch(token, `${apiBase}/repos/${owner}/${repo}/git/commits/${baseSha}`) as { tree: { sha: string } };
      const tree = await ghFetch(token, `${apiBase}/repos/${owner}/${repo}/git/trees`, {
        method: "POST",
        body: { base_tree: baseCommit.tree.sha, tree: treeEntries },
      }) as { sha: string };

      // Create commit
      const commit = await ghFetch(token, `${apiBase}/repos/${owner}/${repo}/git/commits`, {
        method: "POST",
        body: {
          message: `LineageGuard migration for ${input.runId}\n\nSafe migration: customer_id → buyer_id (expand-migrate-contract)`,
          tree: tree.sha,
          parents: [baseSha],
        },
      }) as { sha: string };

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
        pr = await ghFetch(token, `${apiBase}/repos/${owner}/${repo}/pulls`, {
          method: "POST",
          body: {
            title: `LineageGuard: safe migration for customer_id → buyer_id`,
            body: buildPrBody(input),
            head: branchName,
            base: baseBranch,
            draft: true,
          },
        }) as { html_url: string; number: number };
      } catch (createErr: unknown) {
        // PR creation failed — check if one already exists (idempotency)
        const prs = await ghFetch(token, `${apiBase}/repos/${owner}/${repo}/pulls?state=open&head=${owner}:${branchName}`) as Array<{ html_url: string; number: number }>;
        if (prs.length > 0 && prs[0]!.number > 0) {
          pr = prs[0]!;
        } else {
          const msg = createErr instanceof Error ? createErr.message : String(createErr);
          throw new Error(`GitHub PR creation failed and no existing PR found: ${msg.slice(0, 200)}`);
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

async function ghFetch(token: string, url: string, options?: { method?: string; body?: unknown }): Promise<unknown> {
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
    ...((input.candidate as { artifacts?: Array<{ path: string; kind: string }> }).artifacts ?? []).map((a) => `- \`${a.path}\` (${a.kind})`),
    "",
    "---",
    "_Generated by LineageGuard_",
  ].join("\n");
}

// ---------------------------------------------------------------------------
// Phase F: DataHub writeback port adapter
// ---------------------------------------------------------------------------

function createWritebackPort(): AgentWritebackPort | undefined {
  const mutationToken = process.env.DATAHUB_MUTATION_TOKEN;
  const gmsUrl = process.env.DATAHUB_GMS_URL ?? "http://127.0.0.1:8080";
  const writebackEnabled = process.env.WRITEBACK_ENABLED !== "false";

  if (!mutationToken || !writebackEnabled) {
    console.log("[orchestration] DataHub writeback disabled (DATAHUB_MUTATION_TOKEN not set or WRITEBACK_ENABLED=false)");
    return undefined;
  }

  return {
    async write(input: WritebackInput): Promise<WritebackOutput> {
      const { createHash } = await import("node:crypto");
      const datasetUrn =
        "urn:li:dataset:(urn:li:dataPlatform:postgres,lineageguard-canonical.lineageguard.commerce.orders,PROD)";

      const documentContent = [
        `Marker: lineageguard:decision:v1:lineageguard-${input.runId}`,
        `Decision: ${input.comparison.grounded.decision}`,
        `Run: ${input.runId}`,
        `Reasons: ${input.comparison.triggeredRuleIds.join(", ")}`,
        `Candidate: ${(input.candidate as { strategy?: string }).strategy ?? "EXPAND_MIGRATE_CONTRACT"}`,
        `GitHub review: ${input.githubPrUrl}`,
        `Rollback: walkthrough/migrations/rollback.sql`,
      ].join("\n");

      try {
        // Add 'Reviewed' tag to the dataset
        const tagPayload = {
          proposal: {
            entityType: "dataset",
            entityUrn: datasetUrn,
            aspectName: "globalTags",
            changeType: "UPSERT",
            aspect: {
              value: JSON.stringify({
                tags: [
                  { tag: "urn:li:tag:lineageguard-canonical.Reviewed" },
                  { tag: "urn:li:tag:lineageguard-canonical.Critical" },
                  { tag: "urn:li:tag:lineageguard-canonical.Production" },
                ],
              }),
              contentType: "application/json",
            },
          },
        };

        const tagRes = await fetch(`${gmsUrl}/aspects?action=ingestProposal`, {
          method: "POST",
          headers: { "Content-Type": "application/json", Authorization: `Bearer ${mutationToken}` },
          body: JSON.stringify(tagPayload),
        });
        if (!tagRes.ok) {
          throw new Error(`DataHub tag writeback failed: HTTP ${tagRes.status}`);
        }

        // Write decision document (institutional memory)
        const docPayload = {
          proposal: {
            entityType: "dataset",
            entityUrn: datasetUrn,
            aspectName: "institutionalMemory",
            changeType: "UPSERT",
            aspect: {
              value: JSON.stringify({
                elements: [{
                  url: input.githubPrUrl || `https://lineageguard.local/runs/${input.runId}`,
                  description: documentContent,
                  createStamp: { time: Date.now(), actor: "urn:li:corpuser:lineageguard" },
                }],
              }),
              contentType: "application/json",
            },
          },
        };

        const docRes = await fetch(`${gmsUrl}/aspects?action=ingestProposal`, {
          method: "POST",
          headers: { "Content-Type": "application/json", Authorization: `Bearer ${mutationToken}` },
          body: JSON.stringify(docPayload),
        });
        if (!docRes.ok) {
          throw new Error(`DataHub document writeback failed: HTTP ${docRes.status}`);
        }

        const receiptFingerprint = createHash("sha256")
          .update(JSON.stringify({ documentContent, datasetUrn, runId: input.runId }))
          .digest("hex");

        return { status: "SUCCEEDED", receiptFingerprint };
      } catch (err: unknown) {
        const message = err instanceof Error ? err.message : String(err);
        console.error(`[orchestration] Writeback error: ${message.slice(0, 100)}`);
        throw new Error(`DataHub writeback failed: ${message.slice(0, 200)}`);
      }
    },
  };
}

// ---------------------------------------------------------------------------
// Main orchestrator factory
// ---------------------------------------------------------------------------

export async function createOrchestrator(workerId: string) {
  const llmConfig = agentLLMConfigFromEnv();
  const llm = createAgentModel(llmConfig);

  const datahub = await createDataHubPort();
  const validation = createValidationPort();
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
      await updateRunStatus(runId, status, extra as any);
    },
  });
}
