import { describe, expect, it } from "vitest";
import { runWorker } from "./index.js";

describe("runWorker", () => {
  it("returns after a single foundation cycle", async () => {
    await expect(runWorker({ once: true })).resolves.toBeUndefined();
  });

  it("stops when its abort signal is raised", async () => {
    const controller = new AbortController();
    const running = runWorker({ pollIntervalMs: 10, signal: controller.signal });

    controller.abort();

    await expect(running).resolves.toBeUndefined();
  });
});
