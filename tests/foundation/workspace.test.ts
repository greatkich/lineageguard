import { execSync } from "node:child_process";
import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";

describe("workspace contract", () => {
  it("pins package manager and exposes every repository gate", async () => {
    const root = JSON.parse(await readFile("package.json", "utf8")) as {
      packageManager: string;
      scripts: Record<string, string>;
    };
    expect(root.packageManager).toBe("pnpm@11.20.0");
    expect(Object.keys(root.scripts)).toEqual(
      expect.arrayContaining([
        "format:check",
        "lint",
        "typecheck",
        "test",
        "build",
        "test:e2e",
        "browser:install",
        "demo:verify",
        "env:check",
        "boundaries:check",
        "db:test:up",
      ]),
    );
  });

  it("enforces noImplicitAny via shared tsconfig.base.json", () => {
    const result = execSync(
      "pnpm exec tsc --project tests/foundation/fixtures/implicit-any/tsconfig.json --noEmit --pretty false 2>&1 || true",
      { encoding: "utf8" },
    );
    // tsc should fail on implicit any
    const exitCode = execSync(
      "pnpm exec tsc --project tests/foundation/fixtures/implicit-any/tsconfig.json --noEmit --pretty false; echo $?",
      { encoding: "utf8" },
    )
      .trim()
      .split("\n")
      .pop();
    expect(Number(exitCode)).not.toBe(0);
    expect(result).toContain("TS7006");
  });
});
