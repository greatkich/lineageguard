import { describe, expect, it } from "vitest";
import { canonicalDatasetRef, parseProposedChange } from "./change.js";
import {
  canonicalAnalyticsRevenueUrn,
  canonicalDashboardUrn,
  canonicalDatasetUrn,
  canonicalFraudModelUrn,
  canonicalGlossaryTermUrn,
  canonicalQueryUrn,
  canonicalSchemaFieldUrn,
  computeImpactCollectionFailureFingerprint,
  computeImpactCollectionFingerprint,
  computeImpactContextFingerprint,
  createCanonicalImpactContextFixture,
  createEvidence,
  evidenceItemSchema,
  impactCollectionFailureReportSchema,
  impactCollectionResultSchema,
  impactContextSchema,
} from "./evidence.js";
import { sha256 } from "./hash.js";
import * as domainPublic from "./index.js";
import {
  bindMigrationCandidate,
  migrationArtifactFingerprint,
  migrationCandidateFingerprint,
  migrationCandidateSchema,
} from "./migration.js";
import {
  assertRiskEvidenceReferences,
  bindGroundedRiskAssessment,
  compareAuthoritativeRisk,
  evaluateGroundedRisk,
  evaluateRepositoryBaseline,
  riskAssessmentSchema,
  riskComparisonSchema,
} from "./risk.js";
import { authorizeRunEvent, type RunEvent } from "./run.js";
import {
  expectedValidationExecutionSchema,
  liveValidationSignedPayloadFingerprint,
  signedLiveValidationReceiptFingerprint,
  signedLiveValidationReceiptSchema,
  type ValidationCheckName,
  type ValidatorCommandId,
  validationArtifactSetFingerprint,
  validationOutputFingerprint,
  validationReplayPresentationSchema,
} from "./validation.js";

const assessedAt = "2026-08-04T09:00:00.000Z";

function required<T>(value: T | undefined, message: string): T {
  if (value === undefined) throw new Error(message);
  return value;
}

function canonicalChange(
  patch = "ALTER TABLE commerce.orders RENAME COLUMN customer_id TO buyer_id;",
  headSha = "2".repeat(40),
) {
  const result = parseProposedChange({
    source: "FIXTURE",
    repository: "lineageguard/canonical",
    baseSha: "1".repeat(40),
    headSha,
    files: [
      {
        path: "walkthrough/migrations/rename.sql",
        datasetRef: canonicalDatasetRef,
        patch,
      },
    ],
  });
  if (!result.ok) throw new Error(result.error.message);
  return result.value;
}

function reboundContext(
  context: ReturnType<typeof createCanonicalImpactContextFixture>,
  overrides: Partial<
    Omit<
      ReturnType<typeof createCanonicalImpactContextFixture>,
      "impactContextFingerprint" | "collectionFingerprint"
    >
  >,
) {
  const {
    impactContextFingerprint: _fingerprint,
    collectionFingerprint: _collectionFingerprint,
    collectionOrigin: originalCollectionOrigin,
    ...identity
  } = context;
  const { collectionOrigin: overrideCollectionOrigin, ...dataOverrides } = overrides;
  const rebound = {
    ...identity,
    ...dataOverrides,
    evidence: (overrides.evidence ?? identity.evidence)
      .slice()
      .sort((left, right) => left.id.localeCompare(right.id)),
  };
  const liveRebound = {
    ...rebound,
    collectionOrigin: { mode: "LIVE" as const },
  };
  const impactContextFingerprint = computeImpactContextFingerprint(liveRebound);
  const sourceLiveCollectionFingerprint = computeImpactCollectionFingerprint(liveRebound);
  const requestedCollectionOrigin = overrideCollectionOrigin ?? originalCollectionOrigin;
  const collectionOrigin =
    requestedCollectionOrigin.mode === "LIVE"
      ? { mode: "LIVE" as const }
      : {
          mode: "VERIFIED_REPLAY" as const,
          manifestFingerprint: sha256({
            purpose: "LINEAGEGUARD_DOMAIN_TEST_REBOUND_MANIFEST",
            sourceLiveCollectionFingerprint,
            sourceImpactContextFingerprint: impactContextFingerprint,
          }),
          sourceLiveCollectionFingerprint,
          sourceImpactContextFingerprint: impactContextFingerprint,
        };
  const sourcedRebound = { ...rebound, collectionOrigin };
  return {
    ...sourcedRebound,
    impactContextFingerprint,
    collectionFingerprint: computeImpactCollectionFingerprint(sourcedRebound),
  };
}

function contextWithObservedOwnerAbsence(
  context: ReturnType<typeof createCanonicalImpactContextFixture>,
  omittedOwnerUrns = context.evidence
    .filter((item) => item.kind === "OWNER")
    .map((item) => item.payload.ownerUrn),
) {
  const omitted = new Set(omittedOwnerUrns);
  const evidence = context.evidence
    .filter((item) => item.kind !== "OWNER" || !omitted.has(item.payload.ownerUrn))
    .map((item) => {
      if (item.kind === "DASHBOARD") {
        const ownerUrns = item.payload.ownerUrns.filter((ownerUrn) => !omitted.has(ownerUrn));
        if (ownerUrns.length === item.payload.ownerUrns.length) return item;
        const { id: _id, fingerprint: _fingerprint, ...draft } = item;
        return createEvidence({ ...draft, payload: { ...draft.payload, ownerUrns } });
      }
      if (item.kind === "ML_MODEL") {
        const ownerUrns = item.payload.ownerUrns.filter((ownerUrn) => !omitted.has(ownerUrn));
        if (ownerUrns.length === item.payload.ownerUrns.length) return item;
        const { id: _id, fingerprint: _fingerprint, ...draft } = item;
        return createEvidence({ ...draft, payload: { ...draft.payload, ownerUrns } });
      }
      return item;
    });
  return reboundContext(context, { evidence });
}

function canonicalBundle() {
  const change = canonicalChange();
  const context = createCanonicalImpactContextFixture(change.id);
  const baseline = evaluateRepositoryBaseline(change, assessedAt);
  const grounded = evaluateGroundedRisk(change, context, assessedAt);
  return { change, context, baseline, grounded };
}

describe("canonical impact evidence", () => {
  it("contains schema, four hidden consumer outcomes, owners, and glossary with stable IDs", () => {
    const change = canonicalChange();
    const first = createCanonicalImpactContextFixture(change.id);
    const second = createCanonicalImpactContextFixture(change.id);
    expect(first).toEqual(second);
    expect(first.collectionOrigin).toMatchObject({
      mode: "VERIFIED_REPLAY",
      sourceImpactContextFingerprint: first.impactContextFingerprint,
    });
    const live = reboundContext(first, { collectionOrigin: { mode: "LIVE" } });
    expect(live.impactContextFingerprint).toBe(first.impactContextFingerprint);
    expect(live.collectionFingerprint).not.toBe(first.collectionFingerprint);
    if (first.collectionOrigin.mode !== "VERIFIED_REPLAY") {
      throw new Error("fixture must carry verified replay provenance");
    }
    expect(first.collectionOrigin.sourceLiveCollectionFingerprint).toBe(live.collectionFingerprint);
    expect(
      impactCollectionResultSchema.safeParse({ outcome: "COLLECTED_LIVE", context: live }).success,
    ).toBe(true);
    expect(
      impactCollectionResultSchema.safeParse({
        outcome: "COLLECTED_VERIFIED_REPLAY",
        context: first,
      }).success,
    ).toBe(true);
    expect(
      impactCollectionResultSchema.safeParse({ outcome: "COLLECTED_LIVE", context: first }).success,
    ).toBe(false);
    expect(
      impactCollectionResultSchema.safeParse({
        outcome: "COLLECTED_VERIFIED_REPLAY",
        context: live,
      }).success,
    ).toBe(false);
    expect(
      impactCollectionResultSchema.safeParse({ outcome: "COLLECTED", context: first }).success,
    ).toBe(false);
    const {
      impactContextFingerprint: replayImpactFingerprint,
      collectionFingerprint: _replayCollectionFingerprint,
      ...replayData
    } = first;
    const forgedReplayData = {
      ...replayData,
      collectionOrigin: {
        ...first.collectionOrigin,
        sourceImpactContextFingerprint: "f".repeat(64),
      },
    };
    expect(
      impactContextSchema.safeParse({
        ...forgedReplayData,
        impactContextFingerprint: replayImpactFingerprint,
        collectionFingerprint: computeImpactCollectionFingerprint(forgedReplayData),
      }).success,
    ).toBe(false);
    expect(first.impactContextFingerprint).toBe(
      "279bdd00ec97b74d63af2b9ac49732b17f5ee51f0ed1a35363898ab574076018",
    );
    expect(first.collectionFingerprint).toBe(
      "0163ea5ded6869208ac2be170b24532f758f3b9213baba6809514cb31736f5ba",
    );
    expect(first.evidence.map((item) => `${item.kind}:${item.id}`)).toEqual([
      "SCHEMA:ev_09d0ce72de399bd52bd82247",
      "QUERY_USAGE:ev_171e9e739d3d518e46aad9ee",
      "DASHBOARD:ev_59eb5c12bc8d30556ca933fe",
      "OWNER:ev_6978b44631d58088fb428f8b",
      "LINEAGE_PATH:ev_9e907158dba3dd3b5ea635af",
      "ML_MODEL:ev_9fcccd9cd20afda2f0635602",
      "LINEAGE_PATH:ev_a193c7a6f647028a5d17fbac",
      "GLOSSARY_TERM:ev_ba2121f8360a611382d3a157",
      "OWNER:ev_d4164db054a4481b94a20931",
    ]);
    expect(first.evidence.some((item) => item.kind === "SCHEMA")).toBe(true);
    expect(first.evidence.filter((item) => item.kind === "LINEAGE_PATH")).toHaveLength(2);
    expect(first.evidence.some((item) => item.kind === "DASHBOARD")).toBe(true);
    expect(first.evidence.some((item) => item.kind === "ML_MODEL")).toBe(true);
    expect(first.evidence.some((item) => item.kind === "QUERY_USAGE")).toBe(true);
    expect(first.evidence.filter((item) => item.kind === "OWNER")).toHaveLength(2);
    expect(first.evidence.some((item) => item.kind === "GLOSSARY_TERM")).toBe(true);
    expect(first.datasetUrn).toBe(canonicalDatasetUrn);
    expect(first.resolution.schemaFieldUrn).toBe(canonicalSchemaFieldUrn);
    const paths = first.evidence.filter((item) => item.kind === "LINEAGE_PATH");
    expect(paths.map((item) => item.targetUrn).sort()).toEqual(
      [canonicalDashboardUrn, canonicalFraudModelUrn].sort(),
    );
    expect(paths.every((item) => item.payload.segments.at(-1)?.granularity === "ENTITY")).toBe(
      true,
    );
    expect(
      paths.every(
        (item) =>
          item.provenance.map((entry) => `${entry.role}:${entry.tool}`).join(",") ===
          [
            "LINEAGE_DISCOVERY:get_lineage",
            "FIELD_PATH:get_lineage_paths_between",
            "ENTITY_PATH:get_lineage_paths_between",
          ].join(","),
      ),
    ).toBe(true);
    const query = first.evidence.find((item) => item.kind === "QUERY_USAGE");
    expect(query?.payload).toMatchObject({
      queryUrn: canonicalQueryUrn,
      source: "SYSTEM",
      observationBasis: "DATAHUB_QUERY_ENTITY",
      subjectDatasetUrn: canonicalAnalyticsRevenueUrn,
    });
    expect(query?.provenance.map((entry) => `${entry.role}:${entry.tool}`)).toEqual([
      "QUERY_DISCOVERY:get_dataset_queries",
      "QUERY_DETAILS:get_entities",
    ]);
    const glossary = first.evidence.find((item) => item.kind === "GLOSSARY_TERM");
    expect(glossary?.payload).toMatchObject({
      termUrn: canonicalGlossaryTermUrn,
      schemaFieldUrn: canonicalSchemaFieldUrn,
    });
    expect(glossary?.provenance.map((entry) => `${entry.role}:${entry.tool}`)).toEqual([
      "GLOSSARY_BINDING:list_schema_fields",
      "GLOSSARY_DETAILS:get_entities",
    ]);
  });

  it("preserves the adapter-supplied raw response fingerprint separately", () => {
    const context = createCanonicalImpactContextFixture(canonicalChange().id);
    const item = context.evidence.find((evidence) => evidence.kind === "SCHEMA");
    if (!item) throw new Error("fixture must have schema evidence");
    const changedRaw = {
      ...item,
      provenance: item.provenance.map((entry, index) =>
        index === 0 ? { ...entry, responseFingerprint: "b".repeat(64) } : entry,
      ),
    };
    const parsed = evidenceItemSchema.parse(changedRaw);
    expect(parsed.id).toBe(item.id);
    expect(parsed.fingerprint).toBe(item.fingerprint);
    expect(parsed.provenance[0]?.responseFingerprint).toBe("b".repeat(64));
  });

  it("requires every ordered MCP proof used to construct compound evidence", () => {
    const context = createCanonicalImpactContextFixture(canonicalChange().id);
    const query = context.evidence.find((item) => item.kind === "QUERY_USAGE");
    if (!query) throw new Error("fixture must have query evidence");
    const { id: _id, fingerprint: _fingerprint, ...queryDraft } = query;
    const incompleteQuery = createEvidence({
      ...queryDraft,
      provenance: [required(queryDraft.provenance[0], "query discovery provenance is required")],
    });
    const incompleteContext = reboundContext(context, {
      evidence: context.evidence.map((item) => (item.id === query.id ? incompleteQuery : item)),
    });
    expect(impactContextSchema.safeParse(incompleteContext).success).toBe(false);

    const reversedQuery = createEvidence({
      ...queryDraft,
      provenance: [...queryDraft.provenance].reverse(),
    });
    const reversedContext = reboundContext(context, {
      evidence: context.evidence.map((item) => (item.id === query.id ? reversedQuery : item)),
    });
    expect(impactContextSchema.safeParse(reversedContext).success).toBe(false);
  });

  it("rejects reversed call chronology and contradictory shared invocation provenance", () => {
    const context = createCanonicalImpactContextFixture(canonicalChange().id);
    const query = required(
      context.evidence.find((item) => item.kind === "QUERY_USAGE"),
      "query evidence",
    );
    const reversedChronology = reboundContext(context, {
      collectedAt: "2026-08-04T08:00:03.000Z",
      evidence: context.evidence.map((item) =>
        item.id === query.id
          ? {
              ...item,
              provenance: item.provenance.map((entry, index) => ({
                ...entry,
                retrievedAt: index === 0 ? "2026-08-04T08:00:02.000Z" : "2026-08-04T08:00:01.000Z",
              })),
            }
          : item,
      ),
    });
    expect(impactContextSchema.safeParse(reversedChronology).success).toBe(false);

    const paths = context.evidence.filter((item) => item.kind === "LINEAGE_PATH");
    const secondPath = required(paths[1], "second lineage path");
    const contradictoryInvocation = reboundContext(context, {
      evidence: context.evidence.map((item) =>
        item.id === secondPath.id
          ? {
              ...item,
              provenance: item.provenance.map((entry) =>
                entry.role === "LINEAGE_DISCOVERY"
                  ? { ...entry, responseFingerprint: "d".repeat(64) }
                  : entry,
              ),
            }
          : item,
      ),
    });
    expect(impactContextSchema.safeParse(contradictoryInvocation).success).toBe(false);
  });

  it("binds evidence ID and fingerprint to policy-relevant normalized fields", () => {
    const context = createCanonicalImpactContextFixture(canonicalChange().id);
    const item = context.evidence.find((evidence) => evidence.kind === "DASHBOARD");
    if (!item) throw new Error("fixture must have dashboard evidence");
    expect(evidenceItemSchema.safeParse({ ...item, criticality: "LOW" }).success).toBe(false);
  });

  it("rejects duplicate, dangling, and semantically mismatched evidence", () => {
    const context = createCanonicalImpactContextFixture(canonicalChange().id);
    expect(
      impactContextSchema.safeParse({
        ...context,
        evidence: [...context.evidence, context.evidence[0]],
      }).success,
    ).toBe(false);
    const wrongTopLevel = { ...context, datasetUrn: "urn:li:dataset:other" };
    expect(impactContextSchema.safeParse(wrongTopLevel).success).toBe(false);
    const lineage = context.evidence.find((item) => item.kind === "LINEAGE_PATH");
    if (!lineage) throw new Error("fixture must have lineage");
    const { id: _id, fingerprint: _fingerprint, ...draft } = lineage;
    const mismatchedLineage = createEvidence({
      ...draft,
      payload: { ...draft.payload, nodes: [...draft.payload.nodes].reverse() },
    });
    expect(
      impactContextSchema.safeParse({
        ...context,
        evidence: context.evidence.map((item) =>
          item.id === lineage.id ? mismatchedLineage : item,
        ),
      }).success,
    ).toBe(false);
  });

  it("rejects empty/incomplete COMPLETE but permits observed critical assets without owners", () => {
    const context = createCanonicalImpactContextFixture(canonicalChange().id);
    expect(impactContextSchema.safeParse({ ...context, evidence: [] }).success).toBe(false);
    const withoutOwners = contextWithObservedOwnerAbsence(context);
    expect(impactContextSchema.safeParse(withoutOwners).success).toBe(true);
  });

  it("distinguishes partial collection from a pre-resolution failure", () => {
    const context = createCanonicalImpactContextFixture(canonicalChange().id);
    expect(
      impactContextSchema.safeParse({ ...context, collectionStatus: "PARTIAL", failures: [] })
        .success,
    ).toBe(false);
    const partial = reboundContext(context, {
      collectionStatus: "PARTIAL",
      failures: [
        {
          tool: "get_lineage",
          invocationId: "lineage-timeout",
          code: "TIMEOUT",
          message: "Timed out.",
        },
      ],
    });
    expect(impactContextSchema.safeParse(partial).success).toBe(true);
    const failureIdentity = {
      requested: context.resolution.requested,
      failedAt: context.collectedAt,
      failures: [
        {
          tool: "search" as const,
          invocationId: "resolution-timeout",
          code: "TIMEOUT" as const,
          message: "Timed out.",
        },
      ],
    };
    expect(
      impactCollectionFailureReportSchema.safeParse({
        ...failureIdentity,
        failureFingerprint: computeImpactCollectionFailureFingerprint(failureIdentity),
      }).success,
    ).toBe(true);
    const failureReport = impactCollectionFailureReportSchema.parse({
      ...failureIdentity,
      failureFingerprint: computeImpactCollectionFailureFingerprint(failureIdentity),
    });
    expect(
      impactCollectionResultSchema.safeParse({
        outcome: "FAILED",
        mode: "LIVE",
        report: failureReport,
      }).success,
    ).toBe(true);
    expect(
      impactCollectionResultSchema.safeParse({ outcome: "FAILED", report: failureReport }).success,
    ).toBe(false);
    expect(
      impactContextSchema.safeParse({
        ...context,
        collectionStatus: "FAILED",
        evidence: [],
      }).success,
    ).toBe(false);
  });

  it("rejects forged canonical path, query, and classification semantics", () => {
    const context = createCanonicalImpactContextFixture(canonicalChange().id);
    const path = required(
      context.evidence.find((item) => item.kind === "LINEAGE_PATH"),
      "lineage path",
    );
    const { id: _pathId, fingerprint: _pathFingerprint, ...pathDraft } = path;
    const changedPath = createEvidence({
      ...pathDraft,
      payload: {
        ...pathDraft.payload,
        nodes: pathDraft.payload.nodes.map((node, index) =>
          index === 1 ? canonicalAnalyticsRevenueUrn : node,
        ),
        segments: pathDraft.payload.segments.map((segment, index) =>
          index === 0 ? { ...segment, targetUrn: canonicalAnalyticsRevenueUrn } : segment,
        ),
      },
    });
    expect(
      impactContextSchema.safeParse(
        reboundContext(context, {
          evidence: context.evidence.map((item) => (item.id === path.id ? changedPath : item)),
        }),
      ).success,
    ).toBe(false);

    const query = required(
      context.evidence.find((item) => item.kind === "QUERY_USAGE"),
      "query evidence",
    );
    const { id: _queryId, fingerprint: _queryFingerprint, ...queryDraft } = query;
    const changedQuery = createEvidence({
      ...queryDraft,
      payload: { ...queryDraft.payload, normalizedStatementFingerprint: "a".repeat(64) },
    });
    expect(
      impactContextSchema.safeParse(
        reboundContext(context, {
          evidence: context.evidence.map((item) => (item.id === query.id ? changedQuery : item)),
        }),
      ).success,
    ).toBe(false);

    const dashboard = required(
      context.evidence.find((item) => item.kind === "DASHBOARD"),
      "dashboard evidence",
    );
    const { id: _dashboardId, fingerprint: _dashboardFingerprint, ...dashboardDraft } = dashboard;
    const changedDashboard = createEvidence({
      ...dashboardDraft,
      payload: {
        ...dashboardDraft.payload,
        classificationUrns: [
          required(dashboardDraft.payload.classificationUrns[0], "dashboard classification"),
        ],
      },
    });
    expect(
      impactContextSchema.safeParse(
        reboundContext(context, {
          evidence: context.evidence.map((item) =>
            item.id === dashboard.id ? changedDashboard : item,
          ),
        }),
      ).success,
    ).toBe(false);
  });
});

describe("deterministic risk policy", () => {
  it("changes the canonical repository-only ALLOW/LOW assessment to grounded BLOCK", () => {
    const { change, context, baseline, grounded } = canonicalBundle();
    const comparison = compareAuthoritativeRisk(change, context, {
      baseline: assessedAt,
      grounded: assessedAt,
    });
    expect(baseline).toMatchObject({ decision: "ALLOW", risk: "LOW", reasons: [] });
    expect(grounded.decision).toBe("BLOCK");
    expect(grounded.reasons.map((item) => item.ruleId)).toEqual([
      "LG001",
      "LG002",
      "LG003",
      "LG004",
    ]);
    expect(comparison).toMatchObject({ decisionChanged: true, transition: "ALLOW→BLOCK" });
    const evidenceIds = new Set(context.evidence.map((item) => item.id));
    expect(
      grounded.reasons.every((reason) => reason.evidenceIds.every((id) => evidenceIds.has(id))),
    ).toBe(true);
  });

  it("requires canonical evidence ordering and fails closed on mismatched change binding", () => {
    const { context } = canonicalBundle();
    expect(
      impactContextSchema.safeParse({ ...context, evidence: [...context.evidence].reverse() })
        .success,
    ).toBe(false);
    const otherChange = canonicalChange(undefined, "3".repeat(40));
    expect(() => evaluateGroundedRisk(otherChange, context, assessedAt)).toThrow(/not bound/);
  });

  it("binds LG003 to the exact observed SYSTEM query evidence", () => {
    const { grounded, context } = canonicalBundle();
    const query = required(
      context.evidence.find((item) => item.kind === "QUERY_USAGE"),
      "query evidence",
    );
    expect(grounded.reasons.find((reason) => reason.ruleId === "LG003")).toMatchObject({
      message: "An observed system query references the renamed field.",
      evidenceIds: [query.id],
    });
  });

  it("triggers LG005 for complete collected critical assets without owners", () => {
    const { change, context } = canonicalBundle();
    const withoutOwners = contextWithObservedOwnerAbsence(context);
    const assessment = evaluateGroundedRisk(change, withoutOwners, assessedAt);
    expect(
      assessment.reasons.find((reason) => reason.ruleId === "LG005")?.evidenceIds,
    ).toHaveLength(2);
    expect(
      evaluateGroundedRisk(change, context, assessedAt).reasons.some(
        (reason) => reason.ruleId === "LG005",
      ),
    ).toBe(false);
  });

  it("binds full provenance and enforces collection/evaluation ordering", () => {
    const { change, context, grounded } = canonicalBundle();
    expect(grounded.impactContextFingerprint).toBe(context.impactContextFingerprint);
    const first = required(context.evidence[0], "context must have evidence");
    const changedProvenance = {
      ...context,
      evidence: context.evidence.map((item) =>
        item.id === first.id
          ? {
              ...item,
              provenance: item.provenance.map((entry, index) =>
                index === 0 ? { ...entry, responseFingerprint: "c".repeat(64) } : entry,
              ),
            }
          : item,
      ),
    };
    expect(impactContextSchema.safeParse(changedProvenance).success).toBe(false);
    const rebound = reboundContext(context, { evidence: changedProvenance.evidence });
    expect(rebound.impactContextFingerprint).toBe(context.impactContextFingerprint);
    expect(rebound.collectionFingerprint).not.toBe(context.collectionFingerprint);
    expect(() => assertRiskEvidenceReferences(change, grounded, rebound)).not.toThrow();
    expect(() => evaluateGroundedRisk(change, context, "2026-08-04T07:59:59.999Z")).toThrow(
      /precede context collection/,
    );
  });

  it("rejects contradictory assessment and comparison payloads", () => {
    const { grounded } = canonicalBundle();
    expect(riskAssessmentSchema.safeParse({ ...grounded, decision: "ALLOW" }).success).toBe(false);
    expect(riskAssessmentSchema.safeParse({ ...grounded, risk: "LOW" }).success).toBe(false);
    expect(
      riskAssessmentSchema.safeParse({
        ...grounded,
        reasons: grounded.reasons.map((reason, index) =>
          index === 0 ? { ...reason, severity: "LOW" } : reason,
        ),
      }).success,
    ).toBe(false);
    const comparison = compareAuthoritativeRisk(canonicalChange(), canonicalBundle().context, {
      baseline: assessedAt,
      grounded: assessedAt,
    });
    expect(
      riskComparisonSchema.safeParse({ ...comparison, transition: "ALLOW→ALLOW" }).success,
    ).toBe(false);
    expect(
      riskComparisonSchema.safeParse({ ...comparison, changedBecauseEvidenceIds: [] }).success,
    ).toBe(false);
    expect(riskComparisonSchema.safeParse({ ...comparison, triggeredRuleIds: [] }).success).toBe(
      false,
    );
  });

  it("rejects a schema-valid caller-supplied grounded ALLOW decision", () => {
    const { change, context } = canonicalBundle();
    const tampered = riskAssessmentSchema.parse({
      changeId: change.id,
      impactContextFingerprint: context.impactContextFingerprint,
      contextMode: "DATAHUB_GROUNDED",
      decision: "ALLOW",
      risk: "LOW",
      reasons: [],
      evaluatedAt: assessedAt,
      policyVersion: "lineageguard-p0.1",
    });
    expect(() => bindGroundedRiskAssessment(change, context, tampered)).toThrow(/authoritative/);
    expect(() =>
      compareAuthoritativeRisk(
        change,
        { ...context, impactContextFingerprint: "f".repeat(64) },
        { baseline: assessedAt, grounded: assessedAt },
      ),
    ).toThrow();
  });
});

function candidateInput(bundle = canonicalBundle()) {
  const { change, context, grounded } = bundle;
  const sourceEvidenceIds = [
    ...new Set(grounded.reasons.flatMap((reason) => reason.evidenceIds)),
  ].sort();
  return {
    strategy: "EXPAND_MIGRATE_CONTRACT",
    sourceChangeFingerprint: change.fingerprint,
    sourcePatchFingerprint: change.sourcePatchFingerprint,
    sourceImpactContextFingerprint: context.impactContextFingerprint,
    sourceDecision: "BLOCK",
    sourceEvidenceIds,
    summary: "Add buyer_id, migrate readers, then retire customer_id after compatibility.",
    steps: [
      {
        id: "step_expand",
        phase: "EXPAND",
        title: "Expand",
        rationale: "Keep old consumers working.",
        affectedEvidenceIds: sourceEvidenceIds.slice(0, 2),
        artifactTargets: [
          "walkthrough/migrations/001_expand.sql",
          "walkthrough/migrations/001_rollback.sql",
        ],
      },
      {
        id: "step_migrate",
        phase: "MIGRATE",
        title: "Migrate",
        rationale: "Backfill and move controlled readers.",
        affectedEvidenceIds: sourceEvidenceIds.slice(2),
        artifactTargets: ["walkthrough/models/orders.sql", "walkthrough/tests/orders_compat.sql"],
      },
      {
        id: "step_contract",
        phase: "CONTRACT",
        title: "Contract",
        rationale: "Retire the compatibility field after approval.",
        affectedEvidenceIds: [sourceEvidenceIds[0]],
        artifactTargets: ["docs/migrations/customer-id.md"],
      },
    ],
    artifacts: [
      {
        operation: "CREATE",
        path: "walkthrough/migrations/001_expand.sql",
        kind: "SQL_MIGRATION",
        content: "alter table commerce.orders add column buyer_id bigint;",
      },
      {
        operation: "CREATE",
        path: "walkthrough/migrations/001_rollback.sql",
        kind: "ROLLBACK_SQL",
        content: "alter table commerce.orders drop column buyer_id;",
      },
      {
        operation: "MODIFY",
        expectedBaseSha: change.baseSha,
        path: "walkthrough/models/orders.sql",
        kind: "DBT_MODEL",
        content: "select customer_id, buyer_id from commerce.orders",
      },
      {
        operation: "CREATE",
        path: "walkthrough/tests/orders_compat.sql",
        kind: "DBT_TEST",
        content: "select * from commerce.orders where customer_id <> buyer_id",
      },
      {
        operation: "CREATE",
        path: "docs/migrations/customer-id.md",
        kind: "MIGRATION_DOCUMENT",
        content: "Compatibility and rollback plan.",
      },
    ].sort((left, right) => (left.path < right.path ? -1 : left.path > right.path ? 1 : 0)),
    requiredReviewers: [
      ...Array.from(
        context.evidence
          .filter((item) => item.kind === "OWNER")
          .reduce((reviewers, item) => {
            const current = reviewers.get(item.payload.ownerUrn) ?? [];
            reviewers.set(item.payload.ownerUrn, [...current, item.payload.assetUrn]);
            return reviewers;
          }, new Map<string, string[]>())
          .entries(),
        ([ownerUrn, affectedAssetUrns]) => ({
          kind: "OWNER" as const,
          ownerUrn,
          affectedAssetUrns: affectedAssetUrns.sort(),
          reason: "Recorded critical asset owner",
        }),
      ),
      ...(grounded.reasons.find((reason) => reason.ruleId === "LG005")?.evidenceIds ?? []).map(
        (evidenceId) => {
          const item = required(
            context.evidence.find((evidence) => evidence.id === evidenceId),
            "LG005 evidence must exist",
          );
          if (item.kind !== "DASHBOARD" && item.kind !== "ML_MODEL") {
            throw new Error("LG005 evidence must identify a critical asset");
          }
          return {
            kind: "UNRESOLVED_OWNER" as const,
            evidenceId,
            affectedAssetUrn:
              item.kind === "DASHBOARD" ? item.payload.dashboardUrn : item.payload.modelUrn,
            fallbackAuthority: "DATA_PLATFORM_OWNER" as const,
            reason: "No recorded owner; escalate to the data platform owner",
          };
        },
      ),
    ].sort((left, right) => {
      const leftKey =
        left.kind === "OWNER"
          ? `OWNER:${left.ownerUrn}`
          : `UNRESOLVED_OWNER:${left.evidenceId}:${left.affectedAssetUrn}`;
      const rightKey =
        right.kind === "OWNER"
          ? `OWNER:${right.ownerUrn}`
          : `UNRESOLVED_OWNER:${right.evidenceId}:${right.affectedAssetUrn}`;
      return leftKey.localeCompare(rightKey);
    }),
    compatibilityWindowDays: 30,
    rollbackPlan: "Run the rollback SQL while customer_id remains the source of truth.",
  };
}

describe("migration contracts and binding", () => {
  it("accepts and binds the exact ordered, typed artifact contract", () => {
    const bundle = canonicalBundle();
    const candidate = migrationCandidateSchema.parse(candidateInput());
    expect(
      bindMigrationCandidate(candidate, bundle.change, bundle.context, bundle.grounded),
    ).toEqual(candidate);
  });

  it("rejects wrong paths, operations, phase reuse, missing rollback, and authority fields", () => {
    const path = structuredClone(candidateInput());
    required(
      path.artifacts.find((artifact) => artifact.kind === "SQL_MIGRATION"),
      "candidate must have SQL",
    ).path = "src/payload.sql";
    expect(migrationCandidateSchema.safeParse(path).success).toBe(false);
    const operation = structuredClone(candidateInput());
    required(
      operation.artifacts.find((artifact) => artifact.kind === "DBT_MODEL"),
      "candidate must have model",
    ).operation = "CREATE";
    expect(migrationCandidateSchema.safeParse(operation).success).toBe(false);
    const reused = structuredClone(candidateInput());
    required(reused.steps[1], "candidate must have migrate step").artifactTargets.push(
      "walkthrough/migrations/001_expand.sql",
    );
    expect(migrationCandidateSchema.safeParse(reused).success).toBe(false);
    const noRollback = structuredClone(candidateInput());
    noRollback.artifacts = noRollback.artifacts.filter(
      (artifact) => artifact.kind !== "ROLLBACK_SQL",
    );
    expect(migrationCandidateSchema.safeParse(noRollback).success).toBe(false);
    expect(
      migrationCandidateSchema.safeParse({ ...candidateInput(), command: "apply" }).success,
    ).toBe(false);
    expect(
      migrationCandidateSchema.safeParse({ ...candidateInput(), deletePaths: ["src"] }).success,
    ).toBe(false);
    expect(
      migrationCandidateSchema.safeParse({ ...candidateInput(), authority: "ALLOW" }).success,
    ).toBe(false);
    for (const unsafePath of [
      "/walkthrough/models/orders.sql",
      "walkthrough\\models\\orders.sql",
      "walkthrough/models/../orders.sql",
      "walkthrough/models//orders.sql",
      `walkthrough/models/${"a".repeat(230)}.sql`,
    ]) {
      const unsafe = structuredClone(candidateInput());
      required(
        unsafe.artifacts.find((artifact) => artifact.kind === "DBT_MODEL"),
        "model",
      ).path = unsafePath;
      expect(migrationCandidateSchema.safeParse(unsafe).success).toBe(false);
    }
  });

  it("requires every migration artifact role and rejects a test-only bypass", () => {
    for (const kind of [
      "SQL_MIGRATION",
      "ROLLBACK_SQL",
      "DBT_MODEL",
      "DBT_TEST",
      "MIGRATION_DOCUMENT",
    ] as const) {
      const missing = structuredClone(candidateInput());
      missing.artifacts = missing.artifacts.filter((artifact) => artifact.kind !== kind);
      expect(migrationCandidateSchema.safeParse(missing).success).toBe(false);
    }

    const bypass = structuredClone(candidateInput());
    const modelIndex = bypass.artifacts.findIndex((artifact) => artifact.kind === "DBT_MODEL");
    if (modelIndex < 0) throw new Error("candidate must have model");
    const modelPath = bypass.artifacts[modelIndex]?.path;
    bypass.artifacts[modelIndex] = {
      operation: "CREATE",
      path: "walkthrough/tests/orders_model_shape.sql",
      kind: "DBT_TEST",
      content: "select 1 where false",
    };
    const migrate = required(
      bypass.steps.find((step) => step.phase === "MIGRATE"),
      "migrate step",
    );
    migrate.artifactTargets = migrate.artifactTargets
      .map((path) => (path === modelPath ? "walkthrough/tests/orders_model_shape.sql" : path))
      .sort();
    bypass.artifacts.sort((left, right) => left.path.localeCompare(right.path));
    expect(migrationCandidateSchema.safeParse(bypass).success).toBe(false);
  });

  it("binds exact owner reviewers and unresolved-owner fallbacks", () => {
    const canonical = canonicalBundle();
    const withoutOwners = contextWithObservedOwnerAbsence(canonical.context);
    const zeroOwnerBundle = {
      ...canonical,
      context: withoutOwners,
      grounded: evaluateGroundedRisk(canonical.change, withoutOwners, assessedAt),
    };
    const zeroOwnerCandidate = migrationCandidateSchema.parse(candidateInput(zeroOwnerBundle));
    expect(() =>
      bindMigrationCandidate(
        zeroOwnerCandidate,
        zeroOwnerBundle.change,
        zeroOwnerBundle.context,
        zeroOwnerBundle.grounded,
      ),
    ).not.toThrow();

    const ownerToRemove = required(
      canonical.context.evidence.find((item) => item.kind === "OWNER"),
      "owner evidence",
    );
    const partialOwners = contextWithObservedOwnerAbsence(canonical.context, [
      ownerToRemove.payload.ownerUrn,
    ]);
    const partialBundle = {
      ...canonical,
      context: partialOwners,
      grounded: evaluateGroundedRisk(canonical.change, partialOwners, assessedAt),
    };
    const partialCandidate = migrationCandidateSchema.parse(candidateInput(partialBundle));
    expect(() =>
      bindMigrationCandidate(
        partialCandidate,
        partialBundle.change,
        partialBundle.context,
        partialBundle.grounded,
      ),
    ).not.toThrow();

    const missingEscalation = structuredClone(partialCandidate);
    missingEscalation.requiredReviewers = missingEscalation.requiredReviewers.filter(
      (reviewer) => reviewer.kind !== "UNRESOLVED_OWNER",
    );
    expect(() =>
      bindMigrationCandidate(
        migrationCandidateSchema.parse(missingEscalation),
        partialBundle.change,
        partialBundle.context,
        partialBundle.grounded,
      ),
    ).toThrow(/escalations/);

    const wrongOwnerAssets = structuredClone(migrationCandidateSchema.parse(candidateInput()));
    const ownerReviewer = required(
      wrongOwnerAssets.requiredReviewers.find((reviewer) => reviewer.kind === "OWNER"),
      "owner reviewer",
    );
    if (ownerReviewer.kind !== "OWNER") throw new Error("expected owner reviewer");
    ownerReviewer.affectedAssetUrns = ["urn:li:dashboard:(looker,wrong)"];
    expect(() =>
      bindMigrationCandidate(
        wrongOwnerAssets,
        canonical.change,
        canonical.context,
        canonical.grounded,
      ),
    ).toThrow(/owner reviewer assets/);
  });

  it("fails binding for wrong input fingerprints, evidence, decision, and base SHA", () => {
    const bundle = canonicalBundle();
    const wrongFingerprint = migrationCandidateSchema.parse({
      ...candidateInput(),
      sourceChangeFingerprint: "a".repeat(64),
    });
    expect(() =>
      bindMigrationCandidate(wrongFingerprint, bundle.change, bundle.context, bundle.grounded),
    ).toThrow();
    const wrongBaseInput = candidateInput();
    required(
      wrongBaseInput.artifacts.find((artifact) => artifact.kind === "DBT_MODEL"),
      "candidate must have model artifact",
    ).expectedBaseSha = "3".repeat(40);
    const wrongBase = migrationCandidateSchema.parse(wrongBaseInput);
    expect(() =>
      bindMigrationCandidate(wrongBase, bundle.change, bundle.context, bundle.grounded),
    ).toThrow(/base SHA/);
    expect(
      migrationCandidateSchema.safeParse({ ...candidateInput(), sourceDecision: "ALLOW" }).success,
    ).toBe(false);
    const missingEvidence = structuredClone(candidateInput());
    missingEvidence.sourceEvidenceIds = missingEvidence.sourceEvidenceIds.slice(1);
    expect(migrationCandidateSchema.safeParse(missingEvidence).success).toBe(false);
    const wrongContext = migrationCandidateSchema.parse({
      ...candidateInput(),
      sourceImpactContextFingerprint: "d".repeat(64),
    });
    expect(() =>
      bindMigrationCandidate(wrongContext, bundle.change, bundle.context, bundle.grounded),
    ).toThrow(/source binding/);
    const firstReviewer = candidateInput().requiredReviewers[0];
    if (!firstReviewer) throw new Error("candidate must have reviewer");
    const missingReviewer = migrationCandidateSchema.parse({
      ...candidateInput(),
      requiredReviewers: [firstReviewer],
    });
    expect(() =>
      bindMigrationCandidate(missingReviewer, bundle.change, bundle.context, bundle.grounded),
    ).toThrow(/reviewers/);
  });
});
const checkCommands: Record<ValidationCheckName, ValidatorCommandId> = {
  SQL_MIGRATION: "VALIDATE_SQL_MIGRATION_V1",
  BACKFILL_EQUALITY: "VALIDATE_BACKFILL_EQUALITY_V1",
  DBT_PARSE: "VALIDATE_DBT_PARSE_V1",
  DBT_COMPILE: "VALIDATE_DBT_COMPILE_V1",
  DBT_TEST: "VALIDATE_DBT_TEST_V1",
  OLD_CONSUMER_COMPATIBILITY: "VALIDATE_OLD_CONSUMER_V1",
  NEW_CONSUMER_COMPATIBILITY: "VALIDATE_NEW_CONSUMER_V1",
  ROLLBACK: "VALIDATE_ROLLBACK_V1",
};

function expectedValidationExecution() {
  return expectedValidationExecutionSchema.parse({
    schemaVersion: 1,
    purpose: "LINEAGEGUARD_EXPECTED_VALIDATION_EXECUTION",
    runId: "run_111111111111111111111111",
    sandboxId: "sandbox-p0-validation",
    worktreeId: "worktree-p0-domain-policy",
    leaseId: "lease_111111111111111111111111",
    workerId: "validation-worker-1",
    generation: 1,
    validators: (Object.keys(checkCommands) as ValidationCheckName[]).map((check) => ({
      check,
      commandId: checkCommands[check],
      implementationId: `lineageguard-${check.toLowerCase()}`,
      version: "1.0.0",
      digest: sha256(`validator:${check}:1.0.0`),
    })),
  });
}

function signedLiveReceiptInput(candidate = migrationCandidateSchema.parse(candidateInput())) {
  const bundle = canonicalBundle();
  const expected = expectedValidationExecution();
  const artifactPaths = candidate.artifacts.map((artifact) => artifact.path).sort();
  const artifactObservations = candidate.artifacts
    .map((artifact) => ({
      path: artifact.path,
      candidateArtifactFingerprint: migrationArtifactFingerprint(artifact),
      materializedSha256: sha256(artifact.content),
    }))
    .sort((left, right) => left.path.localeCompare(right.path));
  const pathsForCheck = (check: ValidationCheckName): string[] => {
    if (check === "SQL_MIGRATION" || check === "BACKFILL_EQUALITY") {
      return candidate.artifacts
        .filter((artifact) => artifact.kind === "SQL_MIGRATION")
        .map((artifact) => artifact.path)
        .sort();
    }
    if (check === "DBT_PARSE" || check === "DBT_COMPILE" || check === "DBT_TEST") {
      return candidate.artifacts
        .filter((artifact) => artifact.kind === "DBT_MODEL" || artifact.kind === "DBT_TEST")
        .map((artifact) => artifact.path)
        .sort();
    }
    if (check === "ROLLBACK") {
      return candidate.artifacts
        .filter((artifact) => artifact.kind === "ROLLBACK_SQL")
        .map((artifact) => artifact.path);
    }
    return candidate.artifacts
      .filter((artifact) => ["SQL_MIGRATION", "DBT_MODEL", "DBT_TEST"].includes(artifact.kind))
      .map((artifact) => artifact.path)
      .sort();
  };
  const protectedHeaders = {
    schemaVersion: 1,
    purpose: "LINEAGEGUARD_VALIDATION_LIVE",
    algorithm: "ED25519",
    issuer: "lineageguard-validation-service",
    keyId: "validation-key-2026-08",
    candidateFingerprint: migrationCandidateFingerprint(candidate),
    changeFingerprint: bundle.change.fingerprint,
    impactContextFingerprint: bundle.context.impactContextFingerprint,
    authoritativeGroundedAssessmentFingerprint: sha256(bundle.grounded),
    authoritativeGroundedDecision: "BLOCK",
    authorizedRunEventStreamFingerprint: sha256("authorized-run-stream"),
    leaseAcquiredAt: "2026-08-04T09:59:00.000Z",
    leaseExpiresAt: "2026-08-04T10:11:00.000Z",
    runId: expected.runId,
    sandboxId: expected.sandboxId,
    worktreeId: expected.worktreeId,
    leaseId: expected.leaseId,
    workerId: expected.workerId,
    generation: expected.generation,
  } as const;
  const payload = {
    status: "PASS" as const,
    artifactPaths,
    artifactObservations,
    artifactSetFingerprint: validationArtifactSetFingerprint(artifactObservations),
    checks: (Object.keys(checkCommands) as ValidationCheckName[]).map((check, index) => {
      const validator = required(
        expected.validators.find((item) => item.check === check),
        "expected validator",
      );
      const checkArtifactPaths = pathsForCheck(check);
      const observations = artifactObservations.filter((observation) =>
        checkArtifactPaths.includes(observation.path),
      );
      const stdoutFingerprint = sha256(`${check}:stdout`);
      const stderrFingerprint = sha256(`${check}:stderr`);
      return {
        check,
        status: "PASS" as const,
        artifactPaths: checkArtifactPaths,
        artifactObservations: observations,
        artifactSetFingerprint: validationArtifactSetFingerprint(observations),
        validatorImplementationId: validator.implementationId,
        validatorVersion: validator.version,
        validatorDigest: validator.digest,
        commandId: validator.commandId,
        exitCode: 0 as const,
        startedAt: `2026-08-04T10:00:0${index}.000Z`,
        finishedAt: `2026-08-04T10:00:0${index}.500Z`,
        stdoutFingerprint,
        stderrFingerprint,
        outputFingerprint: validationOutputFingerprint({
          schemaVersion: 1,
          purpose: "LINEAGEGUARD_VALIDATOR_OUTPUT",
          check,
          exitCode: 0,
          stdoutFingerprint,
          stderrFingerprint,
          artifactObservations: observations,
        }),
        runId: expected.runId,
        sandboxId: expected.sandboxId,
        worktreeId: expected.worktreeId,
        leaseId: expected.leaseId,
        workerId: expected.workerId,
        generation: expected.generation,
      };
    }),
    completedAt: "2026-08-04T10:00:10.000Z",
  };
  return signedLiveValidationReceiptSchema.parse({
    protectedHeaders,
    payload,
    signedPayloadFingerprint: liveValidationSignedPayloadFingerprint({
      protectedHeaders,
      payload,
    }),
    signature: `${"a".repeat(85)}g`,
  });
}

describe("signed LIVE validation data contracts", () => {
  it("exposes no structural PASS or acceptance capability from the root API", () => {
    expect("createCanonicalImpactContextFixture" in domainPublic).toBe(false);
    expect("acceptExecutedValidationReceipt" in domainPublic).toBe(false);
    expect("AcceptedExecutedValidationReceipt" in domainPublic).toBe(false);
    expect("ValidationAttestationVerifier" in domainPublic).toBe(false);
    expect("structuralValidationReceiptSchema" in domainPublic).toBe(false);
    expect("assertStructuralValidationReceiptBinding" in domainPublic).toBe(false);
    const live = signedLiveReceiptInput();
    expect(signedLiveValidationReceiptSchema.safeParse(live).success).toBe(true);
    expect(
      signedLiveValidationReceiptSchema.safeParse({ ...live, receiptId: "caller-id" }).success,
    ).toBe(false);
  });

  it("domain-separates signed identity, policy, fence, and output data", () => {
    const receipt = signedLiveReceiptInput();
    const unsigned = {
      protectedHeaders: receipt.protectedHeaders,
      payload: receipt.payload,
    };
    const fingerprint = liveValidationSignedPayloadFingerprint(unsigned);
    for (const protectedHeaders of [
      { ...receipt.protectedHeaders, issuer: "different-issuer" },
      { ...receipt.protectedHeaders, keyId: "different-key" },
      { ...receipt.protectedHeaders, algorithm: "HMAC-SHA256" as const },
      { ...receipt.protectedHeaders, changeFingerprint: "b".repeat(64) },
      { ...receipt.protectedHeaders, impactContextFingerprint: "c".repeat(64) },
      { ...receipt.protectedHeaders, generation: 2 },
    ]) {
      expect(
        liveValidationSignedPayloadFingerprint({ protectedHeaders, payload: receipt.payload }),
      ).not.toBe(fingerprint);
    }
    const changedOutput = structuredClone(unsigned);
    required(changedOutput.payload.checks[0], "check").stdoutFingerprint = sha256("different");
    expect(
      sha256({
        domain: "lineageguard.validation.signed-live-envelope.v1",
        envelope: changedOutput,
      }),
    ).not.toBe(fingerprint);
    expect(
      signedLiveValidationReceiptSchema.safeParse({ ...receipt, payload: changedOutput.payload })
        .success,
    ).toBe(false);
    for (const protectedHeaders of [
      { ...receipt.protectedHeaders, purpose: "OTHER_PURPOSE" },
      { ...receipt.protectedHeaders, authoritativeGroundedDecision: "ALLOW" },
    ]) {
      expect(
        sha256({
          domain: "lineageguard.validation.signed-live-envelope.v1",
          envelope: { protectedHeaders, payload: receipt.payload },
        }),
      ).not.toBe(fingerprint);
      expect(
        signedLiveValidationReceiptSchema.safeParse({ ...receipt, protectedHeaders }).success,
      ).toBe(false);
    }
  });

  it("accepts one canonical Base64URL spelling per signature byte sequence", () => {
    const ed25519 = signedLiveReceiptInput();
    const noncanonicalEd25519 = {
      ...ed25519,
      signature: `${ed25519.signature.slice(0, -1)}h`,
    };
    expect(
      Buffer.from(ed25519.signature, "base64url").equals(
        Buffer.from(noncanonicalEd25519.signature, "base64url"),
      ),
    ).toBe(true);
    expect(signedLiveValidationReceiptSchema.safeParse(noncanonicalEd25519).success).toBe(false);
    expect(() =>
      signedLiveValidationReceiptFingerprint(noncanonicalEd25519 as typeof ed25519),
    ).toThrow(/canonical unpadded Base64URL/);

    const hmacHeaders = {
      ...ed25519.protectedHeaders,
      algorithm: "HMAC-SHA256" as const,
    };
    const hmac = signedLiveValidationReceiptSchema.parse({
      ...ed25519,
      protectedHeaders: hmacHeaders,
      signedPayloadFingerprint: liveValidationSignedPayloadFingerprint({
        protectedHeaders: hmacHeaders,
        payload: ed25519.payload,
      }),
      signature: `${"a".repeat(42)}A`,
    });
    expect(signedLiveValidationReceiptFingerprint(hmac)).toHaveLength(64);
    expect(
      signedLiveValidationReceiptSchema.safeParse({
        ...hmac,
        signature: `${hmac.signature.slice(0, -1)}B`,
      }).success,
    ).toBe(false);
    expect(
      Buffer.from(hmac.signature, "base64url").equals(
        Buffer.from(`${hmac.signature.slice(0, -1)}B`, "base64url"),
      ),
    ).toBe(true);
  });

  it("rejects malformed or incomplete expected validator configuration", () => {
    const expected = expectedValidationExecution();
    expect(
      expectedValidationExecutionSchema.safeParse({ ...expected, validators: [] }).success,
    ).toBe(false);
    expect(
      expectedValidationExecutionSchema.safeParse({
        ...expected,
        validators: expected.validators.map((validator, index) =>
          index === 0 ? { ...validator, digest: undefined } : validator,
        ),
      }).success,
    ).toBe(false);
    expect(
      expectedValidationExecutionSchema.safeParse({
        ...expected,
        validators: expected.validators.map((validator, index) =>
          index === 1 ? { ...validator, check: expected.validators[0]?.check } : validator,
        ),
      }).success,
    ).toBe(false);
  });

  it("replays the exact original signed LIVE receipt and cannot substitute candidate B", () => {
    const original = signedLiveReceiptInput();
    const replay = {
      schemaVersion: 1,
      purpose: "LINEAGEGUARD_VALIDATION_REPLAY_PRESENTATION",
      originalLiveReceipt: original,
      originalLiveReceiptFingerprint: signedLiveValidationReceiptFingerprint(original),
      candidateFingerprint: original.protectedHeaders.candidateFingerprint,
      artifactSetFingerprint: original.payload.artifactSetFingerprint,
    };
    expect(validationReplayPresentationSchema.safeParse(replay).success).toBe(true);
    const candidateB = migrationCandidateSchema.parse({
      ...candidateInput(),
      summary: "Different candidate B.",
    });
    expect(
      validationReplayPresentationSchema.safeParse({
        ...replay,
        candidateFingerprint: migrationCandidateFingerprint(candidateB),
      }).success,
    ).toBe(false);
    expect(
      validationReplayPresentationSchema.safeParse({
        ...replay,
        originalLiveReceiptFingerprint: "e".repeat(64),
      }).success,
    ).toBe(false);
  });
});

describe("run state and operational events", () => {
  const runId = "run_111111111111111111111111";
  const statuses = [
    "CREATED",
    "CHANGE_PARSED",
    "BASELINE_ASSESSED",
    "CONTEXT_COLLECTING",
    "CONTEXT_COLLECTED",
    "RISK_DECIDED",
    "MIGRATION_PLANNED",
    "PATCH_GENERATED",
    "VALIDATING",
    "VALIDATED",
    "REVIEW_ARTIFACT_CREATED",
    "WRITEBACK_PENDING",
    "COMPLETED",
  ] as const;
  const eventId = (value: number) => `evt_${value.toString(16).padStart(24, "0")}`;
  const lease = {
    leaseId: "lease_111111111111111111111111",
    workerId: "worker-1",
    generation: 1,
  };
  const exactStatusEvents = () => [
    {
      eventId: eventId(1),
      runId,
      sequence: 0,
      type: "RUN_LEASE_ACQUIRED",
      ...lease,
      occurredAt: "2026-08-04T08:59:59.000Z",
      expiresAt: "2026-08-04T10:00:00.000Z",
    },
    ...statuses.slice(0, -1).map((from, index) => ({
      eventId: eventId(index + 2),
      runId,
      sequence: index + 1,
      type: "RUN_STATUS_CHANGED",
      ...lease,
      from,
      to: required(statuses[index + 1], "next status"),
      occurredAt: `2026-08-04T09:00:${index.toString().padStart(2, "0")}.000Z`,
    })),
  ];

  function streamIsAuthorized(events: readonly unknown[]): boolean {
    try {
      let current: RunEvent[] = [];
      for (const event of events) {
        if (typeof event !== "object" || event === null || !("occurredAt" in event)) return false;
        current = authorizeRunEvent(current, event, String(event.occurredAt));
      }
      return true;
    } catch {
      return false;
    }
  }

  it("matches the exact documented success sequence and failure states", () => {
    expect(streamIsAuthorized(exactStatusEvents())).toBe(true);
  });

  function contextLeaseEvents() {
    const events = exactStatusEvents().slice(0, 4);
    const acquired = required(events[0], "lease acquisition");
    if (acquired.type !== "RUN_LEASE_ACQUIRED") throw new Error("first event must acquire");
    Object.assign(acquired, { expiresAt: "2026-08-04T09:10:00.000Z" });
    return events;
  }

  it("preserves lease worker through retry, renewal, release, and ownership change", () => {
    const events = [
      ...contextLeaseEvents(),
      {
        eventId: eventId(21),
        runId,
        sequence: 4,
        type: "RUN_RETRY_SCHEDULED",
        leaseId: "lease_111111111111111111111111",
        workerId: "worker-1",
        generation: 1,
        operation: "DATAHUB_READ",
        attempt: 1,
        reason: "Transient timeout.",
        occurredAt: "2026-08-04T09:00:04.000Z",
        retryAt: "2026-08-04T09:00:05.000Z",
      },
      {
        eventId: eventId(22),
        runId,
        sequence: 5,
        type: "RUN_LEASE_RENEWED",
        leaseId: "lease_111111111111111111111111",
        workerId: "worker-1",
        generation: 1,
        previousExpiresAt: "2026-08-04T09:10:00.000Z",
        occurredAt: "2026-08-04T09:00:06.000Z",
        expiresAt: "2026-08-04T09:20:00.000Z",
      },
      {
        eventId: eventId(23),
        runId,
        sequence: 6,
        type: "RUN_LEASE_RELEASED",
        leaseId: "lease_111111111111111111111111",
        workerId: "worker-1",
        generation: 1,
        occurredAt: "2026-08-04T09:00:07.000Z",
      },
      {
        eventId: eventId(24),
        runId,
        sequence: 7,
        type: "RUN_LEASE_ACQUIRED",
        leaseId: "lease_222222222222222222222222",
        workerId: "worker-2",
        generation: 2,
        occurredAt: "2026-08-04T09:00:08.000Z",
        expiresAt: "2026-08-04T09:30:00.000Z",
      },
    ];
    expect(streamIsAuthorized(events)).toBe(true);
  });

  it("requires explicit expiry before ownership changes", () => {
    const events = [
      ...contextLeaseEvents(),
      {
        eventId: eventId(25),
        runId,
        sequence: 4,
        type: "RUN_LEASE_EXPIRED",
        leaseId: "lease_111111111111111111111111",
        workerId: "worker-1",
        generation: 1,
        occurredAt: "2026-08-04T09:10:00.000Z",
        expiredAt: "2026-08-04T09:10:00.000Z",
      },
      {
        eventId: eventId(26),
        runId,
        sequence: 5,
        type: "RUN_LEASE_ACQUIRED",
        leaseId: "lease_222222222222222222222222",
        workerId: "worker-2",
        generation: 2,
        occurredAt: "2026-08-04T09:10:00.001Z",
        expiresAt: "2026-08-04T09:20:00.000Z",
      },
    ];
    expect(streamIsAuthorized(events)).toBe(true);
  });

  it("rejects overlap, late renewal, mismatched worker, wrong-state retry, and post-terminal events", () => {
    const overlap = [
      ...contextLeaseEvents(),
      {
        ...contextLeaseEvents()[3],
        eventId: eventId(30),
        sequence: 4,
        leaseId: "lease_222222222222222222222222",
        workerId: "worker-2",
        generation: 2,
      },
    ];
    expect(streamIsAuthorized(overlap)).toBe(false);
    const lateRenewal = [
      ...contextLeaseEvents(),
      {
        eventId: eventId(31),
        runId,
        sequence: 4,
        type: "RUN_LEASE_RENEWED",
        leaseId: "lease_111111111111111111111111",
        workerId: "worker-1",
        generation: 1,
        previousExpiresAt: "2026-08-04T09:10:00.000Z",
        occurredAt: "2026-08-04T09:10:00.000Z",
        expiresAt: "2026-08-04T09:20:00.000Z",
      },
    ];
    expect(streamIsAuthorized(lateRenewal)).toBe(false);
    const mismatch = [
      ...contextLeaseEvents(),
      {
        eventId: eventId(32),
        runId,
        sequence: 4,
        type: "RUN_LEASE_RELEASED",
        leaseId: "lease_111111111111111111111111",
        workerId: "worker-2",
        generation: 1,
        occurredAt: "2026-08-04T09:00:04.000Z",
      },
    ];
    expect(streamIsAuthorized(mismatch)).toBe(false);
    const wrongRetry = [
      {
        eventId: eventId(40),
        runId,
        sequence: 0,
        type: "RUN_LEASE_ACQUIRED",
        leaseId: "lease_111111111111111111111111",
        workerId: "worker-1",
        generation: 1,
        occurredAt: "2026-08-04T09:00:00.000Z",
        expiresAt: "2026-08-04T09:10:00.000Z",
      },
      {
        eventId: eventId(41),
        runId,
        sequence: 1,
        type: "RUN_RETRY_SCHEDULED",
        leaseId: "lease_111111111111111111111111",
        workerId: "worker-1",
        generation: 1,
        operation: "GITHUB_WRITE",
        attempt: 1,
        reason: "Wrong state.",
        occurredAt: "2026-08-04T09:00:01.000Z",
        retryAt: "2026-08-04T09:00:02.000Z",
      },
    ];
    expect(streamIsAuthorized(wrongRetry)).toBe(false);
    const mismatchedRetry = [
      ...contextLeaseEvents(),
      {
        eventId: eventId(42),
        runId,
        sequence: 4,
        type: "RUN_RETRY_SCHEDULED",
        leaseId: "lease_111111111111111111111111",
        workerId: "worker-2",
        generation: 1,
        operation: "DATAHUB_READ",
        attempt: 1,
        reason: "Wrong worker.",
        occurredAt: "2026-08-04T09:00:04.000Z",
        retryAt: "2026-08-04T09:11:00.000Z",
      },
    ];
    expect(streamIsAuthorized(mismatchedRetry)).toBe(false);
    const successEvents = exactStatusEvents();
    const terminal = [
      ...successEvents,
      {
        eventId: eventId(50),
        runId,
        sequence: successEvents.length,
        type: "RUN_LEASE_ACQUIRED",
        leaseId: "lease_333333333333333333333333",
        workerId: "worker-3",
        generation: 2,
        occurredAt: "2026-08-04T09:01:00.000Z",
        expiresAt: "2026-08-04T09:02:00.000Z",
      },
    ];
    expect(streamIsAuthorized(terminal)).toBe(false);
  });

  it("requires a live matching lease for every status transition", () => {
    const transition = required(exactStatusEvents()[1], "first transition");
    expect(streamIsAuthorized([{ ...transition, sequence: 0 }])).toBe(false);
    expect(() =>
      authorizeRunEvent([], { ...transition, sequence: 0 }, transition.occurredAt),
    ).toThrow(/live active lease/);

    const expired = exactStatusEvents().slice(0, 2);
    const acquisition = required(expired[0], "acquisition");
    if (acquisition.type !== "RUN_LEASE_ACQUIRED") throw new Error("expected acquisition");
    Object.assign(acquisition, { expiresAt: "2026-08-04T09:00:00.000Z" });
    expect(streamIsAuthorized(expired)).toBe(false);

    for (const mismatch of [
      { workerId: "other-worker" },
      { leaseId: "lease_999999999999999999999999" },
      { generation: 2 },
    ]) {
      const events = exactStatusEvents().slice(0, 2);
      Object.assign(required(events[1], "transition"), mismatch);
      expect(streamIsAuthorized(events)).toBe(false);
    }
    const trustedTimeAcquisition = required(exactStatusEvents()[0], "acquisition");
    expect(() => authorizeRunEvent([], trustedTimeAcquisition, "2026-08-04T09:00:00.000Z")).toThrow(
      /trusted current time/,
    );
  });

  it("rejects lease ID reuse and non-increasing generations", () => {
    const released = [
      ...contextLeaseEvents(),
      {
        eventId: eventId(60),
        runId,
        sequence: 4,
        type: "RUN_LEASE_RELEASED",
        ...lease,
        occurredAt: "2026-08-04T09:00:04.000Z",
      },
    ];
    expect(
      streamIsAuthorized([
        ...released,
        {
          eventId: eventId(61),
          runId,
          sequence: 5,
          type: "RUN_LEASE_ACQUIRED",
          ...lease,
          generation: 2,
          occurredAt: "2026-08-04T09:00:05.000Z",
          expiresAt: "2026-08-04T09:01:00.000Z",
        },
      ]),
    ).toBe(false);
    expect(
      streamIsAuthorized([
        ...released,
        {
          eventId: eventId(62),
          runId,
          sequence: 5,
          type: "RUN_LEASE_ACQUIRED",
          leaseId: "lease_222222222222222222222222",
          workerId: "worker-2",
          generation: 1,
          occurredAt: "2026-08-04T09:00:05.000Z",
          expiresAt: "2026-08-04T09:01:00.000Z",
        },
      ]),
    ).toBe(false);
  });

  it("keeps retry attempts global across leases and enforces exact backoff", () => {
    const firstRetry = {
      eventId: eventId(70),
      runId,
      sequence: 4,
      type: "RUN_RETRY_SCHEDULED",
      ...lease,
      operation: "DATAHUB_READ",
      attempt: 1,
      reason: "Transient timeout.",
      occurredAt: "2026-08-04T09:00:04.000Z",
      retryAt: "2026-08-04T09:00:05.000Z",
    };
    const acrossLeases = [
      ...contextLeaseEvents(),
      firstRetry,
      {
        eventId: eventId(71),
        runId,
        sequence: 5,
        type: "RUN_LEASE_RELEASED",
        ...lease,
        occurredAt: "2026-08-04T09:00:05.000Z",
      },
      {
        eventId: eventId(72),
        runId,
        sequence: 6,
        type: "RUN_LEASE_ACQUIRED",
        leaseId: "lease_222222222222222222222222",
        workerId: "worker-2",
        generation: 2,
        occurredAt: "2026-08-04T09:00:06.000Z",
        expiresAt: "2026-08-04T09:00:08.000Z",
      },
      {
        eventId: eventId(73),
        runId,
        sequence: 7,
        type: "RUN_RETRY_SCHEDULED",
        leaseId: "lease_222222222222222222222222",
        workerId: "worker-2",
        generation: 2,
        operation: "DATAHUB_READ",
        attempt: 2,
        reason: "Transient timeout again.",
        occurredAt: "2026-08-04T09:00:07.000Z",
        retryAt: "2026-08-04T09:00:12.000Z",
      },
    ];
    expect(streamIsAuthorized(acrossLeases)).toBe(true);

    const reset = structuredClone(acrossLeases);
    Object.assign(required(reset[7], "second retry"), {
      attempt: 1,
      retryAt: "2026-08-04T09:00:08.000Z",
    });
    expect(streamIsAuthorized(reset)).toBe(false);
    const wrongDelay = [
      ...structuredClone(contextLeaseEvents()),
      { ...firstRetry, retryAt: "2026-08-04T09:00:06.000Z" },
    ];
    expect(streamIsAuthorized(wrongDelay)).toBe(false);
    expect(streamIsAuthorized([{ ...firstRetry, sequence: 0, attempt: 4 }])).toBe(false);
  });
});
