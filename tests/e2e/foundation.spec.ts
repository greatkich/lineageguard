import { test, expect } from "@playwright/test";

test("foundation page renders honest status", async ({ page }) => {
  await page.goto("/");
  await expect(page.locator("h1")).toHaveText("LineageGuard");
  await expect(page.locator("main p")).toHaveText(
    "Foundation installed; canonical demo not implemented.",
  );

  const errors: string[] = [];
  page.on("pageerror", (err) => errors.push(err.message));
  await page.waitForTimeout(500);
  expect(errors).toHaveLength(0);
});
