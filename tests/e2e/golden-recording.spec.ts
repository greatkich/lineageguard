import { mkdirSync, writeFileSync } from "node:fs";
import { createSimpleRunStore, type SimpleRun } from "@lineageguard/db";
import { expect, test } from "@playwright/test";
import pg from "pg";

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
const requiredStates = [
  "01-baseline-allow",
  "02-datahub-consumers",
  "03-allow-to-block",
  "04-uuid-migration",
  "05-validation-pass",
  "06-generated-pr",
  "07-datahub-writeback",
  "08-completed-summary",
] as const;

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
    const captured: string[] = [];
    const shoot = async (state: (typeof requiredStates)[number]): Promise<void> => {
      await page.screenshot({ path: `${outputDir}/${state}.png`, fullPage: true });
      captured.push(state);
    };

    // The dashboard must list this exact live run before anything else is claimed.
    await page.goto("/");
    await expect(page.locator(`a[href="/runs/${goldenRunId}"]`)).toBeVisible();

    await page.goto(`/runs/${goldenRunId}`);

    // 1. Baseline ALLOW — the repository-only assessment.
    await expect(page.getByTestId("baseline-assessment")).toContainText("Repository-only");
    await shoot("01-baseline-allow");

    // 2. Four DataHub downstream consumers.
    await expect(page.getByTestId("downstream-consumer-count")).toHaveText("4");
    await expect(page.getByTestId("downstream-consumer")).toHaveCount(4);
    await page.getByTestId("downstream-consumers").scrollIntoViewIfNeeded();
    await shoot("02-datahub-consumers");

    // 3. ALLOW → BLOCK.
    const transition = page.getByTestId("decision-transition");
    await expect(transition).toContainText("ALLOW");
    await expect(transition).toContainText("BLOCK");
    await transition.scrollIntoViewIfNeeded();
    await shoot("03-allow-to-block");

    // 4. UUID-safe expand–migrate–contract migration.
    await expect(page.getByTestId("migration-strategy")).toContainText("Expand");
    await page.getByTestId("migration-strategy").scrollIntoViewIfNeeded();
    await shoot("04-uuid-migration");

    // 5. Validation PASS.
    await expect(page.getByTestId("validation-status")).toContainText("PASS");
    await page.getByTestId("validation-status").scrollIntoViewIfNeeded();
    await shoot("05-validation-pass");

    // 6. The generated pull request.
    const prLink = page.getByTestId("generated-pr-link");
    await expect(prLink).toBeVisible();
    await expect(prLink).toHaveAttribute("href", run.prUrl ?? "");
    await prLink.scrollIntoViewIfNeeded();
    await shoot("06-generated-pr");

    // 7. DataHub write-back.
    const writeback = page.getByTestId("datahub-writeback");
    await expect(writeback).toContainText("SUCCEEDED");
    await writeback.scrollIntoViewIfNeeded();
    await shoot("07-datahub-writeback");

    // 8. Final COMPLETED summary.
    const banner = page.getByTestId("run-summary-banner");
    await expect(banner).toContainText("Breaking change prevented");
    await banner.scrollIntoViewIfNeeded();
    await shoot("08-completed-summary");

    expect(captured).toEqual([...requiredStates]);

    // The manifest binds the screenshots to the run and code they came from, so evidence can never
    // be re-attributed to a different execution later.
    writeFileSync(
      `${outputDir}/manifest.json`,
      `${JSON.stringify(
        {
          runId: goldenRunId,
          executionMode: run.executionMode,
          status: run.status,
          prUrl: run.prUrl,
          capturedAt: new Date().toISOString(),
          viewport: { width: 1440, height: 900 },
          states: captured,
        },
        null,
        2,
      )}\n`,
    );
  });
});
