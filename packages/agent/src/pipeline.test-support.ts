/**
 * Shared canonical pipeline fixtures. Extracted so the drift suite and the end-to-end suite assert
 * against one definition of 'the canonical run' instead of two that can diverge.
 */
import { createAgentModel } from "./llm/client.js";
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
  type ImpactContext,
  type ImpactContextData,
  impactResolutionSchema,
  sha256,
} from "@lineageguard/domain";
import { vi } from "vitest";

export const CANONICAL_PATCH = "ALTER TABLE commerce.orders RENAME COLUMN customer_id TO buyer_id;";

export const MOCK_PLAN_RESPONSE = JSON.stringify({
  strategy: "EXPAND_MIGRATE_CONTRACT",
  steps: [
    { order: 1, action: "EXPAND", description: "Add buyer_id alongside customer_id." },
    { order: 2, action: "MIGRATE", description: "Backfill and update consumers." },
    { order: 3, action: "CONTRACT", description: "Retire customer_id after the window." },
  ],
  rationale: "Safe expand-migrate-contract sequence for the canonical rename.",
});

// context.changeId must equal the real change.id computed by parseChange
// from the patch/repository/SHAs (see packages/domain/src/risk.ts — grounded
// risk comparison rejects a mismatched changeId). The pipeline always calls
// datahub.collect({ changeId: change.id, ... }), so the mock builds its
// fixture context from that real, passed-through id rather than a constant.
//
// Evidence shape mirrors packages/datahub/src/canonical-normalizer.ts'
// normalizeCanonicalLiveCollection output: schema + two LINEAGE_PATH/leaf
// pairs (dashboard, fraud model) + query usage + glossary + two owners —
// the same 4-consumer canonical scenario the real DataHub adapter produces.
function provenanceEntry(
  role:
    | "SCHEMA"
    | "LINEAGE_DISCOVERY"
    | "FIELD_PATH"
    | "ENTITY_PATH"
    | "ENTITY_DETAILS"
    | "QUERY_DISCOVERY"
    | "QUERY_DETAILS"
    | "OWNER"
    | "GLOSSARY_BINDING"
    | "GLOSSARY_DETAILS",
  tool:
    | "get_entities"
    | "list_schema_fields"
    | "get_lineage"
    | "get_lineage_paths_between"
    | "get_dataset_queries",
  invocationId: string,
) {
  return {
    source: "DATAHUB_MCP" as const,
    role,
    tool,
    invocationId,
    retrievedAt: "2026-08-06T10:00:00.000Z",
    responseFingerprint: sha256(`response:${invocationId}`),
  };
}

export function liveCanonicalContext(changeId: string): ImpactContext {
  const resolution = impactResolutionSchema.parse({
    requested: canonicalImpactRequest,
    datasetUrn: canonicalDatasetUrn,
    schemaFieldUrn: canonicalSchemaFieldUrn,
    nativeFieldPath: canonicalNativeFieldPath,
    provenance: [
      {
        ...provenanceEntry("SCHEMA", "get_entities", "resolution"),
        tool: "search" as const,
        role: "RESOLUTION" as const,
      },
    ],
  });
  const schema = createEvidence({
    kind: "SCHEMA",
    sourceUrn: canonicalDatasetUrn,
    fieldPath: canonicalFieldPath,
    title: "orders.customer_id schema",
    summary: "The source field is a non-null uuid in PostgreSQL.",
    criticality: "HIGH",
    relatedEvidenceIds: [],
    provenance: [provenanceEntry("SCHEMA", "list_schema_fields", "schema")],
    payload: {
      schemaFieldUrn: canonicalSchemaFieldUrn,
      nativeFieldPath: canonicalNativeFieldPath,
      nativeType: "uuid",
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
      provenanceEntry("LINEAGE_DISCOVERY", "get_lineage", "lineage-discovery-dashboard"),
      provenanceEntry("FIELD_PATH", "get_lineage_paths_between", "field-path-dashboard"),
      provenanceEntry("ENTITY_PATH", "get_lineage_paths_between", "entity-path-dashboard"),
    ],
    payload: {
      direction: "DOWNSTREAM",
      fieldLevel: true,
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
    relatedEvidenceIds: [dashboardPath.id],
    provenance: [provenanceEntry("ENTITY_DETAILS", "get_entities", "dashboard-details")],
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
      provenanceEntry("LINEAGE_DISCOVERY", "get_lineage", "lineage-discovery-fraud"),
      provenanceEntry("FIELD_PATH", "get_lineage_paths_between", "field-path-fraud"),
      provenanceEntry("ENTITY_PATH", "get_lineage_paths_between", "entity-path-fraud"),
    ],
    payload: {
      direction: "DOWNSTREAM",
      fieldLevel: true,
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
    provenance: [provenanceEntry("ENTITY_DETAILS", "get_entities", "fraud-model-details")],
    payload: {
      modelUrn: canonicalFraudModelUrn,
      lifecycle: "PRODUCTION",
      classificationUrns: [canonicalCriticalTagUrn, canonicalProductionTagUrn].sort(),
      ownershipObserved: true,
      ownerUrns: [canonicalRiskOwnerUrn],
      featureDatasetUrn: canonicalFraudFeaturesUrn,
      featureField: "fraud.customer_features.customer_id",
      trainingDataReceipt: {
        aspectName: "mlModelTrainingData",
        credentialClass: "READ",
        endpoint: `http://127.0.0.1:8080/openapi/v3/entity/mlModel/${encodeURIComponent(canonicalFraudModelUrn)}/mlModelTrainingData`,
        modelUrn: canonicalFraudModelUrn,
        provenDatasetUrn: canonicalFraudFeaturesUrn,
        responseSha256: "a".repeat(64),
        retrievedAt: "2026-08-04T08:00:00.000Z",
      },
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
      provenanceEntry("QUERY_DISCOVERY", "get_dataset_queries", "query-discovery"),
      provenanceEntry("QUERY_DETAILS", "get_entities", "query-details"),
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
    provenance: [provenanceEntry("OWNER", "get_entities", "finance-owner")],
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
    provenance: [provenanceEntry("OWNER", "get_entities", "risk-owner")],
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
      provenanceEntry("GLOSSARY_BINDING", "list_schema_fields", "glossary-binding"),
      provenanceEntry("GLOSSARY_DETAILS", "get_entities", "glossary-details"),
    ],
    payload: {
      termUrn: canonicalGlossaryTermUrn,
      name: "Customer Identifier",
      schemaFieldUrn: canonicalSchemaFieldUrn,
      fieldPath: canonicalFieldPath,
    },
  });

  const liveDraft: ImpactContextData = {
    changeId,
    datasetUrn: canonicalDatasetUrn,
    fieldPath: canonicalFieldPath,
    resolution,
    collectedAt: "2026-08-06T10:00:00.000Z",
    collectionStatus: "COMPLETE" as const,
    evidence: [
      schema,
      dashboardPath,
      dashboard,
      fraudPath,
      fraudModel,
      query,
      financeOwner,
      riskOwner,
      glossary,
    ].sort((left, right) => left.id.localeCompare(right.id)),
    failures: [],
    collectionOrigin: { mode: "LIVE" as const },
  };
  return {
    ...liveDraft,
    impactContextFingerprint: computeImpactContextFingerprint(liveDraft),
    collectionFingerprint: computeImpactCollectionFingerprint(liveDraft),
  };
}

export function stubLlmFetch() {
  return vi.stubGlobal(
    "fetch",
    vi.fn(
      async () =>
        new Response(JSON.stringify({ choices: [{ message: { content: MOCK_PLAN_RESPONSE } }] }), {
          status: 200,
          headers: { "content-type": "application/json" },
        }),
    ),
  );
}

export function unusedLlm() {
  return createAgentModel({
    baseURL: "http://unused.invalid/v1",
    model: "unused",
    apiKey: "unused",
  });
}

export function canonicalRunInput(runId: string) {
  return {
    runId,
    repository: "org/walkthrough",
    baseSha: "a".repeat(40),
    headSha: "b".repeat(40),
    patch: CANONICAL_PATCH,
    table: "commerce.orders",
    field: "customer_id",
    newName: "buyer_id",
  };
}

/** All eight canonical checks reported PASS, matching a real 8/8 validation receipt. */
export function passingValidationChecks() {
  return [
    "SQL_MIGRATION",
    "BACKFILL_EQUALITY",
    "DBT_PARSE",
    "DBT_COMPILE",
    "DBT_TEST",
    "OLD_CONSUMER_COMPATIBILITY",
    "NEW_CONSUMER_COMPATIBILITY",
    "ROLLBACK",
  ].map((check) => ({ check, status: "PASS" as const, summary: `${check} passed` }));
}

/**
 * A pipeline configuration whose external effects all succeed, so a test can isolate one boundary.
 * Callers override the single port they intend to exercise.
 */
export function canonicalPipelineConfig() {
  return {
    datahub: {
      collect: async (input: { changeId: string }) => ({
        outcome: "COLLECTED_LIVE" as const,
        context: liveCanonicalContext(input.changeId),
      }),
    },
    llm: unusedLlm(),
    workerId: "test-worker",
    clock: () => new Date("2026-08-06T10:00:00.000Z"),
    validation: {
      validate: async () => ({
        allPass: true,
        checks: passingValidationChecks(),
        receiptFingerprint: "sha256:val-receipt",
      }),
    },
    github: {
      createReview: async () => ({
        prUrl: "https://github.com/org/walkthrough/pull/99",
        prNumber: 99,
        headSha: "c".repeat(40),
        headBranch: "lineageguard/buyer-id-migration",
        receiptFingerprint: "sha256:gh-receipt",
        outcome: "CREATED" as const,
      }),
    },
    writeback: {
      write: async () => ({
        status: "SUCCEEDED" as const,
        receiptFingerprint: "sha256:wb-receipt",
      }),
    },
  };
}
