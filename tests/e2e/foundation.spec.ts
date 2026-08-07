import { expect, test } from "@playwright/test";

test("renders Mission Control header", async ({ page }) => {
  await page.goto("/");
  await expect(page.locator("header")).toContainText("LineageGuard");
  await expect(page.getByRole("heading", { level: 1 })).toHaveText("Dashboard");
});
