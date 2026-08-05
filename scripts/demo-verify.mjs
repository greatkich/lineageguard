#!/usr/bin/env node
// @ts-check

/**
 * demo-verify.mjs --foundation-only
 * Verifies that FOUNDATION_STATUS.productReady === false.
 */

import { execSync } from "node:child_process";

const output = execSync(
  "node -e \"import('./packages/domain/src/index.ts').then(m => console.log(JSON.stringify(m.FOUNDATION_STATUS)))\" --experimental-strip-types",
  { encoding: "utf8" },
).trim();

const status = JSON.parse(output);

if (process.argv.includes("--foundation-only")) {
  if (status.productReady === false) {
    console.log("demo-verify: foundation-only confirmed (productReady=false)");
    process.exit(0);
  } else {
    console.error("demo-verify: FAIL – productReady is not false");
    process.exit(1);
  }
}

console.error("demo-verify: unknown mode");
process.exit(1);
