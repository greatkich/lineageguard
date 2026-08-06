import { expect, test } from "@playwright/test";

test.describe("Mission Control — Dashboard", () => {
  test("shows real runs from Postgres", async ({ page }) => {
    await page.goto("/");

    // Header present
    await expect(page.locator("header")).toContainText("LineageGuard");
    await expect(page.locator("header")).toContainText("Mission Control");

    // Page title
    await expect(page.getByRole("heading", { level: 1 })).toHaveText("Runs");

    // Real run from Postgres (created by pipeline E2E)
    const runLink = page.locator("a[href*='/runs/run_']").first();
    await expect(runLink).toBeVisible();

    // Shows real status and decision
    await expect(runLink).toContainText("COMPLETED");
    await expect(runLink).toContainText("ALLOW");
    await expect(runLink).toContainText("BLOCK");
    await expect(runLink).toContainText("customer_id");
  });

  test("no hardcoded demo data present", async ({ page }) => {
    await page.goto("/");
    const body = await page.locator("body").textContent();
    // These were old hardcoded values — they should NOT appear
    expect(body).not.toContain("Finance Revenue Dashboard");
    expect(body).not.toContain("run_000000000000000000000001");
  });
});

test.describe("Mission Control — Run Detail", () => {
  test("displays real run data from Postgres", async ({ page }) => {
    // Navigate to dashboard first to get real run ID
    await page.goto("/");
    const runLink = page.locator("a[href*='/runs/run_']").first();
    await expect(runLink).toBeVisible();

    // Click into run detail
    await runLink.click();
    await page.waitForURL(/\/runs\/run_/);

    // 3-panel layout visible
    await expect(page.locator("text=Proposed Change")).toBeVisible();
    await expect(page.locator("text=DataHub Evidence")).toBeVisible();
    await expect(page.locator("text=Migration")).toBeVisible();

    // Real data from pipeline
    await expect(page.getByText("customer_id").first()).toBeVisible();
    await expect(page.locator("text=BLOCK").first()).toBeVisible();
  });

  test("timeline shows progression", async ({ page }) => {
    await page.goto("/");
    const runLink = page.locator("a[href*='/runs/run_']").first();
    await runLink.click();
    await page.waitForURL(/\/runs\/run_/);

    // Timeline steps visible — use exact text matching
    await expect(page.getByText("Created", { exact: true })).toBeVisible();
    await expect(page.getByText("Parsed", { exact: true })).toBeVisible();
    await expect(page.getByText("Context", { exact: true })).toBeVisible();
    await expect(page.getByText("Decision", { exact: true })).toBeVisible();
    await expect(page.getByText("Complete", { exact: true })).toBeVisible();
  });

  test("returns 404 for non-existent run", async ({ page }) => {
    const response = await page.goto("/runs/run_nonexistent");
    expect(response?.status()).toBe(404);
  });
});

test.describe("API Routes", () => {
  test("GET /api/runs returns real data from Postgres", async ({ request }) => {
    const response = await request.get("/api/runs");
    expect(response.ok()).toBe(true);

    const runs = await response.json();
    expect(Array.isArray(runs)).toBe(true);
    expect(runs.length).toBeGreaterThan(0);

    const run = runs[0];
    expect(run.id).toMatch(/^run_/);
    expect(run.status).toBe("COMPLETED");
    expect(run.groundedDecision).toBe("BLOCK");
    expect(run.baselineDecision).toBe("ALLOW");
    expect(run.consumersFound).toBeGreaterThanOrEqual(2);
    expect(run.artifactsGenerated).toBeGreaterThan(0);
  });

  test("GET /api/runs/[id] returns single run", async ({ request }) => {
    // Get ID from list first
    const listRes = await request.get("/api/runs");
    const runs = await listRes.json();
    const runId = runs[0].id;

    const response = await request.get(`/api/runs/${runId}`);
    expect(response.ok()).toBe(true);

    const run = await response.json();
    expect(run.id).toBe(runId);
    expect(run.repository).toBe("greatkich/lineageguard");
    expect(run.field).toBe("customer_id");
  });

  test("GET /api/runs/[id] returns 404 for missing run", async ({ request }) => {
    const response = await request.get("/api/runs/run_does_not_exist");
    expect(response.status()).toBe(404);
  });
});
