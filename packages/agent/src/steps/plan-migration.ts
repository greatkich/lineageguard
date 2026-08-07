import type { ImpactContext } from "@lineageguard/domain";
import { generateText } from "ai";
import { migrationPlanPrompt } from "../llm/prompts.js";
import { migrationPlanSchema } from "../llm/schemas.js";
import type { PlanMigrationResult, StepContext } from "./index.js";

export interface PlanMigrationInput {
  context: ImpactContext;
  table: string;
  field: string;
  newName: string;
}

function extractJson(text: string): unknown {
  // Strip markdown code fences if present
  const stripped = text
    .replace(/^```(?:json)?\n?/m, "")
    .replace(/\n?```$/m, "")
    .trim();
  // Try direct parse first
  try {
    return JSON.parse(stripped);
  } catch {}
  // Try extracting first JSON object
  const match = stripped.match(/\{[\s\S]*\}/);
  if (match) return JSON.parse(match[0]);
  throw new Error("No valid JSON found in LLM response");
}

export async function planMigration(
  ctx: StepContext,
  input: PlanMigrationInput,
): Promise<PlanMigrationResult> {
  const consumers =
    (input.context as any).evidence?.map((evidence: any) => ({
      name: evidence.title ?? evidence.entityName ?? "unknown",
      type: evidence.kind,
      criticality: evidence.criticality,
    })) ?? [];

  const prompt = migrationPlanPrompt({
    table: input.table,
    field: input.field,
    operation: "RENAME",
    newName: input.newName,
    consumers,
  });

  const { text } = await generateText({
    model: ctx.llm,
    prompt:
      prompt +
      "\n\nRespond with ONLY a JSON object matching this schema: {strategy: string, steps: [{order: number, action: string, description: string}], rationale: string}. No markdown, no explanation.",
  });

  const raw = extractJson(text);
  const plan = migrationPlanSchema.parse(raw);
  return { plan };
}
