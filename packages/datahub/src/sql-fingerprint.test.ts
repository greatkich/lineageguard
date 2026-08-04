import { describe, expect, it } from "vitest";
import { normalizedSqlFingerprint, normalizeSqlStatement } from "./sql-fingerprint.js";

const canonicalStatement = `
-- lineageguard:finance-monthly-close
SELECT
    customer_id,
    lifetime_revenue
FROM analytics.customer_revenue
WHERE lifetime_revenue >= 100
ORDER BY lifetime_revenue DESC;
`;

describe("normalized query statement fingerprint", () => {
  it("matches the canonical graph normalization contract", () => {
    expect(normalizeSqlStatement(canonicalStatement)).toBe(
      "select customer_id, lifetime_revenue from analytics.customer_revenue where lifetime_revenue >= 100 order by lifetime_revenue desc",
    );
    expect(normalizedSqlFingerprint(canonicalStatement)).toBe(
      "64e7b3dc02cac7ee25acb65562fa7c075f08abc48310bf8dd16d0c9f6ef45638",
    );
  });

  it("ignores comments, whitespace, case, and trailing statement terminators", () => {
    const equivalent = `/* catalog marker */ SELECT customer_id, lifetime_revenue
      FROM analytics.customer_revenue WHERE lifetime_revenue >= 100
      ORDER BY lifetime_revenue DESC;;;`;

    expect(normalizedSqlFingerprint(equivalent)).toBe(normalizedSqlFingerprint(canonicalStatement));
  });

  it("changes when query semantics change", () => {
    expect(
      normalizedSqlFingerprint(
        "SELECT customer_id, lifetime_revenue FROM analytics.customer_revenue WHERE lifetime_revenue >= 101 ORDER BY lifetime_revenue DESC",
      ),
    ).not.toBe(normalizedSqlFingerprint(canonicalStatement));
  });
});
