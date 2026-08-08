import { mkdirSync, writeFileSync } from "node:fs";
import { createSimpleRunStore, type SimpleRun } from "@lineageguard/db";
import { expect, type Page, test } from "@playwright/test";
import pg from "pg";
import {
  captureGoldenScreenshotManifest,
  canonicalGoldenStates,
} from "../../scripts/golden-manifest.js";

/**
 * LIVE golden recording capture.
 *
 * This suite is the submission-evidence path and is deliberately different from
 * `mission-control.spec.ts`:
 *
 *   - it seeds nothing. The run must already exist in PostgreSQL from a real `demo:run`;
 *   - it refuses to run unless `LINEAGEGUARD_GOLDEN_RUN_ID` names an existing COMPLETED LIVE run;
 *   - every screenshot is captured from `/runs/<LIVE_RUN_ID>`, so all eight states are attributable
 *     to one live execution.
 *
 * Fixture screenshots live under `artifacts/test-fixtures/` and are never golden evidence.
 */

const goldenRunId = process.env.LINEAGEGUARD_GOLDEN_RUN_ID ?? "";
const outputDir =
  process.env.LINEAGEGUARD_GOLDEN_SCREENSHOT_DIR ?? "artifacts/demo-readiness/screenshots";

/** The eight states the recording script needs, in narrative order. */
const requiredStates = canonicalGoldenStates;
type GoldenState = (typeof requiredStates)[number];

async function shootPage(page: Page, state: GoldenState, captured: string[]): Promise<void> {
  await page.screenshot({ path: `${outputDir}/${state}.png`, fullPage: true });
  captured.push(state);
}

async function shootElement(
  page: Page,
  state: GoldenState,
  testId: string,
  captured: string[],
): Promise<void> {
  const target = page.getByTestId(testId);
  await target.scrollIntoViewIfNeeded();
  await target.screenshot({ path: `${outputDir}/${state}.png` });
  captured.push(state);
}

async function captureRiskStates(page: Page, captured: string[]): Promise<void> {
  await page.goto("/");
  await expect(page.locator(`a[href="/runs/${goldenRunId}"]`)).toBeVisible();
  await page.goto(`/runs/${goldenRunId}`);
  await expect(page.getByTestId("baseline-assessment")).toContainText("Repository-only");
  await shootPage(page, "01-baseline-allow", captured);
  await expect(page.getByTestId("downstream-consumer-count")).toHaveText("4");
  await expect(page.getByTestId("downstream-consumer")).toHaveCount(4);
  await shootElement(page, "02-datahub-consumers", "downstream-consumers", captured);
  const transition = page.getByTestId("decision-transition");
  await expect(transition).toContainText("ALLOW");
  await expect(transition).toContainText("BLOCK");
  await shootElement(page, "03-allow-to-block", "decision-transition", captured);
  await expect(page.getByTestId("migration-strategy")).toContainText("Expand");
  await shootElement(page, "04-uuid-migration", "migration-strategy", captured);
}

async function captureOutcomeStates(page: Page, run: SimpleRun, captured: string[]): Promise<void> {
  await expect(page.getByTestId("validation-status")).toContainText("PASS");
  await shootElement(page, "05-validation-pass", "validation-status", captured);
  const prLink = page.getByTestId("generated-pr-link");
  await expect(prLink).toBeVisible();
  await expect(prLink).toHaveAttribute("href", run.prUrl ?? "");
  await shootElement(page, "06-generated-pr", "generated-pr-link", captured);
  await expect(page.getByTestId("datahub-writeback")).toContainText("SUCCEEDED");
  await shootElement(page, "07-datahub-writeback", "datahub-writeback", captured);
  await expect(page.getByTestId("run-summary-banner")).toContainText("Breaking change prevented");
  await shootPage(page, "08-completed-summary", captured);
}

/**
 * Only runs when a golden run id is supplied, which `pnpm demo:golden` always does. A bare
 * `pnpm test:e2e` skips it, because deterministic CI has no live run to record. `demo:golden` does
 * not rely on this suite reporting success — it independently asserts that all eight files and the
 * manifest exist, so a skipped suite can never be mistaken for captured evidence.
 */
const describeGolden = goldenRunId.length === 0 ? test.describe.skip : test.describe;

describeGolden("Golden recording (LIVE run)", () => {
  test.describe.configure({ mode: "serial" });

  let run: SimpleRun;
  let pool: pg.Pool;

  test.beforeAll(async () => {
    if (goldenRunId.length === 0) {
      throw new Error(
        "LINEAGEGUARD_GOLDEN_RUN_ID is required. Golden recording evidence must name the exact " +
          "LIVE run it was captured from; run this through `pnpm demo:golden -- --runId <id>`.",
      );
    }
    pool = new pg.Pool({
      connectionString:
        process.env.LINEAGEGUARD_DATABASE_URL ??
        "postgresql://lineageguard:lineageguard@127.0.0.1:5432/lineageguard",
      max: 2,
    });
    const store = createSimpleRunStore(pool);
    const found = await store.get(goldenRunId);
    if (!found) {
      throw new Error(
        `run ${goldenRunId} is not in the run store. Golden recording never seeds a fixture — ` +
          "execute `pnpm demo:run` first.",
      );
    }
    if (found.status !== "COMPLETED") {
      throw new Error(
        `run ${goldenRunId} is ${found.status}; only a COMPLETED run may be recorded`,
      );
    }
    if (found.executionMode !== "LIVE") {
      throw new Error(
        `run ${goldenRunId} has executionMode ${found.executionMode}; golden evidence requires LIVE`,
      );
    }
    run = found;
    mkdirSync(outputDir, { recursive: true });
  });

  test.afterAll(async () => {
    await pool?.end();
  });

  test("captures the eight recording states from the live run at 1440x900", async ({ page }) => {
    const manifest = await captureGoldenScreenshotManifest({
      run: { ...run, applicationCodeSha: run.applicationCodeSha ?? "" },
      viewport: { width: 1440, height: 900 },
      capture: async () => {
        const captured: string[] = [];
        await captureRiskStates(page, captured);
        await captureOutcomeStates(page, run, captured);
        expect(captured).toEqual([...requiredStates]);
        return { capturedAt: new Date().toISOString(), states: captured };
      },
    });
    writeFileSync(`${outputDir}/manifest.json`, `${JSON.stringify(manifest, null, 2)}\n`);
  });
});
