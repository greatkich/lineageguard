import { describe, expect, it, vi } from "vitest";
import {
  type CanonicalCollectionTargets,
  collectCanonicalObservations,
} from "./canonical-reader.js";
import type { RawToolInvocation, ReadToolName } from "./tool-client.js";

const sourceUrn =
  "urn:li:dataset:(urn:li:dataPlatform:postgres,lineageguard-canonical.lineageguard.commerce.orders,PROD)";
const revenueUrn =
  "urn:li:dataset:(urn:li:dataPlatform:postgres,lineageguard-canonical.lineageguard.analytics.customer_revenue,PROD)";
const fraudFeaturesUrn =
  "urn:li:dataset:(urn:li:dataPlatform:postgres,lineageguard-canonical.lineageguard.fraud.customer_features,PROD)";
const dashboardUrn = "urn:li:dashboard:(looker,lineageguard-canonical.finance-revenue-dashboard)";
const modelUrn =
  "urn:li:mlModel:(urn:li:dataPlatform:mlflow,lineageguard-canonical.fraud-model-v3,PROD)";
const queryUrn =
  "urn:li:query:lineageguard-canonical.system.e4bbe7075754d05de68f76ff0a9b127532e044da8ab0a357bce7e0d41f7ad22c";
const glossaryTermUrn = "urn:li:glossaryTerm:lineageguard-canonical.CustomerIdentifier";

const targets: CanonicalCollectionTargets = {
  dashboardUrn,
  database: "lineageguard",
  dataset: "orders",
  environment: "PROD",
  field: "customer_id",
  fraudFeaturesUrn,
  glossaryTermUrn,
  modelUrn,
  platform: "postgres",
  platformInstance: "lineageguard-canonical",
  queryUrn,
  revenueUrn,
  schema: "commerce",
  sourceUrn,
};

function payloadFor(tool: ReadToolName, call: number): RawToolInvocation["payload"] {
  if (tool === "search") {
    return { count: 1, searchResults: [{ entity: { urn: sourceUrn } }], start: 0, total: 1 };
  }
  if (tool === "list_schema_fields") {
    return {
      fields: [{ fieldPath: "customer_id", nativeDataType: "bigint", nullable: false }],
      matchingCount: 1,
      offset: 0,
      remainingCount: 0,
      returned: 1,
      totalFields: 1,
      urn: sourceUrn,
    };
  }
  if (tool === "get_lineage") return { downstreams: { searchResults: [], total: 0 } };
  if (tool === "get_lineage_paths_between") {
    const pathSources = [sourceUrn, revenueUrn, sourceUrn, fraudFeaturesUrn];
    const pathTargets = [revenueUrn, dashboardUrn, fraudFeaturesUrn, modelUrn];
    const pathIndex = call - 4;
    return {
      pathCount: 0,
      paths: [],
      source: { urn: pathSources[pathIndex] ?? sourceUrn },
      target: { urn: pathTargets[pathIndex] ?? dashboardUrn },
    };
  }
  if (tool === "get_dataset_queries") return { count: 0, start: 0, total: 0 };
  const entityUrns = [dashboardUrn, modelUrn, queryUrn, glossaryTermUrn];
  return [{ urn: entityUrns[call - 9] ?? dashboardUrn }];
}

describe("canonical official MCP reader", () => {
  it("uses the fixed read-only collection sequence and exact official argument names", async () => {
    let call = 0;
    const invoke = vi.fn(async (tool: ReadToolName): Promise<RawToolInvocation> => {
      call += 1;
      return {
        invocationId: `inv_${call}`,
        payload: payloadFor(tool, call),
        responseFingerprint: String(call).padStart(64, "0"),
        retrievedAt: `2026-08-04T08:00:0${call}.000Z`,
        tool,
      };
    });

    const result = await collectCanonicalObservations({ invoke }, targets);

    expect(result.dashboardDetails.data).toEqual([{ urn: dashboardUrn }]);
    expect(result.modelDetails.data).toEqual([{ urn: modelUrn }]);
    expect(result.queryDetails.data).toEqual([{ urn: queryUrn }]);
    expect(result.glossaryDetails.data).toEqual([{ urn: glossaryTermUrn }]);
    expect(invoke.mock.calls).toEqual([
      [
        "search",
        {
          filter: "entity_type = dataset AND platform = postgres AND env = PROD",
          num_results: 50,
          offset: 0,
          query: "/q lineageguard-canonical+lineageguard+commerce+orders",
        },
      ],
      ["list_schema_fields", { keywords: ["customer_id"], limit: 50, offset: 0, urn: sourceUrn }],
      [
        "get_lineage",
        {
          column: "customer_id",
          max_hops: 3,
          max_results: 50,
          offset: 0,
          upstream: false,
          urn: sourceUrn,
        },
      ],
      [
        "get_lineage_paths_between",
        {
          direction: "downstream",
          source_column: "customer_id",
          source_urn: sourceUrn,
          target_column: "customer_id",
          target_urn: revenueUrn,
        },
      ],
      [
        "get_lineage_paths_between",
        { direction: "downstream", source_urn: revenueUrn, target_urn: dashboardUrn },
      ],
      [
        "get_lineage_paths_between",
        {
          direction: "downstream",
          source_column: "customer_id",
          source_urn: sourceUrn,
          target_column: "customer_id",
          target_urn: fraudFeaturesUrn,
        },
      ],
      [
        "get_lineage_paths_between",
        { direction: "downstream", source_urn: fraudFeaturesUrn, target_urn: modelUrn },
      ],
      [
        "get_dataset_queries",
        { column: "customer_id", count: 50, source: "SYSTEM", start: 0, urn: revenueUrn },
      ],
      ["get_entities", { urns: [dashboardUrn] }],
      ["get_entities", { urns: [modelUrn] }],
      ["get_entities", { urns: [queryUrn] }],
      ["get_entities", { urns: [glossaryTermUrn] }],
    ]);
  });

  it("fails before the next tool when an official response drifts", async () => {
    const invoke = vi.fn(
      async (tool: ReadToolName): Promise<RawToolInvocation> => ({
        invocationId: "inv_bad_search",
        payload: { count: "zero", start: 0, total: 0 },
        responseFingerprint: "a".repeat(64),
        retrievedAt: "2026-08-04T08:00:00.000Z",
        tool,
      }),
    );

    await expect(collectCanonicalObservations({ invoke }, targets)).rejects.toMatchObject({
      code: "MALFORMED_RESPONSE",
    });
    expect(invoke).toHaveBeenCalledTimes(1);
  });

  it.each([
    [[], "NOT_FOUND"],
    [[{ entity: { urn: sourceUrn } }, { entity: { urn: sourceUrn } }], "AMBIGUOUS"],
  ])("fails closed on non-unique source resolution", async (searchResults, code) => {
    const invoke = vi.fn(
      async (tool: ReadToolName): Promise<RawToolInvocation> => ({
        invocationId: "inv_resolution",
        payload: {
          count: searchResults.length,
          searchResults,
          start: 0,
          total: searchResults.length,
        },
        responseFingerprint: "a".repeat(64),
        retrievedAt: "2026-08-04T08:00:00.000Z",
        tool,
      }),
    );

    await expect(collectCanonicalObservations({ invoke }, targets)).rejects.toMatchObject({ code });
    expect(invoke).toHaveBeenCalledTimes(1);
  });

  it.each([
    [[], "NOT_FOUND"],
    [
      [
        { fieldPath: "customer_id", nativeDataType: "bigint", nullable: false },
        { fieldPath: "customer_id", nativeDataType: "text", nullable: true },
      ],
      "AMBIGUOUS",
    ],
  ])("fails closed on non-unique field resolution", async (fields, code) => {
    let call = 0;
    const invoke = vi.fn(async (tool: ReadToolName): Promise<RawToolInvocation> => {
      call += 1;
      const payload =
        tool === "search"
          ? payloadFor(tool, call)
          : {
              fields,
              matchingCount: fields.length,
              offset: 0,
              remainingCount: 0,
              returned: fields.length,
              totalFields: fields.length,
              urn: sourceUrn,
            };
      return {
        invocationId: `inv_resolution_${call}`,
        payload,
        responseFingerprint: String(call).padStart(64, "0"),
        retrievedAt: `2026-08-04T08:00:0${call}.000Z`,
        tool,
      };
    });

    await expect(collectCanonicalObservations({ invoke }, targets)).rejects.toMatchObject({ code });
    expect(invoke).toHaveBeenCalledTimes(2);
  });

  it("rejects a schema response for a different dataset", async () => {
    let call = 0;
    const invoke = vi.fn(async (tool: ReadToolName): Promise<RawToolInvocation> => {
      call += 1;
      const payload = payloadFor(tool, call);
      if (tool === "list_schema_fields" && !Array.isArray(payload)) {
        return {
          invocationId: `inv_schema_${call}`,
          payload: { ...payload, urn: revenueUrn },
          responseFingerprint: String(call).padStart(64, "0"),
          retrievedAt: `2026-08-04T08:00:0${call}.000Z`,
          tool,
        };
      }
      return {
        invocationId: `inv_schema_${call}`,
        payload,
        responseFingerprint: String(call).padStart(64, "0"),
        retrievedAt: `2026-08-04T08:00:0${call}.000Z`,
        tool,
      };
    });

    await expect(collectCanonicalObservations({ invoke }, targets)).rejects.toMatchObject({
      code: "MALFORMED_RESPONSE",
    });
    expect(invoke).toHaveBeenCalledTimes(2);
  });

  it("uses the server-wide matching count when a schema page is truncated", async () => {
    let call = 0;
    const invoke = vi.fn(async (tool: ReadToolName): Promise<RawToolInvocation> => {
      call += 1;
      const payload =
        tool === "search"
          ? payloadFor(tool, call)
          : {
              fields: [{ fieldPath: "customer_id", nativeDataType: "bigint", nullable: false }],
              matchingCount: 2,
              offset: 0,
              remainingCount: 99,
              returned: 1,
              totalFields: 100,
              urn: sourceUrn,
            };
      return {
        invocationId: `inv_truncated_schema_${call}`,
        payload,
        responseFingerprint: String(call).padStart(64, "0"),
        retrievedAt: `2026-08-04T08:00:0${call}.000Z`,
        tool,
      };
    });

    await expect(collectCanonicalObservations({ invoke }, targets)).rejects.toMatchObject({
      code: "AMBIGUOUS",
    });
    expect(invoke).toHaveBeenCalledTimes(2);
  });

  it("rejects unbounded or query-shaping target identifiers before transport", async () => {
    const invoke = vi.fn();

    await expect(
      collectCanonicalObservations(
        { invoke },
        { ...targets, platformInstance: "lineageguard OR entity_type = dashboard" },
      ),
    ).rejects.toMatchObject({ code: "CONFIGURATION" });
    expect(invoke).not.toHaveBeenCalled();
  });
});
