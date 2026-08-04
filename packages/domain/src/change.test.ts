import { describe, expect, it } from "vitest";
import {
  canonicalDatasetRef,
  parseProposedChange,
  proposedChangeSchema,
  repositoryChangeInputSchema,
} from "./change.js";

const baseSha = "1".repeat(40);
const headSha = "2".repeat(40);
const canonicalSql = "ALTER TABLE commerce.orders RENAME COLUMN customer_id TO buyer_id;";
const modelPath = "walkthrough/models/orders.sql";

function input(patch: string, path = "walkthrough/migrations/rename.sql", source = "FIXTURE") {
  return {
    source,
    repository: "lineageguard/canonical",
    baseSha,
    headSha,
    files: [{ path, datasetRef: canonicalDatasetRef, patch }],
  };
}

function gitPatch(options: { index?: boolean; header?: string; body?: string } = {}) {
  return [
    `diff --git a/${modelPath} b/${modelPath}`,
    ...(options.index === false ? [] : [`index ${"a".repeat(40)}..${"b".repeat(40)} 100644`]),
    `--- a/${modelPath}`,
    `+++ b/${modelPath}`,
    options.header ?? "@@ -1,3 +1,3 @@",
    ...(options.body?.split("\n") ?? [
      " select",
      "-  customer_id::bigint as customer_id,",
      "+  buyer_id::bigint as buyer_id,",
      "   order_total",
    ]),
  ].join("\n");
}

describe("strict canonical change parser", () => {
  it("accepts only the exact fixture SQL form", () => {
    const result = parseProposedChange(input(canonicalSql));
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value).toMatchObject({
        operation: "RENAME_FIELD",
        field: "customer_id",
        before: { field: "customer_id" },
        after: { field: "buyer_id" },
      });
    }
    expect(parseProposedChange(input(` ${canonicalSql}`)).ok).toBe(false);
    expect(
      parseProposedChange(input(canonicalSql, "walkthrough/migrations/rename.sql", "GITHUB")).ok,
    ).toBe(false);
  });

  it("parses a real single-file single-hunk Git unified diff with exact counts", () => {
    expect(parseProposedChange(input(gitPatch(), modelPath, "GITHUB")).ok).toBe(true);
    expect(parseProposedChange(input(gitPatch({ index: false }), modelPath, "GITHUB")).ok).toBe(
      true,
    );
  });

  it("binds exact source bytes and rejects forged identity", () => {
    const indexed = parseProposedChange(input(gitPatch(), modelPath, "GITHUB"));
    const noIndex = parseProposedChange(input(gitPatch({ index: false }), modelPath, "GITHUB"));
    expect(indexed.ok && noIndex.ok).toBe(true);
    if (indexed.ok && noIndex.ok) {
      expect(indexed.value.sourcePatchFingerprint).not.toBe(noIndex.value.sourcePatchFingerprint);
      expect(indexed.value.id).not.toBe(noIndex.value.id);
      expect(
        proposedChangeSchema.safeParse({ ...indexed.value, fingerprint: "f".repeat(64) }).success,
      ).toBe(false);
    }
  });

  it("rejects every additional changed file and duplicate path", () => {
    const additional = input(canonicalSql);
    additional.files.push({
      path: "walkthrough/migrations/drop.sql",
      datasetRef: canonicalDatasetRef,
      patch: "DROP TABLE commerce.orders;",
    });
    expect(parseProposedChange(additional).ok).toBe(false);
    const duplicate = input(canonicalSql);
    const firstFile = duplicate.files[0];
    if (!firstFile) throw new Error("fixture must have a file");
    duplicate.files.push({ ...firstFile });
    expect(parseProposedChange(duplicate).ok).toBe(false);
  });

  it.each([
    ["abbreviated", "1".repeat(39), headSha],
    ["mixed-case", `A${"1".repeat(39)}`, headSha],
    ["equal", baseSha, baseSha],
  ])("rejects %s object IDs", (_label, base, head) => {
    expect(
      repositoryChangeInputSchema.safeParse({
        ...input(canonicalSql),
        baseSha: base,
        headSha: head,
      }).success,
    ).toBe(false);
  });

  it.each([
    ["hunk fragment", "@@ -1,1 +1,1 @@\n-customer_id\n+buyer_id"],
    ["mismatched counts", gitPatch({ header: "@@ -1,4 +1,3 @@" })],
    ["extra hunk", `${gitPatch()}\n@@ -9,1 +9,1 @@\n-old\n+new`],
    ["binary", `diff --git a/${modelPath} b/${modelPath}\nBinary files differ`],
    ["no-prefix", gitPatch().replace(`--- a/${modelPath}`, `--- ${modelPath}`)],
    [
      "uppercase related edit",
      gitPatch({
        body: " select\n-  CUSTOMER_ID::bigint as CUSTOMER_ID,\n+  BUYER_ID::bigint as BUYER_ID,\n next",
      }),
    ],
    [
      "mixed-case related edit",
      gitPatch({
        body: " select\n-  Customer_Id::bigint as Customer_Id,\n+  Buyer_Id::bigint as Buyer_Id,\n next",
      }),
    ],
    ["malformed line", gitPatch({ body: "select\n-customer_id\n+buyer_id" })],
  ])("rejects %s diff", (_label, patch) => {
    expect(parseProposedChange(input(patch, modelPath, "GITHUB")).ok).toBe(false);
  });

  it("rejects unknown keys and unsafe file paths", () => {
    expect(
      repositoryChangeInputSchema.safeParse({ ...input(canonicalSql), unexpected: true }).success,
    ).toBe(false);
    expect(
      repositoryChangeInputSchema.safeParse({
        ...input(canonicalSql),
        files: [{ path: "../rename.sql", datasetRef: canonicalDatasetRef, patch: canonicalSql }],
      }).success,
    ).toBe(false);
  });
});
