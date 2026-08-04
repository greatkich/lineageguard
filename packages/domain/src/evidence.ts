import { z } from "zod";
import { sha256, stableId } from "./hash.js";

const urnSchema = z.string().min(8).max(1_000).startsWith("urn:li:");
const isoDateTimeSchema = z.iso.datetime({ offset: true });
const evidenceIdSchema = z.string().regex(/^ev_[a-f0-9]{24}$/);

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
  sourceUrn: urnSchema,
  targetUrn: urnSchema.optional(),
  fieldPath: z.string().min(1).max(500).optional(),
  title: z.string().min(1).max(240),
  summary: z.string().min(1).max(1_000),
  criticality: criticalitySchema,
  rawFingerprint: z.string().regex(/^[a-f0-9]{64}$/),
  provenance: evidenceProvenanceSchema,
  relatedEvidenceIds: z.array(evidenceIdSchema).max(20),
};

const schemaEvidenceSchema = z
  .object({
    ...baseEvidenceShape,
    kind: z.literal("SCHEMA"),
    payload: z
      .object({
        nativeType: z.string().min(1).max(80),
        nullable: z.boolean(),
      })
      .strict(),
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

export const evidenceItemSchema = z.discriminatedUnion("kind", [
  schemaEvidenceSchema,
  lineagePathEvidenceSchema,
  dashboardEvidenceSchema,
  modelEvidenceSchema,
  queryEvidenceSchema,
  ownerEvidenceSchema,
  glossaryEvidenceSchema,
]);

export type EvidenceItem = z.infer<typeof evidenceItemSchema>;
export type EvidenceKind = EvidenceItem["kind"];

export const impactCollectionFailureSchema = z
  .object({
    tool: evidenceProvenanceSchema.shape.tool,
    code: z.enum(["TIMEOUT", "NOT_FOUND", "AMBIGUOUS", "MALFORMED_RESPONSE", "UNAVAILABLE"]),
    message: z.string().min(1).max(500),
  })
  .strict();

export const impactContextSchema = z
  .object({
    changeId: z.string().regex(/^chg_[a-f0-9]{24}$/),
    datasetUrn: urnSchema,
    fieldPath: z.literal("commerce.orders.customer_id"),
    collectedAt: isoDateTimeSchema,
    collectionStatus: z.enum(["COMPLETE", "PARTIAL", "FAILED"]),
    evidence: z.array(evidenceItemSchema).max(200),
    failures: z.array(impactCollectionFailureSchema).max(20),
  })
  .strict()
  .superRefine((context, refinement) => {
    const ids = new Set<string>();
    for (const [index, item] of context.evidence.entries()) {
      if (ids.has(item.id)) {
        refinement.addIssue({
          code: "custom",
          message: `Duplicate evidence id: ${item.id}`,
          path: ["evidence", index, "id"],
        });
      }
      ids.add(item.id);
    }

    for (const [index, item] of context.evidence.entries()) {
      for (const relatedId of item.relatedEvidenceIds) {
        if (!ids.has(relatedId)) {
          refinement.addIssue({
            code: "custom",
            message: `Dangling related evidence id: ${relatedId}`,
            path: ["evidence", index, "relatedEvidenceIds"],
          });
        }
      }
    }

    if (context.collectionStatus === "COMPLETE" && context.failures.length > 0) {
      refinement.addIssue({
        code: "custom",
        message: "A complete context cannot contain collection failures",
        path: ["failures"],
      });
    }
    if (context.collectionStatus === "PARTIAL" && context.failures.length === 0) {
      refinement.addIssue({
        code: "custom",
        message: "A partial context must describe at least one failure",
        path: ["failures"],
      });
    }
    if (context.collectionStatus === "FAILED" && context.failures.length === 0) {
      refinement.addIssue({
        code: "custom",
        message: "A failed context must describe at least one failure",
        path: ["failures"],
      });
    }
  });

export type ImpactContext = z.infer<typeof impactContextSchema>;

type EvidenceDraftFor<Item extends EvidenceItem> = Omit<
  Item,
  "id" | "provenance" | "rawFingerprint"
> & {
  provenance: Omit<z.infer<typeof evidenceProvenanceSchema>, "responseFingerprint">;
};

type EvidenceDraft = EvidenceItem extends infer Item
  ? Item extends EvidenceItem
    ? EvidenceDraftFor<Item>
    : never
  : never;

export function createEvidence(draft: EvidenceDraft): EvidenceItem {
  const rawIdentity = {
    kind: draft.kind,
    sourceUrn: draft.sourceUrn,
    targetUrn: draft.targetUrn ?? null,
    fieldPath: draft.fieldPath ?? null,
    payload: draft.payload,
  };
  const rawFingerprint = sha256(rawIdentity);
  const identity = { ...rawIdentity, rawFingerprint };
  return evidenceItemSchema.parse({
    ...draft,
    id: stableId("ev", identity),
    rawFingerprint,
    provenance: { ...draft.provenance, responseFingerprint: rawFingerprint },
  });
}

const sourceUrn = "urn:li:dataset:(urn:li:dataPlatform:postgres,commerce.orders,PROD)";
const fieldPath = "commerce.orders.customer_id";
const retrievedAt = "2026-08-04T08:00:00.000Z";
const dashboardUrn = "urn:li:dashboard:(looker,finance-revenue)";
const fraudModelUrn = "urn:li:mlModel:(fraud-model-v3,PROD)";

function provenance(
  tool: z.infer<typeof evidenceProvenanceSchema>["tool"],
  invocationId: string,
): EvidenceDraft["provenance"] {
  return { source: "DATAHUB_MCP", tool, invocationId, retrievedAt };
}

export function createCanonicalImpactContext(changeId: string): ImpactContext {
  const analyticsPath = createEvidence({
    kind: "LINEAGE_PATH",
    sourceUrn,
    targetUrn: "urn:li:dataset:(urn:li:dataPlatform:dbt,analytics.customer_revenue,PROD)",
    fieldPath,
    title: "Revenue lineage path",
    summary: "customer_id flows through stg_orders into analytics.customer_revenue.",
    criticality: "HIGH",
    relatedEvidenceIds: [],
    provenance: provenance("get_lineage_paths_between", "canonical-lineage-revenue"),
    payload: {
      direction: "DOWNSTREAM",
      fieldLevel: true,
      nodes: [
        sourceUrn,
        "urn:li:dataset:(urn:li:dataPlatform:dbt,analytics.stg_orders,PROD)",
        "urn:li:dataset:(urn:li:dataPlatform:dbt,analytics.customer_revenue,PROD)",
      ],
    },
  });
  const dashboard = createEvidence({
    kind: "DASHBOARD",
    sourceUrn,
    targetUrn: dashboardUrn,
    fieldPath,
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
    sourceUrn,
    targetUrn: "urn:li:dataset:(urn:li:dataPlatform:dbt,fraud.customer_features,PROD)",
    fieldPath,
    title: "Fraud feature lineage path",
    summary: "customer_id flows into the fraud customer feature set.",
    criticality: "CRITICAL",
    relatedEvidenceIds: [],
    provenance: provenance("get_lineage_paths_between", "canonical-lineage-fraud"),
    payload: {
      direction: "DOWNSTREAM",
      fieldLevel: true,
      nodes: [sourceUrn, "urn:li:dataset:(urn:li:dataPlatform:dbt,fraud.customer_features,PROD)"],
    },
  });
  const fraudModel = createEvidence({
    kind: "ML_MODEL",
    sourceUrn,
    targetUrn: fraudModelUrn,
    fieldPath,
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
    sourceUrn,
    fieldPath,
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
      referencedField: fieldPath,
    },
  });
  const financeOwner = createEvidence({
    kind: "OWNER",
    sourceUrn: dashboardUrn,
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
    sourceUrn,
    fieldPath,
    title: "Customer Identifier",
    summary: "customer_id is governed by the Customer Identifier glossary term.",
    criticality: "HIGH",
    relatedEvidenceIds: [],
    provenance: provenance("get_entities", "canonical-glossary"),
    payload: {
      termUrn: "urn:li:glossaryTerm:customer-identifier",
      name: "Customer Identifier",
      fieldPath,
    },
  });

  return impactContextSchema.parse({
    changeId,
    datasetUrn: sourceUrn,
    fieldPath,
    collectedAt: retrievedAt,
    collectionStatus: "COMPLETE",
    evidence: [
      analyticsPath,
      dashboard,
      fraudPath,
      fraudModel,
      query,
      financeOwner,
      riskOwner,
      glossary,
    ],
    failures: [],
  });
}
