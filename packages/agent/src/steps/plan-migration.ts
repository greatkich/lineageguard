import type { ImpactContext } from "@lineageguard/domain";
import { generateObject } from "ai";
import { migrationPlanPrompt } from "../llm/prompts.js";
import { migrationPlanSchema } from "../llm/schemas.js";
import type { PlanMigrationResult, StepContext } from "./index.js";

export interface PlanMigrationInput {
  context: ImpactContext;
  table: string;
  field: string;
  newName: string;
}

export async function planMigration(
  ctx: StepContext,
  input: PlanMigrationInput,
): Promise<PlanMigrationResult> {
  const consumers = input.context.evidence.map((evidence) => ({
    name: evidence.title,
    type: evidence.kind,
    criticality: evidence.criticality,
  }));

  const { object: plan } = await generateObject({
    model: ctx.llm,
    schema: migrationPlanSchema,
    prompt: migrationPlanPrompt({
      table: input.table,
      field: input.field,
      operation: "RENAME",
      newName: input.newName,
      consumers,
    }),
  });

  return { plan };
}
