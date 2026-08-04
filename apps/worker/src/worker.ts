import { runWorker } from "./index.js";

const controller = new AbortController();
for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.once(signal, () => controller.abort());
}

await runWorker({
  once: process.argv.includes("--once"),
  signal: controller.signal,
});
