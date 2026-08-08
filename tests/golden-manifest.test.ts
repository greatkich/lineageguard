import { describe, expect, it } from "vitest";
import {
  buildGoldenScreenshotManifest,
  captureGoldenScreenshotManifest,
} from "../scripts/golden-manifest.js";

const applicationCodeSha = "0123456789abcdef0123456789abcdef01234567";
const states = [
  "01-baseline-allow",
  "02-datahub-consumers",
  "03-allow-to-block",
  "04-uuid-migration",
  "05-validation-pass",
  "06-generated-pr",
  "07-datahub-writeback",
  "08-completed-summary",
] as const;

const completedLiveRun = {
  id: "run_000000000000000000000001",
  applicationCodeSha,
  executionMode: "LIVE",
  status: "COMPLETED",
  prUrl: "https://github.com/greatkich/lineageguard/pull/9",
};

describe("buildGoldenScreenshotManifest", () => {
  it("binds the canonical ordered screenshots to the completed LIVE run application SHA", () => {
    expect(
      buildGoldenScreenshotManifest({
        run: completedLiveRun,
        capturedAt: "2026-08-08T10:00:00.000Z",
        viewport: { width: 1440, height: 900 },
        states,
      }),
    ).toEqual({
      runId: "run_000000000000000000000001",
      applicationCodeSha,
      executionMode: "LIVE",
      status: "COMPLETED",
      prUrl: "https://github.com/greatkich/lineageguard/pull/9",
      capturedAt: "2026-08-08T10:00:00.000Z",
      viewport: { width: 1440, height: 900 },
      states: [...states],
    });
  });

  it.each([null, "not-a-sha"])("rejects applicationCodeSha %s", (invalidSha) => {
    expect(() =>
      buildGoldenScreenshotManifest({
        run: { ...completedLiveRun, applicationCodeSha: invalidSha as unknown as string },
        capturedAt: "2026-08-08T10:00:00.000Z",
        viewport: { width: 1440, height: 900 },
        states,
      }),
    ).toThrowError(/applicationCodeSha/);
  });

  it("rejects screenshots that are not the canonical ordered eight states", () => {
    const outOfOrder: string[] = [...states];
    [outOfOrder[0], outOfOrder[1]] = [outOfOrder[1] as string, outOfOrder[0] as string];

    expect(() =>
      buildGoldenScreenshotManifest({
        run: completedLiveRun,
        capturedAt: "2026-08-08T10:00:00.000Z",
        viewport: { width: 1440, height: 900 },
        states: outOfOrder,
      }),
    ).toThrowError(/canonical ordered eight states/);
  });
});

describe("captureGoldenScreenshotManifest", () => {
  it("rejects when code changes during screenshot capture", async () => {
    const observed = [
      { applicationCodeSha, porcelain: "" },
      {
        applicationCodeSha: "89abcdef0123456789abcdef0123456789abcdef",
        porcelain: "",
      },
    ];

    await expect(
      captureGoldenScreenshotManifest({
        run: completedLiveRun,
        viewport: { width: 1440, height: 900 },
        readState: async () => observed.shift() as (typeof observed)[number],
        capture: async () => ({
          capturedAt: "2026-08-08T10:00:00.000Z",
          states,
        }),
      }),
    ).rejects.toThrowError(/changed/);
  });

  it("binds capture output to the observed clean matching checkout", async () => {
    await expect(
      captureGoldenScreenshotManifest({
        run: completedLiveRun,
        viewport: { width: 1440, height: 900 },
        readState: async () => ({ applicationCodeSha, porcelain: "" }),
        capture: async () => ({
          capturedAt: "2026-08-08T10:00:00.000Z",
          states,
        }),
      }),
    ).resolves.toMatchObject({ applicationCodeSha, states: [...states] });
  });
});
