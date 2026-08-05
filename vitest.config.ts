import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: [
      "packages/*/src/**/*.test.ts",
      "apps/*/src/**/*.test.ts",
      "tests/foundation/**/*.test.ts",
    ],
    exclude: ["node_modules", "dist", ".next", "tests/e2e"],
  },
});
