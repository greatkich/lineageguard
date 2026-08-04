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
  return Object.freeze({ data: parse(invocation.payload), invocation });
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

export async function collectCanonicalObservations(
  invoker: CanonicalToolInvoker,
  input: CanonicalCollectionTargets,
): Promise<CanonicalObservations> {
  const targets = safeTargets(input);
  const resolutionSearch = await observe(
    invoker,
    "search",
    {
      filter: `entity_type = dataset AND platform = ${targets.platform} AND env = ${targets.environment}`,
      num_results: 50,
      offset: 0,
      query: `/q ${targets.platformInstance}+${targets.database}+${targets.schema}+${targets.dataset}`,
    },
    parseSearchPage,
  );
  requireUniqueResolution(
    resolutionSearch.data.searchResults.filter((result) => result.entity.urn === targets.sourceUrn)
      .length,
    resolutionSearch.invocation,
    "dataset",
  );
  const schemaFields = await observe(
    invoker,
    "list_schema_fields",
    {
      keywords: [targets.field],
      limit: 50,
      offset: 0,
      urn: targets.sourceUrn,
    },
    parseSchemaFieldsPage,
  );
  if (schemaFields.data.urn !== targets.sourceUrn) {
    throw new DataHubAdapterError(
      "MALFORMED_RESPONSE",
      "DataHub schema response did not match the resolved dataset.",
      {
        invocationId: schemaFields.invocation.invocationId,
        tool: schemaFields.invocation.tool,
      },
    );
  }
  requireUniqueResolution(
    schemaFields.data.fields.filter((field) => field.fieldPath === targets.field).length,
    schemaFields.invocation,
    "schema field",
  );
  const lineageDiscovery = await observe(
    invoker,
    "get_lineage",
    {
      column: targets.field,
      max_hops: 3,
      max_results: 50,
      offset: 0,
      upstream: false,
      urn: targets.sourceUrn,
    },
    parseLineagePage,
  );
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
  const queryDiscovery = await observe(
    invoker,
    "get_dataset_queries",
    {
      column: targets.field,
      count: 50,
      source: "SYSTEM",
      start: 0,
      urn: targets.revenueUrn,
    },
    parseQueryPage,
  );
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
    glossaryDetails,
    lineageDiscovery,
    modelDetails,
    queryDetails,
    queryDiscovery,
    resolutionSearch,
    schemaFields,
  });
}
