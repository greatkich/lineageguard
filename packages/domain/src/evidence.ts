import { z } from "zod";
import { sha256, stableId } from "./hash.js";

const urnSchema = z.string().min(8).max(1_000).startsWith("urn:li:");
const isoDateTimeSchema = z.iso.datetime({ offset: true });
const evidenceIdSchema = z.string().regex(/^ev_[a-f0-9]{24}$/);
const fingerprintSchema = z.string().regex(/^[a-f0-9]{64}$/);

export const canonicalDatasetUrn =
  "urn:li:dataset:(urn:li:dataPlatform:postgres,lineageguard-canonical.lineageguard.commerce.orders,PROD)";
export const canonicalFieldPath = "commerce.orders.customer_id";
export const canonicalNativeFieldPath = "customer_id";
export const canonicalSchemaFieldUrn = `urn:li:schemaField:(${canonicalDatasetUrn},${canonicalNativeFieldPath})`;
export const canonicalAnalyticsStagingUrn =
  "urn:li:dataset:(urn:li:dataPlatform:postgres,lineageguard-canonical.lineageguard.analytics.stg_orders,PROD)";
export const canonicalAnalyticsRevenueUrn =
  "urn:li:dataset:(urn:li:dataPlatform:postgres,lineageguard-canonical.lineageguard.analytics.customer_revenue,PROD)";
export const canonicalFraudFeaturesUrn =
  "urn:li:dataset:(urn:li:dataPlatform:postgres,lineageguard-canonical.lineageguard.fraud.customer_features,PROD)";
export const canonicalDashboardUrn =
  "urn:li:dashboard:(looker,lineageguard-canonical.finance-revenue-dashboard)";
export const canonicalFraudModelUrn =
  "urn:li:mlModel:(urn:li:dataPlatform:mlflow,lineageguard-canonical.fraud-model-v3,PROD)";
export const canonicalFinanceOwnerUrn = "urn:li:corpGroup:lineageguard-canonical.finance-analytics";
export const canonicalRiskOwnerUrn = "urn:li:corpGroup:lineageguard-canonical.risk-ml";
export const canonicalCriticalTagUrn = "urn:li:tag:lineageguard-canonical.Critical";
export const canonicalProductionTagUrn = "urn:li:tag:lineageguard-canonical.Production";
export const canonicalGlossaryTermUrn =
  "urn:li:glossaryTerm:lineageguard-canonical.CustomerIdentifier";
export const canonicalQueryUrn =
  "urn:li:query:lineageguard-canonical.system.e4bbe7075754d05de68f76ff0a9b127532e044da8ab0a357bce7e0d41f7ad22c";
export const canonicalQuerySubjectFieldUrn = `urn:li:schemaField:(${canonicalAnalyticsRevenueUrn},${canonicalNativeFieldPath})`;
export const canonicalQueryStatementFingerprint =
  "64e7b3dc02cac7ee25acb65562fa7c075f08abc48310bf8dd16d0c9f6ef45638";

const canonicalDashboardPath = {
  nodes: [
    canonicalDatasetUrn,
    canonicalAnalyticsStagingUrn,
    canonicalAnalyticsRevenueUrn,
    canonicalDashboardUrn,
  ],
  segments: [
    {
      granularity: "FIELD",
      sourceUrn: canonicalDatasetUrn,
      targetUrn: canonicalAnalyticsStagingUrn,
      sourceFieldPath: canonicalNativeFieldPath,
      targetFieldPath: canonicalNativeFieldPath,
    },
    {
      granularity: "FIELD",
      sourceUrn: canonicalAnalyticsStagingUrn,
      targetUrn: canonicalAnalyticsRevenueUrn,
      sourceFieldPath: canonicalNativeFieldPath,
      targetFieldPath: canonicalNativeFieldPath,
    },
    {
      granularity: "ENTITY",
      sourceUrn: canonicalAnalyticsRevenueUrn,
      targetUrn: canonicalDashboardUrn,
    },
  ],
} as const;

const canonicalModelPath = {
  nodes: [
    canonicalDatasetUrn,
    canonicalAnalyticsStagingUrn,
    canonicalFraudFeaturesUrn,
    canonicalFraudModelUrn,
  ],
  segments: [
    {
      granularity: "FIELD",
      sourceUrn: canonicalDatasetUrn,
      targetUrn: canonicalAnalyticsStagingUrn,
      sourceFieldPath: canonicalNativeFieldPath,
      targetFieldPath: canonicalNativeFieldPath,
    },
    {
      granularity: "FIELD",
      sourceUrn: canonicalAnalyticsStagingUrn,
      targetUrn: canonicalFraudFeaturesUrn,
      sourceFieldPath: canonicalNativeFieldPath,
      targetFieldPath: canonicalNativeFieldPath,
    },
    {
      granularity: "ENTITY",
      sourceUrn: canonicalFraudFeaturesUrn,
      targetUrn: canonicalFraudModelUrn,
    },
  ],
} as const;

export const canonicalImpactRequestSchema = z
  .object({
    platform: z.literal("postgres"),
    platformInstance: z.literal("lineageguard-canonical"),
    environment: z.literal("PROD"),
    database: z.literal("lineageguard"),
    schema: z.literal("commerce"),
    dataset: z.literal("orders"),
    field: z.literal("customer_id"),
  })
  .strict();
export type CanonicalImpactRequest = z.infer<typeof canonicalImpactRequestSchema>;

export const canonicalImpactRequest: CanonicalImpactRequest = Object.freeze({
  platform: "postgres",
  platformInstance: "lineageguard-canonical",
  environment: "PROD",
  database: "lineageguard",
  schema: "commerce",
  dataset: "orders",
  field: "customer_id",
});

export const criticalitySchema = z.enum(["LOW", "MEDIUM", "HIGH", "CRITICAL"]);
export type Criticality = z.infer<typeof criticalitySchema>;

export const impactCollectionOriginSchema = z.discriminatedUnion("mode", [
  z.object({ mode: z.literal("LIVE") }).strict(),
  z
    .object({
      mode: z.literal("VERIFIED_REPLAY"),
      manifestFingerprint: fingerprintSchema,
      sourceLiveCollectionFingerprint: fingerprintSchema,
      sourceImpactContextFingerprint: fingerprintSchema,
    })
    .strict(),
]);
export type ImpactCollectionOrigin = z.infer<typeof impactCollectionOriginSchema>;

export const evidenceProvenanceSchema = z
  .object({
    source: z.literal("DATAHUB_MCP"),
    role: z.enum([
      "RESOLUTION",
      "SCHEMA",
      "LINEAGE_DISCOVERY",
      "FIELD_PATH",
      "ENTITY_PATH",
      "ENTITY_DETAILS",
      "QUERY_DISCOVERY",
      "QUERY_DETAILS",
      "OWNER",
      "GLOSSARY_BINDING",
      "GLOSSARY_DETAILS",
    ]),
    tool: z.enum([
      "search",
      "get_entities",
      "list_schema_fields",
      "get_lineage",
      "get_lineage_paths_between",
      "get_dataset_queries",
    ]),
    invocationId: z.string().min(1).max(160),
    retrievedAt: isoDateTimeSchema,
    responseFingerprint: fingerprintSchema,
  })
  .strict();

export const impactResolutionSchema = z
  .object({
    requested: canonicalImpactRequestSchema,
    datasetUrn: z.literal(canonicalDatasetUrn),
    schemaFieldUrn: z.literal(canonicalSchemaFieldUrn),
    nativeFieldPath: z.literal(canonicalNativeFieldPath),
    provenance: z
      .array(
        evidenceProvenanceSchema
          .extend({ tool: z.literal("search"), role: z.literal("RESOLUTION") })
          .strict(),
      )
      .min(1)
      .max(8),
  })
  .strict();
export type ImpactResolution = z.infer<typeof impactResolutionSchema>;

const baseEvidenceShape = {
  id: evidenceIdSchema,
  fingerprint: fingerprintSchema,
  sourceUrn: urnSchema,
  targetUrn: urnSchema.optional(),
  fieldPath: z.string().min(1).max(500).optional(),
  title: z.string().min(1).max(240),
  summary: z.string().min(1).max(1_000),
  criticality: criticalitySchema,
  provenance: z.array(evidenceProvenanceSchema).min(1).max(8),
  relatedEvidenceIds: z.array(evidenceIdSchema).max(20),
};

const schemaEvidenceSchema = z
  .object({
    ...baseEvidenceShape,
    kind: z.literal("SCHEMA"),
    payload: z
      .object({
        schemaFieldUrn: urnSchema,
        nativeFieldPath: z.string().min(1).max(500),
        nativeType: z.string().min(1).max(80),
        nullable: z.boolean(),
      })
      .strict(),
  })
  .strict();

const fieldLineageSegmentSchema = z
  .object({
    granularity: z.literal("FIELD"),
    sourceUrn: urnSchema,
    targetUrn: urnSchema,
    sourceFieldPath: z.string().min(1).max(500),
    targetFieldPath: z.string().min(1).max(500),
  })
  .strict();
const entityLineageSegmentSchema = z
  .object({
    granularity: z.literal("ENTITY"),
    sourceUrn: urnSchema,
    targetUrn: urnSchema,
  })
  .strict();
export const lineageSegmentSchema = z.discriminatedUnion("granularity", [
  fieldLineageSegmentSchema,
  entityLineageSegmentSchema,
]);

const lineagePathEvidenceSchema = z
  .object({
    ...baseEvidenceShape,
    kind: z.literal("LINEAGE_PATH"),
    payload: z
      .object({
        direction: z.literal("DOWNSTREAM"),
        nodes: z.array(urnSchema).min(2).max(20),
        segments: z.array(lineageSegmentSchema).min(1).max(19),
        fieldLevel: z.literal(true),
      })
      .strict(),
  })
  .strict();

const dashboardEvidenceSchema = z
  .object({
    ...baseEvidenceShape,
    kind: z.literal("DASHBOARD"),
    payload: z
      .object({
        dashboardUrn: urnSchema,
        platform: z.string().min(1).max(80),
        lifecycle: z.enum(["DEVELOPMENT", "PRODUCTION", "RETIRED"]),
        classificationUrns: z.array(urnSchema).min(1).max(20),
        ownershipObserved: z.literal(true),
        ownerUrns: z.array(urnSchema).max(20),
        downstreamDatasetUrn: urnSchema,
        downstreamField: z.string().min(1).max(500),
      })
      .strict(),
  })
  .strict();

const modelEvidenceSchema = z
  .object({
    ...baseEvidenceShape,
    kind: z.literal("ML_MODEL"),
    payload: z
      .object({
        modelUrn: urnSchema,
        lifecycle: z.enum(["DEVELOPMENT", "PRODUCTION", "RETIRED"]),
        classificationUrns: z.array(urnSchema).min(1).max(20),
        ownershipObserved: z.literal(true),
        ownerUrns: z.array(urnSchema).max(20),
        featureDatasetUrn: urnSchema,
        featureField: z.string().min(1).max(500),
      })
      .strict(),
  })
  .strict();

const queryEvidenceSchema = z
  .object({
    ...baseEvidenceShape,
    kind: z.literal("QUERY_USAGE"),
    payload: z
      .object({
        queryUrn: urnSchema,
        source: z.literal("SYSTEM"),
        observationBasis: z.literal("DATAHUB_QUERY_ENTITY"),
        subjectDatasetUrn: urnSchema,
        subjectSchemaFieldUrn: urnSchema,
        subjectFieldPath: z.string().min(1).max(500),
        normalizedStatementFingerprint: fingerprintSchema,
      })
      .strict(),
  })
  .strict();

const ownerEvidenceSchema = z
  .object({
    ...baseEvidenceShape,
    kind: z.literal("OWNER"),
    payload: z
      .object({
        assetUrn: urnSchema,
        ownerUrn: urnSchema,
        displayName: z.string().min(1).max(240),
        ownershipType: z.enum(["TECHNICAL_OWNER", "BUSINESS_OWNER"]),
      })
      .strict(),
  })
  .strict();

const glossaryEvidenceSchema = z
  .object({
    ...baseEvidenceShape,
    kind: z.literal("GLOSSARY_TERM"),
    payload: z
      .object({
        termUrn: urnSchema,
        name: z.string().min(1).max(240),
        schemaFieldUrn: urnSchema,
        fieldPath: z.string().min(1).max(500),
      })
      .strict(),
  })
  .strict();

const evidenceUnionSchema = z.discriminatedUnion("kind", [
  schemaEvidenceSchema,
  lineagePathEvidenceSchema,
  dashboardEvidenceSchema,
  modelEvidenceSchema,
  queryEvidenceSchema,
  ownerEvidenceSchema,
  glossaryEvidenceSchema,
]);

export type EvidenceItem = z.infer<typeof evidenceUnionSchema>;
export type EvidenceKind = EvidenceItem["kind"];

function normalizedEvidenceIdentity(item: Omit<EvidenceItem, "fingerprint" | "id">) {
  const semanticProvenance = item.provenance.reduce<
    Array<Pick<z.infer<typeof evidenceProvenanceSchema>, "source" | "tool" | "role">>
  >((steps, entry) => {
    const previous = steps.at(-1);
    if (
      !previous ||
      previous.source !== entry.source ||
      previous.tool !== entry.tool ||
      previous.role !== entry.role
    ) {
      steps.push({ source: entry.source, tool: entry.tool, role: entry.role });
    }
    return steps;
  }, []);
  return {
    kind: item.kind,
    sourceUrn: item.sourceUrn,
    targetUrn: item.targetUrn ?? null,
    fieldPath: item.fieldPath ?? null,
    title: item.title,
    summary: item.summary,
    criticality: item.criticality,
    payload: item.payload,
    relatedEvidenceIds: [...item.relatedEvidenceIds].sort(),
    provenance: semanticProvenance,
  };
}

export const evidenceItemSchema = evidenceUnionSchema.superRefine((item, refinement) => {
  const identity = normalizedEvidenceIdentity(item);
  const fingerprint = sha256(identity);
  if (item.fingerprint !== fingerprint) {
    refinement.addIssue({
      code: "custom",
      message: "Evidence fingerprint is invalid",
      path: ["fingerprint"],
    });
  }
  if (item.id !== stableId("ev", identity)) {
    refinement.addIssue({ code: "custom", message: "Evidence ID is invalid", path: ["id"] });
  }
});

export const impactCollectionFailureSchema = z
  .object({
    tool: evidenceProvenanceSchema.shape.tool,
    invocationId: z.string().min(1).max(160),
    code: z.enum([
      "TIMEOUT",
      "NOT_FOUND",
      "AMBIGUOUS",
      "MALFORMED_RESPONSE",
      "UNAVAILABLE",
      "TOOL_MISSING",
      "POLICY_VIOLATION",
      "RESPONSE_LIMIT",
      "PAGINATION_LIMIT",
      "CURSOR_CYCLE",
      "TERMINATED",
      "SCHEMA_DRIFT",
    ]),
    message: z.string().min(1).max(500),
  })
  .strict();

export const impactCollectionFailureReportSchema = z
  .object({
    failureFingerprint: fingerprintSchema,
    requested: canonicalImpactRequestSchema,
    failedAt: isoDateTimeSchema,
    failures: z.array(impactCollectionFailureSchema).min(1).max(20),
  })
  .strict()
  .superRefine((report, refinement) => {
    const invocationIds = report.failures.map((failure) => failure.invocationId);
    if (new Set(invocationIds).size !== invocationIds.length) {
      issue(refinement, "Collection failure invocation IDs must be unique", ["failures"]);
    }
    const keys = report.failures.map(
      (failure) =>
        `${failure.tool}\u0000${failure.invocationId}\u0000${failure.code}\u0000${failure.message}`,
    );
    const sortedKeys = [...keys].sort();
    if (keys.some((key, index) => key !== sortedKeys[index])) {
      issue(refinement, "Collection failures must be canonically ordered", ["failures"]);
    }
    const { failureFingerprint, ...identity } = report;
    if (failureFingerprint !== sha256(identity)) {
      issue(refinement, "Collection failure fingerprint is invalid", ["failureFingerprint"]);
    }
  });
export type ImpactCollectionFailureReport = z.infer<typeof impactCollectionFailureReportSchema>;

export function computeImpactCollectionFailureFingerprint(
  report: Omit<ImpactCollectionFailureReport, "failureFingerprint">,
): string {
  return sha256(report);
}

export function createImpactCollectionFailureReport(
  report: Omit<ImpactCollectionFailureReport, "failureFingerprint">,
): ImpactCollectionFailureReport {
  return impactCollectionFailureReportSchema.parse({
    ...report,
    failureFingerprint: computeImpactCollectionFailureFingerprint(report),
  });
}

function issue(refinement: z.RefinementCtx, message: string, path: PropertyKey[]): void {
  refinement.addIssue({ code: "custom", message, path });
}

export const impactContextSchema = z
  .object({
    impactContextFingerprint: fingerprintSchema,
    collectionFingerprint: fingerprintSchema,
    changeId: z.string().regex(/^chg_[a-f0-9]{24}$/),
    datasetUrn: z.literal(canonicalDatasetUrn),
    fieldPath: z.literal(canonicalFieldPath),
    collectionOrigin: impactCollectionOriginSchema,
    resolution: impactResolutionSchema,
    collectedAt: isoDateTimeSchema,
    collectionStatus: z.enum(["COMPLETE", "PARTIAL"]),
    evidence: z.array(evidenceItemSchema).max(200),
    failures: z.array(impactCollectionFailureSchema).max(20),
  })
  .strict()
  .superRefine((context, refinement) => {
    const { impactContextFingerprint, collectionFingerprint, ...contextData } = context;
    if (impactContextFingerprint !== computeImpactContextFingerprint(contextData)) {
      issue(refinement, "Impact context fingerprint is invalid", ["impactContextFingerprint"]);
    }
    if (collectionFingerprint !== computeImpactCollectionFingerprint(contextData)) {
      issue(refinement, "Impact collection fingerprint is invalid", ["collectionFingerprint"]);
    }
    if (
      context.collectionOrigin.mode === "VERIFIED_REPLAY" &&
      context.collectionOrigin.sourceImpactContextFingerprint !== impactContextFingerprint
    ) {
      issue(refinement, "Replay manifest is not bound to the preserved semantic context", [
        "collectionOrigin",
        "sourceImpactContextFingerprint",
      ]);
    }
    if (
      context.resolution.datasetUrn !== context.datasetUrn ||
      JSON.stringify(context.resolution.requested) !== JSON.stringify(canonicalImpactRequest)
    ) {
      issue(refinement, "Resolution does not match the canonical request and dataset", [
        "resolution",
      ]);
    }
    const collectedTime = new Date(context.collectedAt).getTime();
    let resolutionTime = Number.NEGATIVE_INFINITY;
    const resolutionInvocationKeys = context.resolution.provenance.map(
      (entry) => `${entry.tool}\u0000${entry.invocationId}`,
    );
    if (new Set(resolutionInvocationKeys).size !== resolutionInvocationKeys.length) {
      issue(refinement, "Resolution provenance entries must be unique", [
        "resolution",
        "provenance",
      ]);
    }
    for (const [provenanceIndex, entry] of context.resolution.provenance.entries()) {
      const retrievalTime = new Date(entry.retrievedAt).getTime();
      if (retrievalTime < resolutionTime) {
        issue(refinement, "Resolution provenance must follow pagination chronology", [
          "resolution",
          "provenance",
          provenanceIndex,
          "retrievedAt",
        ]);
      }
      if (retrievalTime > collectedTime) {
        issue(refinement, "Resolution cannot be retrieved after context collection", [
          "resolution",
          "provenance",
          provenanceIndex,
          "retrievedAt",
        ]);
      }
      resolutionTime = retrievalTime;
    }
    const sortedEvidenceIds = context.evidence.map((item) => item.id).sort();
    if (context.evidence.some((item, index) => item.id !== sortedEvidenceIds[index])) {
      issue(refinement, "Evidence must use canonical ID order", ["evidence"]);
    }
    const failureKeys = context.failures.map(
      (failure) =>
        `${failure.tool}\u0000${failure.invocationId}\u0000${failure.code}\u0000${failure.message}`,
    );
    const failureInvocationIds = context.failures.map((failure) => failure.invocationId);
    if (new Set(failureInvocationIds).size !== failureInvocationIds.length) {
      issue(refinement, "Collection failure invocation IDs must be unique", ["failures"]);
    }
    const sortedFailureKeys = [...failureKeys].sort();
    if (failureKeys.some((key, index) => key !== sortedFailureKeys[index])) {
      issue(refinement, "Collection failures must use canonical order", ["failures"]);
    }
    const byId = new Map(context.evidence.map((item) => [item.id, item]));
    if (byId.size !== context.evidence.length) {
      issue(refinement, "Evidence IDs must be unique", ["evidence"]);
    }

    const invocationIdentity = new Map<
      string,
      Pick<
        z.infer<typeof evidenceProvenanceSchema>,
        "source" | "tool" | "retrievedAt" | "responseFingerprint"
      >
    >();
    for (const entry of context.resolution.provenance) {
      invocationIdentity.set(entry.invocationId, {
        source: entry.source,
        tool: entry.tool,
        retrievedAt: entry.retrievedAt,
        responseFingerprint: entry.responseFingerprint,
      });
    }

    for (const [index, item] of context.evidence.entries()) {
      const invocationIds = item.provenance.map((entry) => entry.invocationId);
      if (new Set(invocationIds).size !== invocationIds.length) {
        issue(refinement, "Evidence provenance invocation IDs must be unique", [
          "evidence",
          index,
          "provenance",
        ]);
      }
      let previousRetrievalTime = resolutionTime;
      for (const [provenanceIndex, entry] of item.provenance.entries()) {
        const retrievalTime = new Date(entry.retrievedAt).getTime();
        if (retrievalTime > collectedTime) {
          issue(refinement, "Evidence cannot be retrieved after context collection", [
            "evidence",
            index,
            "provenance",
            provenanceIndex,
            "retrievedAt",
          ]);
        }
        if (retrievalTime < previousRetrievalTime) {
          issue(refinement, "Evidence provenance must follow collection chronology", [
            "evidence",
            index,
            "provenance",
            provenanceIndex,
            "retrievedAt",
          ]);
        }
        previousRetrievalTime = retrievalTime;

        const identity = {
          source: entry.source,
          tool: entry.tool,
          retrievedAt: entry.retrievedAt,
          responseFingerprint: entry.responseFingerprint,
        };
        const existingIdentity = invocationIdentity.get(entry.invocationId);
        if (
          existingIdentity &&
          (existingIdentity.source !== identity.source ||
            existingIdentity.tool !== identity.tool ||
            existingIdentity.retrievedAt !== identity.retrievedAt ||
            existingIdentity.responseFingerprint !== identity.responseFingerprint)
        ) {
          issue(refinement, "Invocation ID has contradictory raw-response provenance", [
            "evidence",
            index,
            "provenance",
            provenanceIndex,
            "invocationId",
          ]);
        } else {
          invocationIdentity.set(entry.invocationId, identity);
        }
      }
      const actualProvenance = item.provenance.map((entry) => `${entry.role}:${entry.tool}`);
      const matchesRepeatedPrefix = (prefix: string, suffix: readonly string[] = []) => {
        const prefixLength = actualProvenance.length - suffix.length;
        return (
          prefixLength >= 1 &&
          actualProvenance.slice(0, prefixLength).every((step) => step === prefix) &&
          suffix.every((step, suffixIndex) => step === actualProvenance[prefixLength + suffixIndex])
        );
      };
      const matchesExact = (...steps: string[]) =>
        steps.length === actualProvenance.length &&
        steps.every((step, index) => step === actualProvenance[index]);
      const provenanceMatches =
        item.kind === "SCHEMA"
          ? matchesRepeatedPrefix("SCHEMA:list_schema_fields")
          : item.kind === "LINEAGE_PATH"
            ? matchesRepeatedPrefix("LINEAGE_DISCOVERY:get_lineage", [
                "FIELD_PATH:get_lineage_paths_between",
                "ENTITY_PATH:get_lineage_paths_between",
              ])
            : item.kind === "DASHBOARD" || item.kind === "ML_MODEL"
              ? matchesExact("ENTITY_DETAILS:get_entities")
              : item.kind === "QUERY_USAGE"
                ? matchesRepeatedPrefix("QUERY_DISCOVERY:get_dataset_queries", [
                    "QUERY_DETAILS:get_entities",
                  ])
                : item.kind === "OWNER"
                  ? matchesExact("OWNER:get_entities")
                  : matchesRepeatedPrefix("GLOSSARY_BINDING:list_schema_fields", [
                      "GLOSSARY_DETAILS:get_entities",
                    ]);
      if (!provenanceMatches) {
        issue(refinement, "Evidence provenance does not match its semantic collection steps", [
          "evidence",
          index,
          "provenance",
        ]);
      }
      const sortedRelated = [...item.relatedEvidenceIds].sort();
      if (item.relatedEvidenceIds.some((id, relatedIndex) => id !== sortedRelated[relatedIndex])) {
        issue(refinement, "Related evidence IDs must use canonical order", [
          "evidence",
          index,
          "relatedEvidenceIds",
        ]);
      }
      for (const relatedId of item.relatedEvidenceIds) {
        if (!byId.has(relatedId)) {
          issue(refinement, `Dangling related evidence id: ${relatedId}`, [
            "evidence",
            index,
            "relatedEvidenceIds",
          ]);
        }
      }

      if (item.kind !== "OWNER") {
        if (item.sourceUrn !== context.datasetUrn || item.fieldPath !== context.fieldPath) {
          issue(refinement, "Evidence is not bound to the requested dataset field", [
            "evidence",
            index,
          ]);
        }
      }

      if (item.kind === "SCHEMA") {
        if (
          item.targetUrn ||
          item.relatedEvidenceIds.length > 0 ||
          item.payload.schemaFieldUrn !== context.resolution.schemaFieldUrn ||
          item.payload.nativeFieldPath !== context.resolution.nativeFieldPath
        ) {
          issue(refinement, "Schema evidence does not match the resolved source field", [
            "evidence",
            index,
          ]);
        }
      }
      if (item.kind === "LINEAGE_PATH") {
        const segmentsMatchNodes = item.payload.segments.every(
          (segment, segmentIndex) =>
            segment.sourceUrn === item.payload.nodes[segmentIndex] &&
            segment.targetUrn === item.payload.nodes[segmentIndex + 1],
        );
        const firstField = item.payload.segments.find((segment) => segment.granularity === "FIELD");
        const firstEntityIndex = item.payload.segments.findIndex(
          (segment) => segment.granularity === "ENTITY",
        );
        const fieldAfterEntity = item.payload.segments.some(
          (segment, segmentIndex) =>
            firstEntityIndex >= 0 &&
            segmentIndex > firstEntityIndex &&
            segment.granularity === "FIELD",
        );
        if (
          item.payload.nodes[0] !== context.datasetUrn ||
          item.payload.nodes.at(-1) !== item.targetUrn ||
          item.payload.nodes.length !== item.payload.segments.length + 1 ||
          !segmentsMatchNodes ||
          !firstField ||
          firstField.sourceUrn !== context.datasetUrn ||
          firstField.sourceFieldPath !== context.resolution.nativeFieldPath ||
          fieldAfterEntity
        ) {
          issue(refinement, "Lineage path segments do not prove the resolved downstream path", [
            "evidence",
            index,
          ]);
        }
      }
      if (item.kind === "DASHBOARD") {
        const relatedPaths = item.relatedEvidenceIds
          .map((id) => byId.get(id))
          .filter((related) => related?.kind === "LINEAGE_PATH");
        const classifications = item.payload.classificationUrns;
        const ownerUrns = item.payload.ownerUrns;
        if (
          item.targetUrn !== item.payload.dashboardUrn ||
          item.payload.lifecycle !== "PRODUCTION" ||
          new Set(classifications).size !== classifications.length ||
          classifications.some(
            (classification, classificationIndex) =>
              classification !== [...classifications].sort()[classificationIndex],
          ) ||
          !classifications.includes(canonicalCriticalTagUrn) ||
          !classifications.includes(canonicalProductionTagUrn) ||
          new Set(ownerUrns).size !== ownerUrns.length ||
          ownerUrns.some(
            (ownerUrn, ownerIndex) => ownerUrn !== [...ownerUrns].sort()[ownerIndex],
          ) ||
          !item.payload.downstreamField.endsWith(".customer_id") ||
          !relatedPaths.some(
            (path) =>
              path?.targetUrn === item.payload.dashboardUrn &&
              path.payload.segments.some(
                (segment) =>
                  segment.granularity === "FIELD" &&
                  segment.targetUrn === item.payload.downstreamDatasetUrn &&
                  segment.targetFieldPath === canonicalNativeFieldPath,
              ) &&
              path.payload.segments.some(
                (segment) =>
                  segment.granularity === "ENTITY" &&
                  segment.sourceUrn === item.payload.downstreamDatasetUrn &&
                  segment.targetUrn === item.payload.dashboardUrn,
              ),
          )
        ) {
          issue(refinement, "Dashboard evidence is not linked to a matching field lineage path", [
            "evidence",
            index,
          ]);
        }
      }
      if (item.kind === "ML_MODEL") {
        const relatedPaths = item.relatedEvidenceIds
          .map((id) => byId.get(id))
          .filter((related) => related?.kind === "LINEAGE_PATH");
        const classifications = item.payload.classificationUrns;
        const ownerUrns = item.payload.ownerUrns;
        if (
          item.targetUrn !== item.payload.modelUrn ||
          item.payload.lifecycle !== "PRODUCTION" ||
          new Set(classifications).size !== classifications.length ||
          classifications.some(
            (classification, classificationIndex) =>
              classification !== [...classifications].sort()[classificationIndex],
          ) ||
          !classifications.includes(canonicalCriticalTagUrn) ||
          !classifications.includes(canonicalProductionTagUrn) ||
          new Set(ownerUrns).size !== ownerUrns.length ||
          ownerUrns.some(
            (ownerUrn, ownerIndex) => ownerUrn !== [...ownerUrns].sort()[ownerIndex],
          ) ||
          !item.payload.featureField.endsWith(".customer_id") ||
          !relatedPaths.some(
            (path) =>
              path?.targetUrn === item.payload.modelUrn &&
              path.payload.segments.some(
                (segment) =>
                  segment.granularity === "FIELD" &&
                  segment.targetUrn === item.payload.featureDatasetUrn &&
                  segment.targetFieldPath === canonicalNativeFieldPath,
              ) &&
              path.payload.segments.some(
                (segment) =>
                  segment.granularity === "ENTITY" &&
                  segment.sourceUrn === item.payload.featureDatasetUrn &&
                  segment.targetUrn === item.payload.modelUrn,
              ),
          )
        ) {
          issue(refinement, "ML model evidence is not linked to a matching field lineage path", [
            "evidence",
            index,
          ]);
        }
      }
      if (item.kind === "QUERY_USAGE") {
        const relatedPaths = item.relatedEvidenceIds
          .map((id) => byId.get(id))
          .filter((related) => related?.kind === "LINEAGE_PATH");
        if (
          item.targetUrn !== item.payload.queryUrn ||
          item.payload.subjectSchemaFieldUrn !==
            `urn:li:schemaField:(${item.payload.subjectDatasetUrn},${item.payload.subjectFieldPath})` ||
          !relatedPaths.some((path) =>
            path?.payload.segments.some(
              (segment) =>
                segment.granularity === "FIELD" &&
                segment.targetUrn === item.payload.subjectDatasetUrn &&
                segment.targetFieldPath === item.payload.subjectFieldPath,
            ),
          )
        ) {
          issue(refinement, "Query evidence does not match its DataHub query subject", [
            "evidence",
            index,
          ]);
        }
      }
      if (item.kind === "GLOSSARY_TERM") {
        if (
          item.targetUrn !== item.payload.termUrn ||
          item.payload.schemaFieldUrn !== context.resolution.schemaFieldUrn ||
          item.payload.fieldPath !== context.fieldPath
        ) {
          issue(refinement, "Glossary evidence does not match the requested field", [
            "evidence",
            index,
          ]);
        }
      }
      if (item.kind === "OWNER") {
        const relatedAssets = item.relatedEvidenceIds.map((id) => byId.get(id));
        const ownsRelatedAsset = relatedAssets.some(
          (related) =>
            (related?.kind === "DASHBOARD" &&
              related.payload.dashboardUrn === item.payload.assetUrn &&
              related.payload.ownerUrns.includes(item.payload.ownerUrn)) ||
            (related?.kind === "ML_MODEL" &&
              related.payload.modelUrn === item.payload.assetUrn &&
              related.payload.ownerUrns.includes(item.payload.ownerUrn)),
        );
        if (
          item.sourceUrn !== item.payload.assetUrn ||
          item.targetUrn !== item.payload.ownerUrn ||
          !ownsRelatedAsset
        ) {
          issue(refinement, "Owner evidence does not match its related critical asset", [
            "evidence",
            index,
          ]);
        }
      }
    }

    if (context.collectionStatus === "COMPLETE") {
      if (context.failures.length > 0)
        issue(refinement, "Complete context cannot contain failures", ["failures"]);
      const schemas = context.evidence.filter((item) => item.kind === "SCHEMA");
      const paths = context.evidence.filter((item) => item.kind === "LINEAGE_PATH");
      const dashboards = context.evidence.filter((item) => item.kind === "DASHBOARD");
      const models = context.evidence.filter((item) => item.kind === "ML_MODEL");
      const queries = context.evidence.filter((item) => item.kind === "QUERY_USAGE");
      const glossaries = context.evidence.filter((item) => item.kind === "GLOSSARY_TERM");
      const owners = context.evidence.filter((item) => item.kind === "OWNER");
      const dashboardPath = paths.find((path) => path.targetUrn === canonicalDashboardUrn);
      const modelPath = paths.find((path) => path.targetUrn === canonicalFraudModelUrn);
      const ownerKeys = new Set(
        owners.map((owner) => `${owner.payload.assetUrn}\u0000${owner.payload.ownerUrn}`),
      );
      const declaredOwnerKeys = new Set([
        ...(dashboards[0]?.payload.ownerUrns ?? []).map(
          (ownerUrn) => `${canonicalDashboardUrn}\u0000${ownerUrn}`,
        ),
        ...(models[0]?.payload.ownerUrns ?? []).map(
          (ownerUrn) => `${canonicalFraudModelUrn}\u0000${ownerUrn}`,
        ),
      ]);
      if (
        schemas.length !== 1 ||
        schemas[0]?.payload.schemaFieldUrn !== canonicalSchemaFieldUrn ||
        schemas[0]?.payload.nativeFieldPath !== canonicalNativeFieldPath ||
        schemas[0]?.payload.nativeType !== "bigint" ||
        schemas[0]?.payload.nullable !== false ||
        paths.length !== 2 ||
        !dashboardPath ||
        JSON.stringify(dashboardPath.payload.nodes) !==
          JSON.stringify(canonicalDashboardPath.nodes) ||
        JSON.stringify(dashboardPath.payload.segments) !==
          JSON.stringify(canonicalDashboardPath.segments) ||
        !modelPath ||
        JSON.stringify(modelPath.payload.nodes) !== JSON.stringify(canonicalModelPath.nodes) ||
        JSON.stringify(modelPath.payload.segments) !==
          JSON.stringify(canonicalModelPath.segments) ||
        dashboards.length !== 1 ||
        dashboards[0]?.payload.dashboardUrn !== canonicalDashboardUrn ||
        dashboards[0]?.payload.downstreamDatasetUrn !== canonicalAnalyticsRevenueUrn ||
        dashboards[0]?.payload.downstreamField !== "analytics.customer_revenue.customer_id" ||
        dashboards[0]?.payload.platform !== "looker" ||
        JSON.stringify(dashboards[0]?.payload.classificationUrns) !==
          JSON.stringify([canonicalCriticalTagUrn, canonicalProductionTagUrn].sort()) ||
        ![JSON.stringify([]), JSON.stringify([canonicalFinanceOwnerUrn])].includes(
          JSON.stringify(dashboards[0]?.payload.ownerUrns),
        ) ||
        dashboards[0]?.criticality !== "CRITICAL" ||
        models.length !== 1 ||
        models[0]?.payload.modelUrn !== canonicalFraudModelUrn ||
        models[0]?.payload.featureDatasetUrn !== canonicalFraudFeaturesUrn ||
        models[0]?.payload.featureField !== "fraud.customer_features.customer_id" ||
        models[0]?.payload.lifecycle !== "PRODUCTION" ||
        JSON.stringify(models[0]?.payload.classificationUrns) !==
          JSON.stringify([canonicalCriticalTagUrn, canonicalProductionTagUrn].sort()) ||
        ![JSON.stringify([]), JSON.stringify([canonicalRiskOwnerUrn])].includes(
          JSON.stringify(models[0]?.payload.ownerUrns),
        ) ||
        models[0]?.criticality !== "CRITICAL" ||
        queries.length !== 1 ||
        queries[0]?.payload.queryUrn !== canonicalQueryUrn ||
        queries[0]?.payload.subjectDatasetUrn !== canonicalAnalyticsRevenueUrn ||
        queries[0]?.payload.subjectSchemaFieldUrn !== canonicalQuerySubjectFieldUrn ||
        queries[0]?.payload.subjectFieldPath !== canonicalNativeFieldPath ||
        queries[0]?.payload.normalizedStatementFingerprint !== canonicalQueryStatementFingerprint ||
        queries[0]?.payload.source !== "SYSTEM" ||
        queries[0]?.payload.observationBasis !== "DATAHUB_QUERY_ENTITY" ||
        queries[0]?.criticality !== "HIGH" ||
        glossaries.length !== 1 ||
        glossaries[0]?.payload.termUrn !== canonicalGlossaryTermUrn ||
        glossaries[0]?.payload.schemaFieldUrn !== canonicalSchemaFieldUrn ||
        glossaries[0]?.payload.name !== "Customer Identifier" ||
        glossaries[0]?.criticality !== "HIGH" ||
        owners.length > 2 ||
        ownerKeys.size !== owners.length ||
        ownerKeys.size !== declaredOwnerKeys.size ||
        [...ownerKeys].some((key) => !declaredOwnerKeys.has(key)) ||
        owners.some(
          (owner) =>
            !(
              (owner.payload.assetUrn === canonicalDashboardUrn &&
                owner.payload.ownerUrn === canonicalFinanceOwnerUrn &&
                owner.payload.displayName === "Finance Analytics") ||
              (owner.payload.assetUrn === canonicalFraudModelUrn &&
                owner.payload.ownerUrn === canonicalRiskOwnerUrn &&
                owner.payload.displayName === "Risk ML")
            ),
        )
      ) {
        issue(refinement, "Complete canonical context is missing required collected evidence", [
          "evidence",
        ]);
      }
    }
    if (context.collectionStatus === "PARTIAL" && context.failures.length === 0) {
      issue(refinement, "Partial context must describe at least one failure", ["failures"]);
    }
    for (const [failureIndex, failure] of context.failures.entries()) {
      if (invocationIdentity.has(failure.invocationId)) {
        issue(refinement, "Invocation ID cannot represent both a response and a failure", [
          "failures",
          failureIndex,
          "invocationId",
        ]);
      }
    }
  });

export type ImpactContext = z.infer<typeof impactContextSchema>;
export type ImpactContextData = Omit<
  ImpactContext,
  "impactContextFingerprint" | "collectionFingerprint"
>;

function impactContextSemanticIdentity(context: ImpactContextData) {
  // Policy identity is mode-independent. The collection fingerprint separately binds LIVE versus
  // VERIFIED_REPLAY provenance and the verified replay-manifest/original-live fingerprints.
  return {
    changeId: context.changeId,
    datasetUrn: context.datasetUrn,
    fieldPath: context.fieldPath,
    resolution: {
      requested: context.resolution.requested,
      datasetUrn: context.resolution.datasetUrn,
      schemaFieldUrn: context.resolution.schemaFieldUrn,
      nativeFieldPath: context.resolution.nativeFieldPath,
    },
    collectionStatus: context.collectionStatus,
    evidence: context.evidence.map((item) => ({ id: item.id, fingerprint: item.fingerprint })),
    failures: context.failures.map((failure) => ({ tool: failure.tool, code: failure.code })),
  };
}

export function computeImpactContextFingerprint(context: ImpactContextData): string {
  return sha256(impactContextSemanticIdentity(context));
}

export function computeImpactCollectionFingerprint(context: ImpactContextData): string {
  return sha256(context);
}

export const impactCollectionResultSchema = z
  .discriminatedUnion("outcome", [
    z.object({ outcome: z.literal("COLLECTED_LIVE"), context: impactContextSchema }).strict(),
    z
      .object({ outcome: z.literal("COLLECTED_VERIFIED_REPLAY"), context: impactContextSchema })
      .strict(),
    z
      .object({
        outcome: z.literal("FAILED"),
        mode: z.enum(["LIVE", "VERIFIED_REPLAY"]),
        report: impactCollectionFailureReportSchema,
      })
      .strict(),
  ])
  .superRefine((result, refinement) => {
    if (result.outcome === "COLLECTED_LIVE" && result.context.collectionOrigin.mode !== "LIVE") {
      issue(refinement, "Live collection result requires live context provenance", ["context"]);
    }
    if (
      result.outcome === "COLLECTED_VERIFIED_REPLAY" &&
      result.context.collectionOrigin.mode !== "VERIFIED_REPLAY"
    ) {
      issue(refinement, "Replay collection result requires verified replay provenance", [
        "context",
      ]);
    }
  });
export type ImpactCollectionResult = z.infer<typeof impactCollectionResultSchema>;

type EvidenceDraftFor<Item extends EvidenceItem> = Omit<Item, "fingerprint" | "id">;
type EvidenceDraft = EvidenceItem extends infer Item
  ? Item extends EvidenceItem
    ? EvidenceDraftFor<Item>
    : never
  : never;

export function createEvidence(draft: EvidenceDraft): EvidenceItem {
  const identity = normalizedEvidenceIdentity(draft);
  return evidenceItemSchema.parse({
    ...draft,
    id: stableId("ev", identity),
    fingerprint: sha256(identity),
  });
}

const retrievedAt = "2026-08-04T08:00:00.000Z";

function provenance(
  role: z.infer<typeof evidenceProvenanceSchema>["role"],
  tool: z.infer<typeof evidenceProvenanceSchema>["tool"],
  invocationId: string,
): z.infer<typeof evidenceProvenanceSchema> {
  return {
    source: "DATAHUB_MCP",
    role,
    tool,
    invocationId,
    retrievedAt,
    responseFingerprint: sha256(`recorded-mcp-response:${invocationId}`),
  };
}

/** Internal deterministic test fixture; intentionally omitted from the package root API. */
export function createCanonicalImpactContextFixture(changeId: string): ImpactContext {
  const resolution = impactResolutionSchema.parse({
    requested: canonicalImpactRequest,
    datasetUrn: canonicalDatasetUrn,
    schemaFieldUrn: canonicalSchemaFieldUrn,
    nativeFieldPath: canonicalNativeFieldPath,
    provenance: [provenance("RESOLUTION", "search", "canonical-resolution")],
  });
  const schema = createEvidence({
    kind: "SCHEMA",
    sourceUrn: canonicalDatasetUrn,
    fieldPath: canonicalFieldPath,
    title: "orders.customer_id schema",
    summary: "The source field is a non-null bigint in PostgreSQL.",
    criticality: "HIGH",
    relatedEvidenceIds: [],
    provenance: [provenance("SCHEMA", "list_schema_fields", "canonical-schema")],
    payload: {
      schemaFieldUrn: canonicalSchemaFieldUrn,
      nativeFieldPath: canonicalNativeFieldPath,
      nativeType: "bigint",
      nullable: false,
    },
  });
  const analyticsPath = createEvidence({
    kind: "LINEAGE_PATH",
    sourceUrn: canonicalDatasetUrn,
    targetUrn: canonicalDashboardUrn,
    fieldPath: canonicalFieldPath,
    title: "Finance dashboard lineage path",
    summary: "customer_id flows through the revenue datasets into the Finance dashboard.",
    criticality: "CRITICAL",
    relatedEvidenceIds: [],
    provenance: [
      provenance("LINEAGE_DISCOVERY", "get_lineage", "canonical-lineage-discovery"),
      provenance("FIELD_PATH", "get_lineage_paths_between", "canonical-lineage-revenue-field"),
      provenance("ENTITY_PATH", "get_lineage_paths_between", "canonical-lineage-revenue-entity"),
    ],
    payload: {
      direction: "DOWNSTREAM",
      fieldLevel: true,
      nodes: [...canonicalDashboardPath.nodes],
      segments: canonicalDashboardPath.segments.map((segment) => ({ ...segment })),
    },
  });
  const dashboard = createEvidence({
    kind: "DASHBOARD",
    sourceUrn: canonicalDatasetUrn,
    targetUrn: canonicalDashboardUrn,
    fieldPath: canonicalFieldPath,
    title: "Finance Revenue Dashboard",
    summary: "A critical Finance dashboard consumes the revenue lineage path.",
    criticality: "CRITICAL",
    relatedEvidenceIds: [analyticsPath.id],
    provenance: [provenance("ENTITY_DETAILS", "get_entities", "canonical-dashboard")],
    payload: {
      dashboardUrn: canonicalDashboardUrn,
      platform: "looker",
      lifecycle: "PRODUCTION",
      classificationUrns: [canonicalCriticalTagUrn, canonicalProductionTagUrn].sort(),
      ownershipObserved: true,
      ownerUrns: [canonicalFinanceOwnerUrn],
      downstreamDatasetUrn: canonicalAnalyticsRevenueUrn,
      downstreamField: "analytics.customer_revenue.customer_id",
    },
  });
  const fraudPath = createEvidence({
    kind: "LINEAGE_PATH",
    sourceUrn: canonicalDatasetUrn,
    targetUrn: canonicalFraudModelUrn,
    fieldPath: canonicalFieldPath,
    title: "Fraud model lineage path",
    summary: "customer_id flows through the fraud feature set into the production model.",
    criticality: "CRITICAL",
    relatedEvidenceIds: [],
    provenance: [
      provenance("LINEAGE_DISCOVERY", "get_lineage", "canonical-lineage-discovery"),
      provenance("FIELD_PATH", "get_lineage_paths_between", "canonical-lineage-fraud-field"),
      provenance("ENTITY_PATH", "get_lineage_paths_between", "canonical-lineage-fraud-entity"),
    ],
    payload: {
      direction: "DOWNSTREAM",
      fieldLevel: true,
      nodes: [...canonicalModelPath.nodes],
      segments: canonicalModelPath.segments.map((segment) => ({ ...segment })),
    },
  });
  const fraudModel = createEvidence({
    kind: "ML_MODEL",
    sourceUrn: canonicalDatasetUrn,
    targetUrn: canonicalFraudModelUrn,
    fieldPath: canonicalFieldPath,
    title: "Fraud Model v3",
    summary: "The production fraud model consumes customer_features.customer_id.",
    criticality: "CRITICAL",
    relatedEvidenceIds: [fraudPath.id],
    provenance: [provenance("ENTITY_DETAILS", "get_entities", "canonical-fraud-model")],
    payload: {
      modelUrn: canonicalFraudModelUrn,
      lifecycle: "PRODUCTION",
      classificationUrns: [canonicalCriticalTagUrn, canonicalProductionTagUrn].sort(),
      ownershipObserved: true,
      ownerUrns: [canonicalRiskOwnerUrn],
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
    relatedEvidenceIds: [analyticsPath.id],
    provenance: [
      provenance("QUERY_DISCOVERY", "get_dataset_queries", "canonical-finance-query-discovery"),
      provenance("QUERY_DETAILS", "get_entities", "canonical-finance-query-details"),
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
  const financeOwner = createEvidence({
    kind: "OWNER",
    sourceUrn: canonicalDashboardUrn,
    targetUrn: canonicalFinanceOwnerUrn,
    title: "Finance Analytics owner",
    summary: "Finance Analytics owns the revenue dashboard.",
    criticality: "HIGH",
    relatedEvidenceIds: [dashboard.id],
    provenance: [provenance("OWNER", "get_entities", "canonical-finance-owner")],
    payload: {
      assetUrn: canonicalDashboardUrn,
      ownerUrn: canonicalFinanceOwnerUrn,
      displayName: "Finance Analytics",
      ownershipType: "BUSINESS_OWNER",
    },
  });
  const riskOwner = createEvidence({
    kind: "OWNER",
    sourceUrn: canonicalFraudModelUrn,
    targetUrn: canonicalRiskOwnerUrn,
    title: "Risk ML owner",
    summary: "Risk ML owns Fraud Model v3.",
    criticality: "HIGH",
    relatedEvidenceIds: [fraudModel.id],
    provenance: [provenance("OWNER", "get_entities", "canonical-risk-owner")],
    payload: {
      assetUrn: canonicalFraudModelUrn,
      ownerUrn: canonicalRiskOwnerUrn,
      displayName: "Risk ML",
      ownershipType: "TECHNICAL_OWNER",
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
      provenance("GLOSSARY_BINDING", "list_schema_fields", "canonical-glossary-binding"),
      provenance("GLOSSARY_DETAILS", "get_entities", "canonical-glossary-details"),
    ],
    payload: {
      termUrn: canonicalGlossaryTermUrn,
      name: "Customer Identifier",
      schemaFieldUrn: canonicalSchemaFieldUrn,
      fieldPath: canonicalFieldPath,
    },
  });

  const commonContext = {
    changeId,
    datasetUrn: canonicalDatasetUrn,
    fieldPath: canonicalFieldPath,
    resolution,
    collectedAt: retrievedAt,
    collectionStatus: "COMPLETE",
    evidence: [
      schema,
      analyticsPath,
      dashboard,
      fraudPath,
      fraudModel,
      query,
      financeOwner,
      riskOwner,
      glossary,
    ].sort((left, right) => left.id.localeCompare(right.id)),
    failures: [],
  } satisfies Omit<ImpactContextData, "collectionOrigin">;
  const liveContext = {
    ...commonContext,
    collectionOrigin: { mode: "LIVE" as const },
  } satisfies ImpactContextData;
  const impactContextFingerprint = computeImpactContextFingerprint(liveContext);
  const sourceLiveCollectionFingerprint = computeImpactCollectionFingerprint(liveContext);
  const context = {
    ...commonContext,
    collectionOrigin: {
      mode: "VERIFIED_REPLAY" as const,
      manifestFingerprint: sha256({
        purpose: "LINEAGEGUARD_DOMAIN_TEST_REPLAY_MANIFEST",
        sourceLiveCollectionFingerprint,
        sourceImpactContextFingerprint: impactContextFingerprint,
      }),
      sourceLiveCollectionFingerprint,
      sourceImpactContextFingerprint: impactContextFingerprint,
    },
  } satisfies ImpactContextData;
  return impactContextSchema.parse({
    ...context,
    impactContextFingerprint,
    collectionFingerprint: computeImpactCollectionFingerprint(context),
  });
}
