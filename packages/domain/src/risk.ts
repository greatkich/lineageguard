import { z } from "zod";
import type { ProposedChange } from "./change.js";
import type { EvidenceItem, ImpactContext } from "./evidence.js";

const isoDateTimeSchema = z.iso.datetime({ offset: true });
const evidenceIdSchema = z.string().regex(/^ev_[a-f0-9]{24}$/);

export const decisionSchema = z.enum(["ALLOW", "REVIEW", "BLOCK"]);
export const riskLevelSchema = z.enum(["LOW", "MEDIUM", "HIGH", "CRITICAL"]);
export const riskRuleIdSchema = z.enum(["LG001", "LG002", "LG003", "LG004", "LG005"]);

export const riskReasonSchema = z
  .object({
    ruleId: riskRuleIdSchema,
    message: z.string().min(1).max(500),
    evidenceIds: z.array(evidenceIdSchema).min(1).max(200),
    severity: riskLevelSchema,
  })
  .strict();

export type RiskReason = z.infer<typeof riskReasonSchema>;

export const riskAssessmentSchema = z
  .object({
    changeId: z.string().regex(/^chg_[a-f0-9]{24}$/),
    contextMode: z.enum(["REPOSITORY_ONLY", "DATAHUB_GROUNDED"]),
    decision: decisionSchema,
    risk: riskLevelSchema,
    reasons: z.array(riskReasonSchema).max(20),
    evaluatedAt: isoDateTimeSchema,
    policyVersion: z.literal("lineageguard-p0.1"),
  })
  .strict()
  .superRefine((assessment, refinement) => {
    if (assessment.contextMode === "REPOSITORY_ONLY") {
      if (
        assessment.decision !== "ALLOW" ||
        assessment.risk !== "LOW" ||
        assessment.reasons.length !== 0
      ) {
        refinement.addIssue({
          code: "custom",
          message: "Repository-only assessment must be ALLOW/LOW with no external evidence reasons",
        });
      }
    }
    if (assessment.decision === "ALLOW" && assessment.reasons.length > 0) {
      refinement.addIssue({
        code: "custom",
        message: "ALLOW cannot include triggered risk rules",
        path: ["reasons"],
      });
    }
  });

export type RiskAssessment = z.infer<typeof riskAssessmentSchema>;

export const riskComparisonSchema = z
  .object({
    changeId: z.string().regex(/^chg_[a-f0-9]{24}$/),
    baseline: riskAssessmentSchema,
    grounded: riskAssessmentSchema,
    decisionChanged: z.boolean(),
    transition: z.string().regex(/^(ALLOW|REVIEW|BLOCK)→(ALLOW|REVIEW|BLOCK)$/),
    triggeredRuleIds: z.array(riskRuleIdSchema).max(5),
    changedBecauseEvidenceIds: z.array(evidenceIdSchema).max(200),
  })
  .strict();

export type RiskComparison = z.infer<typeof riskComparisonSchema>;

function sortEvidence(items: EvidenceItem[]): EvidenceItem[] {
  return [...items].sort((left, right) => left.id.localeCompare(right.id));
}

function reason(
  ruleId: RiskReason["ruleId"],
  message: string,
  severity: RiskReason["severity"],
  evidence: EvidenceItem[],
): RiskReason | undefined {
  if (evidence.length === 0) {
    return undefined;
  }
  return {
    ruleId,
    message,
    severity,
    evidenceIds: sortEvidence(evidence).map((item) => item.id),
  };
}

export function evaluateRepositoryBaseline(
  change: ProposedChange,
  evaluatedAt: string,
): RiskAssessment {
  return riskAssessmentSchema.parse({
    changeId: change.id,
    contextMode: "REPOSITORY_ONLY",
    decision: "ALLOW",
    risk: "LOW",
    reasons: [],
    evaluatedAt,
    policyVersion: "lineageguard-p0.1",
  });
}

export function evaluateGroundedRisk(
  change: ProposedChange,
  context: ImpactContext,
  evaluatedAt: string,
): RiskAssessment {
  if (context.changeId !== change.id) {
    throw new Error("Impact context belongs to a different proposed change");
  }
  if (context.collectionStatus !== "COMPLETE") {
    throw new Error("Grounded risk evaluation requires a complete impact context");
  }

  const evidence = sortEvidence(context.evidence);
  const downstreamPaths = evidence.filter((item) => item.kind === "LINEAGE_PATH");
  const productionModels = evidence.filter(
    (item) => item.kind === "ML_MODEL" && item.payload.lifecycle === "PRODUCTION",
  );
  const criticalDashboards = evidence.filter(
    (item) => item.kind === "DASHBOARD" && item.criticality === "CRITICAL",
  );
  const assessedTime = new Date(evaluatedAt).getTime();
  const recentUnmanagedQueries = evidence.filter((item) => {
    if (item.kind !== "QUERY_USAGE" || item.payload.managed) {
      return false;
    }
    const lastSeen = new Date(item.payload.lastSeenAt).getTime();
    const age = assessedTime - lastSeen;
    return age >= 0 && age <= 30 * 24 * 60 * 60 * 1_000;
  });
  const ownerAssetUrns = new Set(
    evidence.filter((item) => item.kind === "OWNER").map((item) => item.payload.assetUrn),
  );
  const missingOwnerAssets = evidence.filter((item) => {
    if (item.kind === "DASHBOARD") {
      return item.criticality === "CRITICAL" && !ownerAssetUrns.has(item.payload.dashboardUrn);
    }
    if (item.kind === "ML_MODEL") {
      return item.criticality === "CRITICAL" && !ownerAssetUrns.has(item.payload.modelUrn);
    }
    return false;
  });

  const reasons = [
    reason(
      "LG001",
      "The incompatible field rename has downstream field-level lineage.",
      "CRITICAL",
      downstreamPaths,
    ),
    reason(
      "LG002",
      "A production ML model depends on the renamed field.",
      "CRITICAL",
      productionModels,
    ),
    reason(
      "LG003",
      "A recent unmanaged query references the renamed field.",
      "HIGH",
      recentUnmanagedQueries,
    ),
    reason(
      "LG004",
      "A critical dashboard depends on the incompatible field change.",
      "CRITICAL",
      criticalDashboards,
    ),
    reason(
      "LG005",
      "An affected critical asset has no recorded owner.",
      "HIGH",
      missingOwnerAssets,
    ),
  ].filter((item): item is RiskReason => item !== undefined);

  const blocking = reasons.some((item) =>
    ["LG001", "LG002", "LG003", "LG004"].includes(item.ruleId),
  );
  const decision = blocking ? "BLOCK" : reasons.length > 0 ? "REVIEW" : "ALLOW";
  const risk = blocking
    ? reasons.some((item) => item.severity === "CRITICAL")
      ? "CRITICAL"
      : "HIGH"
    : reasons.length > 0
      ? "HIGH"
      : "LOW";

  const assessment = riskAssessmentSchema.parse({
    changeId: change.id,
    contextMode: "DATAHUB_GROUNDED",
    decision,
    risk,
    reasons,
    evaluatedAt,
    policyVersion: "lineageguard-p0.1",
  });
  assertRiskEvidenceReferences(assessment, context);
  return assessment;
}

export function assertRiskEvidenceReferences(
  assessment: RiskAssessment,
  context: ImpactContext,
): void {
  const ids = new Set(context.evidence.map((item) => item.id));
  for (const item of assessment.reasons) {
    for (const evidenceId of item.evidenceIds) {
      if (!ids.has(evidenceId)) {
        throw new Error(`Risk reason ${item.ruleId} cites unknown evidence ${evidenceId}`);
      }
    }
  }
}

export function compareRiskAssessments(
  baseline: RiskAssessment,
  grounded: RiskAssessment,
): RiskComparison {
  if (baseline.changeId !== grounded.changeId) {
    throw new Error("Cannot compare assessments for different changes");
  }
  if (baseline.contextMode !== "REPOSITORY_ONLY" || grounded.contextMode !== "DATAHUB_GROUNDED") {
    throw new Error(
      "Risk comparison requires repository-only baseline and DataHub-grounded result",
    );
  }
  const changedBecauseEvidenceIds = [
    ...new Set(grounded.reasons.flatMap((item) => item.evidenceIds)),
  ].sort();
  return riskComparisonSchema.parse({
    changeId: baseline.changeId,
    baseline,
    grounded,
    decisionChanged: baseline.decision !== grounded.decision,
    transition: `${baseline.decision}→${grounded.decision}`,
    triggeredRuleIds: grounded.reasons.map((item) => item.ruleId),
    changedBecauseEvidenceIds,
  });
}
