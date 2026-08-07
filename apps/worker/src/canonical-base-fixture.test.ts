import { describe, expect, it } from "vitest";
import { canonicalBaseFixtureSql } from "./canonical-base-fixture.js";

/**
 * Asserts the emitted SQL, not the source text, so the guarantees hold for what actually reaches
 * the validation container.
 */
describe("canonical base fixture SQL", () => {
  it("declares both identifier columns as uuid", () => {
    expect(canonicalBaseFixtureSql).toContain("order_id UUID PRIMARY KEY");
    expect(canonicalBaseFixtureSql).toContain("customer_id UUID NOT NULL");
    expect(canonicalBaseFixtureSql.toLowerCase()).not.toContain("bigint");
  });

  it("uses fixed literals so a validation receipt is reproducible", () => {
    expect(canonicalBaseFixtureSql).not.toContain("gen_random_uuid");
    expect(canonicalBaseFixtureSql).not.toContain("uuid_generate");
    expect(canonicalBaseFixtureSql).not.toContain("now() as");
  });

  it("seeds three rows whose identifiers are all well-formed uuids", () => {
    const literals = [...canonicalBaseFixtureSql.matchAll(/'([0-9a-f-]{36})'/g)].map(
      (match) => match[1],
    );

    expect(literals).toHaveLength(6);
    for (const literal of literals) {
      expect(literal).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
    }
  });

  it("repeats one customer so backfill equality covers a duplicate identifier", () => {
    const customerIds = [...canonicalBaseFixtureSql.matchAll(/'([0-9a-f-]{36})'/g)]
      .map((match) => match[1])
      .filter((_, index) => index % 2 === 1);

    expect(customerIds).toHaveLength(3);
    expect(new Set(customerIds).size).toBe(2);
  });

  it("is a single deterministic string across evaluations", () => {
    expect(canonicalBaseFixtureSql).toBe(canonicalBaseFixtureSql);
    expect(canonicalBaseFixtureSql.startsWith("CREATE SCHEMA IF NOT EXISTS commerce;")).toBe(true);
    expect(canonicalBaseFixtureSql.trimEnd().endsWith(";")).toBe(true);
  });
});
