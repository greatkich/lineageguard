import { describe, it, expect } from "vitest";
import { validateSourceChange, type SourceChange } from "./source-change.js";

describe("validateSourceChange", () => {
  const validChange: SourceChange = {
    source: "GITHUB",
    repository: "org/lineageguard-walkthrough",
    pullRequestNumber: 42,
    pullRequestUrl: "https://github.com/org/lineageguard-walkthrough/pull/42",
    baseSha: "abc123def456abc123def456abc123def456abc1",
    headSha: "def456abc123def456abc123def456abc123def4",
    filePath: "migrations/001_rename_customer_id.sql",
    unifiedDiff: [
      "--- a/migrations/001_rename_customer_id.sql",
      "+++ b/migrations/001_rename_customer_id.sql",
      "@@ -0,0 +1,2 @@",
      "+ALTER TABLE commerce.orders",
      "+RENAME COLUMN customer_id TO buyer_id;",
    ].join("\n"),
    diffFingerprint: "sha256:abcdef1234567890abcdef1234567890abcdef1234567890abcdef1234567890",
  };

  it("accepts a valid SourceChange", () => {
    const result = validateSourceChange(validChange);
    expect(result.success).toBe(true);
  });

  it("rejects missing source field", () => {
    const bad = { ...validChange, source: undefined };
    const result = validateSourceChange(bad as any);
    expect(result.success).toBe(false);
  });

  it("rejects non-GITHUB source", () => {
    const bad = { ...validChange, source: "FIXTURE" };
    const result = validateSourceChange(bad as any);
    expect(result.success).toBe(false);
  });

  it("rejects empty unifiedDiff", () => {
    const bad = { ...validChange, unifiedDiff: "" };
    const result = validateSourceChange(bad as any);
    expect(result.success).toBe(false);
  });

  it("rejects missing diffFingerprint", () => {
    const bad = { ...validChange, diffFingerprint: "" };
    const result = validateSourceChange(bad as any);
    expect(result.success).toBe(false);
  });
});
