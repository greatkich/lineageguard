import { describe, expect, it } from "vitest";
import { canonicalDatasetRef, parseProposedChange } from "./change.js";
import {
  canonicalAnalyticsRevenueUrn,
  canonicalAnalyticsStagingUrn,
  canonicalDashboardUrn,
  canonicalFinanceOwnerUrn,
  canonicalFraudModelUrn,
  canonicalQueryUrn,
  createCanonicalImpactContextFixture,
} from "./evidence.js";
import { deriveImpactConsumers } from "./impact-consumer.js";

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

describe("deriveImpactConsumers", () => {
  const canonicalContext = createCanonicalImpactContextFixture(canonicalChangeId());

  it("produces exactly 4 consumers in canonical order", () => {
    const consumers = deriveImpactConsumers(canonicalContext);
    expect(consumers).toHaveLength(4);
    expect(consumers.map((c) => c.kind)).toEqual([
      "DATA_MODEL",
      "DASHBOARD",
      "ML_CONSUMER",
      "UNMANAGED_QUERY",
    ]);
  });

  it("includes the downstream data model consumer", () => {
    const consumers = deriveImpactConsumers(canonicalContext);
    const dataModel = consumers.find((c) => c.kind === "DATA_MODEL");
    expect(dataModel?.entityUrn).toBe(canonicalAnalyticsRevenueUrn);
  });

  it("excludes staging nodes from consumer list", () => {
    const consumers = deriveImpactConsumers(canonicalContext);
    const urns = consumers.map((c) => c.entityUrn);
    expect(urns).not.toContain(canonicalAnalyticsStagingUrn);
  });

  it("has no duplicate URNs", () => {
    const consumers = deriveImpactConsumers(canonicalContext);
    const urns = consumers.map((c) => c.entityUrn);
    expect(new Set(urns).size).toBe(urns.length);
  });

  it("all URNs are non-empty strings", () => {
    const consumers = deriveImpactConsumers(canonicalContext);
    for (const c of consumers) {
      expect(c.entityUrn).toBeTruthy();
      expect(typeof c.entityUrn).toBe("string");
    }
  });

  it("all evidence IDs are non-empty", () => {
    const consumers = deriveImpactConsumers(canonicalContext);
    for (const c of consumers) {
      expect(c.evidenceIds.length).toBeGreaterThan(0);
      for (const id of c.evidenceIds) {
        expect(id).toBeTruthy();
      }
    }
  });

  it("ML_CONSUMER groups the feature dataset with the model as one consumer", () => {
    const consumers = deriveImpactConsumers(canonicalContext);
    const ml = consumers.find((c) => c.kind === "ML_CONSUMER");
    expect(ml).toBeDefined();
    expect(ml!.title).toContain("Fraud Model v3");
    expect(ml!.entityUrn).toBe(canonicalFraudModelUrn);
  });

  it("DASHBOARD consumer resolves to the canonical dashboard URN", () => {
    const consumers = deriveImpactConsumers(canonicalContext);
    const dashboard = consumers.find((c) => c.kind === "DASHBOARD");
    expect(dashboard?.entityUrn).toBe(canonicalDashboardUrn);
  });

  it("UNMANAGED_QUERY consumer resolves to the canonical query URN", () => {
    const consumers = deriveImpactConsumers(canonicalContext);
    const query = consumers.find((c) => c.kind === "UNMANAGED_QUERY");
    expect(query?.entityUrn).toBe(canonicalQueryUrn);
  });

  it("owners are correctly joined where available", () => {
    const consumers = deriveImpactConsumers(canonicalContext);
    const dashboard = consumers.find((c) => c.kind === "DASHBOARD");
    expect(dashboard!.owners).toContain(canonicalFinanceOwnerUrn);
  });
});
