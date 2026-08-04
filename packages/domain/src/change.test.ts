import { describe, expect, it } from "vitest";
import {
  canonicalDatasetRef,
  datasetRefSchema,
  parseProposedChange,
  repositoryChangeInputSchema,
} from "./change.js";

const canonicalSql = "ALTER TABLE commerce.orders RENAME COLUMN customer_id TO buyer_id;";

function input(patch: string, path = "walkthrough/migrations/rename.sql") {
  return {
    source: "FIXTURE" as const,
    repository: "lineageguard/canonical",
    baseSha: "1111111",
    headSha: "2222222",
    files: [{ path, datasetRef: canonicalDatasetRef, patch }],
  };
}

describe("proposed change parser", () => {
  it("parses the qualified canonical ALTER TABLE rename deterministically", () => {
    const first = parseProposedChange(input(canonicalSql));
    const second = parseProposedChange(input(canonicalSql));

    expect(first).toEqual(second);
    expect(first.ok).toBe(true);
    if (first.ok) {
      expect(first.value).toMatchObject({
        operation: "RENAME_FIELD",
        field: "customer_id",
        before: { field: "customer_id" },
        after: { field: "buyer_id" },
        datasetRef: canonicalDatasetRef,
      });
      expect(first.value.id).toMatch(/^chg_[a-f0-9]{24}$/);
      expect(first.value.fingerprint).toMatch(/^[a-f0-9]{64}$/);
    }
  });

  it("parses the exact unified-diff field rename with explicit file and dataset context", () => {
    const path = "walkthrough/models/orders.sql";
    const patch = [
      `diff --git a/${path} b/${path}`,
      `--- a/${path}`,
      `+++ b/${path}`,
      "@@ -1,3 +1,3 @@",
      " select",
      "-  customer_id::bigint as customer_id,",
      "+  buyer_id::bigint as buyer_id,",
      "   order_total",
    ].join("\n");

    const result = parseProposedChange(input(patch, path));
    expect(result.ok).toBe(true);
  });

  it.each([
    ["NO_SUPPORTED_CHANGE", "select order_id from commerce.orders;"],
    ["UNSUPPORTED_CHANGE", "ALTER TABLE orders RENAME COLUMN customer_id TO buyer_id;"],
    ["UNSUPPORTED_CHANGE", "ALTER TABLE commerce.orders RENAME COLUMN customer_id TO account_id;"],
  ])("returns %s for a rejected patch", (code, patch) => {
    const result = parseProposedChange(input(patch));
    expect(result).toMatchObject({ ok: false, error: { code } });
  });

  it("rejects multiple supported changes", () => {
    const value = input(canonicalSql);
    value.files.push({
      path: "walkthrough/migrations/second.sql",
      datasetRef: canonicalDatasetRef,
      patch: canonicalSql,
    });
    expect(parseProposedChange(value)).toMatchObject({
      ok: false,
      error: { code: "MULTIPLE_SUPPORTED_CHANGES" },
    });
  });

  it("rejects multiple canonical statements in one file", () => {
    expect(parseProposedChange(input(`${canonicalSql}\n${canonicalSql}`))).toMatchObject({
      ok: false,
      error: { code: "MULTIPLE_SUPPORTED_CHANGES" },
    });
  });

  it("rejects a canonical rename mixed with an ambiguous field edit", () => {
    const value = input(canonicalSql);
    value.files.push({
      path: "walkthrough/models/ambiguous.sql",
      datasetRef: canonicalDatasetRef,
      patch: "+ select buyer_id from commerce.orders;",
    });
    expect(parseProposedChange(value)).toMatchObject({
      ok: false,
      error: { code: "AMBIGUOUS_CHANGE" },
    });
  });

  it("rejects unqualified context and unknown keys", () => {
    expect(
      repositoryChangeInputSchema.safeParse({
        ...input(canonicalSql),
        unexpected: true,
      }).success,
    ).toBe(false);
    expect(
      datasetRefSchema.safeParse({
        ...canonicalDatasetRef,
        dataset: "other",
      }).success,
    ).toBe(false);
  });
});
