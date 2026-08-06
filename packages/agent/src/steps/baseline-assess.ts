import { evaluateRepositoryBaseline, type ProposedChange } from "@lineageguard/domain";
import type { BaselineAssessResult, StepContext } from "./index.js";

export async function baselineAssess(
  ctx: StepContext,
  change: ProposedChange,
): Promise<BaselineAssessResult> {
  return {
    baseline: evaluateRepositoryBaseline(change, ctx.clock().toISOString()),
  };
}
