import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    coverage: {
      reporter: ["text", "json", "html"],
    },
    exclude: ["**/node_modules/**", "**/.next/**", "**/dist/**", "tests/e2e/**"],
    include: ["apps/**/*.test.ts", "packages/**/*.test.ts", "tests/**/*.test.ts"],
  },
});
