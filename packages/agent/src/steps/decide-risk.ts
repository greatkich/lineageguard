import {
  compareAuthoritativeRisk,
  type ImpactContext,
  type ProposedChange,
  type RiskAssessment,
} from "@lineageguard/domain";
import type { DecideRiskResult, StepContext } from "./index.js";

export interface DecideRiskInput {
  change: ProposedChange;
  context: ImpactContext;
  baseline: RiskAssessment;
}

export async function decideRisk(
  ctx: StepContext,
  input: DecideRiskInput,
): Promise<DecideRiskResult> {
  const comparison = compareAuthoritativeRisk(input.change, input.context, {
    baseline: input.baseline.evaluatedAt,
    grounded: ctx.clock().toISOString(),
  });

  return { comparison };
}
