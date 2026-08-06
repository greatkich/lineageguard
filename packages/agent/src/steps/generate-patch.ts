import { generateObject } from "ai";
import { migrationPatchPrompt } from "../llm/prompts.js";
import { migrationPatchSchema } from "../llm/schemas.js";
import type { GeneratePatchResult, PlanMigrationResult, StepContext } from "./index.js";

export interface GeneratePatchInput {
  plan: PlanMigrationResult["plan"];
  table: string;
  field: string;
  newName: string;
}

export async function generatePatch(
  ctx: StepContext,
  input: GeneratePatchInput,
): Promise<GeneratePatchResult> {
  const { object: patch } = await generateObject({
    model: ctx.llm,
    schema: migrationPatchSchema,
    prompt: migrationPatchPrompt({
      plan: {
        steps: input.plan.steps.map((step) => ({
          action: step.action,
          description: step.description,
          ...(step.targetPath === undefined ? {} : { targetPath: step.targetPath }),
        })),
      },
      table: input.table,
      field: input.field,
      newName: input.newName,
      existingModels: ["customer_revenue", "fraud_features"],
    }),
  });

  // The LLM output is a lightweight draft patch; it is not yet the fully
  // bound MigrationCandidate (which requires source fingerprints, reviewer
  // derivation, and evidence binding computed downstream via
  // bindMigrationCandidate). Cast for the MVP pipeline; tighten once the
  // downstream binding step is implemented.
  const candidate = {
    strategy: "EXPAND_MIGRATE_CONTRACT",
    artifacts: patch.artifacts,
    summary: patch.summary,
    // biome-ignore lint/suspicious/noExplicitAny: MVP draft patch; not yet bound to MigrationCandidate via bindMigrationCandidate.
  } as any;

  return { candidate };
}
