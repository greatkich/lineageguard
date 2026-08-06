import type { ImpactContext } from "@lineageguard/domain";
import { describe, expect, it } from "vitest";
import { deriveImpactCards } from "./derive-impact-cards.js";

const SOURCE_URN =
  "urn:li:dataset:(urn:li:dataPlatform:postgres,lineageguard-canonical.lineageguard.commerce.orders,PROD)";
const STG_ORDERS_URN =
  "urn:li:dataset:(urn:li:dataPlatform:postgres,lineageguard-canonical.lineageguard.analytics.stg_orders,PROD)";
const CUSTOMER_REVENUE_URN =
  "urn:li:dataset:(urn:li:dataPlatform:postgres,lineageguard-canonical.lineageguard.analytics.customer_revenue,PROD)";
const DASHBOARD_URN = "urn:li:dashboard:(looker,lineageguard-canonical.finance-revenue-dashboard)";
const MODEL_URN =
  "urn:li:mlModel:(urn:li:dataPlatform:mlflow,lineageguard-canonical.fraud-model-v3,PROD)";
const QUERY_URN =
  "urn:li:query:lineageguard-canonical.system.e4bbe7075754d05de68f76ff0a9b127532e044da8ab0a357bce7e0d41f7ad22c";

/**
 * Minimal canonical-shaped evidence fixture. `deriveImpactCards` only reads the
 * `evidence` array and specific payload fields, so this does not need to satisfy the
 * full `impactContextSchema` refinement rules — only the fields the function reads.
 */
function canonicalEvidenceContext(): ImpactContext {
  return {
    sourceUrn: SOURCE_URN,
    evidence: [
      {
        id: "ev-path-dashboard",
        kind: "LINEAGE_PATH",
        sourceUrn: SOURCE_URN,
        targetUrn: DASHBOARD_URN,
        criticality: "CRITICAL",
        title: "customer_id \u2192 Finance Revenue Dashboard",
        payload: {
          nodes: [SOURCE_URN, STG_ORDERS_URN, CUSTOMER_REVENUE_URN, DASHBOARD_URN],
          segments: [],
        },
      },
      {
        id: "ev-dashboard",
        kind: "DASHBOARD",
        sourceUrn: CUSTOMER_REVENUE_URN,
        targetUrn: DASHBOARD_URN,
        criticality: "CRITICAL",
        title: "Finance Revenue Dashboard",
        payload: {
          dashboardUrn: DASHBOARD_URN,
          downstreamDatasetUrn: CUSTOMER_REVENUE_URN,
          downstreamField: "analytics.customer_revenue.customer_id",
          platform: "looker",
          classificationUrns: [],
          ownerUrns: [],
        },
      },
      {
        id: "ev-model",
        kind: "ML_MODEL",
        sourceUrn: SOURCE_URN,
        targetUrn: MODEL_URN,
        criticality: "CRITICAL",
        title: "Fraud Model v3",
        payload: {
          modelUrn: MODEL_URN,
          featureDatasetUrn: SOURCE_URN,
          featureField: "fraud.customer_features.customer_id",
          lifecycle: "PRODUCTION",
          classificationUrns: [],
          ownerUrns: [],
        },
      },
      {
        id: "ev-query",
        kind: "QUERY_USAGE",
        sourceUrn: CUSTOMER_REVENUE_URN,
        targetUrn: QUERY_URN,
        criticality: "HIGH",
        title: "finance-monthly-close.sql",
        payload: {
          queryUrn: QUERY_URN,
          subjectDatasetUrn: CUSTOMER_REVENUE_URN,
          subjectSchemaFieldUrn: `urn:li:schemaField:(${CUSTOMER_REVENUE_URN},customer_id)`,
          subjectFieldPath: "customer_id",
          normalizedStatementFingerprint: "fingerprint",
          source: "SYSTEM",
          observationBasis: "DATAHUB_QUERY_ENTITY",
        },
      },
      // biome-ignore lint/suspicious/noExplicitAny: test fixture bypasses full schema refinement
    ] as any,
    collectionStatus: "COMPLETE",
    failures: [],
    // biome-ignore lint/suspicious/noExplicitAny: test fixture bypasses full schema refinement
  } as any;
}

describe("deriveImpactCards", () => {
  it("derives exactly four canonical impact cards, one per consumer group", () => {
    const cards = deriveImpactCards(canonicalEvidenceContext());

    expect(cards).toHaveLength(4);

    const kinds = cards.map((card) => card.kind).sort();
    expect(kinds).toEqual(["DASHBOARD", "DOWNSTREAM_MODEL", "ML_MODEL", "QUERY"].sort());
  });

  it("attaches a DataHub evidence id to every impact card", () => {
    const cards = deriveImpactCards(canonicalEvidenceContext());

    for (const card of cards) {
      expect(card.evidenceId).toBeTruthy();
      expect(card.entityUrn).toMatch(/^urn:li:/);
    }
  });

  it("never renders a card as a microservice or operational database consumer", () => {
    const cards = deriveImpactCards(canonicalEvidenceContext());
    const rendered = JSON.stringify(cards).toLowerCase();

    expect(rendered).not.toContain("microservice");
    expect(rendered).not.toContain("oltp");
  });

  it("excludes the staging intermediate (analytics.stg_orders) as its own card", () => {
    const cards = deriveImpactCards(canonicalEvidenceContext());

    expect(cards.some((card) => card.entityUrn.includes("stg_orders"))).toBe(false);
  });
});
