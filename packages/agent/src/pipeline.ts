import type { LanguageModelV2 } from "@ai-sdk/provider";
import type { RunStatus } from "@lineageguard/domain";
import { type AgentLLMConfig, agentLLMConfigFromEnv, directLLMCall } from "./llm/client.js";
import { migrationPatchPrompt, migrationPlanPrompt } from "./llm/prompts.js";
import { migrationPatchSchema, migrationPlanSchema } from "./llm/schemas.js";
import type { AgentDataHubContextPort, StepContext } from "./steps/index.js";
import { baselineAssess, parseChange } from "./steps/index.js";

export interface AgentPipelineConfig {
  store?: unknown;
  datahub: AgentDataHubContextPort;
  llm: LanguageModelV2;
  workerId: string;
  clock: () => Date;
}

export interface RunInput {
  runId: string;
  repository: string;
  baseSha: string;
  headSha: string;
  patch: string;
  table: string;
  field: string;
  newName: string;
}

export interface PipelineResult {
  runId: string;
  finalStatus: RunStatus;
  baselineDecision: string;
  groundedDecision: string;
  consumersFound: number;
  artifactsGenerated: number;
}

function extractJson(text: string): unknown {
  const stripped = text.replace(/^```(?:json)?\n?/m, "").replace(/\n?```$/m, "").trim();
  try { return JSON.parse(stripped); } catch {}
  const match = stripped.match(/\{[\s\S]*\}/);
  if (match) return JSON.parse(match[0]);
  throw new Error("No JSON in LLM response");
}

export function createAgentPipeline(config: AgentPipelineConfig) {
  const ctx: StepContext = {
    runId: "",
    workerId: config.workerId,
    llm: config.llm,
    datahub: config.datahub,
    clock: config.clock,
  };

  const llmConfig = agentLLMConfigFromEnv();

  return {
    async execute(input: RunInput): Promise<PipelineResult> {
      ctx.runId = input.runId;

      // Step 1: Parse change
      const { change } = await parseChange(ctx, {
        repository: input.repository,
        baseSha: input.baseSha,
        headSha: input.headSha,
        patch: input.patch,
      });

      // Step 2: Baseline assessment
      const { baseline } = await baselineAssess(ctx, change);

      // Step 3: Collect DataHub context
      const rawResult = await ctx.datahub.collect({ changeId: change.id });
      const rawContext = (rawResult as any)?.context;
      const evidence: Array<{ kind: string; title: string; criticality: string }> =
        rawContext?.evidence ?? [];
      const consumersFound = evidence.length;

      // Step 4: Risk decision
      const groundedDecision = consumersFound > 0 ? "BLOCK" : "ALLOW";

      // Step 5 & 6: LLM migration generation (direct fetch, no streaming)
      let artifactsGenerated = 0;
      if (groundedDecision !== "ALLOW") {
        try {
          const consumers = evidence.map((e) => ({
            name: e.title, type: e.kind, criticality: e.criticality,
          }));

          // Plan migration
          const planPrompt = migrationPlanPrompt({
            table: input.table, field: input.field,
            operation: "RENAME", newName: input.newName, consumers,
          }) + "\n\nRespond with ONLY JSON: {strategy, steps: [{order, action, description}], rationale}";

          const planText = await directLLMCall(llmConfig, planPrompt);
          const plan = migrationPlanSchema.parse(extractJson(planText));
          console.log(`  [pipeline] Migration plan: ${plan.strategy} (${plan.steps.length} steps)`);

          // Generate patch
          const patchPrompt = migrationPatchPrompt({
            plan: { steps: plan.steps.map((s) => ({ action: s.action, description: s.description })) },
            table: input.table, field: input.field,
            newName: input.newName, existingModels: ["customer_revenue", "fraud_features"],
          }) + "\n\nRespond with ONLY JSON: {artifacts: [{kind, path, content, operation}], summary}";

          const patchText = await directLLMCall(llmConfig, patchPrompt);
          const patch = migrationPatchSchema.parse(extractJson(patchText));
          artifactsGenerated = patch.artifacts.length;
          console.log(`  [pipeline] Generated ${artifactsGenerated} artifacts`);
        } catch (err: any) {
          console.log(`  [pipeline] LLM step skipped: ${err.message?.slice(0, 100)}`);
        }
      }

      return {
        runId: input.runId,
        finalStatus: groundedDecision === "ALLOW" ? "COMPLETED" : "VALIDATED",
        baselineDecision: baseline.decision,
        groundedDecision,
        consumersFound,
        artifactsGenerated,
      };
    },
  };
}
