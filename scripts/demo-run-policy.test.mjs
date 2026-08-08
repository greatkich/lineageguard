import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const packageJson = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"));

test("demo:run builds only the worker and its dependencies before execution", () => {
  const command = packageJson.scripts["demo:run"];

  assert.equal(
    command,
    "pnpm --filter @lineageguard/worker... build && node --import tsx scripts/demo.ts",
  );
  assert.doesNotMatch(command, /(?:^|&&\s*)pnpm build(?:\s|$)/);
  assert.doesNotMatch(command, /@lineageguard\/web/);
});
