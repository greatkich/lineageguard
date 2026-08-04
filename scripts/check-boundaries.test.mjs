import assert from "node:assert/strict";
import { resolve } from "node:path";
import test from "node:test";
import { extractImportSpecifiers, findBoundaryViolations } from "./check-boundaries.mjs";

const repositoryRoot = resolve("/workspace/lineageguard");

function sourceFile(path, source) {
  return { path: resolve(repositoryRoot, path), source };
}

test("extracts static, exported, dynamic, and required module specifiers", () => {
  const source = `
    import type { Run } from "@lineageguard/domain";
    export { store } from "@lineageguard/db";
    const adapter = import("@lineageguard/datahub");
    const legacy = require("external-package");
  `;

  assert.deepEqual(extractImportSpecifiers(source), [
    "@lineageguard/domain",
    "@lineageguard/db",
    "@lineageguard/datahub",
    "external-package",
  ]);
});

test("accepts imports explicitly allowed for each application boundary", () => {
  const files = [
    sourceFile(
      "packages/agent/src/index.ts",
      'import type { Evidence } from "@lineageguard/domain";',
    ),
    sourceFile("apps/web/app/page.tsx", 'import type { Run } from "@lineageguard/db";'),
    sourceFile(
      "apps/worker/src/worker.ts",
      'import { collect } from "@lineageguard/datahub"; import { plan } from "@lineageguard/agent";',
    ),
  ];

  assert.deepEqual(findBoundaryViolations(files, repositoryRoot), []);
});

test("rejects forbidden package and relative cross-boundary imports", () => {
  const files = [
    sourceFile(
      "packages/domain/src/policy.ts",
      'import { client } from "@lineageguard/datahub"; import { hidden } from "../../datahub/src/internal.js";',
    ),
    sourceFile("apps/worker/src/worker.ts", 'import { Panel } from "@lineageguard/ui";'),
  ];

  assert.deepEqual(
    findBoundaryViolations(files, repositoryRoot).map(({ source, target }) => ({ source, target })),
    [
      { source: "domain", target: "datahub" },
      { source: "domain", target: "datahub" },
      { source: "worker", target: "ui" },
    ],
  );
});

test("rejects unknown internal package names", () => {
  const files = [
    sourceFile("apps/worker/src/worker.ts", 'import { value } from "@lineageguard/unknown";'),
  ];

  assert.equal(findBoundaryViolations(files, repositoryRoot).length, 1);
});
