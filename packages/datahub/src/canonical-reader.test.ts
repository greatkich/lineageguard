import { describe, expect, it, vi } from "vitest";
import {
  type CanonicalCollectionTargets,
  collectCanonicalObservations,
} from "./canonical-reader.js";
import { type CanonicalRawResponse, canonicalRawResponses } from "./canonical-test-support.js";
import type { RawToolInvocation, ReadToolName } from "./tool-client.js";

const sourceUrn =
  "urn:li:dataset:(urn:li:dataPlatform:postgres,lineageguard-canonical.lineageguard.commerce.orders,PROD)";
const revenueUrn =
  "urn:li:dataset:(urn:li:dataPlatform:postgres,lineageguard-canonical.lineageguard.analytics.customer_revenue,PROD)";
const stagingUrn =
  "urn:li:dataset:(urn:li:dataPlatform:postgres,lineageguard-canonical.lineageguard.analytics.stg_orders,PROD)";
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

function queuedInvoker(responses: CanonicalRawResponse[]) {
  let index = 0;
  return vi.fn(async (tool: ReadToolName): Promise<RawToolInvocation> => {
    const response = responses[index];
    index += 1;
    if (response === undefined || response.tool !== tool) throw new Error("unexpected tool order");
    return {
      invocationId: `inv_page_${index}`,
      payload: response.payload,
      responseFingerprint: index.toString(16).padStart(64, "a"),
      retrievedAt: `2026-08-04T08:00:${String(index).padStart(2, "0")}.000Z`,
      tool,
    };
  });
}

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

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
  if (tool === "get_lineage") {
    const searchResults = [stagingUrn, revenueUrn, fraudFeaturesUrn].map((urn, index) => ({
      degree: index === 0 ? 1 : 2,
      entity: { type: "DATASET", urn },
      lineageColumns: ["customer_id"],
    }));
    return {
      downstreams: {
        count: searchResults.length,
        hasMore: false,
        offset: 0,
        returned: searchResults.length,
        searchResults,
        total: searchResults.length,
      },
    };
  }
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
  if (tool === "get_dataset_queries") {
    return {
      count: 1,
      queries: [
        {
          platform: { name: "postgres", urn: "urn:li:dataPlatform:postgres" },
          properties: {
            source: "SYSTEM",
            statement: { language: "SQL", value: "SELECT customer_id FROM customer_revenue" },
          },
          subjects: [revenueUrn],
          urn: queryUrn,
        },
      ],
      start: 0,
      total: 1,
    };
  }
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

  it("finds an exact source dataset on a later bounded search page", async () => {
    const base = canonicalRawResponses();
    const sourcePage = base[0];
    if (sourcePage === undefined || !isRecord(sourcePage.payload)) {
      throw new Error("expected search fixture");
    }
    const invoke = queuedInvoker([
      {
        tool: "search",
        payload: {
          count: 1,
          searchResults: [{ entity: { urn: `${sourceUrn}.unrelated` } }],
          start: 0,
          total: 2,
        },
      },
      {
        ...sourcePage,
        payload: { ...sourcePage.payload, count: 1, start: 1, total: 2 },
      },
      ...base.slice(1),
    ]);

    const result = await collectCanonicalObservations({ invoke }, targets);

    expect(result.resolutionSearch.invocation.invocationId).toBe("inv_page_2");
    expect(result.resolutionSearchPages.map((page) => page.invocation.invocationId)).toEqual([
      "inv_page_1",
      "inv_page_2",
    ]);
    expect(invoke.mock.calls.filter(([tool]) => tool === "search")).toEqual([
      ["search", expect.objectContaining({ num_results: 50, offset: 0 })],
      ["search", expect.objectContaining({ num_results: 50, offset: 1 })],
    ]);
  });

  it("finds the uniquely matched field on a later schema page", async () => {
    const base = canonicalRawResponses();
    const schemaPage = base[1];
    if (schemaPage === undefined || !isRecord(schemaPage.payload)) {
      throw new Error("expected schema fixture");
    }
    const invoke = queuedInvoker([
      base[0] as CanonicalRawResponse,
      {
        tool: "list_schema_fields",
        payload: {
          fields: [{ fieldPath: "other_field", nativeDataType: "text", nullable: true }],
          matchingCount: 1,
          offset: 0,
          remainingCount: 3,
          returned: 1,
          totalFields: 4,
          urn: sourceUrn,
        },
      },
      {
        ...schemaPage,
        payload: {
          ...schemaPage.payload,
          fields: [
            {
              fieldPath: "customer_id",
              glossaryTerms: ["Customer Identifier"],
              nativeDataType: "bigint",
              nullable: false,
            },
          ],
          offset: 1,
          remainingCount: 2,
          returned: 1,
        },
      },
      {
        tool: "list_schema_fields",
        payload: {
          fields: [
            { fieldPath: "amount", nativeDataType: "numeric", nullable: false },
            { fieldPath: "created_at", nativeDataType: "timestamp", nullable: false },
          ],
          matchingCount: 1,
          offset: 2,
          remainingCount: 0,
          returned: 2,
          totalFields: 4,
          urn: sourceUrn,
        },
      },
      ...base.slice(2),
    ]);

    const result = await collectCanonicalObservations({ invoke }, targets);

    expect(result.schemaFields.invocation.invocationId).toBe("inv_page_3");
    expect(result.schemaFieldPages.map((page) => page.invocation.invocationId)).toEqual([
      "inv_page_2",
      "inv_page_3",
      "inv_page_4",
    ]);
    expect(invoke.mock.calls.filter(([tool]) => tool === "list_schema_fields")).toEqual([
      ["list_schema_fields", expect.objectContaining({ limit: 50, offset: 0 })],
      ["list_schema_fields", expect.objectContaining({ limit: 50, offset: 1 })],
      ["list_schema_fields", expect.objectContaining({ limit: 50, offset: 2 })],
    ]);
  });

  it("collects all bounded lineage and query pages while retaining each proof page", async () => {
    const base = canonicalRawResponses();
    const lineagePage = base[2];
    const queryPage = base[7];
    if (
      lineagePage === undefined ||
      queryPage === undefined ||
      !isRecord(lineagePage.payload) ||
      !isRecord(queryPage.payload)
    ) {
      throw new Error("expected paged fixtures");
    }
    const downstreams = lineagePage.payload.downstreams;
    const queries = queryPage.payload.queries;
    if (
      !isRecord(downstreams) ||
      !Array.isArray(downstreams.searchResults) ||
      !Array.isArray(queries)
    ) {
      throw new Error("expected page collections");
    }
    const [staging, revenue, fraud] = downstreams.searchResults;
    const canonicalQuery = queries[0];
    if (
      staging === undefined ||
      revenue === undefined ||
      fraud === undefined ||
      canonicalQuery === undefined
    ) {
      throw new Error("expected canonical page items");
    }
    const invoke = queuedInvoker([
      ...base.slice(0, 2),
      {
        tool: "get_lineage",
        payload: {
          downstreams: {
            count: 2,
            hasMore: true,
            offset: 0,
            returned: 2,
            searchResults: [staging, revenue],
            start: 0,
            total: 3,
          },
        },
      },
      {
        tool: "get_lineage",
        payload: {
          downstreams: {
            count: 1,
            hasMore: false,
            offset: 2,
            returned: 1,
            searchResults: [fraud],
            start: 2,
            total: 3,
          },
        },
      },
      ...base.slice(3, 7),
      {
        tool: "get_dataset_queries",
        payload: {
          count: 1,
          queries: [
            {
              ...canonicalQuery,
              urn: "urn:li:query:lineageguard-canonical.unrelated",
            },
          ],
          start: 0,
          total: 2,
        },
      },
      {
        ...queryPage,
        payload: { ...queryPage.payload, count: 1, start: 1, total: 2 },
      },
      ...base.slice(8),
    ]);

    const result = await collectCanonicalObservations({ invoke }, targets);

    expect(result.lineageDiscovery.data.downstreams?.searchResults).toHaveLength(2);
    expect(result.fraudLineageDiscovery.data.downstreams?.searchResults).toHaveLength(1);
    expect(result.lineageDiscovery.invocation.invocationId).toBe("inv_page_3");
    expect(result.fraudLineageDiscovery.invocation.invocationId).toBe("inv_page_4");
    expect(result.queryDiscovery.invocation.invocationId).toBe("inv_page_10");
    expect(result.lineageDiscoveryPages.map((page) => page.invocation.invocationId)).toEqual([
      "inv_page_3",
      "inv_page_4",
    ]);
    expect(result.queryDiscoveryPages.map((page) => page.invocation.invocationId)).toEqual([
      "inv_page_9",
      "inv_page_10",
    ]);
    expect(invoke.mock.calls.filter(([tool]) => tool === "get_lineage")).toHaveLength(2);
    expect(invoke.mock.calls.filter(([tool]) => tool === "get_dataset_queries")).toHaveLength(2);
  });

  it("rejects a paged response that repeats its offset", async () => {
    const invoke = vi.fn(
      async (tool: ReadToolName): Promise<RawToolInvocation> => ({
        invocationId: "inv_cycle",
        payload: {
          count: 1,
          searchResults: [{ entity: { urn: `${sourceUrn}.unrelated` } }],
          start: 0,
          total: 2,
        },
        responseFingerprint: "a".repeat(64),
        retrievedAt: "2026-08-04T08:00:00.000Z",
        tool,
      }),
    );

    await expect(collectCanonicalObservations({ invoke }, targets)).rejects.toMatchObject({
      code: "CURSOR_CYCLE",
      invocationId: "inv_cycle",
      tool: "search",
    });
    expect(invoke).toHaveBeenCalledTimes(2);
  });

  it("fails closed when official search pagination exceeds four pages", async () => {
    let page = 0;
    const invoke = vi.fn(
      async (tool: ReadToolName, arguments_: Readonly<Record<string, unknown>>) => {
        const offset = arguments_.offset;
        if (tool !== "search" || typeof offset !== "number") {
          throw new Error("unexpected tool order");
        }
        page += 1;
        return {
          invocationId: `inv_limit_${page}`,
          payload: {
            count: 50,
            searchResults: Array.from({ length: 50 }, (_, index) => ({
              entity: { urn: `urn:li:dataset:unrelated-${offset + index}` },
            })),
            start: offset,
            total: 250,
          },
          responseFingerprint: page.toString(16).padStart(64, "b"),
          retrievedAt: `2026-08-04T08:00:0${page}.000Z`,
          tool,
        } satisfies RawToolInvocation;
      },
    );

    await expect(collectCanonicalObservations({ invoke }, targets)).rejects.toMatchObject({
      code: "PAGINATION_LIMIT",
      invocationId: "inv_limit_4",
      tool: "search",
    });
    expect(invoke).toHaveBeenCalledTimes(4);
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
