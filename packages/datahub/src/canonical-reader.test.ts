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
  if (tool === "search") return { count: 0, start: 0, total: 0 };
  if (tool === "list_schema_fields") {
    return {
      fields: [],
      matchingCount: 0,
      offset: 0,
      remainingCount: 0,
      returned: 0,
      totalFields: 0,
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
  return [{ urn: dashboardUrn }, { urn: modelUrn }, { urn: queryUrn }, { urn: glossaryTermUrn }];
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

    expect(result.entityDetails.data).toHaveLength(4);
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
      ["get_entities", { urns: [dashboardUrn, modelUrn, queryUrn, glossaryTermUrn] }],
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
