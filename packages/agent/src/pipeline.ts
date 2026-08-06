import type { LanguageModelV2 } from "@ai-sdk/provider";
import type { RunStatus } from "@lineageguard/domain";
import type { AgentDataHubContextPort, StepContext } from "./steps/index.js";
import {
  baselineAssess,
  collectContext,
  decideRisk,
  generatePatch,
  parseChange,
  planMigration,
} from "./steps/index.js";

export interface AgentPipelineConfig {
  // Structural run-store port. Left untyped here because the agent package
  // cannot depend on @lineageguard/db per workspace boundary rules; the
  // worker app wires the concrete RunStore in and drives state transitions
  // around calls to `execute`. Not used internally by this MVP pipeline.
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

export function createAgentPipeline(config: AgentPipelineConfig) {
  const ctx: StepContext = {
    runId: "",
    workerId: config.workerId,
    llm: config.llm,
    datahub: config.datahub,
    clock: config.clock,
  };

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

      // Step 2: Baseline assessment (repository-only, deterministic)
      const { baseline } = await baselineAssess(ctx, change);

      // Step 3: Collect DataHub context
      const { context } = await collectContext(ctx, change.id);

      // Step 4: Decide risk (compare baseline vs grounded)
      const { comparison } = await decideRisk(ctx, { change, context, baseline });

      // Step 5 & 6: Plan migration and generate patch (only if not a clean ALLOW)
      let artifactsGenerated = 0;
      if (comparison.grounded.decision !== "ALLOW") {
        const { plan } = await planMigration(ctx, {
          context,
          table: input.table,
          field: input.field,
          newName: input.newName,
        });

        const { candidate } = await generatePatch(ctx, {
          plan,
          table: input.table,
          field: input.field,
          newName: input.newName,
        });
        artifactsGenerated = candidate.artifacts?.length ?? 0;
      }

      return {
        runId: input.runId,
        finalStatus: comparison.grounded.decision === "ALLOW" ? "COMPLETED" : "VALIDATED",
        baselineDecision: baseline.decision,
        groundedDecision: comparison.grounded.decision,
        consumersFound: context.evidence.length,
        artifactsGenerated,
      };
    },
  };
}
