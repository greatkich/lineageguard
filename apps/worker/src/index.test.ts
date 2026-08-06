import { describe, expect, it } from "vitest";
import { runWorker } from "./index.js";

describe("runWorker", () => {
  it("fails when base/head SHAs are not set in --once mode", async () => {
    // In --once mode, LINEAGEGUARD_BASE_SHA and LINEAGEGUARD_HEAD_SHA are required
    const origBase = process.env.LINEAGEGUARD_BASE_SHA;
    const origHead = process.env.LINEAGEGUARD_HEAD_SHA;
    delete process.env.LINEAGEGUARD_BASE_SHA;
    delete process.env.LINEAGEGUARD_HEAD_SHA;
    try {
      await expect(runWorker({ once: true })).rejects.toThrow("LINEAGEGUARD_BASE_SHA");
    } finally {
      if (origBase !== undefined) process.env.LINEAGEGUARD_BASE_SHA = origBase;
      if (origHead !== undefined) process.env.LINEAGEGUARD_HEAD_SHA = origHead;
    }
  });

  it("stops when its abort signal is raised", async () => {
    const controller = new AbortController();
    const running = runWorker({ pollIntervalMs: 10, signal: controller.signal });

    controller.abort();

    const result = await running;
    expect(result).toBeNull();
  });
});
