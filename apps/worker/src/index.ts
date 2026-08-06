import type { PipelineResult } from "@lineageguard/agent";
import { eventBus } from "./events.js";
import { createOrchestrator } from "./orchestration.js";
import { createSimpleRun, ensureRunsTable } from "./simple-store.js";

export interface WorkerOptions {
  once?: boolean;
  signal?: AbortSignal;
  pollIntervalMs?: number;
  workerId?: string;
}

export async function runWorker(options: WorkerOptions = {}): Promise<PipelineResult | null> {
  const workerId = options.workerId ?? process.env.WORKER_ID ?? "worker-1";
  const orchestrator = await createOrchestrator(workerId);

  if (options.once) {
    // --once mode: create and execute a single canonical run
    await ensureRunsTable();

    const runId = `run_${Date.now().toString(16).padStart(24, "0")}`;
    const repository = process.env.LINEAGEGUARD_REPOSITORY ?? "greatkich/lineageguard";

    const baseSha = process.env.LINEAGEGUARD_BASE_SHA;
    const headSha = process.env.LINEAGEGUARD_HEAD_SHA;

    if (!baseSha || !headSha) {
      throw new Error(
        "LINEAGEGUARD_BASE_SHA and LINEAGEGUARD_HEAD_SHA are required in LIVE mode. " +
        "Set these to real Git SHAs from the repository."
      );
    }

    await createSimpleRun({
      id: runId,
      repository,
      field: "customer_id",
      patch: "ALTER TABLE commerce.orders RENAME COLUMN customer_id TO buyer_id;",
    });

    console.log(`[worker] Executing canonical run ${runId}...`);

    const result = await orchestrator.execute({
      runId,
      repository,
      baseSha,
      headSha,
      patch: "ALTER TABLE commerce.orders RENAME COLUMN customer_id TO buyer_id;",
      table: "commerce.orders",
      field: "customer_id",
      newName: "buyer_id",
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
