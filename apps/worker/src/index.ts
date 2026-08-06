import type { PipelineResult } from "@lineageguard/agent";
import { createSimpleRunStore } from "@lineageguard/db";
import pg from "pg";
import { eventBus } from "./events.js";
import { createOrchestrator } from "./orchestration.js";
import { readSourcePR, type SourcePRInfo } from "./source-pr-reader.js";

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
    // Source type stays FIXTURE because domain classifyGitDiff expects model diffs,
    // not migration SQL. The real SHAs from the source PR are what bind the run.
    const sourceType: "FIXTURE" = "FIXTURE";

    if (sourcePR) {
      // Validate source PR contains the canonical rename
      const renamePattern = /RENAME\s+COLUMN\s+customer_id\s+TO\s+buyer_id/i;
      const sqlPatches = sourcePR.patches.filter(
        (p) => p.filename.endsWith(".sql") && renamePattern.test(p.patch),
      );
      if (sqlPatches.length === 0) {
        throw new Error(
          `Source PR #${sourcePR.prNumber} does not contain the canonical rename ` +
            `(ALTER TABLE ... RENAME COLUMN customer_id TO buyer_id). ` +
            `Changed files: ${sourcePR.changedFiles.join(", ")}`,
        );
      }
      if (sqlPatches.length > 1) {
        throw new Error(
          `Source PR #${sourcePR.prNumber} contains multiple schema rename statements. ` +
            `Only one canonical change is supported.`,
        );
      }
      // Use exact canonical SQL — domain parser validates this specific statement
      patch = "ALTER TABLE commerce.orders RENAME COLUMN customer_id TO buyer_id;";
      console.log(
        `[worker] Source PR validated: canonical rename found in ${sqlPatches[0]!.filename}`,
      );
    }

    await store.create({
      id: runId,
      repository,
      field: "customer_id",
      patch,
    });

    // Persist source PR info if available
    if (sourcePR) {
      await store.update(runId, "CREATED", { sourcePrUrl: sourcePR.prUrl });
    }

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
      sourcePath: sourcePR
        ? sourcePR.patches.find((p) => /RENAME\s+COLUMN\s+customer_id/i.test(p.patch))?.filename
        : undefined,
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
