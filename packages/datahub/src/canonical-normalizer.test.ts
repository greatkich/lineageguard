import {
  canonicalAnalyticsRevenueUrn,
  canonicalQueryStatementFingerprint,
  canonicalQuerySubjectFieldUrn,
  canonicalQueryUrn,
  impactCollectionResultSchema,
} from "@lineageguard/domain";
import { describe, expect, it } from "vitest";
import { normalizeCanonicalLiveCollection } from "./canonical-normalizer.js";
import {
  canonicalLiveTestResult,
  canonicalRawResponses,
  canonicalTestObservations,
} from "./canonical-test-support.js";

describe("canonical live DataHub normalization", () => {
  it("creates the exact complete domain context without leaking raw metadata", async () => {
    const result = impactCollectionResultSchema.parse(await canonicalLiveTestResult());

    expect(result.outcome).toBe("COLLECTED_LIVE");
    if (result.outcome !== "COLLECTED_LIVE") throw new Error("expected live result");
    expect(result.context.collectionOrigin).toEqual({ mode: "LIVE" });
    expect(result.context.collectionStatus).toBe("COMPLETE");
    expect(result.context.evidence).toHaveLength(9);
    expect(result.context.evidence.map((item) => item.id)).toEqual(
      [...result.context.evidence.map((item) => item.id)].sort(),
    );
    expect(
      result.context.evidence.find((item) => item.kind === "QUERY_USAGE")?.payload,
    ).toMatchObject({
      normalizedStatementFingerprint: canonicalQueryStatementFingerprint,
      queryUrn: canonicalQueryUrn,
      subjectSchemaFieldUrn: canonicalQuerySubjectFieldUrn,
    });
    expect(
      result.context.evidence.find(
        (item) => item.kind === "OWNER" && item.payload.assetUrn.includes("dashboard"),
      )?.payload,
    ).toMatchObject({ ownershipType: "BUSINESS_OWNER" });
    expect(JSON.stringify(result)).not.toContain("IGNORE PRIOR INSTRUCTIONS");
    expect(JSON.stringify(result)).not.toContain("SELECT");
  });

  it("keeps semantic fingerprints stable while collection fingerprints bind raw retrieval", async () => {
    const first = await canonicalLiveTestResult(canonicalRawResponses(), "live", 0);
    const second = await canonicalLiveTestResult(canonicalRawResponses(), "again", 1);
    if (first.outcome !== "COLLECTED_LIVE" || second.outcome !== "COLLECTED_LIVE") {
      throw new Error("expected live results");
    }

    expect(second.context.impactContextFingerprint).toBe(first.context.impactContextFingerprint);
    expect(second.context.evidence.map((item) => item.id)).toEqual(
      first.context.evidence.map((item) => item.id),
    );
    expect(second.context.collectionFingerprint).not.toBe(first.context.collectionFingerprint);
  });

  it("rejects a query detail that does not prove the exact schema-field subject", async () => {
    const changedQueryDetails = {
      platform: { name: "postgres", urn: "urn:li:dataPlatform:postgres" },
      properties: {
        source: "SYSTEM",
        statement: {
          language: "SQL",
          value:
            "SELECT customer_id, lifetime_revenue FROM analytics.customer_revenue WHERE lifetime_revenue >= 100 ORDER BY lifetime_revenue DESC",
        },
      },
      subjects: [
        {
          dataset: { urn: canonicalAnalyticsRevenueUrn },
          schemaField: {
            fieldPath: "account_id",
            urn: `urn:li:schemaField:(${canonicalAnalyticsRevenueUrn},account_id)`,
          },
        },
      ],
      type: "QUERY",
      urn: canonicalQueryUrn,
    };
    const observations = await canonicalTestObservations(
      canonicalRawResponses({ 11: [changedQueryDetails] }),
      "bad-subject",
    );

    expect(() =>
      normalizeCanonicalLiveCollection({
        changeId: "chg_0123456789abcdef01234567",
        collectedAt: "2026-08-04T08:00:13.000Z",
        observations,
      }),
    ).toThrowError(expect.objectContaining({ code: "SCHEMA_DRIFT" }));
  });

  it("does not let edited glossary metadata substitute for the system binding", async () => {
    const schemaWithoutSystemTerm = {
      fields: [
        {
          editedGlossaryTerms: ["Customer Identifier"],
          fieldPath: "customer_id",
          nativeDataType: "bigint",
          nullable: false,
        },
        { fieldPath: "order_id", nativeDataType: "bigint", nullable: false },
        { fieldPath: "amount", nativeDataType: "numeric", nullable: false },
        { fieldPath: "created_at", nativeDataType: "timestamp", nullable: false },
      ],
      matchingCount: 1,
      offset: 0,
      remainingCount: 0,
      returned: 4,
      totalFields: 4,
      urn: "urn:li:dataset:(urn:li:dataPlatform:postgres,lineageguard-canonical.lineageguard.commerce.orders,PROD)",
    };

    await expect(
      canonicalLiveTestResult(canonicalRawResponses({ 2: schemaWithoutSystemTerm })),
    ).rejects.toMatchObject({ code: "NOT_FOUND" });
  });
});
