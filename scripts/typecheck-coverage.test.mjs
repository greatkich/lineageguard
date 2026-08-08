import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const scriptsDir = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(scriptsDir, "..");

function readJson(relativePath) {
  return JSON.parse(readFileSync(join(repoRoot, relativePath), "utf8"));
}

/**
 * `scripts/` is not a pnpm workspace package, so `pnpm --recursive typecheck` skips it. The demo
 * lifecycle is implemented as TypeScript scripts, so a dedicated project must stay wired into the
 * standard gate. These checks fail if that wiring is removed or a script escapes its include glob.
 */
test("the standard typecheck gate invokes the scripts project", () => {
  const { scripts } = readJson("package.json");
  assert.ok(scripts["typecheck:scripts"], "typecheck:scripts script must exist");
  assert.match(
    scripts["typecheck:scripts"],
    /tsc -p tsconfig\.scripts\.json/,
    "typecheck:scripts must compile tsconfig.scripts.json",
  );
  assert.match(
    scripts.typecheck,
    /typecheck:scripts/,
    "the top-level typecheck script must chain typecheck:scripts",
  );
});

test("the scripts project type-checks without emitting and inherits repository strictness", () => {
  const config = readJson("tsconfig.scripts.json");
  assert.equal(config.extends, "./tsconfig.base.json");
  assert.equal(config.compilerOptions.noEmit, true);
  // Both trees live outside the pnpm workspace, so both need this project to be gated at all.
  assert.deepEqual(config.include, ["scripts/**/*.ts", "tests/**/*.ts"]);
});

test("every TypeScript file outside the pnpm workspace is covered by the gate", () => {
  const testsDir = join(repoRoot, "tests");
  const collect = (dir) =>
    readdirSync(dir, { recursive: true, withFileTypes: true })
      .filter((entry) => entry.isFile() && entry.name.endsWith(".ts"))
      .map((entry) => entry.name);

  const scriptFiles = collect(scriptsDir);
  const testFiles = collect(testsDir);

  assert.ok(
    scriptFiles.length > 0,
    "expected at least one TypeScript script; update this test if scripts/ becomes JS-only",
  );
  assert.ok(testFiles.length > 0, "expected at least one TypeScript file under tests/");
  // The globs cover both trees recursively, so the only escape is a declaration-only file, which
  // carries no runtime behaviour worth gating.
  for (const name of [...scriptFiles, ...testFiles]) {
    assert.ok(!name.endsWith(".d.ts"), `unexpected declaration file: ${name}`);
  }
});

test("the demo lifecycle entrypoints are present and typed", () => {
  const names = readdirSync(scriptsDir).filter((name) => name.endsWith(".ts"));
  for (const required of ["demo.ts", "export-evidence.ts"]) {
    assert.ok(names.includes(required), `scripts/${required} must exist and be typechecked`);
  }
});
