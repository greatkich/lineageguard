import { defineConfig, devices } from "@playwright/test";

export default defineConfig({
  testDir: "tests/e2e",
  projects: [
    {
      name: "chromium",
      use: { ...devices["Desktop Chrome"] },
    },
  ],
  webServer: {
    command:
      "pnpm --filter @lineageguard/web build && pnpm --filter @lineageguard/web start -p 3999",
    port: 3999,
    reuseExistingServer: !process.env.CI,
  },
  use: {
    baseURL: "http://localhost:3999",
  },
});
