export interface WorkerOptions {
  once?: boolean;
  signal?: AbortSignal;
  pollIntervalMs?: number;
}

export async function runWorker(options: WorkerOptions = {}): Promise<void> {
  if (options.once) return;

  const signal = options.signal;
  if (signal?.aborted) return;

  await new Promise<void>((resolve) => {
    const interval = setInterval(() => undefined, options.pollIntervalMs ?? 1_000);
    const stop = () => {
      clearInterval(interval);
      resolve();
    };

    signal?.addEventListener("abort", stop, { once: true });
  });
}
