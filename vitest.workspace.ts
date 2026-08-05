import { defineWorkspace } from "vitest/config";

export default defineWorkspace([
  "apps/*/vitest.config.ts",
  "packages/*/vitest.config.ts",
  {
    test: {
      name: "foundation",
      include: ["tests/foundation/**/*.test.ts"],
    },
  },
]);
