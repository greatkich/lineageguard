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
  onStatusChange?: (runId: string, status: string, extra?: Record<string, unknown>) => Promise<void>;
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
  const notify = config.onStatusChange ?? (async () => {});

  return {
    async execute(input: RunInput): Promise<PipelineResult> {
      ctx.runId = input.runId;

      // Step 1: Parse change
      await notify(input.runId, "CHANGE_PARSED");
      const { change } = await parseChange(ctx, {
        repository: input.repository,
        baseSha: input.baseSha,
        headSha: input.headSha,
        patch: input.patch,
      });

      // Step 2: Baseline assessment
      await notify(input.runId, "BASELINE_ASSESSED", { baselineDecision: "ALLOW" });
      const { baseline } = await baselineAssess(ctx, change);

      // Step 3: Collect DataHub context
      await notify(input.runId, "CONTEXT_COLLECTING");
      const rawResult = await ctx.datahub.collect({ changeId: change.id });
      const rawContext = (rawResult as any)?.context;
      const evidence: Array<{ kind: string; title: string; criticality: string }> =
        rawContext?.evidence ?? [];
      const consumersFound = evidence.length;
      await notify(input.runId, "CONTEXT_COLLECTED", { consumersFound });

      // Step 4: Risk decision
      const groundedDecision = consumersFound > 0 ? "BLOCK" : "ALLOW";
      await notify(input.runId, "RISK_DECIDED", { groundedDecision });

      // Step 5 & 6: LLM migration generation (direct fetch, no streaming)
      let artifactsGenerated = 0;
      if (groundedDecision !== "ALLOW") {
        try {
          await notify(input.runId, "MIGRATION_PLANNED");
          const consumers = evidence.map((e) => ({
            name: e.title, type: e.kind, criticality: e.criticality,
          }));

          const planPrompt = migrationPlanPrompt({
            table: input.table, field: input.field,
            operation: "RENAME", newName: input.newName, consumers,
          }) + "\n\nRespond with ONLY JSON: {strategy, steps: [{order, action, description}], rationale}";

          const planText = await directLLMCall(llmConfig, planPrompt);
          const plan = migrationPlanSchema.parse(extractJson(planText));
          console.log(`  [pipeline] Migration plan: ${plan.strategy} (${plan.steps.length} steps)`);

          await notify(input.runId, "PATCH_GENERATED");
          const patchPrompt = migrationPatchPrompt({
            plan: { steps: plan.steps.map((s) => ({ action: s.action, description: s.description })) },
            table: input.table, field: input.field,
            newName: input.newName, existingModels: ["customer_revenue", "fraud_features"],
          }) + "\n\nRespond with ONLY JSON: {artifacts: [{kind, path, content, operation}], summary}";

          const patchText = await directLLMCall(llmConfig, patchPrompt);
          const patch = migrationPatchSchema.parse(extractJson(patchText));
          artifactsGenerated = patch.artifacts.length;
          console.log(`  [pipeline] Generated ${artifactsGenerated} artifacts`);

          await notify(input.runId, "VALIDATED", { artifactsGenerated });
        } catch (err: any) {
          console.log(`  [pipeline] LLM step skipped: ${err.message?.slice(0, 100)}`);
          await notify(input.runId, "FAILED_GENERATION");
        }
      }

      const finalStatus = groundedDecision === "ALLOW" ? "COMPLETED" : (artifactsGenerated > 0 ? "COMPLETED" : "FAILED_GENERATION");
      await notify(input.runId, finalStatus, { artifactsGenerated });

      return {
        runId: input.runId,
        finalStatus: finalStatus as RunStatus,
        baselineDecision: baseline.decision,
        groundedDecision,
        consumersFound,
        artifactsGenerated,
      };
    },
  };
}
