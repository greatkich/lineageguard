import { describe, expect, it } from "vitest";
import { canonicalDatasetRef, parseProposedChange } from "./change.js";
import { createCanonicalImpactContextFixture } from "./evidence.js";

/**
 * The canonical identifiers are `uuid` at every layer. An earlier revision read `uuid` from DataHub
 * but recorded `bigint` in evidence, so the exported evidence misstated the column type while every
 * gate stayed green. These checks fail if any canonical surface reintroduces `bigint`.
 */
function canonicalChangeId(): string {
  const result = parseProposedChange({
    source: "FIXTURE",
    repository: "lineageguard/canonical",
    baseSha: "1".repeat(40),
    headSha: "2".repeat(40),
    files: [
      {
        path: "walkthrough/migrations/rename.sql",
        datasetRef: canonicalDatasetRef,
        patch: "ALTER TABLE commerce.orders RENAME COLUMN customer_id TO buyer_id;",
      },
    ],
  });
  if (!result.ok) throw new Error(result.error.message);
  return result.value.id;
}

describe("canonical identifier type is uuid", () => {
  const context = createCanonicalImpactContextFixture(canonicalChangeId());

  it("records uuid as the source field's native type", () => {
    const schema = context.evidence.find((item) => item.kind === "SCHEMA");
    expect(schema?.kind).toBe("SCHEMA");
    if (schema?.kind !== "SCHEMA") throw new Error("schema evidence missing");

    expect(schema.payload.nativeType).toBe("uuid");
    expect(schema.payload.nativeType).not.toBe("bigint");
  });

  it("never mentions bigint in any evidence summary or payload", () => {
    const serialized = JSON.stringify(context);
    expect(serialized.toLowerCase()).not.toContain("bigint");
  });

  it("states uuid in the human-readable schema summary a judge reads", () => {
    const schema = context.evidence.find((item) => item.kind === "SCHEMA");
    expect(schema?.summary).toContain("uuid");
    expect(schema?.summary).not.toContain("bigint");
  });
});
