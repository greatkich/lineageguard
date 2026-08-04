import { z } from "zod";
import { sha256, stableId } from "./hash.js";

const urnSchema = z.string().min(8).max(1_000).startsWith("urn:li:");
const isoDateTimeSchema = z.iso.datetime({ offset: true });
const evidenceIdSchema = z.string().regex(/^ev_[a-f0-9]{24}$/);

export const canonicalDatasetUrn =
  "urn:li:dataset:(urn:li:dataPlatform:postgres,commerce.orders,PROD)";
export const canonicalFieldPath = "commerce.orders.customer_id";

export const criticalitySchema = z.enum(["LOW", "MEDIUM", "HIGH", "CRITICAL"]);
export type Criticality = z.infer<typeof criticalitySchema>;

export const evidenceProvenanceSchema = z
  .object({
    source: z.literal("DATAHUB_MCP"),
    tool: z.enum([
      "get_entities",
      "list_schema_fields",
      "get_lineage",
      "get_lineage_paths_between",
      "get_dataset_queries",
    ]),
    invocationId: z.string().min(1).max(160),
    retrievedAt: isoDateTimeSchema,
    responseFingerprint: z.string().regex(/^[a-f0-9]{64}$/),
  })
  .strict();

const baseEvidenceShape = {
  id: evidenceIdSchema,
  fingerprint: z.string().regex(/^[a-f0-9]{64}$/),
  sourceUrn: urnSchema,
  targetUrn: urnSchema.optional(),
  fieldPath: z.string().min(1).max(500).optional(),
  title: z.string().min(1).max(240),
  summary: z.string().min(1).max(1_000),
  criticality: criticalitySchema,
  provenance: evidenceProvenanceSchema,
  relatedEvidenceIds: z.array(evidenceIdSchema).max(20),
};

const schemaEvidenceSchema = z
  .object({
    ...baseEvidenceShape,
    kind: z.literal("SCHEMA"),
    payload: z.object({ nativeType: z.string().min(1).max(80), nullable: z.boolean() }).strict(),
  })
  .strict();

const lineagePathEvidenceSchema = z
  .object({
    ...baseEvidenceShape,
    kind: z.literal("LINEAGE_PATH"),
    payload: z
      .object({
        direction: z.literal("DOWNSTREAM"),
        nodes: z.array(urnSchema).min(2).max(20),
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
        queryId: z.string().min(1).max(240),
        queryName: z.string().min(1).max(240),
        lastSeenAt: isoDateTimeSchema,
        managed: z.boolean(),
        referencedField: z.string().min(1).max(500),
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
    provenance: { source: item.provenance.source, tool: item.provenance.tool },
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
    code: z.enum(["TIMEOUT", "NOT_FOUND", "AMBIGUOUS", "MALFORMED_RESPONSE", "UNAVAILABLE"]),
    message: z.string().min(1).max(500),
  })
  .strict();

function issue(refinement: z.RefinementCtx, message: string, path: PropertyKey[]): void {
  refinement.addIssue({ code: "custom", message, path });
}

export const impactContextSchema = z
  .object({
    impactContextFingerprint: z.string().regex(/^[a-f0-9]{64}$/),
    changeId: z.string().regex(/^chg_[a-f0-9]{24}$/),
    datasetUrn: z.literal(canonicalDatasetUrn),
    fieldPath: z.literal(canonicalFieldPath),
    collectedAt: isoDateTimeSchema,
    collectionStatus: z.enum(["COMPLETE", "PARTIAL", "FAILED"]),
    evidence: z.array(evidenceItemSchema).max(200),
    failures: z.array(impactCollectionFailureSchema).max(20),
  })
  .strict()
  .superRefine((context, refinement) => {
    const { impactContextFingerprint, ...contextIdentity } = context;
    if (impactContextFingerprint !== sha256(contextIdentity)) {
      issue(refinement, "Impact context fingerprint is invalid", ["impactContextFingerprint"]);
    }
    const sortedEvidenceIds = context.evidence.map((item) => item.id).sort();
    if (context.evidence.some((item, index) => item.id !== sortedEvidenceIds[index])) {
      issue(refinement, "Evidence must use canonical ID order", ["evidence"]);
    }
    const failureKeys = context.failures.map(
      (failure) => `${failure.tool}\u0000${failure.code}\u0000${failure.message}`,
    );
    const sortedFailureKeys = [...failureKeys].sort();
    if (
      new Set(failureKeys).size !== failureKeys.length ||
      failureKeys.some((key, index) => key !== sortedFailureKeys[index])
    ) {
      issue(refinement, "Collection failures must use canonical order", ["failures"]);
    }
    const byId = new Map(context.evidence.map((item) => [item.id, item]));
    if (byId.size !== context.evidence.length) {
      issue(refinement, "Evidence IDs must be unique", ["evidence"]);
    }

    for (const [index, item] of context.evidence.entries()) {
      if (
        new Date(item.provenance.retrievedAt).getTime() > new Date(context.collectedAt).getTime()
      ) {
        issue(refinement, "Evidence cannot be retrieved after context collection", [
          "evidence",
          index,
          "provenance",
          "retrievedAt",
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

      if (item.kind === "SCHEMA" && (item.targetUrn || item.relatedEvidenceIds.length > 0)) {
        issue(refinement, "Schema evidence cannot target or reference downstream evidence", [
          "evidence",
          index,
        ]);
      }
      if (item.kind === "LINEAGE_PATH") {
        if (
          item.payload.nodes[0] !== context.datasetUrn ||
          item.payload.nodes.at(-1) !== item.targetUrn
        ) {
          issue(refinement, "Lineage path endpoints do not match its source and target", [
            "evidence",
            index,
          ]);
        }
      }
      if (item.kind === "DASHBOARD") {
        const relatedPaths = item.relatedEvidenceIds
          .map((id) => byId.get(id))
          .filter((related) => related?.kind === "LINEAGE_PATH");
        const downstreamDataset = item.payload.downstreamField.slice(
          0,
          item.payload.downstreamField.lastIndexOf("."),
        );
        if (
          item.targetUrn !== item.payload.dashboardUrn ||
          !item.payload.downstreamField.endsWith(".customer_id") ||
          !relatedPaths.some((path) => path?.targetUrn?.includes(`,${downstreamDataset},PROD)`))
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
        const featureDataset = item.payload.featureField.slice(
          0,
          item.payload.featureField.lastIndexOf("."),
        );
        if (
          item.targetUrn !== item.payload.modelUrn ||
          !item.payload.featureField.endsWith(".customer_id") ||
          !relatedPaths.some((path) => path?.targetUrn?.includes(`,${featureDataset},PROD)`))
        ) {
          issue(refinement, "ML model evidence is not linked to a matching field lineage path", [
            "evidence",
            index,
          ]);
        }
      }
      if (item.kind === "QUERY_USAGE") {
        if (
          item.payload.referencedField !== context.fieldPath ||
          new Date(item.payload.lastSeenAt).getTime() > new Date(context.collectedAt).getTime()
        ) {
          issue(refinement, "Query evidence has a mismatched or future field observation", [
            "evidence",
            index,
          ]);
        }
      }
      if (item.kind === "GLOSSARY_TERM") {
        if (
          item.targetUrn !== item.payload.termUrn ||
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
              related.payload.dashboardUrn === item.payload.assetUrn) ||
            (related?.kind === "ML_MODEL" && related.payload.modelUrn === item.payload.assetUrn),
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
      const models = context.evidence
        .filter((item) => item.kind === "ML_MODEL")
        .filter((item) => item.payload.lifecycle === "PRODUCTION");
      const queries = context.evidence.filter(
        (item) => item.kind === "QUERY_USAGE" && !item.payload.managed,
      );
      const glossaries = context.evidence.filter((item) => item.kind === "GLOSSARY_TERM");
      if (
        schemas.length === 0 ||
        paths.length < 2 ||
        dashboards.length === 0 ||
        models.length === 0 ||
        queries.length === 0 ||
        glossaries.length === 0
      ) {
        issue(refinement, "Complete canonical context is missing required collected evidence", [
          "evidence",
        ]);
      }
    }
    if (context.collectionStatus === "PARTIAL" && context.failures.length === 0) {
      issue(refinement, "Partial context must describe at least one failure", ["failures"]);
    }
    if (context.collectionStatus === "FAILED" && context.failures.length === 0) {
      issue(refinement, "Failed context must describe at least one failure", ["failures"]);
    }
  });

export type ImpactContext = z.infer<typeof impactContextSchema>;

export function computeImpactContextFingerprint(
  context: Omit<ImpactContext, "impactContextFingerprint">,
): string {
  return sha256(context);
}

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
const dashboardUrn = "urn:li:dashboard:(looker,finance-revenue)";
const fraudModelUrn = "urn:li:mlModel:(fraud-model-v3,PROD)";

function provenance(
  tool: z.infer<typeof evidenceProvenanceSchema>["tool"],
  invocationId: string,
): z.infer<typeof evidenceProvenanceSchema> {
  return {
    source: "DATAHUB_MCP",
    tool,
    invocationId,
    retrievedAt,
    responseFingerprint: sha256(`recorded-mcp-response:${invocationId}`),
  };
}

export function createCanonicalImpactContext(changeId: string): ImpactContext {
  const schema = createEvidence({
    kind: "SCHEMA",
    sourceUrn: canonicalDatasetUrn,
    fieldPath: canonicalFieldPath,
    title: "orders.customer_id schema",
    summary: "The source field is a non-null bigint in PostgreSQL.",
    criticality: "HIGH",
    relatedEvidenceIds: [],
    provenance: provenance("list_schema_fields", "canonical-schema"),
    payload: { nativeType: "bigint", nullable: false },
  });
  const analyticsPath = createEvidence({
    kind: "LINEAGE_PATH",
    sourceUrn: canonicalDatasetUrn,
    targetUrn: "urn:li:dataset:(urn:li:dataPlatform:dbt,analytics.customer_revenue,PROD)",
    fieldPath: canonicalFieldPath,
    title: "Revenue lineage path",
    summary: "customer_id flows through stg_orders into analytics.customer_revenue.",
    criticality: "HIGH",
    relatedEvidenceIds: [],
    provenance: provenance("get_lineage_paths_between", "canonical-lineage-revenue"),
    payload: {
      direction: "DOWNSTREAM",
      fieldLevel: true,
      nodes: [
        canonicalDatasetUrn,
        "urn:li:dataset:(urn:li:dataPlatform:dbt,analytics.stg_orders,PROD)",
        "urn:li:dataset:(urn:li:dataPlatform:dbt,analytics.customer_revenue,PROD)",
      ],
    },
  });
  const dashboard = createEvidence({
    kind: "DASHBOARD",
    sourceUrn: canonicalDatasetUrn,
    targetUrn: dashboardUrn,
    fieldPath: canonicalFieldPath,
    title: "Finance Revenue Dashboard",
    summary: "A critical Finance dashboard consumes the revenue lineage path.",
    criticality: "CRITICAL",
    relatedEvidenceIds: [analyticsPath.id],
    provenance: provenance("get_entities", "canonical-dashboard"),
    payload: {
      dashboardUrn,
      platform: "looker",
      downstreamField: "analytics.customer_revenue.customer_id",
    },
  });
  const fraudPath = createEvidence({
    kind: "LINEAGE_PATH",
    sourceUrn: canonicalDatasetUrn,
    targetUrn: "urn:li:dataset:(urn:li:dataPlatform:dbt,fraud.customer_features,PROD)",
    fieldPath: canonicalFieldPath,
    title: "Fraud feature lineage path",
    summary: "customer_id flows into the fraud customer feature set.",
    criticality: "CRITICAL",
    relatedEvidenceIds: [],
    provenance: provenance("get_lineage_paths_between", "canonical-lineage-fraud"),
    payload: {
      direction: "DOWNSTREAM",
      fieldLevel: true,
      nodes: [
        canonicalDatasetUrn,
        "urn:li:dataset:(urn:li:dataPlatform:dbt,fraud.customer_features,PROD)",
      ],
    },
  });
  const fraudModel = createEvidence({
    kind: "ML_MODEL",
    sourceUrn: canonicalDatasetUrn,
    targetUrn: fraudModelUrn,
    fieldPath: canonicalFieldPath,
    title: "Fraud Model v3",
    summary: "The production fraud model consumes customer_features.customer_id.",
    criticality: "CRITICAL",
    relatedEvidenceIds: [fraudPath.id],
    provenance: provenance("get_entities", "canonical-fraud-model"),
    payload: {
      modelUrn: fraudModelUrn,
      lifecycle: "PRODUCTION",
      featureField: "fraud.customer_features.customer_id",
    },
  });
  const query = createEvidence({
    kind: "QUERY_USAGE",
    sourceUrn: canonicalDatasetUrn,
    fieldPath: canonicalFieldPath,
    title: "finance-monthly-close.sql",
    summary: "An unmanaged Finance query recently referenced customer_id.",
    criticality: "HIGH",
    relatedEvidenceIds: [],
    provenance: provenance("get_dataset_queries", "canonical-finance-query"),
    payload: {
      queryId: "finance-monthly-close",
      queryName: "finance-monthly-close.sql",
      lastSeenAt: "2026-08-03T16:30:00.000Z",
      managed: false,
      referencedField: canonicalFieldPath,
    },
  });
  const financeOwner = createEvidence({
    kind: "OWNER",
    sourceUrn: dashboardUrn,
    targetUrn: "urn:li:corpGroup:finance-analytics",
    title: "Finance Analytics owner",
    summary: "Finance Analytics owns the revenue dashboard.",
    criticality: "HIGH",
    relatedEvidenceIds: [dashboard.id],
    provenance: provenance("get_entities", "canonical-finance-owner"),
    payload: {
      assetUrn: dashboardUrn,
      ownerUrn: "urn:li:corpGroup:finance-analytics",
      ownershipType: "BUSINESS_OWNER",
    },
  });
  const riskOwner = createEvidence({
    kind: "OWNER",
    sourceUrn: fraudModelUrn,
    targetUrn: "urn:li:corpGroup:risk-ml",
    title: "Risk ML owner",
    summary: "Risk ML owns Fraud Model v3.",
    criticality: "HIGH",
    relatedEvidenceIds: [fraudModel.id],
    provenance: provenance("get_entities", "canonical-risk-owner"),
    payload: {
      assetUrn: fraudModelUrn,
      ownerUrn: "urn:li:corpGroup:risk-ml",
      ownershipType: "TECHNICAL_OWNER",
    },
  });
  const glossary = createEvidence({
    kind: "GLOSSARY_TERM",
    sourceUrn: canonicalDatasetUrn,
    targetUrn: "urn:li:glossaryTerm:customer-identifier",
    fieldPath: canonicalFieldPath,
    title: "Customer Identifier",
    summary: "customer_id is governed by the Customer Identifier glossary term.",
    criticality: "HIGH",
    relatedEvidenceIds: [],
    provenance: provenance("get_entities", "canonical-glossary"),
    payload: {
      termUrn: "urn:li:glossaryTerm:customer-identifier",
      name: "Customer Identifier",
      fieldPath: canonicalFieldPath,
    },
  });

  const context = {
    changeId,
    datasetUrn: canonicalDatasetUrn,
    fieldPath: canonicalFieldPath,
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
  } satisfies Omit<ImpactContext, "impactContextFingerprint">;
  return impactContextSchema.parse({
    ...context,
    impactContextFingerprint: computeImpactContextFingerprint(context),
  });
}
