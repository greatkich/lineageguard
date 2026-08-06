import { defineConfig, devices } from "@playwright/test";

export default defineConfig({
  testDir: "./tests/e2e",
  fullyParallel: true,
  forbidOnly: Boolean(process.env.CI),
  retries: process.env.CI ? 2 : 0,
  reporter: process.env.CI ? "github" : "list",
  use: {
    baseURL: "http://127.0.0.1:3000",
    trace: "on-first-retry",
    viewport: { width: 1440, height: 900 },
  },
  webServer: {
    command: "LINEAGEGUARD_DATABASE_URL=postgresql://lineageguard:lineageguard@127.0.0.1:5432/lineageguard pnpm --filter @lineageguard/web dev --port 3000",
    reuseExistingServer: true,
    url: "http://127.0.0.1:3000",
    timeout: 15_000,
  },
  projects: [
    {
      name: "chromium",
      use: { ...devices["Desktop Chrome"], viewport: { width: 1440, height: 900 } },
    },
  ],
});
