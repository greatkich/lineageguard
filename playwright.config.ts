import { defineConfig, devices } from "@playwright/test";

export default defineConfig({
  testDir: "./tests/e2e",
  fullyParallel: true,
  forbidOnly: Boolean(process.env.CI),
  retries: process.env.CI ? 2 : 0,
  reporter: process.env.CI ? "github" : "list",
  use: {
    baseURL: "http://127.0.0.1:4317",
    trace: "on-first-retry",
  },
  webServer: {
    command:
      "pnpm --filter @lineageguard/web build && pnpm --filter @lineageguard/web exec next start --hostname 127.0.0.1 --port 4317",
    reuseExistingServer: false,
    url: "http://127.0.0.1:4317",
  },
  projects: [
    {
      name: "chromium",
      use: { ...devices["Desktop Chrome"] },
    },
  ],
});
