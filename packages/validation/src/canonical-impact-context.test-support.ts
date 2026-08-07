import {
  computeImpactCollectionFingerprint,
  computeImpactContextFingerprint,
  createEvidence,
  type ImpactContext,
  type ImpactContextData,
  impactContextSchema,
} from "@lineageguard/domain";

// Canonical parser/unit fixture only. It models recorded MCP-shaped evidence but carries no
// replay manifest, validation receipt, credentials, or runtime authority.
const canonicalImpactContextData: Omit<ImpactContextData, "changeId" | "collectionOrigin"> = {
  datasetUrn:
    "urn:li:dataset:(urn:li:dataPlatform:postgres,lineageguard-canonical.lineageguard.commerce.orders,PROD)",
  fieldPath: "commerce.orders.customer_id",
  resolution: {
    requested: {
      platform: "postgres",
      platformInstance: "lineageguard-canonical",
      environment: "PROD",
      database: "lineageguard",
      schema: "commerce",
      dataset: "orders",
      field: "customer_id",
    },
    datasetUrn:
      "urn:li:dataset:(urn:li:dataPlatform:postgres,lineageguard-canonical.lineageguard.commerce.orders,PROD)",
    schemaFieldUrn:
      "urn:li:schemaField:(urn:li:dataset:(urn:li:dataPlatform:postgres,lineageguard-canonical.lineageguard.commerce.orders,PROD),customer_id)",
    nativeFieldPath: "customer_id",
    provenance: [
      {
        source: "DATAHUB_MCP",
        role: "RESOLUTION",
        tool: "search",
        invocationId: "canonical-resolution",
        retrievedAt: "2026-08-04T08:00:00.000Z",
        responseFingerprint: "92f71027fd8aabc07db02fd99d73ba624a9e050e90d90ffeec8b42acdf39aa9c",
      },
    ],
  },
  collectedAt: "2026-08-04T08:00:00.000Z",
  collectionStatus: "COMPLETE",
  evidence: [
    {
      id: "ev_09d0ce72de399bd52bd82247",
      fingerprint: "09d0ce72de399bd52bd82247a149ab278e5535b65faa2fc956fcc543cbf80215",
      sourceUrn:
        "urn:li:dataset:(urn:li:dataPlatform:postgres,lineageguard-canonical.lineageguard.commerce.orders,PROD)",
      fieldPath: "commerce.orders.customer_id",
      title: "orders.customer_id schema",
      summary: "The source field is a non-null uuid in PostgreSQL.",
      criticality: "HIGH",
      provenance: [
        {
          source: "DATAHUB_MCP",
          role: "SCHEMA",
          tool: "list_schema_fields",
          invocationId: "canonical-schema",
          retrievedAt: "2026-08-04T08:00:00.000Z",
          responseFingerprint: "5eda31499dcf4124f450bcc44deb152cbc85c7f17b80a2927d7b0fa65ed6c878",
        },
      ],
      relatedEvidenceIds: [],
      kind: "SCHEMA",
      payload: {
        schemaFieldUrn:
          "urn:li:schemaField:(urn:li:dataset:(urn:li:dataPlatform:postgres,lineageguard-canonical.lineageguard.commerce.orders,PROD),customer_id)",
        nativeFieldPath: "customer_id",
        nativeType: "uuid",
        nullable: false,
      },
    },
    {
      id: "ev_171e9e739d3d518e46aad9ee",
      fingerprint: "171e9e739d3d518e46aad9ee73a7bad7e89475ef5d185503655385adbe0fe810",
      sourceUrn:
        "urn:li:dataset:(urn:li:dataPlatform:postgres,lineageguard-canonical.lineageguard.commerce.orders,PROD)",
      targetUrn:
        "urn:li:query:lineageguard-canonical.system.e4bbe7075754d05de68f76ff0a9b127532e044da8ab0a357bce7e0d41f7ad22c",
      fieldPath: "commerce.orders.customer_id",
      title: "Finance close SYSTEM query",
      summary:
        "A cataloged PostgreSQL query subject references analytics.customer_revenue.customer_id.",
      criticality: "HIGH",
      provenance: [
        {
          source: "DATAHUB_MCP",
          role: "QUERY_DISCOVERY",
          tool: "get_dataset_queries",
          invocationId: "canonical-finance-query-discovery",
          retrievedAt: "2026-08-04T08:00:00.000Z",
          responseFingerprint: "ff6cb26ea485a9e32ad54a124022c203617f07a8f3a7d91aa8e345eaa076fd8f",
        },
        {
          source: "DATAHUB_MCP",
          role: "QUERY_DETAILS",
          tool: "get_entities",
          invocationId: "canonical-finance-query-details",
          retrievedAt: "2026-08-04T08:00:00.000Z",
          responseFingerprint: "629f1b1ddafadee23e9772b52e92191b4e3e08d889120c476a790cd337d88295",
        },
      ],
      relatedEvidenceIds: ["ev_9e907158dba3dd3b5ea635af"],
      kind: "QUERY_USAGE",
      payload: {
        queryUrn:
          "urn:li:query:lineageguard-canonical.system.e4bbe7075754d05de68f76ff0a9b127532e044da8ab0a357bce7e0d41f7ad22c",
        source: "SYSTEM",
        observationBasis: "DATAHUB_QUERY_ENTITY",
        subjectDatasetUrn:
          "urn:li:dataset:(urn:li:dataPlatform:postgres,lineageguard-canonical.lineageguard.analytics.customer_revenue,PROD)",
        subjectSchemaFieldUrn:
          "urn:li:schemaField:(urn:li:dataset:(urn:li:dataPlatform:postgres,lineageguard-canonical.lineageguard.analytics.customer_revenue,PROD),customer_id)",
        subjectFieldPath: "customer_id",
        normalizedStatementFingerprint:
          "64e7b3dc02cac7ee25acb65562fa7c075f08abc48310bf8dd16d0c9f6ef45638",
      },
    },
    {
      id: "ev_59eb5c12bc8d30556ca933fe",
      fingerprint: "59eb5c12bc8d30556ca933fe36a8ffc4f1f5843c9fe0d508fbca7cb2472bc7d2",
      sourceUrn:
        "urn:li:dataset:(urn:li:dataPlatform:postgres,lineageguard-canonical.lineageguard.commerce.orders,PROD)",
      targetUrn: "urn:li:dashboard:(looker,lineageguard-canonical.finance-revenue-dashboard)",
      fieldPath: "commerce.orders.customer_id",
      title: "Finance Revenue Dashboard",
      summary: "A critical Finance dashboard consumes the revenue lineage path.",
      criticality: "CRITICAL",
      provenance: [
        {
          source: "DATAHUB_MCP",
          role: "ENTITY_DETAILS",
          tool: "get_entities",
          invocationId: "canonical-dashboard",
          retrievedAt: "2026-08-04T08:00:00.000Z",
          responseFingerprint: "d9b976f2de6736cd0acec8dc4a6a440c877614c8f8e3f6bcc1bf43cb2225cfb5",
        },
      ],
      relatedEvidenceIds: ["ev_9e907158dba3dd3b5ea635af"],
      kind: "DASHBOARD",
      payload: {
        dashboardUrn: "urn:li:dashboard:(looker,lineageguard-canonical.finance-revenue-dashboard)",
        platform: "looker",
        lifecycle: "PRODUCTION",
        classificationUrns: [
          "urn:li:tag:lineageguard-canonical.Critical",
          "urn:li:tag:lineageguard-canonical.Production",
        ],
        ownershipObserved: true,
        ownerUrns: ["urn:li:corpGroup:lineageguard-canonical.finance-analytics"],
        downstreamDatasetUrn:
          "urn:li:dataset:(urn:li:dataPlatform:postgres,lineageguard-canonical.lineageguard.analytics.customer_revenue,PROD)",
        downstreamField: "analytics.customer_revenue.customer_id",
      },
    },
    {
      id: "ev_6978b44631d58088fb428f8b",
      fingerprint: "6978b44631d58088fb428f8b83a255ef2a4f758bfb89539dbf3b7b677792a7fe",
      sourceUrn:
        "urn:li:mlModel:(urn:li:dataPlatform:mlflow,lineageguard-canonical.fraud-model-v3,PROD)",
      targetUrn: "urn:li:corpGroup:lineageguard-canonical.risk-ml",
      title: "Risk ML owner",
      summary: "Risk ML owns Fraud Model v3.",
      criticality: "HIGH",
      provenance: [
        {
          source: "DATAHUB_MCP",
          role: "OWNER",
          tool: "get_entities",
          invocationId: "canonical-risk-owner",
          retrievedAt: "2026-08-04T08:00:00.000Z",
          responseFingerprint: "96d6c825148f465827d85fe8d58e926c399334817ff168f410da67d268e2089e",
        },
      ],
      relatedEvidenceIds: ["ev_9fcccd9cd20afda2f0635602"],
      kind: "OWNER",
      payload: {
        assetUrn:
          "urn:li:mlModel:(urn:li:dataPlatform:mlflow,lineageguard-canonical.fraud-model-v3,PROD)",
        ownerUrn: "urn:li:corpGroup:lineageguard-canonical.risk-ml",
        displayName: "Risk ML",
        ownershipType: "TECHNICAL_OWNER",
      },
    },
    {
      id: "ev_9e907158dba3dd3b5ea635af",
      fingerprint: "9e907158dba3dd3b5ea635aff032242f6a347f9855195d3283f7e80fbeac684d",
      sourceUrn:
        "urn:li:dataset:(urn:li:dataPlatform:postgres,lineageguard-canonical.lineageguard.commerce.orders,PROD)",
      targetUrn: "urn:li:dashboard:(looker,lineageguard-canonical.finance-revenue-dashboard)",
      fieldPath: "commerce.orders.customer_id",
      title: "Finance dashboard lineage path",
      summary: "customer_id flows through the revenue datasets into the Finance dashboard.",
      criticality: "CRITICAL",
      provenance: [
        {
          source: "DATAHUB_MCP",
          role: "LINEAGE_DISCOVERY",
          tool: "get_lineage",
          invocationId: "canonical-lineage-discovery",
          retrievedAt: "2026-08-04T08:00:00.000Z",
          responseFingerprint: "b2b030b4e4a3ff1eec6b4b4451ea249fad021d1b0291ff1779cd2a9cd9e496fd",
        },
        {
          source: "DATAHUB_MCP",
          role: "FIELD_PATH",
          tool: "get_lineage_paths_between",
          invocationId: "canonical-lineage-revenue-field",
          retrievedAt: "2026-08-04T08:00:00.000Z",
          responseFingerprint: "32cfa71ac9624cae25b3d833747e76a5364f7a15b3a154b37783e216c815df7e",
        },
        {
          source: "DATAHUB_MCP",
          role: "ENTITY_PATH",
          tool: "get_lineage_paths_between",
          invocationId: "canonical-lineage-revenue-entity",
          retrievedAt: "2026-08-04T08:00:00.000Z",
          responseFingerprint: "71804b534206fab502c6a25a4531a0cfce8038e0377d93e4311661c61a95d5d7",
        },
      ],
      relatedEvidenceIds: [],
      kind: "LINEAGE_PATH",
      payload: {
        direction: "DOWNSTREAM",
        nodes: [
          "urn:li:dataset:(urn:li:dataPlatform:postgres,lineageguard-canonical.lineageguard.commerce.orders,PROD)",
          "urn:li:dataset:(urn:li:dataPlatform:postgres,lineageguard-canonical.lineageguard.analytics.stg_orders,PROD)",
          "urn:li:dataset:(urn:li:dataPlatform:postgres,lineageguard-canonical.lineageguard.analytics.customer_revenue,PROD)",
          "urn:li:dashboard:(looker,lineageguard-canonical.finance-revenue-dashboard)",
        ],
        segments: [
          {
            granularity: "FIELD",
            sourceUrn:
              "urn:li:dataset:(urn:li:dataPlatform:postgres,lineageguard-canonical.lineageguard.commerce.orders,PROD)",
            targetUrn:
              "urn:li:dataset:(urn:li:dataPlatform:postgres,lineageguard-canonical.lineageguard.analytics.stg_orders,PROD)",
            sourceFieldPath: "customer_id",
            targetFieldPath: "customer_id",
          },
          {
            granularity: "FIELD",
            sourceUrn:
              "urn:li:dataset:(urn:li:dataPlatform:postgres,lineageguard-canonical.lineageguard.analytics.stg_orders,PROD)",
            targetUrn:
              "urn:li:dataset:(urn:li:dataPlatform:postgres,lineageguard-canonical.lineageguard.analytics.customer_revenue,PROD)",
            sourceFieldPath: "customer_id",
            targetFieldPath: "customer_id",
          },
          {
            granularity: "ENTITY",
            sourceUrn:
              "urn:li:dataset:(urn:li:dataPlatform:postgres,lineageguard-canonical.lineageguard.analytics.customer_revenue,PROD)",
            targetUrn: "urn:li:dashboard:(looker,lineageguard-canonical.finance-revenue-dashboard)",
          },
        ],
        fieldLevel: true,
      },
    },
    {
      id: "ev_9fcccd9cd20afda2f0635602",
      fingerprint: "9fcccd9cd20afda2f063560283ce228b07e21314ded18886c31c0671944526c9",
      sourceUrn:
        "urn:li:dataset:(urn:li:dataPlatform:postgres,lineageguard-canonical.lineageguard.commerce.orders,PROD)",
      targetUrn:
        "urn:li:mlModel:(urn:li:dataPlatform:mlflow,lineageguard-canonical.fraud-model-v3,PROD)",
      fieldPath: "commerce.orders.customer_id",
      title: "Fraud Model v3",
      summary: "The production fraud model consumes customer_features.customer_id.",
      criticality: "CRITICAL",
      provenance: [
        {
          source: "DATAHUB_MCP",
          role: "ENTITY_DETAILS",
          tool: "get_entities",
          invocationId: "canonical-fraud-model",
          retrievedAt: "2026-08-04T08:00:00.000Z",
          responseFingerprint: "efefb46b166903130561bedfc825776214276ac530e80ca50b71ed1e41b7635f",
        },
      ],
      relatedEvidenceIds: ["ev_a193c7a6f647028a5d17fbac"],
      kind: "ML_MODEL",
      payload: {
        modelUrn:
          "urn:li:mlModel:(urn:li:dataPlatform:mlflow,lineageguard-canonical.fraud-model-v3,PROD)",
        lifecycle: "PRODUCTION",
        classificationUrns: [
          "urn:li:tag:lineageguard-canonical.Critical",
          "urn:li:tag:lineageguard-canonical.Production",
        ],
        ownershipObserved: true,
        ownerUrns: ["urn:li:corpGroup:lineageguard-canonical.risk-ml"],
        featureDatasetUrn:
          "urn:li:dataset:(urn:li:dataPlatform:postgres,lineageguard-canonical.lineageguard.fraud.customer_features,PROD)",
        featureField: "fraud.customer_features.customer_id",
        trainingDataReceipt: {
          aspectName: "trainingData",
          credentialClass: "READ",
          endpoint:
            "http://127.0.0.1:8080/openapi/v3/entity/mlModel/urn%3Ali%3AmlModel%3A(urn%3Ali%3AdataPlatform%3Amlflow%2Clineageguard-canonical.fraud-model-v3%2CPROD)/trainingData",
          modelUrn:
            "urn:li:mlModel:(urn:li:dataPlatform:mlflow,lineageguard-canonical.fraud-model-v3,PROD)",
          provenDatasetUrn:
            "urn:li:dataset:(urn:li:dataPlatform:postgres,lineageguard-canonical.lineageguard.fraud.customer_features,PROD)",
          responseSha256: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
          retrievedAt: "2026-08-04T08:00:00.000Z",
        },
      },
    },
    {
      id: "ev_a193c7a6f647028a5d17fbac",
      fingerprint: "a193c7a6f647028a5d17fbacf3a10f4f4d96e81bcbde975f62e885d572d4baa9",
      sourceUrn:
        "urn:li:dataset:(urn:li:dataPlatform:postgres,lineageguard-canonical.lineageguard.commerce.orders,PROD)",
      targetUrn:
        "urn:li:mlModel:(urn:li:dataPlatform:mlflow,lineageguard-canonical.fraud-model-v3,PROD)",
      fieldPath: "commerce.orders.customer_id",
      title: "Fraud model lineage path",
      summary: "customer_id flows through the fraud feature set into the production model.",
      criticality: "CRITICAL",
      provenance: [
        {
          source: "DATAHUB_MCP",
          role: "LINEAGE_DISCOVERY",
          tool: "get_lineage",
          invocationId: "canonical-lineage-discovery",
          retrievedAt: "2026-08-04T08:00:00.000Z",
          responseFingerprint: "b2b030b4e4a3ff1eec6b4b4451ea249fad021d1b0291ff1779cd2a9cd9e496fd",
        },
        {
          source: "DATAHUB_MCP",
          role: "FIELD_PATH",
          tool: "get_lineage_paths_between",
          invocationId: "canonical-lineage-fraud-field",
          retrievedAt: "2026-08-04T08:00:00.000Z",
          responseFingerprint: "12988896fee8ef847567bf232c0c617e6dae9dba07ccf732085e543a607e00d7",
        },
        {
          source: "DATAHUB_MCP",
          role: "ENTITY_PATH",
          tool: "get_lineage_paths_between",
          invocationId: "canonical-lineage-fraud-entity",
          retrievedAt: "2026-08-04T08:00:00.000Z",
          responseFingerprint: "abf002240fb6d90f987a6a4bcdcb52604bc5b962cc78307197499029995b0e97",
        },
      ],
      relatedEvidenceIds: [],
      kind: "LINEAGE_PATH",
      payload: {
        direction: "DOWNSTREAM",
        nodes: [
          "urn:li:dataset:(urn:li:dataPlatform:postgres,lineageguard-canonical.lineageguard.commerce.orders,PROD)",
          "urn:li:dataset:(urn:li:dataPlatform:postgres,lineageguard-canonical.lineageguard.analytics.stg_orders,PROD)",
          "urn:li:dataset:(urn:li:dataPlatform:postgres,lineageguard-canonical.lineageguard.fraud.customer_features,PROD)",
          "urn:li:mlModel:(urn:li:dataPlatform:mlflow,lineageguard-canonical.fraud-model-v3,PROD)",
        ],
        segments: [
          {
            granularity: "FIELD",
            sourceUrn:
              "urn:li:dataset:(urn:li:dataPlatform:postgres,lineageguard-canonical.lineageguard.commerce.orders,PROD)",
            targetUrn:
              "urn:li:dataset:(urn:li:dataPlatform:postgres,lineageguard-canonical.lineageguard.analytics.stg_orders,PROD)",
            sourceFieldPath: "customer_id",
            targetFieldPath: "customer_id",
          },
          {
            granularity: "FIELD",
            sourceUrn:
              "urn:li:dataset:(urn:li:dataPlatform:postgres,lineageguard-canonical.lineageguard.analytics.stg_orders,PROD)",
            targetUrn:
              "urn:li:dataset:(urn:li:dataPlatform:postgres,lineageguard-canonical.lineageguard.fraud.customer_features,PROD)",
            sourceFieldPath: "customer_id",
            targetFieldPath: "customer_id",
          },
          {
            granularity: "ENTITY",
            sourceUrn:
              "urn:li:dataset:(urn:li:dataPlatform:postgres,lineageguard-canonical.lineageguard.fraud.customer_features,PROD)",
            targetUrn:
              "urn:li:mlModel:(urn:li:dataPlatform:mlflow,lineageguard-canonical.fraud-model-v3,PROD)",
          },
        ],
        fieldLevel: true,
      },
    },
    {
      id: "ev_ba2121f8360a611382d3a157",
      fingerprint: "ba2121f8360a611382d3a15743b34f35adc483bf361cca7e24d4e2a5113e22e5",
      sourceUrn:
        "urn:li:dataset:(urn:li:dataPlatform:postgres,lineageguard-canonical.lineageguard.commerce.orders,PROD)",
      targetUrn: "urn:li:glossaryTerm:lineageguard-canonical.CustomerIdentifier",
      fieldPath: "commerce.orders.customer_id",
      title: "Customer Identifier",
      summary: "customer_id is governed by the Customer Identifier glossary term.",
      criticality: "HIGH",
      provenance: [
        {
          source: "DATAHUB_MCP",
          role: "GLOSSARY_BINDING",
          tool: "list_schema_fields",
          invocationId: "canonical-glossary-binding",
          retrievedAt: "2026-08-04T08:00:00.000Z",
          responseFingerprint: "f208b1c6a24a1c8d9ca3f2658f176b9e241da9ac9ab7c3d096f4b4b7791a306c",
        },
        {
          source: "DATAHUB_MCP",
          role: "GLOSSARY_DETAILS",
          tool: "get_entities",
          invocationId: "canonical-glossary-details",
          retrievedAt: "2026-08-04T08:00:00.000Z",
          responseFingerprint: "34aa89f12850a7f75ed673cbea27ad04bdf51f59ad656c75404369f827e255bb",
        },
      ],
      relatedEvidenceIds: [],
      kind: "GLOSSARY_TERM",
      payload: {
        termUrn: "urn:li:glossaryTerm:lineageguard-canonical.CustomerIdentifier",
        name: "Customer Identifier",
        schemaFieldUrn:
          "urn:li:schemaField:(urn:li:dataset:(urn:li:dataPlatform:postgres,lineageguard-canonical.lineageguard.commerce.orders,PROD),customer_id)",
        fieldPath: "commerce.orders.customer_id",
      },
    },
    {
      id: "ev_d4164db054a4481b94a20931",
      fingerprint: "d4164db054a4481b94a2093134f8ad047b9ca2026fc596e958378309dce701c6",
      sourceUrn: "urn:li:dashboard:(looker,lineageguard-canonical.finance-revenue-dashboard)",
      targetUrn: "urn:li:corpGroup:lineageguard-canonical.finance-analytics",
      title: "Finance Analytics owner",
      summary: "Finance Analytics owns the revenue dashboard.",
      criticality: "HIGH",
      provenance: [
        {
          source: "DATAHUB_MCP",
          role: "OWNER",
          tool: "get_entities",
          invocationId: "canonical-finance-owner",
          retrievedAt: "2026-08-04T08:00:00.000Z",
          responseFingerprint: "c1743e899688ed8d264e64f11d4bc5589bbb63705a411dcb4e8ba3af2d7a7a67",
        },
      ],
      relatedEvidenceIds: ["ev_59eb5c12bc8d30556ca933fe"],
      kind: "OWNER",
      payload: {
        assetUrn: "urn:li:dashboard:(looker,lineageguard-canonical.finance-revenue-dashboard)",
        ownerUrn: "urn:li:corpGroup:lineageguard-canonical.finance-analytics",
        displayName: "Finance Analytics",
        ownershipType: "BUSINESS_OWNER",
      },
    },
  ],
  failures: [],
};

/**
 * Recomputes every evidence id and fingerprint from the recorded semantic content instead of
 * trusting the literals above.
 *
 * The literals drifted silently once already: this fixture is only exercised by the Docker-gated
 * integration suite, so a UUID change and a new required ML receipt field left it invalid for weeks
 * while every non-skipped gate stayed green. Deriving the identities removes that whole class of
 * drift — the recorded evidence stays reviewable, but its identity can no longer be stale.
 *
 * Items are resolved in dependency order: an item is computed once every id it references has been
 * computed, so relatedEvidenceIds are remapped onto the freshly derived ids.
 */
function withDerivedEvidenceIdentities(
  evidence: ImpactContextData["evidence"],
): ImpactContextData["evidence"] {
  const remaining = evidence.map((item) => ({ ...item }));
  const idByOldId = new Map<string, string>();
  const resolved: ImpactContextData["evidence"] = [];

  while (remaining.length > 0) {
    const readyIndex = remaining.findIndex((item) =>
      item.relatedEvidenceIds.every((id) => idByOldId.has(id)),
    );
    if (readyIndex === -1) {
      throw new Error(
        "canonical fixture evidence has a cyclic or dangling relatedEvidenceIds graph",
      );
    }
    const [item] = remaining.splice(readyIndex, 1);
    if (!item) throw new Error("canonical fixture evidence iteration lost an item");
    const { id: oldId, fingerprint: _staleFingerprint, ...draft } = item;
    const derived = createEvidence({
      ...draft,
      relatedEvidenceIds: item.relatedEvidenceIds.map((id) => idByOldId.get(id) ?? id).sort(),
    } as Parameters<typeof createEvidence>[0]);
    idByOldId.set(oldId, derived.id);
    resolved.push(derived);
  }

  return resolved.sort((left, right) => left.id.localeCompare(right.id));
}

export function createCanonicalLiveImpactContextTestFixture(changeId: string): ImpactContext {
  const recorded = structuredClone(canonicalImpactContextData);
  const data: ImpactContextData = {
    ...recorded,
    evidence: withDerivedEvidenceIdentities(recorded.evidence),
    changeId,
    collectionOrigin: { mode: "LIVE" },
  };
  return impactContextSchema.parse({
    ...data,
    impactContextFingerprint: computeImpactContextFingerprint(data),
    collectionFingerprint: computeImpactCollectionFingerprint(data),
  });
}
