import type { LanguageModelV2 } from "@ai-sdk/provider";
import type {
  CanonicalImpactRequest,
  ImpactCollectionResult,
  ImpactContext,
  MigrationCandidate,
  ProposedChange,
  RiskAssessment,
  RiskComparison,
} from "@lineageguard/domain";
import type { MigrationPlan } from "../llm/schemas.js";

// Structural port matching @lineageguard/datahub's DataHubContextPort. Defined
// locally (rather than imported) because the agent package is not allowed to
// depend on @lineageguard/datahub per workspace boundary rules — only the
// worker app wires the concrete adapter into this shape.
export interface AgentDataHubContextPort {
  collect(input: {
    changeId: string;
    request: CanonicalImpactRequest;
  }): Promise<ImpactCollectionResult>;
}

export interface StepContext {
  runId: string;
  workerId: string;
  llm: LanguageModelV2;
  datahub: AgentDataHubContextPort;
  clock: () => Date;
}

export interface ParseChangeResult {
  change: ProposedChange;
}

export interface BaselineAssessResult {
  baseline: RiskAssessment;
}

export interface CollectContextResult {
  context: ImpactContext;
}

export interface DecideRiskResult {
  comparison: RiskComparison;
}

export interface PlanMigrationResult {
  plan: MigrationPlan;
}

export interface GeneratePatchResult {
  candidate: MigrationCandidate;
}

export { baselineAssess } from "./baseline-assess.js";
export { collectContext } from "./collect-context.js";
export type { DecideRiskInput } from "./decide-risk.js";
export { decideRisk } from "./decide-risk.js";
export type { GeneratePatchInput } from "./generate-patch.js";
export { generatePatch } from "./generate-patch.js";
export type { ParseChangeInput } from "./parse-change.js";
export { parseChange } from "./parse-change.js";
export type { PlanMigrationInput } from "./plan-migration.js";
export { planMigration } from "./plan-migration.js";
