import { canonicalAnalyticsStagingUrn } from "@lineageguard/domain";
import { z } from "zod";
import { type TrainingDataResult, readTrainingDataAspect } from "./aspect-reader.js";
import { DataHubAdapterError } from "./errors.js";
import {
  type OfficialEntity,
  type OfficialLineagePage,
  type OfficialPathResult,
  type OfficialQueryPage,
  type OfficialSchemaFieldsPage,
  type OfficialSearchPage,
  parseEntitiesResult,
  parseLineagePage,
  parsePathResult,
  parseQueryPage,
  parseSchemaFieldsPage,
  parseSearchPage,
} from "./official-contract.js";
import { collectBoundedPages } from "./pagination.js";
import type { RawToolInvocation, ReadToolName } from "./tool-client.js";

const identifier = z
  .string()
  .min(1)
  .max(128)
  .regex(/^[A-Za-z0-9][A-Za-z0-9_-]*$/u);
const platformIdentifier = z
  .string()
  .min(1)
  .max(64)
  .regex(/^[a-z][a-z0-9_-]*$/u);
const environmentIdentifier = z
  .string()
  .min(1)
  .max(32)
  .regex(/^[A-Z][A-Z0-9_]*$/u);
const urn = z.string().startsWith("urn:li:").max(4_096);

const targetsSchema = z
  .object({
    dashboardUrn: urn,
    database: identifier,
    dataset: identifier,
    environment: environmentIdentifier,
    field: identifier,
    fraudFeaturesUrn: urn,
    glossaryTermUrn: urn,
    gmsBaseUrl: z.string().min(1).max(2_048),
    modelUrn: urn,
    platform: platformIdentifier,
    platformInstance: identifier,
    queryUrn: urn,
    readToken: z.string().min(8).max(4_096),
    revenueUrn: urn,
    schema: identifier,
    sourceUrn: urn,
  })
  .strict();

export type CanonicalCollectionTargets = z.infer<typeof targetsSchema> & {
  /** Injected fetch implementation for testing. Uses global `fetch` when omitted. */
  fetchImpl?: typeof fetch;
};

export interface CanonicalToolInvoker {
  invoke(
    tool: ReadToolName,
    arguments_: Readonly<Record<string, unknown>>,
  ): Promise<RawToolInvocation>;
}

export type OfficialObservation<T> = Readonly<{
  data: T;
  invocation: RawToolInvocation;
}>;

export type CanonicalObservations = Readonly<{
  dashboardDetails: OfficialObservation<readonly OfficialEntity[]>;
  dashboardEntityPath: OfficialObservation<OfficialPathResult>;
  dashboardFieldPath: OfficialObservation<OfficialPathResult>;
  fraudEntityPath: OfficialObservation<OfficialPathResult>;
  fraudFieldPath: OfficialObservation<OfficialPathResult>;
  fraudLineageDiscovery: OfficialObservation<OfficialLineagePage>;
  glossaryDetails: OfficialObservation<readonly OfficialEntity[]>;
  lineageDiscovery: OfficialObservation<OfficialLineagePage>;
  lineageDiscoveryPages: readonly OfficialObservation<OfficialLineagePage>[];
  modelDetails: OfficialObservation<readonly OfficialEntity[]>;
  queryDetails: OfficialObservation<readonly OfficialEntity[]>;
  queryDiscovery: OfficialObservation<OfficialQueryPage>;
  queryDiscoveryPages: readonly OfficialObservation<OfficialQueryPage>[];
  resolutionSearch: OfficialObservation<OfficialSearchPage>;
  resolutionSearchPages: readonly OfficialObservation<OfficialSearchPage>[];
  revenueDetails: OfficialObservation<readonly OfficialEntity[]>;
  schemaFieldPages: readonly OfficialObservation<OfficialSchemaFieldsPage>[];
  schemaFields: OfficialObservation<OfficialSchemaFieldsPage>;
  trainingDataProof: TrainingDataResult;
}>;

async function observe<T>(
  invoker: CanonicalToolInvoker,
  tool: ReadToolName,
  arguments_: Readonly<Record<string, unknown>>,
  parse: (payload: unknown) => T,
): Promise<OfficialObservation<T>> {
  const invocation = await invoker.invoke(tool, arguments_);
  if (invocation.tool !== tool) {
    throw new DataHubAdapterError(
      "MALFORMED_RESPONSE",
      "DataHub MCP invocation identity did not match the requested tool.",
      { invocationId: invocation.invocationId, tool },
    );
  }
  try {
    return Object.freeze({ data: parse(invocation.payload), invocation });
  } catch (error) {
    if (error instanceof DataHubAdapterError) {
      throw new DataHubAdapterError(error.code, error.message, {
        invocationId: invocation.invocationId,
        retryable: error.retryable,
        tool,
      });
    }
    throw error;
  }
}

function safeTargets(input: CanonicalCollectionTargets): CanonicalCollectionTargets {
  const { fetchImpl, ...zodFields } = input;
  const parsed = targetsSchema.safeParse(zodFields);
  if (!parsed.success) {
    throw new DataHubAdapterError(
      "CONFIGURATION",
      "Canonical DataHub collection targets are invalid.",
    );
  }
  return { ...parsed.data, ...(fetchImpl === undefined ? {} : { fetchImpl }) };
}

/**
 * Calls `get_lineage_paths_between` but tolerates the MCP server returning isError:true when no
 * lineage edges exist between two entities. This happens for mlModel entities whose relationship
 * is established through the TrainingData aspect rather than UpstreamLineage. The normalizer
 * accepts pathCount=0 for this case.
 */
async function observePathOrEmpty(
  invoker: CanonicalToolInvoker,
  tool: ReadToolName,
  arguments_: Readonly<Record<string, unknown>>,
  sourceUrn: string,
  targetUrn: string,
): Promise<OfficialObservation<OfficialPathResult>> {
  try {
    return await observe(invoker, tool, arguments_, parsePathResult);
  } catch (error) {
    if (error instanceof DataHubAdapterError && error.code === "TOOL_FAILURE") {
      // The MCP server returns isError:true with "No lineage found" when no lineage edges
      // connect the entities. Synthesize an empty path result — the normalizer already accepts
      // pathCount=0 for non-lineage relationships (TrainingData, etc.).
      const { createHash } = await import("node:crypto");
      const emptyPathResult: OfficialPathResult = {
        source: { urn: sourceUrn },
        target: { urn: targetUrn },
        paths: [],
        pathCount: 0,
      };
      const responseFingerprint = createHash("sha256")
        .update(JSON.stringify(emptyPathResult))
        .digest("hex");
      return Object.freeze({
        data: emptyPathResult,
        invocation: {
          invocationId: error.invocationId ?? `synth_${Date.now().toString(16)}`,
          tool,
          payload: emptyPathResult as unknown as Readonly<Record<string, unknown>>,
          responseFingerprint,
          retrievedAt: new Date().toISOString(),
        },
      });
    }
    throw error;
  }
}

function requireUniqueResolution(
  count: number,
  invocation: RawToolInvocation,
  subject: string,
): void {
  if (count === 1) return;
  throw new DataHubAdapterError(
    count === 0 ? "NOT_FOUND" : "AMBIGUOUS",
    count === 0
      ? `Canonical DataHub ${subject} was not found.`
      : `Canonical DataHub ${subject} resolution was ambiguous.`,
    { invocationId: invocation.invocationId, tool: invocation.tool },
  );
}

type PagedItem<TPage, TItem> = Readonly<{
  item: TItem;
  page: OfficialObservation<TPage>;
}>;

type ObservedPage<TPage, TItem> = Readonly<{
  items: readonly TItem[];
  nextOffset?: number;
  observation: OfficialObservation<TPage>;
}>;

async function collectObservedPages<TPage, TItem>(
  tool: ReadToolName,
  fetchPage: (offset: number, pageSize: number) => Promise<ObservedPage<TPage, TItem>>,
): Promise<
  Readonly<{
    items: readonly PagedItem<TPage, TItem>[];
    pages: readonly OfficialObservation<TPage>[];
  }>
> {
  const pages: OfficialObservation<TPage>[] = [];
  let lastInvocation: RawToolInvocation | undefined;
  try {
    const items = await collectBoundedPages<PagedItem<TPage, TItem>>(async (offset, pageSize) => {
      const page = await fetchPage(offset, pageSize);
      pages.push(page.observation);
      lastInvocation = page.observation.invocation;
      const observedItems = page.items.map((item) =>
        Object.freeze({ item, page: page.observation }),
      );
      return page.nextOffset === undefined
        ? { items: observedItems }
        : { items: observedItems, nextOffset: page.nextOffset };
    });
    return Object.freeze({ items, pages: Object.freeze(pages) });
  } catch (error) {
    if (
      error instanceof DataHubAdapterError &&
      error.invocationId === undefined &&
      lastInvocation !== undefined
    ) {
      throw new DataHubAdapterError(error.code, error.message, {
        invocationId: lastInvocation.invocationId,
        retryable: error.retryable,
        tool,
      });
    }
    throw error;
  }
}

function pageInvocation<TPage, TItem>(
  matches: readonly PagedItem<TPage, TItem>[],
  pages: readonly OfficialObservation<TPage>[],
): RawToolInvocation {
  const invocation = matches.at(-1)?.page.invocation ?? pages.at(-1)?.invocation;
  if (invocation === undefined) {
    throw new DataHubAdapterError(
      "MALFORMED_RESPONSE",
      "DataHub pagination produced no observable page.",
    );
  }
  return invocation;
}

function stablePageTotal(
  expected: number | undefined,
  actual: number,
  observation: OfficialObservation<unknown>,
  subject: string,
): number {
  if (expected !== undefined && actual !== expected) {
    throw new DataHubAdapterError("SCHEMA_DRIFT", `DataHub ${subject} changed during pagination.`, {
      invocationId: observation.invocation.invocationId,
      tool: observation.invocation.tool,
    });
  }
  return expected ?? actual;
}

async function collectResolutionSearch(
  invoker: CanonicalToolInvoker,
  targets: CanonicalCollectionTargets,
): Promise<
  Readonly<{
    pages: readonly OfficialObservation<OfficialSearchPage>[];
    proof: OfficialObservation<OfficialSearchPage>;
  }>
> {
  let resultTotal: number | undefined;
  const paged = await collectObservedPages("search", async (offset, pageSize) => {
    const observation = await observe(
      invoker,
      "search",
      {
        filter: `entity_type = dataset AND platform = ${targets.platform} AND env = ${targets.environment}`,
        num_results: pageSize,
        offset,
        query: `/q ${targets.platformInstance}+${targets.database}+${targets.schema}+${targets.dataset}`,
      },
      parseSearchPage,
    );
    if (observation.data.start !== offset) {
      throw new DataHubAdapterError(
        "CURSOR_CYCLE",
        "DataHub pagination did not return the requested offset.",
        {
          invocationId: observation.invocation.invocationId,
          tool: observation.invocation.tool,
        },
      );
    }
    resultTotal = stablePageTotal(
      resultTotal,
      observation.data.total,
      observation,
      "search result total",
    );
    const nextOffset = observation.data.start + observation.data.count;
    return {
      items: observation.data.searchResults,
      ...(nextOffset >= resultTotal ? {} : { nextOffset }),
      observation,
    };
  });
  const matches = paged.items.filter((result) => result.item.entity.urn === targets.sourceUrn);
  requireUniqueResolution(matches.length, pageInvocation(matches, paged.pages), "dataset");
  const proof = matches[0]?.page;
  if (proof === undefined) {
    throw new DataHubAdapterError("NOT_FOUND", "Canonical DataHub dataset was not found.");
  }
  return Object.freeze({ pages: paged.pages, proof });
}

async function collectSchemaFields(
  invoker: CanonicalToolInvoker,
  targets: CanonicalCollectionTargets,
): Promise<
  Readonly<{
    pages: readonly OfficialObservation<OfficialSchemaFieldsPage>[];
    proof: OfficialObservation<OfficialSchemaFieldsPage>;
  }>
> {
  let globalMatchingCount: number | undefined;
  let totalFields: number | undefined;
  const paged = await collectObservedPages("list_schema_fields", async (offset, pageSize) => {
    const observation = await observe(
      invoker,
      "list_schema_fields",
      {
        keywords: [targets.field],
        limit: pageSize,
        offset,
        urn: targets.sourceUrn,
      },
      parseSchemaFieldsPage,
    );
    if (observation.data.urn !== targets.sourceUrn) {
      throw new DataHubAdapterError(
        "MALFORMED_RESPONSE",
        "DataHub schema response did not match the resolved dataset.",
        {
          invocationId: observation.invocation.invocationId,
          tool: observation.invocation.tool,
        },
      );
    }
    if (observation.data.offset !== offset) {
      throw new DataHubAdapterError(
        "CURSOR_CYCLE",
        "DataHub pagination did not return the requested offset.",
        {
          invocationId: observation.invocation.invocationId,
          tool: observation.invocation.tool,
        },
      );
    }
    totalFields = stablePageTotal(
      totalFields,
      observation.data.totalFields,
      observation,
      "schema field total",
    );
    const matchingCount = observation.data.matchingCount;
    if (matchingCount === null || matchingCount === undefined) {
      throw new DataHubAdapterError(
        "MALFORMED_RESPONSE",
        "DataHub schema response omitted the filtered-field match count.",
        {
          invocationId: observation.invocation.invocationId,
          tool: observation.invocation.tool,
        },
      );
    }
    globalMatchingCount ??= matchingCount;
    if (matchingCount !== globalMatchingCount) {
      throw new DataHubAdapterError(
        "SCHEMA_DRIFT",
        "DataHub schema match count changed during pagination.",
        {
          invocationId: observation.invocation.invocationId,
          tool: observation.invocation.tool,
        },
      );
    }
    requireUniqueResolution(matchingCount, observation.invocation, "schema field");
    const nextOffset = observation.data.offset + observation.data.returned;
    return {
      items: observation.data.fields,
      ...(observation.data.remainingCount === 0 ? {} : { nextOffset }),
      observation,
    };
  });
  const matches = paged.items.filter((field) => field.item.fieldPath === targets.field);
  requireUniqueResolution(matches.length, pageInvocation(matches, paged.pages), "schema field");
  const proof = matches[0]?.page;
  if (proof === undefined) {
    throw new DataHubAdapterError("NOT_FOUND", "Canonical DataHub schema field was not found.");
  }
  return Object.freeze({ pages: paged.pages, proof });
}

type LineageResult = NonNullable<OfficialLineagePage["downstreams"]>["searchResults"][number];

async function collectLineageDiscovery(
  invoker: CanonicalToolInvoker,
  targets: CanonicalCollectionTargets,
): Promise<
  Readonly<{
    dashboard: OfficialObservation<OfficialLineagePage>;
    fraud: OfficialObservation<OfficialLineagePage>;
    pages: readonly OfficialObservation<OfficialLineagePage>[];
  }>
> {
  let resultTotal: number | undefined;
  const paged = await collectObservedPages<OfficialLineagePage, LineageResult>(
    "get_lineage",
    async (offset, pageSize) => {
      const observation = await observe(
        invoker,
        "get_lineage",
        {
          column: targets.field,
          max_hops: 3,
          max_results: pageSize,
          offset,
          upstream: false,
          urn: targets.sourceUrn,
        },
        parseLineagePage,
      );
      const downstreams = observation.data.downstreams;
      if (downstreams === undefined) {
        throw new DataHubAdapterError(
          "MALFORMED_RESPONSE",
          "DataHub lineage response omitted downstream results.",
          {
            invocationId: observation.invocation.invocationId,
            tool: observation.invocation.tool,
          },
        );
      }
      if (
        downstreams.truncatedDueToTokenBudget === true ||
        downstreams.searchResults.some((result) => result.truncatedChildren === true)
      ) {
        throw new DataHubAdapterError(
          "PAGINATION_LIMIT",
          "DataHub lineage response was explicitly truncated.",
          {
            invocationId: observation.invocation.invocationId,
            tool: observation.invocation.tool,
          },
        );
      }
      if (downstreams.offset === undefined && downstreams.start === undefined) {
        throw new DataHubAdapterError(
          "MALFORMED_RESPONSE",
          "DataHub lineage pagination omitted its page offset.",
          {
            invocationId: observation.invocation.invocationId,
            tool: observation.invocation.tool,
          },
        );
      }
      if (
        (downstreams.offset !== undefined && downstreams.offset !== offset) ||
        (downstreams.start !== undefined && downstreams.start !== offset)
      ) {
        throw new DataHubAdapterError(
          "CURSOR_CYCLE",
          "DataHub pagination did not return the requested offset.",
          {
            invocationId: observation.invocation.invocationId,
            tool: observation.invocation.tool,
          },
        );
      }
      resultTotal = stablePageTotal(
        resultTotal,
        downstreams.total,
        observation,
        "lineage result total",
      );
      const nextOffset = offset + downstreams.searchResults.length;
      const hasMore = nextOffset < resultTotal;
      if (downstreams.hasMore !== undefined && downstreams.hasMore !== hasMore) {
        throw new DataHubAdapterError(
          "MALFORMED_RESPONSE",
          "DataHub lineage continuation flag contradicted its result total.",
          {
            invocationId: observation.invocation.invocationId,
            tool: observation.invocation.tool,
          },
        );
      }
      return {
        items: downstreams.searchResults,
        ...(hasMore ? { nextOffset } : {}),
        observation,
      };
    },
  );
  const exact = (urn: string) =>
    paged.items.filter(
      (result) =>
        result.item.entity.urn === urn &&
        result.item.lineageColumns?.includes(targets.field) === true,
    );
  const staging = exact(canonicalAnalyticsStagingUrn);
  const revenue = exact(targets.revenueUrn);
  const fraud = exact(targets.fraudFeaturesUrn);
  for (const matches of [staging, revenue, fraud]) {
    requireUniqueResolution(
      matches.length,
      pageInvocation(matches, paged.pages),
      "downstream field lineage",
    );
  }
  const dashboardProof = revenue[0]?.page;
  const fraudProof = fraud[0]?.page;
  if (dashboardProof === undefined || fraudProof === undefined) {
    throw new DataHubAdapterError("NOT_FOUND", "Canonical downstream field lineage was not found.");
  }
  return Object.freeze({
    dashboard: dashboardProof,
    fraud: fraudProof,
    pages: paged.pages,
  });
}

async function collectQueryDiscovery(
  invoker: CanonicalToolInvoker,
  targets: CanonicalCollectionTargets,
): Promise<
  Readonly<{
    pages: readonly OfficialObservation<OfficialQueryPage>[];
    proof: OfficialObservation<OfficialQueryPage>;
  }>
> {
  let resultTotal: number | undefined;
  const paged = await collectObservedPages("get_dataset_queries", async (offset, pageSize) => {
    const observation = await observe(
      invoker,
      "get_dataset_queries",
      {
        column: targets.field,
        count: pageSize,
        source: "SYSTEM",
        start: offset,
        urn: targets.revenueUrn,
      },
      parseQueryPage,
    );
    if (observation.data.start !== offset) {
      throw new DataHubAdapterError(
        "CURSOR_CYCLE",
        "DataHub pagination did not return the requested offset.",
        {
          invocationId: observation.invocation.invocationId,
          tool: observation.invocation.tool,
        },
      );
    }
    resultTotal = stablePageTotal(
      resultTotal,
      observation.data.total,
      observation,
      "query result total",
    );
    const nextOffset = observation.data.start + observation.data.count;
    return {
      items: observation.data.queries,
      ...(nextOffset >= resultTotal ? {} : { nextOffset }),
      observation,
    };
  });
  const matches = paged.items.filter((query) => query.item.urn === targets.queryUrn);
  requireUniqueResolution(matches.length, pageInvocation(matches, paged.pages), "query");
  const proof = matches[0]?.page;
  if (proof === undefined) {
    throw new DataHubAdapterError("NOT_FOUND", "Canonical DataHub query was not found.");
  }
  return Object.freeze({ pages: paged.pages, proof });
}

export async function collectCanonicalObservations(
  invoker: CanonicalToolInvoker,
  input: CanonicalCollectionTargets,
): Promise<CanonicalObservations> {
  const targets = safeTargets(input);
  const resolution = await collectResolutionSearch(invoker, targets);
  const resolutionSearch = resolution.proof;
  const resolutionSearchPages = resolution.pages;
  const schema = await collectSchemaFields(invoker, targets);
  const schemaFields = schema.proof;
  const schemaFieldPages = schema.pages;
  const lineage = await collectLineageDiscovery(invoker, targets);
  const lineageDiscovery = lineage.dashboard;
  const fraudLineageDiscovery = lineage.fraud;
  const lineageDiscoveryPages = lineage.pages;
  const dashboardFieldPath = await observe(
    invoker,
    "get_lineage_paths_between",
    {
      direction: "downstream",
      source_column: targets.field,
      source_urn: targets.sourceUrn,
      target_column: targets.field,
      target_urn: targets.revenueUrn,
    },
    parsePathResult,
  );
  const dashboardEntityPath = await observe(
    invoker,
    "get_lineage_paths_between",
    {
      direction: "downstream",
      source_urn: targets.revenueUrn,
      target_urn: targets.dashboardUrn,
    },
    parsePathResult,
  );
  const fraudFieldPath = await observe(
    invoker,
    "get_lineage_paths_between",
    {
      direction: "downstream",
      source_column: targets.field,
      source_urn: targets.sourceUrn,
      target_column: targets.field,
      target_urn: targets.fraudFeaturesUrn,
    },
    parsePathResult,
  );
  const fraudEntityPath = await observePathOrEmpty(
    invoker,
    "get_lineage_paths_between",
    {
      direction: "downstream",
      source_urn: targets.fraudFeaturesUrn,
      target_urn: targets.modelUrn,
    },
    targets.fraudFeaturesUrn,
    targets.modelUrn,
  );
  const trainingDataProof = await readTrainingDataAspect({
    gmsBaseUrl: targets.gmsBaseUrl,
    readToken: targets.readToken,
    modelUrn: targets.modelUrn,
    expectedDatasetUrn: targets.fraudFeaturesUrn,
    ...(targets.fetchImpl === undefined ? {} : { fetchImpl: targets.fetchImpl }),
  });
  const query = await collectQueryDiscovery(invoker, targets);
  const queryDiscovery = query.proof;
  const queryDiscoveryPages = query.pages;
  const dashboardDetails = await observe(
    invoker,
    "get_entities",
    { urns: [targets.dashboardUrn] },
    parseEntitiesResult,
  );
  const modelDetails = await observe(
    invoker,
    "get_entities",
    { urns: [targets.modelUrn] },
    parseEntitiesResult,
  );
  const queryDetails = await observe(
    invoker,
    "get_entities",
    { urns: [targets.queryUrn] },
    parseEntitiesResult,
  );
  const revenueDetails = await observe(
    invoker,
    "get_entities",
    { urns: [targets.revenueUrn] },
    parseEntitiesResult,
  );
  const glossaryDetails = await observe(
    invoker,
    "get_entities",
    { urns: [targets.glossaryTermUrn] },
    parseEntitiesResult,
  );

  return Object.freeze({
    dashboardDetails,
    dashboardEntityPath,
    dashboardFieldPath,
    fraudEntityPath,
    fraudFieldPath,
    fraudLineageDiscovery,
    glossaryDetails,
    lineageDiscovery,
    lineageDiscoveryPages,
    modelDetails,
    queryDetails,
    queryDiscovery,
    queryDiscoveryPages,
    resolutionSearch,
    resolutionSearchPages,
    revenueDetails,
    schemaFieldPages,
    schemaFields,
    trainingDataProof,
  });
}
