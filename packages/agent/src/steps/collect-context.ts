import { canonicalImpactRequest } from "@lineageguard/domain";
import type { CollectContextResult, StepContext } from "./index.js";

export async function collectContext(
  ctx: StepContext,
  changeId: string,
): Promise<CollectContextResult> {
  const result = await ctx.datahub.collect({
    changeId,
    request: canonicalImpactRequest,
  });

  if (result.outcome === "FAILED") {
    const messages = result.report.failures.map((failure) => failure.message).join(", ");
    throw new Error(`Context collection failed: ${messages}`);
  }

  return { context: result.context };
}
