import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

/**
 * Guards the generated SQL surfaces against an identifier-type regression. The canonical column
 * types are `uuid`; a `bigint` here would make the generated migration disagree with the schema
 * evidence a reviewer reads, which is exactly the drift this repository already shipped once.
 */
const packageSrc = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(packageSrc, "..", "..", "..");

function readSource(relativePath: string): string {
  return readFileSync(join(repoRoot, relativePath), "utf8");
}

describe("generated SQL uses uuid identifiers", () => {
  it("declares buyer_id as uuid in the canonical expand migration", () => {
    const candidate = readSource("packages/agent/src/steps/build-canonical-candidate.ts");

    expect(candidate).toContain("add column buyer_id uuid;");
    expect(candidate).not.toContain("add column buyer_id bigint");
  });

  it("expects a uuid buyer_id in the validator's canonical program allowlist", () => {
    const validator = readSource("packages/validation/src/validator.ts");

    expect(validator).toContain("add column buyer_id uuid;");
    expect(validator).not.toContain("add column buyer_id bigint");
  });

  it("keeps the backfill probe free of integer identifier arithmetic", () => {
    const validator = readSource("packages/validation/src/validator.ts");

    expect(validator).toContain("probe_order_id uuid");
    expect(validator).not.toContain("next_order_id bigint");
    expect(validator).not.toContain("max(order_id), 0) + 1");
  });
});
