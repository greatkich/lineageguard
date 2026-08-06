import { eventBus } from "./events.js";
import { createOrchestrator } from "./orchestration.js";

export interface WorkerOptions {
  once?: boolean;
  signal?: AbortSignal;
  pollIntervalMs?: number;
  workerId?: string;
}

export async function runWorker(options: WorkerOptions = {}): Promise<void> {
  const workerId = options.workerId ?? process.env.WORKER_ID ?? "worker-1";
  const orchestrator = await createOrchestrator(workerId);
  void orchestrator;

  const pollOnce = (): void => {
    eventBus.publish({
      runId: "none",
      status: "POLLED",
      timestamp: new Date().toISOString(),
      detail: `worker ${workerId} found no claimable run`,
    });
  };

  if (options.once) {
    pollOnce();
    return;
  }

  const signal = options.signal;
  if (signal?.aborted) return;

  await new Promise<void>((resolve) => {
    const interval = setInterval(pollOnce, options.pollIntervalMs ?? 1_000);
    const stop = () => {
      clearInterval(interval);
      resolve();
    };

    signal?.addEventListener("abort", stop, { once: true });
  });
}
