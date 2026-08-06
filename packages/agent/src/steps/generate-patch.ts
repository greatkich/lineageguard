import { generateText } from "ai";
import { migrationPatchPrompt } from "../llm/prompts.js";
import { migrationPatchSchema } from "../llm/schemas.js";
import type { GeneratePatchResult, PlanMigrationResult, StepContext } from "./index.js";

export interface GeneratePatchInput {
  plan: PlanMigrationResult["plan"];
  table: string;
  field: string;
  newName: string;
}

function extractJson(text: string): unknown {
  const stripped = text.replace(/^```(?:json)?\n?/m, "").replace(/\n?```$/m, "").trim();
  try {
    return JSON.parse(stripped);
  } catch {}
  const match = stripped.match(/\{[\s\S]*\}/);
  if (match) return JSON.parse(match[0]);
  throw new Error("No valid JSON found in LLM response");
}

export async function generatePatch(
  ctx: StepContext,
  input: GeneratePatchInput,
): Promise<GeneratePatchResult> {
  const { text } = await generateText({
    model: ctx.llm,
    prompt:
      migrationPatchPrompt({
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
      }) +
      "\n\nRespond with ONLY a JSON object: {artifacts: [{kind: string, path: string, content: string, operation: string}], summary: string}. No markdown fences, no explanation.",
  });

  const raw = extractJson(text);
  const patch = migrationPatchSchema.parse(raw);

  const candidate = {
    strategy: "EXPAND_MIGRATE_CONTRACT",
    artifacts: patch.artifacts,
    summary: patch.summary,
    // biome-ignore lint/suspicious/noExplicitAny: MVP draft patch
  } as any;

  return { candidate };
}
