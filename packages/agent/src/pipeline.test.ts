import { createAgentModel } from "./llm/client.js";
import { createAgentPipeline } from "./pipeline.js";
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
import { describe, expect, it, vi } from "vitest";

/**
 * Full-pipeline E2E test proving the canonical scenario reaches COMPLETED
 * (or the correct FAILED_* state) with all ports wired — not just steps 1-4.
 *
 * The migration-plan step (Step 5) calls out to an LLM via `fetch` with no
 * injectable port (see packages/agent/src/llm/client.ts:directLLMCall). This
 * test stubs global fetch to return a fixed, schema-valid plan response so
 * the deterministic control flow (parse -> baseline -> DataHub context ->
 * risk decision -> validation -> GitHub -> writeback) can be exercised
 * end-to-end without depending on a live LLM endpoint. All other ports
 * (DataHub, validation, GitHub, writeback) are wired through the pipeline's
 * real, typed port interfaces — this is dependency injection, not internal
 * mocking, and is intentionally scoped to this agent-package-level test
 * rather than the final walkthrough (see AGENTS.md: "A final walkthrough
 * may not depend on unit-test mocks for DataHub").
 */

const CANONICAL_PATCH = "ALTER TABLE commerce.orders RENAME COLUMN customer_id TO buyer_id;";

const MOCK_PLAN_RESPONSE = JSON.stringify({
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

function liveCanonicalContext(changeId: string): ImpactContext {
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
    summary: "The source field is a non-null bigint in PostgreSQL.",
    criticality: "HIGH",
    relatedEvidenceIds: [],
    provenance: [provenanceEntry("SCHEMA", "list_schema_fields", "schema")],
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

function stubLlmFetch() {
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

function unusedLlm() {
  return createAgentModel({
    baseURL: "http://unused.invalid/v1",
    model: "unused",
    apiKey: "unused",
  });
}

function baseRunInput(runId: string) {
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

describe("Full pipeline to COMPLETED", () => {
  it("reaches COMPLETED with mocked external ports", async () => {
    stubLlmFetch();
    try {
      const events: Array<{ status: string; extra?: Record<string, unknown> }> = [];
      const pipeline = createAgentPipeline({
        datahub: {
          collect: async (input) => ({
            outcome: "COLLECTED_LIVE",
            context: liveCanonicalContext(input.changeId),
          }),
        },
        llm: unusedLlm(),
        workerId: "test-worker",
        clock: () => new Date("2026-08-06T10:00:00.000Z"),
        validation: {
          validate: async () => ({
            allPass: true,
            checks: [
              "SQL_MIGRATION",
              "BACKFILL_EQUALITY",
              "DBT_PARSE",
              "DBT_COMPILE",
              "DBT_TEST",
              "OLD_CONSUMER_COMPATIBILITY",
              "NEW_CONSUMER_COMPATIBILITY",
              "ROLLBACK",
            ].map((check) => ({ check, status: "PASS" as const, summary: `${check} passed` })),
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
          }),
        },
        writeback: {
          write: async () => ({ status: "SUCCEEDED", receiptFingerprint: "sha256:wb-receipt" }),
        },
        onStatusChange: async (_runId, status, extra) => {
          events.push({ status, ...(extra !== undefined ? { extra } : {}) });
        },
      });

      const result = await pipeline.execute(baseRunInput("run_e2e_completed_0000000001"));

      expect(result.finalStatus).toBe("COMPLETED");
      expect(result.baselineDecision).toBe("ALLOW");
      expect(result.groundedDecision).toBe("BLOCK");
      expect(result.consumersFound).toBe(4);
      expect(result.validationPassed).toBe(true);
      expect(result.prUrl).toBe("https://github.com/org/walkthrough/pull/99");
      expect(result.writebackStatus).toBe("SUCCEEDED");
      expect(events.map((event) => event.status)).toEqual([
        "CHANGE_PARSED",
        "BASELINE_ASSESSED",
        "CONTEXT_COLLECTING",
        "CONTEXT_COLLECTED",
        "RISK_DECIDED",
        "MIGRATION_PLANNED",
        "PATCH_GENERATED",
        "VALIDATED",
        "REVIEW_ARTIFACT_CREATED",
        "WRITEBACK_PENDING",
        "COMPLETED",
      ]);
    } finally {
      vi.unstubAllGlobals();
    }
  }, 30_000);

  it("returns FAILED_CONTEXT when the DataHub port throws", async () => {
    const pipeline = createAgentPipeline({
      datahub: {
        collect: async () => {
          throw new Error("DataHub is unreachable");
        },
      },
      llm: unusedLlm(),
      workerId: "test-worker",
      clock: () => new Date("2026-08-06T10:00:00.000Z"),
    });

    const result = await pipeline.execute(baseRunInput("run_e2e_failed_context_00001"));

    expect(result.finalStatus).toBe("FAILED_CONTEXT");
  });

  it("returns FAILED_VALIDATION when a validation check fails", async () => {
    stubLlmFetch();
    try {
      const pipeline = createAgentPipeline({
        datahub: {
          collect: async (input) => ({
            outcome: "COLLECTED_LIVE",
            context: liveCanonicalContext(input.changeId),
          }),
        },
        llm: unusedLlm(),
        workerId: "test-worker",
        clock: () => new Date("2026-08-06T10:00:00.000Z"),
        validation: {
          validate: async () => ({
            allPass: false,
            checks: [{ check: "SQL_MIGRATION", status: "FAIL" as const, summary: "syntax error" }],
            receiptFingerprint: "sha256:failed-receipt",
          }),
        },
      });

      const result = await pipeline.execute(baseRunInput("run_e2e_failed_validation_001"));

      expect(result.finalStatus).toBe("FAILED_VALIDATION");
      expect(result.validationPassed).toBe(false);
    } finally {
      vi.unstubAllGlobals();
    }
  }, 30_000);

  it("returns FAILED_GITHUB when no GitHub port is configured", async () => {
    stubLlmFetch();
    try {
      const pipeline = createAgentPipeline({
        datahub: {
          collect: async (input) => ({
            outcome: "COLLECTED_LIVE",
            context: liveCanonicalContext(input.changeId),
          }),
        },
        llm: unusedLlm(),
        workerId: "test-worker",
        clock: () => new Date("2026-08-06T10:00:00.000Z"),
        validation: {
          validate: async () => ({
            allPass: true,
            checks: [{ check: "SQL_MIGRATION", status: "PASS" as const, summary: "ok" }],
            receiptFingerprint: "sha256:val-receipt",
          }),
        },
      });

      const result = await pipeline.execute(baseRunInput("run_e2e_failed_github_00001"));

      expect(result.finalStatus).toBe("FAILED_GITHUB");
    } finally {
      vi.unstubAllGlobals();
    }
  }, 30_000);
});
