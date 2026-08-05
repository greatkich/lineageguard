import {
  canonicalAnalyticsRevenueUrn,
  canonicalAnalyticsStagingUrn,
  canonicalCriticalTagUrn,
  canonicalDashboardUrn,
  canonicalDatasetUrn,
  canonicalFieldPath,
  canonicalFinanceOwnerUrn,
  canonicalFraudFeaturesUrn,
  canonicalFraudModelUrn,
  canonicalGlossaryTermUrn,
  canonicalImpactRequest,
  canonicalNativeFieldPath,
  canonicalProductionTagUrn,
  canonicalQueryStatementFingerprint,
  canonicalQuerySubjectFieldUrn,
  canonicalQueryUrn,
  canonicalRiskOwnerUrn,
  canonicalSchemaFieldUrn,
  computeImpactCollectionFingerprint,
  computeImpactContextFingerprint,
  createEvidence,
  type EvidenceItem,
  type ImpactCollectionResult,
  type ImpactContextData,
  impactCollectionResultSchema,
  impactContextSchema,
  impactResolutionSchema,
} from "@lineageguard/domain";
import { z } from "zod";
import type { CanonicalObservations, OfficialObservation } from "./canonical-reader.js";
import { DataHubAdapterError } from "./errors.js";
import type {
  OfficialEntity,
  OfficialLineagePage,
  OfficialPathResult,
  OfficialQueryPage,
  OfficialSchemaFieldsPage,
} from "./official-contract.js";
import { normalizedSqlFingerprint } from "./sql-fingerprint.js";

const urnSchema = z.string().startsWith("urn:li:").max(4_096);
const textSchema = z.string().min(1).max(65_536);

type Provenance = EvidenceItem["provenance"][number];
type ProvenanceRole = Provenance["role"];

type Owner = Readonly<{
  displayName: string;
  ownershipType: "BUSINESS_OWNER" | "TECHNICAL_OWNER";
  urn: string;
}>;

type NormalizedAsset = Readonly<{
  classificationUrns: readonly string[];
  owner: Owner | undefined;
}>;

const ownerEdgeSchema = z
  .object({
    owner: z
      .object({
        info: z.object({ displayName: textSchema }).passthrough().optional(),
        properties: z.object({ displayName: textSchema }).passthrough().optional(),
        urn: urnSchema,
      })
      .passthrough(),
    type: textSchema,
  })
  .passthrough();

const assetEntitySchema = z
  .object({
    deprecation: z.object({ deprecated: z.boolean() }).passthrough().optional(),
    name: textSchema.optional(),
    origin: textSchema.optional(),
    ownership: z
      .object({ owners: z.array(ownerEdgeSchema).max(20) })
      .passthrough()
      .optional(),
    platform: z.object({ name: textSchema, urn: urnSchema.optional() }).passthrough().optional(),
    properties: z
      .object({
        name: textSchema.optional(),
      })
      .passthrough()
      .optional(),
    tags: z
      .object({
        tags: z
          .array(
            z
              .object({
                tag: z.object({ urn: urnSchema }).passthrough(),
              })
              .passthrough(),
          )
          .max(20),
      })
      .passthrough()
      .optional(),
    tool: textSchema.optional(),
    type: textSchema.optional(),
    urn: urnSchema,
  })
  .passthrough();

const queryDetailSchema = z
  .object({
    platform: z.object({ name: textSchema, urn: urnSchema.optional() }).passthrough().optional(),
    properties: z
      .object({
        source: z.enum(["MANUAL", "SYSTEM"]),
        statement: z.object({ value: textSchema }).passthrough(),
      })
      .passthrough(),
    subjects: z
      .array(
        z
          .object({
            dataset: z.object({ urn: urnSchema }).passthrough(),
            schemaField: z
              .object({
                fieldPath: textSchema,
                urn: urnSchema,
              })
              .passthrough()
              .optional(),
          })
          .passthrough(),
      )
      .max(200),
    type: textSchema.optional(),
    urn: urnSchema,
  })
  .passthrough();

const glossaryDetailSchema = z
  .object({
    properties: z.object({ name: textSchema }).passthrough(),
    type: textSchema.optional(),
    urn: urnSchema,
  })
  .passthrough();

function errorFor(
  observation: OfficialObservation<unknown>,
  code: "AMBIGUOUS" | "NOT_FOUND" | "SCHEMA_DRIFT",
  message: string,
): never {
  throw new DataHubAdapterError(code, message, {
    invocationId: observation.invocation.invocationId,
    tool: observation.invocation.tool,
  });
}

function provenance(observation: OfficialObservation<unknown>, role: ProvenanceRole): Provenance {
  return {
    source: "DATAHUB_MCP",
    role,
    tool: observation.invocation.tool,
    invocationId: observation.invocation.invocationId,
    retrievedAt: observation.invocation.retrievedAt,
    responseFingerprint: observation.invocation.responseFingerprint,
  };
}

function pagedProvenance(
  observations: readonly OfficialObservation<unknown>[],
  role: ProvenanceRole,
): Provenance[] {
  return observations.map((observation) => provenance(observation, role));
}

function requireExactlyOne<T>(
  items: readonly T[],
  observation: OfficialObservation<unknown>,
  subject: string,
): T {
  if (items.length === 0) {
    errorFor(observation, "NOT_FOUND", `Canonical DataHub ${subject} was not found.`);
  }
  if (items.length !== 1) {
    errorFor(observation, "AMBIGUOUS", `Canonical DataHub ${subject} was ambiguous.`);
  }
  const item = items[0];
  if (item === undefined) {
    errorFor(observation, "NOT_FOUND", `Canonical DataHub ${subject} was not found.`);
  }
  return item;
}

function exactEntity(
  observation: OfficialObservation<readonly OfficialEntity[]>,
  expectedUrn: string,
  subject: string,
): OfficialEntity {
  const matches = observation.data.filter((entity) => entity.urn === expectedUrn);
  const entity = requireExactlyOne(matches, observation, subject);
  if (observation.data.length !== 1) {
    errorFor(observation, "AMBIGUOUS", `Canonical DataHub ${subject} response was ambiguous.`);
  }
  return entity;
}

function exactSortedValues(
  actual: readonly string[],
  expected: readonly string[],
  observation: OfficialObservation<unknown>,
  subject: string,
): readonly string[] {
  const sorted = [...new Set(actual)].sort();
  if (
    sorted.length !== actual.length ||
    JSON.stringify(sorted) !== JSON.stringify([...expected].sort())
  ) {
    errorFor(observation, "SCHEMA_DRIFT", `Canonical DataHub ${subject} changed.`);
  }
  return Object.freeze(sorted);
}

function normalizeOwner(
  edge: z.infer<typeof ownerEdgeSchema>,
  expectedUrn: string,
  expectedDisplayName: string,
  expectedType: Owner["ownershipType"],
  observation: OfficialObservation<unknown>,
): Owner {
  const propertyName = edge.owner.properties?.displayName;
  const infoName = edge.owner.info?.displayName;
  if (propertyName !== undefined && infoName !== undefined && propertyName !== infoName) {
    errorFor(observation, "SCHEMA_DRIFT", "Canonical DataHub owner identity changed.");
  }
  const displayName = propertyName ?? infoName;
  if (
    edge.owner.urn !== expectedUrn ||
    displayName !== expectedDisplayName ||
    edge.type !== expectedType
  ) {
    errorFor(observation, "SCHEMA_DRIFT", "Canonical DataHub owner identity changed.");
  }
  return Object.freeze({ displayName, ownershipType: expectedType, urn: expectedUrn });
}

function normalizeAsset(
  observation: OfficialObservation<readonly OfficialEntity[]>,
  expected: Readonly<{
    displayName: string;
    ownerDisplayName: string;
    ownerType: Owner["ownershipType"];
    ownerUrn: string;
    platform?: string;
    type: string;
    urn: string;
  }>,
  subject: string,
): NormalizedAsset {
  const entity = exactEntity(observation, expected.urn, subject);
  const parsed = assetEntitySchema.safeParse(entity);
  if (!parsed.success) {
    errorFor(observation, "SCHEMA_DRIFT", `Canonical DataHub ${subject} details changed.`);
  }
  const asset = parsed.data;
  const displayName = asset.properties?.name ?? asset.name;
  if (
    asset.type !== expected.type ||
    displayName !== expected.displayName ||
    asset.deprecation?.deprecated === true ||
    (expected.platform !== undefined &&
      (asset.platform?.name !== expected.platform || asset.tool !== expected.platform))
  ) {
    errorFor(observation, "SCHEMA_DRIFT", `Canonical DataHub ${subject} identity changed.`);
  }
  const classificationUrns = exactSortedValues(
    (asset.tags?.tags ?? []).map((entry) => entry.tag.urn),
    [canonicalCriticalTagUrn, canonicalProductionTagUrn],
    observation,
    `${subject} classifications`,
  );
  if (!classificationUrns.includes(canonicalProductionTagUrn)) {
    errorFor(observation, "SCHEMA_DRIFT", `Canonical DataHub ${subject} lifecycle changed.`);
  }
  const owners = asset.ownership?.owners ?? [];
  if (owners.length > 1) {
    errorFor(observation, "AMBIGUOUS", `Canonical DataHub ${subject} ownership was ambiguous.`);
  }
  const owner = owners[0];
  return Object.freeze({
    classificationUrns,
    owner:
      owner === undefined
        ? undefined
        : normalizeOwner(
            owner,
            expected.ownerUrn,
            expected.ownerDisplayName,
            expected.ownerType,
            observation,
          ),
  });
}

function requireLineageDiscovery(
  observation: OfficialObservation<OfficialLineagePage>,
  expectedUrns: readonly string[],
): void {
  const downstreams = observation.data.downstreams?.searchResults ?? [];
  for (const expectedUrn of expectedUrns) {
    const matching = downstreams.filter(
      (result) =>
        result.entity.urn === expectedUrn &&
        result.lineageColumns?.includes(canonicalNativeFieldPath) === true,
    );
    if (matching.length === 0) {
      errorFor(observation, "NOT_FOUND", "Canonical downstream field lineage was not found.");
    }
    if (matching.length !== 1) {
      errorFor(observation, "AMBIGUOUS", "Canonical downstream field lineage was ambiguous.");
    }
  }
}

type PathNode = Readonly<{ fieldPath?: string; parentUrn?: string; type: string; urn: string }>;

function pathNodes(path: OfficialPathResult["paths"][number]): readonly PathNode[] {
  return path.path
    .filter((node) => node.type !== "QUERY")
    .map((node) => ({
      ...(node.fieldPath === undefined ? {} : { fieldPath: node.fieldPath }),
      ...(node.parent?.urn === undefined ? {} : { parentUrn: node.parent.urn }),
      type: node.type,
      urn: node.urn,
    }));
}

function exactFieldPath(
  observation: OfficialObservation<OfficialPathResult>,
  targetUrn: string,
  expectedDatasets: readonly string[],
): void {
  const result = observation.data;
  if (
    result.source.urn !== canonicalDatasetUrn ||
    result.source.column !== canonicalNativeFieldPath ||
    result.target.urn !== targetUrn ||
    result.target.column !== canonicalNativeFieldPath
  ) {
    errorFor(observation, "SCHEMA_DRIFT", "Canonical field-lineage endpoints changed.");
  }
  const matching = result.paths.filter((path) => {
    const nodes = pathNodes(path);
    return (
      nodes.length === expectedDatasets.length &&
      nodes.every(
        (node, index) =>
          node.type === "SCHEMA_FIELD" &&
          node.parentUrn === expectedDatasets[index] &&
          node.fieldPath === canonicalNativeFieldPath,
      )
    );
  });
  requireExactlyOne(matching, observation, "field-lineage path");
}

function exactEntityPath(
  observation: OfficialObservation<OfficialPathResult>,
  sourceUrn: string,
  targetUrn: string,
  expectedTypes: readonly string[],
): void {
  const result = observation.data;
  if (
    result.source.urn !== sourceUrn ||
    result.source.column !== undefined ||
    result.target.urn !== targetUrn ||
    result.target.column !== undefined
  ) {
    errorFor(observation, "SCHEMA_DRIFT", "Canonical entity-lineage endpoints changed.");
  }
  const matching = result.paths.filter((path) => {
    const nodes = pathNodes(path);
    return (
      nodes.length === 2 &&
      nodes[0]?.urn === sourceUrn &&
      nodes[1]?.urn === targetUrn &&
      nodes.every((node, index) => node.type === expectedTypes[index])
    );
  });
  requireExactlyOne(matching, observation, "entity-lineage path");
}

function normalizeSchema(observation: OfficialObservation<OfficialSchemaFieldsPage>) {
  const schemaField = requireExactlyOne(
    observation.data.fields.filter((item) => item.fieldPath === canonicalNativeFieldPath),
    observation,
    "schema field",
  );
  if (
    schemaField.nativeDataType?.trim().toLowerCase() !== "bigint" ||
    schemaField.nullable !== false ||
    schemaField.deprecated?.deprecated === true
  ) {
    errorFor(observation, "SCHEMA_DRIFT", "Canonical DataHub source-field schema changed.");
  }
  if (
    (schemaField.glossaryTerms ?? []).filter((name) => name === "Customer Identifier").length !== 1
  ) {
    errorFor(observation, "NOT_FOUND", "Canonical system glossary binding was not found.");
  }
  return schemaField;
}

function normalizeQueryDiscovery(observation: OfficialObservation<OfficialQueryPage>) {
  const query = requireExactlyOne(
    observation.data.queries.filter((item) => item.urn === canonicalQueryUrn),
    observation,
    "query",
  );
  if (
    query.properties.source !== "SYSTEM" ||
    query.platform.name !== "postgres" ||
    query.subjects.length !== 1 ||
    query.subjects[0] !== canonicalAnalyticsRevenueUrn ||
    normalizedSqlFingerprint(query.properties.statement.value) !==
      canonicalQueryStatementFingerprint
  ) {
    errorFor(observation, "SCHEMA_DRIFT", "Canonical DataHub query discovery changed.");
  }
  return query;
}

function normalizeQueryDetails(observation: OfficialObservation<readonly OfficialEntity[]>): void {
  const entity = exactEntity(observation, canonicalQueryUrn, "query details");
  const parsed = queryDetailSchema.safeParse(entity);
  if (!parsed.success) {
    errorFor(observation, "SCHEMA_DRIFT", "Canonical DataHub query details changed.");
  }
  const query = parsed.data;
  const matchingSubjects = query.subjects.filter(
    (subject) =>
      subject.dataset.urn === canonicalAnalyticsRevenueUrn &&
      subject.schemaField?.urn === canonicalQuerySubjectFieldUrn &&
      subject.schemaField.fieldPath === canonicalNativeFieldPath,
  );
  if (
    query.type !== "QUERY" ||
    query.properties.source !== "SYSTEM" ||
    query.platform?.name !== "postgres" ||
    normalizedSqlFingerprint(query.properties.statement.value) !==
      canonicalQueryStatementFingerprint ||
    matchingSubjects.length !== 1
  ) {
    errorFor(observation, "SCHEMA_DRIFT", "Canonical DataHub query proof changed.");
  }
}

function normalizeGlossaryDetails(
  observation: OfficialObservation<readonly OfficialEntity[]>,
): void {
  const entity = exactEntity(observation, canonicalGlossaryTermUrn, "glossary term");
  const parsed = glossaryDetailSchema.safeParse(entity);
  if (
    !parsed.success ||
    parsed.data.type !== "GLOSSARY_TERM" ||
    parsed.data.properties.name !== "Customer Identifier"
  ) {
    errorFor(observation, "SCHEMA_DRIFT", "Canonical DataHub glossary term changed.");
  }
}

function pathPayload(targetUrn: string, middleUrn: string) {
  const isDashboard = targetUrn === canonicalDashboardUrn;
  const terminalDatasetUrn = isDashboard ? canonicalAnalyticsRevenueUrn : canonicalFraudFeaturesUrn;
  return {
    direction: "DOWNSTREAM" as const,
    fieldLevel: true as const,
    nodes: [canonicalDatasetUrn, middleUrn, terminalDatasetUrn, targetUrn],
    segments: [
      {
        granularity: "FIELD" as const,
        sourceUrn: canonicalDatasetUrn,
        targetUrn: middleUrn,
        sourceFieldPath: canonicalNativeFieldPath,
        targetFieldPath: canonicalNativeFieldPath,
      },
      {
        granularity: "FIELD" as const,
        sourceUrn: middleUrn,
        targetUrn: terminalDatasetUrn,
        sourceFieldPath: canonicalNativeFieldPath,
        targetFieldPath: canonicalNativeFieldPath,
      },
      {
        granularity: "ENTITY" as const,
        sourceUrn: terminalDatasetUrn,
        targetUrn,
      },
    ],
  };
}

export function normalizeCanonicalLiveCollection(
  input: Readonly<{
    changeId: string;
    collectedAt: string;
    observations: CanonicalObservations;
  }>,
): ImpactCollectionResult {
  const { observations } = input;
  normalizeSchema(observations.schemaFields);
  requireLineageDiscovery(observations.lineageDiscovery, [canonicalAnalyticsRevenueUrn]);
  requireLineageDiscovery(observations.fraudLineageDiscovery, [canonicalFraudFeaturesUrn]);
  exactFieldPath(observations.dashboardFieldPath, canonicalAnalyticsRevenueUrn, [
    canonicalDatasetUrn,
    canonicalAnalyticsStagingUrn,
    canonicalAnalyticsRevenueUrn,
  ]);
  exactEntityPath(
    observations.dashboardEntityPath,
    canonicalAnalyticsRevenueUrn,
    canonicalDashboardUrn,
    ["DATASET", "DASHBOARD"],
  );
  exactFieldPath(observations.fraudFieldPath, canonicalFraudFeaturesUrn, [
    canonicalDatasetUrn,
    canonicalAnalyticsStagingUrn,
    canonicalFraudFeaturesUrn,
  ]);
  exactEntityPath(observations.fraudEntityPath, canonicalFraudFeaturesUrn, canonicalFraudModelUrn, [
    "DATASET",
    "MLMODEL",
  ]);
  normalizeQueryDiscovery(observations.queryDiscovery);
  normalizeQueryDetails(observations.queryDetails);
  normalizeGlossaryDetails(observations.glossaryDetails);

  const dashboardAsset = normalizeAsset(
    observations.dashboardDetails,
    {
      displayName: "Finance Revenue Dashboard",
      ownerDisplayName: "Finance Analytics",
      ownerType: "BUSINESS_OWNER",
      ownerUrn: canonicalFinanceOwnerUrn,
      platform: "looker",
      type: "DASHBOARD",
      urn: canonicalDashboardUrn,
    },
    "dashboard",
  );
  const modelAsset = normalizeAsset(
    observations.modelDetails,
    {
      displayName: "Fraud Model v3",
      ownerDisplayName: "Risk ML",
      ownerType: "TECHNICAL_OWNER",
      ownerUrn: canonicalRiskOwnerUrn,
      type: "MLMODEL",
      urn: canonicalFraudModelUrn,
    },
    "model",
  );

  const resolution = impactResolutionSchema.parse({
    requested: canonicalImpactRequest,
    datasetUrn: canonicalDatasetUrn,
    schemaFieldUrn: canonicalSchemaFieldUrn,
    nativeFieldPath: canonicalNativeFieldPath,
    provenance: pagedProvenance(observations.resolutionSearchPages, "RESOLUTION"),
  });
  const schema = createEvidence({
    kind: "SCHEMA",
    sourceUrn: canonicalDatasetUrn,
    fieldPath: canonicalFieldPath,
    title: "orders.customer_id schema",
    summary: "The source field is a non-null bigint in PostgreSQL.",
    criticality: "HIGH",
    relatedEvidenceIds: [],
    provenance: pagedProvenance(observations.schemaFieldPages, "SCHEMA"),
    payload: {
      schemaFieldUrn: canonicalSchemaFieldUrn,
      nativeFieldPath: canonicalNativeFieldPath,
      nativeType: "bigint",
      nullable: false,
    },
  });
  const dashboardPath = createEvidence({
    kind: "LINEAGE_PATH",
    sourceUrn: canonicalDatasetUrn,
    targetUrn: canonicalDashboardUrn,
    fieldPath: canonicalFieldPath,
    title: "Finance dashboard lineage path",
    summary: "customer_id flows through the revenue datasets into the Finance dashboard.",
    criticality: "CRITICAL",
    relatedEvidenceIds: [],
    provenance: [
      ...pagedProvenance(observations.lineageDiscoveryPages, "LINEAGE_DISCOVERY"),
      provenance(observations.dashboardFieldPath, "FIELD_PATH"),
      provenance(observations.dashboardEntityPath, "ENTITY_PATH"),
    ],
    payload: pathPayload(canonicalDashboardUrn, canonicalAnalyticsStagingUrn),
  });
  const dashboard = createEvidence({
    kind: "DASHBOARD",
    sourceUrn: canonicalDatasetUrn,
    targetUrn: canonicalDashboardUrn,
    fieldPath: canonicalFieldPath,
    title: "Finance Revenue Dashboard",
    summary: "A critical Finance dashboard consumes the revenue lineage path.",
    criticality: "CRITICAL",
    relatedEvidenceIds: [dashboardPath.id],
    provenance: [provenance(observations.dashboardDetails, "ENTITY_DETAILS")],
    payload: {
      dashboardUrn: canonicalDashboardUrn,
      platform: "looker",
      lifecycle: "PRODUCTION",
      classificationUrns: [...dashboardAsset.classificationUrns],
      ownershipObserved: true,
      ownerUrns: dashboardAsset.owner === undefined ? [] : [dashboardAsset.owner.urn],
      downstreamDatasetUrn: canonicalAnalyticsRevenueUrn,
      downstreamField: "analytics.customer_revenue.customer_id",
    },
  });
  const modelPath = createEvidence({
    kind: "LINEAGE_PATH",
    sourceUrn: canonicalDatasetUrn,
    targetUrn: canonicalFraudModelUrn,
    fieldPath: canonicalFieldPath,
    title: "Fraud model lineage path",
    summary: "customer_id flows through the fraud feature set into the production model.",
    criticality: "CRITICAL",
    relatedEvidenceIds: [],
    provenance: [
      ...pagedProvenance(observations.lineageDiscoveryPages, "LINEAGE_DISCOVERY"),
      provenance(observations.fraudFieldPath, "FIELD_PATH"),
      provenance(observations.fraudEntityPath, "ENTITY_PATH"),
    ],
    payload: pathPayload(canonicalFraudModelUrn, canonicalAnalyticsStagingUrn),
  });
  const model = createEvidence({
    kind: "ML_MODEL",
    sourceUrn: canonicalDatasetUrn,
    targetUrn: canonicalFraudModelUrn,
    fieldPath: canonicalFieldPath,
    title: "Fraud Model v3",
    summary: "The production fraud model consumes customer_features.customer_id.",
    criticality: "CRITICAL",
    relatedEvidenceIds: [modelPath.id],
    provenance: [provenance(observations.modelDetails, "ENTITY_DETAILS")],
    payload: {
      modelUrn: canonicalFraudModelUrn,
      lifecycle: "PRODUCTION",
      classificationUrns: [...modelAsset.classificationUrns],
      ownershipObserved: true,
      ownerUrns: modelAsset.owner === undefined ? [] : [modelAsset.owner.urn],
      featureDatasetUrn: canonicalFraudFeaturesUrn,
      featureField: "fraud.customer_features.customer_id",
    },
  });
  const query = createEvidence({
    kind: "QUERY_USAGE",
    sourceUrn: canonicalDatasetUrn,
    targetUrn: canonicalQueryUrn,
    fieldPath: canonicalFieldPath,
    title: "Finance close SYSTEM query",
    summary:
      "A cataloged PostgreSQL query subject references analytics.customer_revenue.customer_id.",
    criticality: "HIGH",
    relatedEvidenceIds: [dashboardPath.id],
    provenance: [
      ...pagedProvenance(observations.queryDiscoveryPages, "QUERY_DISCOVERY"),
      provenance(observations.queryDetails, "QUERY_DETAILS"),
    ],
    payload: {
      queryUrn: canonicalQueryUrn,
      source: "SYSTEM",
      observationBasis: "DATAHUB_QUERY_ENTITY",
      subjectDatasetUrn: canonicalAnalyticsRevenueUrn,
      subjectSchemaFieldUrn: canonicalQuerySubjectFieldUrn,
      subjectFieldPath: canonicalNativeFieldPath,
      normalizedStatementFingerprint: canonicalQueryStatementFingerprint,
    },
  });
  const glossary = createEvidence({
    kind: "GLOSSARY_TERM",
    sourceUrn: canonicalDatasetUrn,
    targetUrn: canonicalGlossaryTermUrn,
    fieldPath: canonicalFieldPath,
    title: "Customer Identifier",
    summary: "customer_id is governed by the Customer Identifier glossary term.",
    criticality: "HIGH",
    relatedEvidenceIds: [],
    provenance: [
      ...pagedProvenance(observations.schemaFieldPages, "GLOSSARY_BINDING"),
      provenance(observations.glossaryDetails, "GLOSSARY_DETAILS"),
    ],
    payload: {
      termUrn: canonicalGlossaryTermUrn,
      name: "Customer Identifier",
      schemaFieldUrn: canonicalSchemaFieldUrn,
      fieldPath: canonicalFieldPath,
    },
  });
  const evidence: EvidenceItem[] = [
    schema,
    dashboardPath,
    dashboard,
    modelPath,
    model,
    query,
    glossary,
  ];
  if (dashboardAsset.owner !== undefined) {
    evidence.push(
      createEvidence({
        kind: "OWNER",
        sourceUrn: canonicalDashboardUrn,
        targetUrn: canonicalFinanceOwnerUrn,
        title: "Finance Analytics owner",
        summary: "Finance Analytics owns the revenue dashboard.",
        criticality: "HIGH",
        relatedEvidenceIds: [dashboard.id],
        provenance: [provenance(observations.dashboardDetails, "OWNER")],
        payload: {
          assetUrn: canonicalDashboardUrn,
          ownerUrn: canonicalFinanceOwnerUrn,
          displayName: dashboardAsset.owner.displayName,
          ownershipType: dashboardAsset.owner.ownershipType,
        },
      }),
    );
  }
  if (modelAsset.owner !== undefined) {
    evidence.push(
      createEvidence({
        kind: "OWNER",
        sourceUrn: canonicalFraudModelUrn,
        targetUrn: canonicalRiskOwnerUrn,
        title: "Risk ML owner",
        summary: "Risk ML owns Fraud Model v3.",
        criticality: "HIGH",
        relatedEvidenceIds: [model.id],
        provenance: [provenance(observations.modelDetails, "OWNER")],
        payload: {
          assetUrn: canonicalFraudModelUrn,
          ownerUrn: canonicalRiskOwnerUrn,
          displayName: modelAsset.owner.displayName,
          ownershipType: modelAsset.owner.ownershipType,
        },
      }),
    );
  }
  evidence.sort((left, right) => left.id.localeCompare(right.id));
  const contextData = {
    changeId: input.changeId,
    datasetUrn: canonicalDatasetUrn,
    fieldPath: canonicalFieldPath,
    collectionOrigin: { mode: "LIVE" as const },
    resolution,
    collectedAt: input.collectedAt,
    collectionStatus: "COMPLETE" as const,
    evidence,
    failures: [],
  } satisfies ImpactContextData;
  const context = impactContextSchema.parse({
    ...contextData,
    impactContextFingerprint: computeImpactContextFingerprint(contextData),
    collectionFingerprint: computeImpactCollectionFingerprint(contextData),
  });
  return impactCollectionResultSchema.parse({ outcome: "COLLECTED_LIVE", context });
}
