import { z } from "zod";
import { DataHubAdapterError } from "./errors.js";

const MAX_URN_LENGTH = 4_096;
const MAX_TEXT_LENGTH = 65_536;
const MAX_PAGE_ITEMS = 200;
const nonnegativeInteger = z.number().int().nonnegative();
const boundedText = z.string().max(MAX_TEXT_LENGTH);
const urn = z.string().startsWith("urn:li:").max(MAX_URN_LENGTH);

const searchEntitySchema = z
  .object({
    urn,
  })
  .passthrough();

const searchResultSchema = z
  .object({
    entity: searchEntitySchema,
    matchedFields: z.array(boundedText).max(100).optional(),
  })
  .strict();

const searchPageSchema = z
  .object({
    count: nonnegativeInteger,
    facets: z.unknown().optional(),
    searchResults: z.array(searchResultSchema).max(MAX_PAGE_ITEMS).default([]),
    start: nonnegativeInteger,
    total: nonnegativeInteger,
  })
  .strict()
  .refine(
    (page) => page.count === page.searchResults.length && page.total >= page.start + page.count,
  );

const schemaFieldSchema = z
  .object({
    deprecated: z
      .object({
        deprecated: z.literal(true),
        note: boundedText,
      })
      .strict()
      .optional(),
    description: boundedText.nullable().optional(),
    editedDescription: boundedText.nullable().optional(),
    editedGlossaryTerms: z.array(boundedText).max(100).optional(),
    editedTags: z.array(boundedText).max(100).optional(),
    glossaryTerms: z.array(boundedText).max(100).optional(),
    fieldPath: boundedText.min(1),
    isPartOfKey: z.boolean().optional(),
    isPartitioningKey: z.boolean().optional(),
    label: boundedText.nullable().optional(),
    nativeDataType: boundedText.nullable().optional(),
    nullable: z.boolean().optional(),
    recursive: z.boolean().optional(),
    tags: z.array(boundedText).max(100).optional(),
    type: boundedText.nullable().optional(),
  })
  .strict();

const schemaFieldsPageSchema = z
  .object({
    fields: z.array(schemaFieldSchema).max(MAX_PAGE_ITEMS),
    matchingCount: nonnegativeInteger.nullable().optional(),
    offset: nonnegativeInteger,
    remainingCount: nonnegativeInteger,
    returned: nonnegativeInteger,
    totalFields: nonnegativeInteger,
    urn,
  })
  .strict()
  .refine(
    (page) =>
      page.returned === page.fields.length &&
      page.offset <= page.totalFields &&
      page.remainingCount === Math.max(page.totalFields - page.offset - page.returned, 0),
  );

const lineageEntitySchema = z
  .object({
    name: boundedText.optional(),
    type: boundedText.optional(),
    urn,
  })
  .passthrough();

const lineageResultSchema = z
  .object({
    degree: nonnegativeInteger,
    entity: lineageEntitySchema,
    explored: z.boolean().optional(),
    ignoredAsHop: z.boolean().optional(),
    lineageColumns: z.array(boundedText).max(200).optional(),
    truncatedChildren: z.boolean().optional(),
  })
  .strict();

const lineageDirectionSchema = z
  .object({
    count: nonnegativeInteger.optional(),
    facets: z.unknown().optional(),
    hasMore: z.boolean().optional(),
    offset: nonnegativeInteger.optional(),
    returned: nonnegativeInteger.optional(),
    searchResults: z.array(lineageResultSchema).max(MAX_PAGE_ITEMS).default([]),
    start: nonnegativeInteger.optional(),
    total: nonnegativeInteger,
    truncatedDueToTokenBudget: z.boolean().optional(),
  })
  .strict()
  .refine(
    (page) =>
      (page.returned === undefined || page.returned === page.searchResults.length) &&
      page.total >= (page.offset ?? page.start ?? 0) + page.searchResults.length,
  );

const lineageMetadataSchema = z
  .object({
    groupedBy: boundedText.optional(),
    queryType: boundedText.optional(),
  })
  .passthrough();

const lineagePageSchema = z
  .object({
    downstreams: lineageDirectionSchema.optional(),
    metadata: lineageMetadataSchema.optional(),
    upstreams: lineageDirectionSchema.optional(),
  })
  .strict()
  .refine((page) => page.downstreams !== undefined || page.upstreams !== undefined);

const pathEndpointSchema = z
  .object({
    column: boundedText.optional(),
    urn,
  })
  .strict();

const pathParentSchema = z
  .object({
    type: boundedText,
    urn,
  })
  .passthrough();

const pathNodeSchema = z
  .object({
    fieldPath: boundedText.optional(),
    parent: pathParentSchema.optional(),
    type: boundedText,
    urn,
  })
  .passthrough();

const lineagePathSchema = z
  .object({
    path: z.array(pathNodeSchema).min(1).max(50),
  })
  .strict();

const pathMetadataSchema = z
  .object({
    direction: boundedText.optional(),
    note: boundedText.optional(),
    pathType: boundedText.optional(),
    queryType: boundedText.optional(),
  })
  .passthrough();

const pathResultSchema = z
  .object({
    metadata: pathMetadataSchema.optional(),
    pathCount: nonnegativeInteger,
    paths: z.array(lineagePathSchema).max(10),
    source: pathEndpointSchema,
    target: pathEndpointSchema,
  })
  .strict()
  .refine((result) => result.pathCount === result.paths.length);

const queryStatementSchema = z
  .object({
    language: boundedText.optional(),
    value: boundedText,
  })
  .strict();

const queryModificationSchema = z
  .object({
    actor: urn.optional(),
    time: nonnegativeInteger.optional(),
  })
  .strict();

const queryPropertiesSchema = z
  .object({
    description: boundedText.nullable().optional(),
    lastModified: queryModificationSchema.optional(),
    name: boundedText.nullable().optional(),
    source: z.enum(["MANUAL", "SYSTEM"]),
    statement: queryStatementSchema,
  })
  .strict();

const queryPlatformSchema = z
  .object({
    name: boundedText.optional(),
    urn,
  })
  .strict();

const querySchema = z
  .object({
    platform: queryPlatformSchema,
    properties: queryPropertiesSchema,
    subjects: z.array(urn).max(200),
    urn,
  })
  .strict();

const queryPageSchema = z
  .object({
    count: nonnegativeInteger,
    queries: z.array(querySchema).max(MAX_PAGE_ITEMS).default([]),
    start: nonnegativeInteger,
    total: nonnegativeInteger,
  })
  .strict()
  .refine((page) => page.count === page.queries.length && page.total >= page.start + page.count);

const entitySchema = z
  .object({
    urn,
  })
  .passthrough()
  .refine((entity) => !("error" in entity));

const entitiesResultSchema = z.union([
  entitySchema.transform((entity) => [entity]),
  z.array(entitySchema).max(50),
]);

export type OfficialSearchPage = z.infer<typeof searchPageSchema>;
export type OfficialSchemaFieldsPage = z.infer<typeof schemaFieldsPageSchema>;
export type OfficialLineagePage = z.infer<typeof lineagePageSchema>;
export type OfficialPathResult = z.infer<typeof pathResultSchema>;
export type OfficialQueryPage = z.infer<typeof queryPageSchema>;
export type OfficialEntity = z.infer<typeof entitySchema>;

function parseContract<T>(schema: z.ZodType<T>, value: unknown): T {
  const parsed = schema.safeParse(value);
  if (!parsed.success) {
    throw new DataHubAdapterError(
      "MALFORMED_RESPONSE",
      "Official DataHub MCP response schema changed or is malformed.",
    );
  }
  return parsed.data;
}

export function parseSearchPage(value: unknown): OfficialSearchPage {
  return parseContract(searchPageSchema, value);
}

export function parseSchemaFieldsPage(value: unknown): OfficialSchemaFieldsPage {
  return parseContract(schemaFieldsPageSchema, value);
}

export function parseLineagePage(value: unknown): OfficialLineagePage {
  return parseContract(lineagePageSchema, value);
}

export function parsePathResult(value: unknown): OfficialPathResult {
  return parseContract(pathResultSchema, value);
}

export function parseQueryPage(value: unknown): OfficialQueryPage {
  return parseContract(queryPageSchema, value);
}

export function parseEntitiesResult(value: unknown): readonly OfficialEntity[] {
  return parseContract(entitiesResultSchema, value);
}
