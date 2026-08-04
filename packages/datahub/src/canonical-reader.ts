import { canonicalAnalyticsStagingUrn } from "@lineageguard/domain";
import { z } from "zod";
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
    modelUrn: urn,
    platform: platformIdentifier,
    platformInstance: identifier,
    queryUrn: urn,
    revenueUrn: urn,
    schema: identifier,
    sourceUrn: urn,
  })
  .strict();

export type CanonicalCollectionTargets = z.infer<typeof targetsSchema>;

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
  modelDetails: OfficialObservation<readonly OfficialEntity[]>;
  queryDetails: OfficialObservation<readonly OfficialEntity[]>;
  queryDiscovery: OfficialObservation<OfficialQueryPage>;
  resolutionSearch: OfficialObservation<OfficialSearchPage>;
  schemaFields: OfficialObservation<OfficialSchemaFieldsPage>;
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
  const parsed = targetsSchema.safeParse(input);
  if (!parsed.success) {
    throw new DataHubAdapterError(
      "CONFIGURATION",
      "Canonical DataHub collection targets are invalid.",
    );
  }
  return parsed.data;
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

async function collectResolutionSearch(
  invoker: CanonicalToolInvoker,
  targets: CanonicalCollectionTargets,
): Promise<OfficialObservation<OfficialSearchPage>> {
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
    const nextOffset = observation.data.start + observation.data.count;
    return {
      items: observation.data.searchResults,
      ...(nextOffset >= observation.data.total ? {} : { nextOffset }),
      observation,
    };
  });
  const matches = paged.items.filter((result) => result.item.entity.urn === targets.sourceUrn);
  requireUniqueResolution(matches.length, pageInvocation(matches, paged.pages), "dataset");
  const proof = matches[0]?.page;
  if (proof === undefined) {
    throw new DataHubAdapterError("NOT_FOUND", "Canonical DataHub dataset was not found.");
  }
  return proof;
}

async function collectSchemaFields(
  invoker: CanonicalToolInvoker,
  targets: CanonicalCollectionTargets,
): Promise<OfficialObservation<OfficialSchemaFieldsPage>> {
  let globalMatchingCount: number | undefined;
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
  return proof;
}

type LineageResult = NonNullable<OfficialLineagePage["downstreams"]>["searchResults"][number];

async function collectLineageDiscovery(
  invoker: CanonicalToolInvoker,
  targets: CanonicalCollectionTargets,
): Promise<
  Readonly<{
    dashboard: OfficialObservation<OfficialLineagePage>;
    fraud: OfficialObservation<OfficialLineagePage>;
  }>
> {
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
      const actualOffset = downstreams.offset ?? downstreams.start ?? offset;
      if (actualOffset !== offset) {
        throw new DataHubAdapterError(
          "CURSOR_CYCLE",
          "DataHub pagination did not return the requested offset.",
          {
            invocationId: observation.invocation.invocationId,
            tool: observation.invocation.tool,
          },
        );
      }
      const nextOffset = actualOffset + downstreams.searchResults.length;
      const hasMore = downstreams.hasMore === true || nextOffset < downstreams.total;
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
  });
}

async function collectQueryDiscovery(
  invoker: CanonicalToolInvoker,
  targets: CanonicalCollectionTargets,
): Promise<OfficialObservation<OfficialQueryPage>> {
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
    const nextOffset = observation.data.start + observation.data.count;
    return {
      items: observation.data.queries,
      ...(nextOffset >= observation.data.total ? {} : { nextOffset }),
      observation,
    };
  });
  const matches = paged.items.filter((query) => query.item.urn === targets.queryUrn);
  requireUniqueResolution(matches.length, pageInvocation(matches, paged.pages), "query");
  const proof = matches[0]?.page;
  if (proof === undefined) {
    throw new DataHubAdapterError("NOT_FOUND", "Canonical DataHub query was not found.");
  }
  return proof;
}

export async function collectCanonicalObservations(
  invoker: CanonicalToolInvoker,
  input: CanonicalCollectionTargets,
): Promise<CanonicalObservations> {
  const targets = safeTargets(input);
  const resolutionSearch = await collectResolutionSearch(invoker, targets);
  const schemaFields = await collectSchemaFields(invoker, targets);
  const lineage = await collectLineageDiscovery(invoker, targets);
  const lineageDiscovery = lineage.dashboard;
  const fraudLineageDiscovery = lineage.fraud;
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
  const fraudEntityPath = await observe(
    invoker,
    "get_lineage_paths_between",
    {
      direction: "downstream",
      source_urn: targets.fraudFeaturesUrn,
      target_urn: targets.modelUrn,
    },
    parsePathResult,
  );
  const queryDiscovery = await collectQueryDiscovery(invoker, targets);
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
    modelDetails,
    queryDetails,
    queryDiscovery,
    resolutionSearch,
    schemaFields,
  });
}
