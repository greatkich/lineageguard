import type { PipelineResult } from "@lineageguard/agent";
import { createSimpleRunStore } from "@lineageguard/db";
import type { SourceChangeEnvelope } from "@lineageguard/domain";
import pg from "pg";
import { eventBus } from "./events.js";
import { createOrchestrator } from "./orchestration.js";
import {
  buildSourceChange,
  buildSourceEnvelope,
  readSourcePR,
  reattestSourceEnvelope,
  type SourcePRInfo,
} from "./source-pr-reader.js";

export interface WorkerOptions {
  once?: boolean;
  signal?: AbortSignal;
  pollIntervalMs?: number;
  workerId?: string;
}

const pool = new pg.Pool({
  connectionString:
    process.env.LINEAGEGUARD_DATABASE_URL ??
    "postgresql://lineageguard:lineageguard@127.0.0.1:5432/lineageguard",
  max: 5,
});
const store = createSimpleRunStore(pool);

export async function runWorker(options: WorkerOptions = {}): Promise<PipelineResult | null> {
  const workerId = options.workerId ?? process.env.WORKER_ID ?? "worker-1";
  const orchestrator = await createOrchestrator(workerId, store);

  if (options.once) {
    // --once mode: create and execute a single canonical run
    await store.ensureSchema();

    const runId = `run_${Date.now().toString(16).padStart(24, "0")}`;
    const repository = process.env.LINEAGEGUARD_REPOSITORY ?? "greatkich/lineageguard";
    const owner = process.env.GITHUB_OWNER ?? "greatkich";
    const repo = process.env.GITHUB_REPO ?? "lineageguard";
    const token = process.env.GITHUB_TOKEN ?? "";

    // Read source PR if SOURCE_PR_NUMBER is set
    let sourcePR: SourcePRInfo | undefined;
    const sourcePrNumber = process.env.SOURCE_PR_NUMBER;
    if (sourcePrNumber && token) {
      console.log(`[worker] Reading source PR #${sourcePrNumber}...`);
      sourcePR = await readSourcePR({
        owner,
        repo,
        token,
        prNumber: Number.parseInt(sourcePrNumber, 10),
      });
      console.log(
        `[worker] Source PR: ${sourcePR.prUrl} (${sourcePR.baseSha.slice(0, 7)}..${sourcePR.headSha.slice(0, 7)})`,
      );
    }

    const baseSha = sourcePR?.baseSha ?? process.env.LINEAGEGUARD_BASE_SHA;
    const headSha = sourcePR?.headSha ?? process.env.LINEAGEGUARD_HEAD_SHA;

    if (!baseSha || !headSha) {
      throw new Error(
        "LINEAGEGUARD_BASE_SHA and LINEAGEGUARD_HEAD_SHA are required in LIVE mode. " +
          "Set these to real Git SHAs, or set SOURCE_PR_NUMBER to read from a GitHub PR.",
      );
    }

    // Determine the actual patch — from source PR or canonical default
    let patch = "ALTER TABLE commerce.orders RENAME COLUMN customer_id TO buyer_id;";
    let sourceType: "FIXTURE" | "GITHUB" = "FIXTURE";
    let sourcePath: string | undefined;
    let sourceEnvelope: SourceChangeEnvelope | undefined;

    if (sourcePR) {
      // One allowlist, in the domain. It throws a typed SourceChangeRejectedError naming why a PR
      // is not the supported scenario, replacing the reader/worker duplicate checks that could
      // drift apart.
      try {
        sourceEnvelope = buildSourceEnvelope(sourcePR, repository);
      } catch (error) {
        const rejection = error as { code?: string; detail?: string };
        throw new Error(
          `Source PR #${String(sourcePR.prNumber)} rejected: ${rejection.code ?? "UNKNOWN"}` +
            `${rejection.detail ? ` — ${rejection.detail}` : ""}`,
        );
      }

      const sourceChange = buildSourceChange(sourcePR, repository);
      if (!sourceChange) {
        throw new Error(
          `Source PR #${String(sourcePR.prNumber)} passed the allowlist but produced no diff.`,
        );
      }

      patch = sourceChange.unifiedDiff;
      sourceType = "GITHUB";
      sourcePath = sourceEnvelope.selectedPath;
      console.log(
        `[worker] Source PR accepted: path=${sourcePath} fingerprint=${sourceEnvelope.sourceFingerprint.slice(0, 12)}`,
      );
    }

    await store.create({
      id: runId,
      repository,
      field: "customer_id",
      patch,
      ...(sourcePR
        ? {
            sourcePrUrl: sourcePR.prUrl,
            sourcePrNumber: sourcePR.prNumber,
            sourceBaseSha: sourcePR.baseSha,
            sourceHeadSha: sourcePR.headSha,
            sourceDiffFingerprint: sourceEnvelope?.sourceFingerprint ?? sourcePR.diffFingerprint,
            ...(sourcePath ? { sourceFilePath: sourcePath } : {}),
          }
        : {}),
    });

    console.log(`[worker] Executing canonical run ${runId}... (source: ${sourceType})`);

    const result = await orchestrator.execute({
      runId,
      repository,
      baseSha,
      headSha,
      patch,
      table: "commerce.orders",
      field: "customer_id",
      newName: "buyer_id",
      source: sourceType,
      ...(sourcePath === undefined ? {} : { sourcePath }),
      ...(sourceEnvelope === undefined ? {} : { sourceEnvelope }),
      ...(sourcePrNumber && token
        ? {
            reattestSource: () =>
              reattestSourceEnvelope(
                { owner, repo, token, prNumber: Number.parseInt(sourcePrNumber, 10) },
                repository,
              ),
          }
        : {}),
    });

    console.log(`[worker] Run ${runId} finished: ${result.finalStatus}`);
    eventBus.publish({
      runId,
      status: result.finalStatus,
      timestamp: new Date().toISOString(),
      detail: `${result.baselineDecision} → ${result.groundedDecision}`,
    });
    return result;
  }

  // Poll mode: check for work periodically
  const signal = options.signal;
  if (signal?.aborted) return null;

  const pollOnce = (): void => {
    eventBus.publish({
      runId: "none",
      status: "POLLED",
      timestamp: new Date().toISOString(),
      detail: `worker ${workerId} found no claimable run`,
    });
  };

  await new Promise<void>((resolve) => {
    const interval = setInterval(pollOnce, options.pollIntervalMs ?? 1_000);
    const stop = () => {
      clearInterval(interval);
      resolve();
    };

    signal?.addEventListener("abort", stop, { once: true });
  });

  return null;
}
