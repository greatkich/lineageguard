import { describe, expect, it } from "vitest";
import { canonicalDatasetRef, parseProposedChange } from "./change.js";
import {
  canonicalAnalyticsRevenueUrn,
  canonicalAnalyticsStagingUrn,
  canonicalDashboardUrn,
  canonicalFinanceOwnerUrn,
  canonicalFraudFeaturesUrn,
  canonicalFraudModelUrn,
  canonicalQueryUrn,
  createCanonicalImpactContextFixture,
} from "./evidence.js";
import {
  assertExactlyFourConsumers,
  canonicalConsumerKinds,
  deriveImpactConsumers,
  type ImpactConsumer,
} from "./impact-consumer.js";

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

describe("assertExactlyFourConsumers", () => {
  const canonicalContext = createCanonicalImpactContextFixture(canonicalChangeId());

  function canonicalConsumers(): ImpactConsumer[] {
    return deriveImpactConsumers(canonicalContext);
  }

  it("accepts the canonical derivation", () => {
    expect(() => assertExactlyFourConsumers(canonicalConsumers())).not.toThrow();
  });

  it("exposes the canonical kinds the derivation is asserted against", () => {
    expect([...canonicalConsumerKinds]).toEqual([
      "DATA_MODEL",
      "DASHBOARD",
      "ML_CONSUMER",
      "UNMANAGED_QUERY",
    ]);
    expect(canonicalConsumers().map((consumer) => consumer.kind)).toEqual([
      ...canonicalConsumerKinds,
    ]);
  });

  it("rejects a fifth consumer as a count regression", () => {
    const five: ImpactConsumer[] = [
      ...canonicalConsumers(),
      {
        kind: "DASHBOARD",
        title: "Unexpected second dashboard",
        entityUrn: "urn:li:dashboard:(looker,unexpected.extra-dashboard)",
        evidenceIds: ["ev_000000000000000000000000"],
        owners: [],
      },
    ];

    expect(() => assertExactlyFourConsumers(five)).toThrowError(/IMPACT_CARD_COUNT_MISMATCH/);
    expect(() => assertExactlyFourConsumers(five)).toThrowError(/expected 4, got 5/);
  });

  it("rejects a dropped consumer as a count regression", () => {
    const three = canonicalConsumers().slice(0, 3);
    expect(() => assertExactlyFourConsumers(three)).toThrowError(/expected 4, got 3/);
  });

  it("rejects the canonical set in the wrong order", () => {
    const consumers = canonicalConsumers();
    const swapped = [consumers[1], consumers[0], consumers[2], consumers[3]] as ImpactConsumer[];

    expect(() => assertExactlyFourConsumers(swapped)).toThrowError(/IMPACT_CARD_ORDER_MISMATCH/);
  });

  it("rejects a duplicated entity URN", () => {
    const consumers = canonicalConsumers();
    const dashboard = consumers.find((consumer) => consumer.kind === "DASHBOARD");
    if (!dashboard) throw new Error("dashboard consumer missing");
    const duplicated = consumers.map((consumer) =>
      consumer.kind === "UNMANAGED_QUERY"
        ? { ...consumer, entityUrn: dashboard.entityUrn }
        : consumer,
    );

    expect(() => assertExactlyFourConsumers(duplicated)).toThrowError(/IMPACT_CARD_DUPLICATE_URN/);
  });

  it("rejects a consumer carrying no evidence reference", () => {
    const unevidenced = canonicalConsumers().map((consumer) =>
      consumer.kind === "ML_CONSUMER" ? { ...consumer, evidenceIds: [] } : consumer,
    );

    expect(() => assertExactlyFourConsumers(unevidenced)).toThrowError(
      /IMPACT_CARD_WITHOUT_EVIDENCE: ML_CONSUMER/,
    );
  });
});

describe("canonical grouping invariants", () => {
  const canonicalContext = createCanonicalImpactContextFixture(canonicalChangeId());

  it("groups the feature dataset into ML_CONSUMER instead of a separate card", () => {
    const consumers = deriveImpactConsumers(canonicalContext);
    const ml = consumers.find((consumer) => consumer.kind === "ML_CONSUMER");

    expect(ml?.kind).toBe("ML_CONSUMER");
    if (ml?.kind !== "ML_CONSUMER") throw new Error("ML consumer missing");
    expect(ml.featureDatasetUrn).toBe(canonicalFraudFeaturesUrn);
    expect(consumers.map((consumer) => consumer.entityUrn)).not.toContain(
      canonicalFraudFeaturesUrn,
    );
  });

  it("excludes the staging intermediate from every card", () => {
    const consumers = deriveImpactConsumers(canonicalContext);

    expect(consumers.map((consumer) => consumer.entityUrn)).not.toContain(
      canonicalAnalyticsStagingUrn,
    );
    const dataModel = consumers.find((consumer) => consumer.kind === "DATA_MODEL");
    expect(dataModel?.entityUrn).toBe(canonicalAnalyticsRevenueUrn);
  });

  it("keeps staging on the lineage path even though it is not a consumer", () => {
    const consumers = deriveImpactConsumers(canonicalContext);
    const dataModel = consumers.find((consumer) => consumer.kind === "DATA_MODEL");
    if (dataModel?.kind !== "DATA_MODEL") throw new Error("data model consumer missing");

    expect(dataModel.lineagePath).toContain(canonicalAnalyticsStagingUrn);
    expect(dataModel.lineagePath[0]).toBe(canonicalContext.datasetUrn);
  });

  it("does not double-count a lineage terminal that is already a leaf consumer", () => {
    const consumers = deriveImpactConsumers(canonicalContext);
    const urns = consumers.map((consumer) => consumer.entityUrn);

    expect(urns.filter((urn) => urn === canonicalDashboardUrn)).toHaveLength(1);
    expect(urns.filter((urn) => urn === canonicalFraudModelUrn)).toHaveLength(1);
  });

  it("derives nothing from an evidence-free context", () => {
    const empty = { ...canonicalContext, evidence: [] };
    const consumers = deriveImpactConsumers(empty);

    expect(consumers).toEqual([]);
    expect(() => assertExactlyFourConsumers(consumers)).toThrowError(/expected 4, got 0/);
  });
});
