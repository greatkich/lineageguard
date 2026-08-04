import { z } from "zod";
import { type ProposedChange, proposedChangeSchema } from "./change.js";
import {
  canonicalFieldPath,
  type EvidenceItem,
  type ImpactContext,
  impactContextSchema,
} from "./evidence.js";

const isoDateTimeSchema = z.iso.datetime({ offset: true });
const evidenceIdSchema = z.string().regex(/^ev_[a-f0-9]{24}$/);
const fingerprintSchema = z.string().regex(/^[a-f0-9]{64}$/);
const ruleOrder = ["LG001", "LG002", "LG003", "LG004", "LG005"] as const;
const blockingRules = new Set<string>(["LG001", "LG002", "LG003", "LG004"]);

export const decisionSchema = z.enum(["ALLOW", "REVIEW", "BLOCK"]);
export const riskLevelSchema = z.enum(["LOW", "MEDIUM", "HIGH", "CRITICAL"]);
export const riskRuleIdSchema = z.enum(ruleOrder);

export const riskReasonSchema = z
  .object({
    ruleId: riskRuleIdSchema,
    message: z.string().min(1).max(500),
    evidenceIds: z.array(evidenceIdSchema).min(1).max(200),
    severity: riskLevelSchema,
  })
  .strict()
  .superRefine((reason, refinement) => {
    const expectedSeverity = {
      LG001: "CRITICAL",
      LG002: "CRITICAL",
      LG003: "HIGH",
      LG004: "CRITICAL",
      LG005: "HIGH",
    } as const;
    if (reason.severity !== expectedSeverity[reason.ruleId]) {
      refinement.addIssue({
        code: "custom",
        message: "Rule severity contradicts the deterministic policy",
        path: ["severity"],
      });
    }
    const sorted = [...reason.evidenceIds].sort();
    if (new Set(reason.evidenceIds).size !== reason.evidenceIds.length) {
      refinement.addIssue({
        code: "custom",
        message: "Reason evidence IDs must be unique",
        path: ["evidenceIds"],
      });
    }
    if (reason.evidenceIds.some((id, index) => id !== sorted[index])) {
      refinement.addIssue({
        code: "custom",
        message: "Reason evidence IDs must be sorted",
        path: ["evidenceIds"],
      });
    }
  });

export type RiskReason = z.infer<typeof riskReasonSchema>;

function deriveOutcome(reasons: RiskReason[]): {
  decision: "ALLOW" | "REVIEW" | "BLOCK";
  risk: "LOW" | "HIGH" | "CRITICAL";
} {
  if (reasons.some((reason) => blockingRules.has(reason.ruleId))) {
    return {
      decision: "BLOCK",
      risk: reasons.some((reason) => reason.severity === "CRITICAL") ? "CRITICAL" : "HIGH",
    };
  }
  return reasons.length === 0
    ? { decision: "ALLOW", risk: "LOW" }
    : { decision: "REVIEW", risk: "HIGH" };
}

export const riskAssessmentSchema = z
  .object({
    changeId: z.string().regex(/^chg_[a-f0-9]{24}$/),
    impactContextFingerprint: fingerprintSchema.optional(),
    contextMode: z.enum(["REPOSITORY_ONLY", "DATAHUB_GROUNDED"]),
    decision: decisionSchema,
    risk: riskLevelSchema,
    reasons: z.array(riskReasonSchema).max(20),
    evaluatedAt: isoDateTimeSchema,
    policyVersion: z.literal("lineageguard-p0.1"),
  })
  .strict()
  .superRefine((assessment, refinement) => {
    const ruleIds = assessment.reasons.map((reason) => reason.ruleId);
    if (new Set(ruleIds).size !== ruleIds.length) {
      refinement.addIssue({
        code: "custom",
        message: "Risk rules must be unique",
        path: ["reasons"],
      });
    }
    const expectedOrder = [...ruleIds].sort(
      (left, right) => ruleOrder.indexOf(left) - ruleOrder.indexOf(right),
    );
    if (ruleIds.some((ruleId, index) => ruleId !== expectedOrder[index])) {
      refinement.addIssue({
        code: "custom",
        message: "Risk rules must use canonical order",
        path: ["reasons"],
      });
    }

    if (assessment.contextMode === "REPOSITORY_ONLY") {
      if (
        assessment.decision !== "ALLOW" ||
        assessment.risk !== "LOW" ||
        assessment.reasons.length !== 0 ||
        assessment.impactContextFingerprint !== undefined
      ) {
        refinement.addIssue({
          code: "custom",
          message: "Repository-only assessment must be ALLOW/LOW with no evidence reasons",
        });
      }
      return;
    }

    if (assessment.impactContextFingerprint === undefined) {
      refinement.addIssue({
        code: "custom",
        message: "Grounded assessment must bind the impact context fingerprint",
        path: ["impactContextFingerprint"],
      });
    }

    const derived = deriveOutcome(assessment.reasons);
    if (assessment.decision !== derived.decision || assessment.risk !== derived.risk) {
      refinement.addIssue({
        code: "custom",
        message: "Grounded decision and risk must be derived from triggered policy rules",
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
  .strict()
  .superRefine((comparison, refinement) => {
    const expectedRules = comparison.grounded.reasons.map((reason) => reason.ruleId);
    const expectedEvidence = [
      ...new Set(comparison.grounded.reasons.flatMap((reason) => reason.evidenceIds)),
    ].sort();
    if (
      comparison.baseline.changeId !== comparison.changeId ||
      comparison.grounded.changeId !== comparison.changeId ||
      comparison.baseline.contextMode !== "REPOSITORY_ONLY" ||
      comparison.grounded.contextMode !== "DATAHUB_GROUNDED"
    ) {
      refinement.addIssue({
        code: "custom",
        message: "Comparison assessments are not bound to the same change",
      });
    }
    if (
      comparison.decisionChanged !==
      (comparison.baseline.decision !== comparison.grounded.decision)
    ) {
      refinement.addIssue({
        code: "custom",
        message: "decisionChanged is contradictory",
        path: ["decisionChanged"],
      });
    }
    if (
      comparison.transition !== `${comparison.baseline.decision}→${comparison.grounded.decision}`
    ) {
      refinement.addIssue({
        code: "custom",
        message: "Transition is contradictory",
        path: ["transition"],
      });
    }
    if (JSON.stringify(comparison.triggeredRuleIds) !== JSON.stringify(expectedRules)) {
      refinement.addIssue({
        code: "custom",
        message: "Triggered rule delta is contradictory",
        path: ["triggeredRuleIds"],
      });
    }
    if (JSON.stringify(comparison.changedBecauseEvidenceIds) !== JSON.stringify(expectedEvidence)) {
      refinement.addIssue({
        code: "custom",
        message: "Evidence delta is contradictory",
        path: ["changedBecauseEvidenceIds"],
      });
    }
  });

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
  if (evidence.length === 0) return undefined;
  return riskReasonSchema.parse({
    ruleId,
    message,
    severity,
    evidenceIds: sortEvidence(evidence).map((item) => item.id),
  });
}

export function evaluateRepositoryBaseline(
  untrustedChange: ProposedChange,
  evaluatedAt: string,
): RiskAssessment {
  const change = proposedChangeSchema.parse(untrustedChange);
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
  untrustedChange: ProposedChange,
  untrustedContext: ImpactContext,
  evaluatedAt: string,
): RiskAssessment {
  const change = proposedChangeSchema.parse(untrustedChange);
  const context = impactContextSchema.parse(untrustedContext);
  if (
    context.changeId !== change.id ||
    change.field !== "customer_id" ||
    context.fieldPath !== canonicalFieldPath
  ) {
    throw new Error("Impact context is not bound to the proposed field change");
  }
  if (context.collectionStatus !== "COMPLETE") {
    throw new Error("Grounded risk evaluation requires a complete impact context");
  }

  const assessedTime = new Date(evaluatedAt).getTime();
  if (!Number.isFinite(assessedTime)) throw new Error("Risk assessment time is invalid");
  if (assessedTime < new Date(context.collectedAt).getTime()) {
    throw new Error("Risk assessment cannot precede context collection");
  }
  if (
    context.evidence.some((item) => new Date(item.provenance.retrievedAt).getTime() > assessedTime)
  ) {
    throw new Error("Risk assessment cannot precede evidence retrieval");
  }
  const connectedIds = new Set(
    context.evidence
      .filter((item) => item.kind !== "OWNER" && item.fieldPath === canonicalFieldPath)
      .map((item) => item.id),
  );
  const evidence = sortEvidence(
    context.evidence.filter(
      (item) =>
        connectedIds.has(item.id) ||
        item.relatedEvidenceIds.some((relatedId) => connectedIds.has(relatedId)),
    ),
  );
  const downstreamPaths = evidence.filter((item) => item.kind === "LINEAGE_PATH");
  const productionModels = evidence.filter(
    (item) => item.kind === "ML_MODEL" && item.payload.lifecycle === "PRODUCTION",
  );
  const criticalDashboards = evidence.filter(
    (item) => item.kind === "DASHBOARD" && item.criticality === "CRITICAL",
  );
  const recentUnmanagedQueries = evidence.filter((item) => {
    if (item.kind !== "QUERY_USAGE" || item.payload.managed) return false;
    const lastSeen = new Date(item.payload.lastSeenAt).getTime();
    if (lastSeen > assessedTime) throw new Error("Query evidence cannot be observed in the future");
    return assessedTime - lastSeen <= 30 * 24 * 60 * 60 * 1_000;
  });
  const ownerAssetUrns = new Set(
    evidence.filter((item) => item.kind === "OWNER").map((item) => item.payload.assetUrn),
  );
  const missingOwnerAssets = evidence.filter((item) => {
    if (item.kind === "DASHBOARD") {
      return item.criticality === "CRITICAL" && !ownerAssetUrns.has(item.payload.dashboardUrn);
    }
    return (
      item.kind === "ML_MODEL" &&
      item.criticality === "CRITICAL" &&
      !ownerAssetUrns.has(item.payload.modelUrn)
    );
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
  const derived = deriveOutcome(reasons);
  const assessment = riskAssessmentSchema.parse({
    changeId: change.id,
    impactContextFingerprint: context.impactContextFingerprint,
    contextMode: "DATAHUB_GROUNDED",
    ...derived,
    reasons,
    evaluatedAt,
    policyVersion: "lineageguard-p0.1",
  });
  return assessment;
}

export function bindGroundedRiskAssessment(
  changeInput: ProposedChange,
  contextInput: ImpactContext,
  assessmentInput: RiskAssessment,
): RiskAssessment {
  const change = proposedChangeSchema.parse(changeInput);
  const parsedContext = impactContextSchema.parse(contextInput);
  const parsedAssessment = riskAssessmentSchema.parse(assessmentInput);
  if (
    parsedContext.changeId !== change.id ||
    parsedAssessment.changeId !== change.id ||
    parsedAssessment.contextMode !== "DATAHUB_GROUNDED" ||
    parsedAssessment.impactContextFingerprint !== parsedContext.impactContextFingerprint
  ) {
    throw new Error("Grounded assessment identity does not match the change and context");
  }
  const authoritative = evaluateGroundedRisk(change, parsedContext, parsedAssessment.evaluatedAt);
  if (JSON.stringify(parsedAssessment) !== JSON.stringify(authoritative)) {
    throw new Error("Grounded assessment is not the authoritative deterministic decision");
  }
  const ids = new Set(parsedContext.evidence.map((item) => item.id));
  for (const item of parsedAssessment.reasons) {
    for (const evidenceId of item.evidenceIds) {
      if (!ids.has(evidenceId))
        throw new Error(`Risk reason ${item.ruleId} cites unknown evidence ${evidenceId}`);
    }
  }
  return parsedAssessment;
}

export function assertRiskEvidenceReferences(
  change: ProposedChange,
  assessment: RiskAssessment,
  context: ImpactContext,
): void {
  bindGroundedRiskAssessment(change, context, assessment);
}

export function compareAuthoritativeRisk(
  changeInput: ProposedChange,
  contextInput: ImpactContext,
  evaluatedAt: { baseline: string; grounded: string },
): RiskComparison {
  const change = proposedChangeSchema.parse(changeInput);
  const context = impactContextSchema.parse(contextInput);
  const parsedBaseline = evaluateRepositoryBaseline(change, evaluatedAt.baseline);
  const parsedGrounded = evaluateGroundedRisk(change, context, evaluatedAt.grounded);
  const changedBecauseEvidenceIds = [
    ...new Set(parsedGrounded.reasons.flatMap((item) => item.evidenceIds)),
  ].sort();
  return riskComparisonSchema.parse({
    changeId: change.id,
    baseline: parsedBaseline,
    grounded: parsedGrounded,
    decisionChanged: parsedBaseline.decision !== parsedGrounded.decision,
    transition: `${parsedBaseline.decision}→${parsedGrounded.decision}`,
    triggeredRuleIds: parsedGrounded.reasons.map((item) => item.ruleId),
    changedBecauseEvidenceIds,
  });
}
