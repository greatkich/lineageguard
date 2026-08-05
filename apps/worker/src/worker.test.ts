import { expect, it } from "vitest";
import { createWorkerHeartbeat } from "./worker.js";

it("creates a deterministic foundation heartbeat", () => {
  expect(createWorkerHeartbeat("2026-08-03T12:00:00.000Z")).toEqual({
    service: "worker",
    phase: "FOUNDATION",
    productReady: false,
    observedAt: "2026-08-03T12:00:00.000Z",
  });
});
