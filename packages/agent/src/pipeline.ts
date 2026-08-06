import type { LanguageModelV2 } from "@ai-sdk/provider";
import {
  bindMigrationCandidate,
  type ImpactContext,
  type MigrationCandidate,
  type ProposedChange,
  type RiskComparison,
  type RunStatus,
} from "@lineageguard/domain";
import { type AgentLLMConfig, agentLLMConfigFromEnv, directLLMCall } from "./llm/client.js";
import { migrationPlanPrompt } from "./llm/prompts.js";
import { migrationPlanSchema } from "./llm/schemas.js";
import { buildCanonicalCandidate } from "./steps/build-canonical-candidate.js";
import { deriveImpactCards } from "./steps/derive-impact-cards.js";
import type { AgentDataHubContextPort, StepContext } from "./steps/index.js";
import {
  baselineAssess,
  collectContext,
  decideRisk,
  parseChange,
} from "./steps/index.js";

// ---------------------------------------------------------------------------
// Ports for external effects (wired by the worker app)
// ---------------------------------------------------------------------------

export interface AgentGitHubPort {
  createReview(input: GitHubReviewInput): Promise<GitHubReviewOutput>;
}

export interface GitHubReviewInput {
  runId: string;
  candidate: MigrationCandidate;
  comparison: RiskComparison;
  context: ImpactContext;
}

export interface GitHubReviewOutput {
  prUrl: string;
  prNumber: number;
  headSha: string;
  headBranch: string;
  receiptFingerprint: string;
}

export interface AgentValidationPort {
  validate(candidate: MigrationCandidate, context: { runId: string }): Promise<ValidationOutput>;
}

export interface ValidationOutput {
  allPass: boolean;
  checks: Array<{ check: string; status: "PASS" | "FAIL"; summary: string }>;
  receiptFingerprint: string;
}

export interface AgentWritebackPort {
  write(input: WritebackInput): Promise<WritebackOutput>;
}

export interface WritebackInput {
  runId: string;
  comparison: RiskComparison;
  context: ImpactContext;
  candidate: MigrationCandidate;
  githubPrUrl: string;
  githubReceiptFingerprint: string;
  validationReceiptFingerprint: string;
}

export interface WritebackOutput {
  status: "SUCCEEDED" | "AMBIGUOUS";
  receiptFingerprint: string;
}

// ---------------------------------------------------------------------------
// Pipeline config
// ---------------------------------------------------------------------------

export interface AgentPipelineConfig {
  datahub: AgentDataHubContextPort;
  llm: LanguageModelV2;
  workerId: string;
  clock: () => Date;
  github?: AgentGitHubPort | undefined;
  validation?: AgentValidationPort | undefined;
  writeback?: AgentWritebackPort | undefined;
  onStatusChange?: ((runId: string, status: string, extra?: Record<string, unknown>) => Promise<void>) | undefined;
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
  source?: "GITHUB" | "FIXTURE" | undefined;
  sourcePath?: string | undefined;
}

export interface PipelineResult {
  runId: string;
  finalStatus: RunStatus;
  baselineDecision: string;
  groundedDecision: string;
  consumersFound: number;
  artifactsGenerated: number;
  triggeredRules: string[];
  validationPassed: boolean;
  prUrl: string | null;
  writebackStatus: string | null;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function extractJson(text: string): unknown {
  const stripped = text.replace(/^```(?:json)?\n?/m, "").replace(/\n?```$/m, "").trim();
  try { return JSON.parse(stripped); } catch {}
  const match = stripped.match(/\{[\s\S]*\}/);
  if (match) return JSON.parse(match[0]);
  throw new Error("No JSON in LLM response");
}

// ---------------------------------------------------------------------------
// Pipeline
// ---------------------------------------------------------------------------

export function createAgentPipeline(config: AgentPipelineConfig) {
  const notify = config.onStatusChange ?? (async () => {});
  const llmConfig = agentLLMConfigFromEnv();

  return {
    async execute(input: RunInput): Promise<PipelineResult> {
      const ctx: StepContext = {
        runId: input.runId,
        workerId: config.workerId,
        llm: config.llm,
        datahub: config.datahub,
        clock: config.clock,
      };

      const result: PipelineResult = {
        runId: input.runId,
        finalStatus: "CREATED" as RunStatus,
        baselineDecision: "ALLOW",
        groundedDecision: "ALLOW",
        consumersFound: 0,
        artifactsGenerated: 0,
        triggeredRules: [],
        validationPassed: false,
        prUrl: null,
        writebackStatus: null,
      };

      // ─── Step 1: Parse change ─────────────────────────────────────────
      console.log(`  [pipeline] Step 1: Parsing change...`);
      await notify(input.runId, "CHANGE_PARSED");
      const { change } = await parseChange(ctx, {
        repository: input.repository,
        baseSha: input.baseSha,
        headSha: input.headSha,
        patch: input.patch,
        source: input.source,
        sourcePath: input.sourcePath,
      });

      // ─── Step 2: Baseline assessment ──────────────────────────────────
      console.log(`  [pipeline] Step 2: Baseline assessment...`);
      const { baseline } = await baselineAssess(ctx, change);
      result.baselineDecision = baseline.decision;
      await notify(input.runId, "BASELINE_ASSESSED", { baselineDecision: baseline.decision });

      // ─── Step 3: Collect DataHub context (REAL MCP) ───────────────────
      console.log(`  [pipeline] Step 3: Collecting DataHub context...`);
      await notify(input.runId, "CONTEXT_COLLECTING");
      let context: ImpactContext;
      try {
        const collectResult = await collectContext(ctx, change.id);
        context = collectResult.context;
        // Derive exactly 4 canonical impact cards (not raw evidence count)
        const impactCards = deriveImpactCards(context);
        result.consumersFound = impactCards.length;
        console.log(`  [pipeline] Step 3: Collected ${context.evidence.length} evidence items (${impactCards.length} impact cards)`);
        await notify(input.runId, "CONTEXT_COLLECTED", {
          consumersFound: impactCards.length,
          evidenceItems: context.evidence.length,
          contextJson: context,
        });
      } catch (err: any) {
        console.error(`  [pipeline] Step 3 FAILED: ${err.message}`);
        await notify(input.runId, "FAILED_CONTEXT");
        result.finalStatus = "FAILED_CONTEXT" as RunStatus;
        return result;
      }

      // ─── Step 4: Risk decision (REAL 5-rule engine) ───────────────────
      console.log(`  [pipeline] Step 4: Evaluating risk (5 rules)...`);
      let comparison: RiskComparison;
      try {
        const riskResult = await decideRisk(ctx, { change, context, baseline });
        comparison = riskResult.comparison;
        result.groundedDecision = comparison.grounded.decision;
        result.triggeredRules = [...comparison.triggeredRuleIds];
        console.log(`  [pipeline] Step 4: ${comparison.transition} — rules: ${comparison.triggeredRuleIds.join(", ")}`);
        await notify(input.runId, "RISK_DECIDED", {
          groundedDecision: comparison.grounded.decision,
          triggeredRules: comparison.triggeredRuleIds,
          comparisonJson: comparison,
        });
      } catch (err: any) {
        console.error(`  [pipeline] Step 4 FAILED: ${err.message}`);
        await notify(input.runId, "FAILED_CONTEXT");
        result.finalStatus = "FAILED_CONTEXT" as RunStatus;
        return result;
      }

      // If ALLOW, we're done
      if (comparison.grounded.decision === "ALLOW") {
        result.finalStatus = "COMPLETED" as RunStatus;
        await notify(input.runId, "COMPLETED");
        return result;
      }

      // ─── Step 5: Plan migration (LLM — rationale only) ────────────────
      console.log(`  [pipeline] Step 5: Planning migration...`);
      let plan;
      try {
        // Filter evidence to consumer-relevant kinds for the LLM prompt
        const consumerKinds = new Set(["LINEAGE_PATH", "DASHBOARD", "ML_MODEL", "QUERY_USAGE"]);
        const consumers = ((context as any).evidence ?? [])
          .filter((e: any) => consumerKinds.has(e.kind))
          .map((e: any) => ({
            name: e.title ?? e.entityName ?? "unknown",
            type: e.kind,
            criticality: e.criticality,
          }));
        const planPrompt = migrationPlanPrompt({
          table: input.table, field: input.field,
          operation: "RENAME", newName: input.newName, consumers,
        }) + "\n\nRespond with ONLY a valid JSON object: {\"strategy\": string, \"steps\": [{\"order\": number, \"action\": string, \"description\": string}], \"rationale\": string}. No markdown fences.";
        const planText = await directLLMCall(llmConfig, planPrompt, 3000);
        plan = migrationPlanSchema.parse(extractJson(planText));
        console.log(`  [pipeline] Step 5: Plan strategy: ${plan.strategy} (${plan.steps.length} steps)`);
        await notify(input.runId, "MIGRATION_PLANNED", { strategy: plan.strategy });
      } catch (err: any) {
        const msg = err.message?.slice(0, 200) ?? String(err).slice(0, 200);
        console.error(`  [pipeline] Step 5 FAILED: ${msg}`);
        await notify(input.runId, "FAILED_GENERATION");
        result.finalStatus = "FAILED_GENERATION" as RunStatus;
        return result;
      }

      // ─── Step 6: Build canonical migration candidate (deterministic) ───
      console.log(`  [pipeline] Step 6: Building canonical migration candidate...`);
      let candidate: MigrationCandidate;
      try {
        candidate = buildCanonicalCandidate({
          change,
          context,
          comparison,
          rationale: plan.rationale,
        });
        // Bind candidate to change/context/assessment — proves consistency
        bindMigrationCandidate(candidate, change, context, comparison.grounded);
        result.artifactsGenerated = candidate.artifacts.length;
        console.log(`  [pipeline] Step 6: Built ${result.artifactsGenerated} artifacts (deterministic, bound)`);
        await notify(input.runId, "PATCH_GENERATED", {
          artifactsGenerated: result.artifactsGenerated,
          candidateJson: candidate,
        });
      } catch (err: any) {
        console.error(`  [pipeline] Step 6 FAILED: ${err.message?.slice(0, 100)}`);
        await notify(input.runId, "FAILED_GENERATION");
        result.finalStatus = "FAILED_GENERATION" as RunStatus;
        return result;
      }

      // ─── Step 7: Validation (REAL Docker containers) ──────────────────
      let validationReceiptFingerprint = "";
      if (config.validation) {
        console.log(`  [pipeline] Step 7: Running validation (8 checks)...`);
        try {
          const validationOutput = await config.validation.validate(candidate, { runId: input.runId });
          result.validationPassed = validationOutput.allPass;
          validationReceiptFingerprint = validationOutput.receiptFingerprint;
          if (!validationOutput.allPass) {
            const failed = validationOutput.checks.filter((c) => c.status === "FAIL");
            console.error(`  [pipeline] Step 7: Validation FAILED: ${failed.map((c) => c.check).join(", ")}`);
            await notify(input.runId, "FAILED_VALIDATION", { failedChecks: failed.map((c) => c.check) });
            result.finalStatus = "FAILED_VALIDATION" as RunStatus;
            return result;
          }
          console.log(`  [pipeline] Step 7: All 8 checks PASS`);
          await notify(input.runId, "VALIDATED", {
            artifactsGenerated: result.artifactsGenerated,
            validationReceiptFingerprint,
          });
        } catch (err: any) {
          console.error(`  [pipeline] Step 7 FAILED: ${err.message?.slice(0, 150)}`);
          await notify(input.runId, "FAILED_VALIDATION");
          result.finalStatus = "FAILED_VALIDATION" as RunStatus;
          return result;
        }
      } else {
        console.error(`  [pipeline] Step 7: No validation port configured — failing`);
        await notify(input.runId, "FAILED_VALIDATION");
        result.finalStatus = "FAILED_VALIDATION" as RunStatus;
        return result;
      }

      // ─── Step 8: GitHub PR (REAL) ─────────────────────────────────────
      let githubReceipt: GitHubReviewOutput | null = null;
      if (config.github) {
        console.log(`  [pipeline] Step 8: Creating GitHub PR...`);
        try {
          githubReceipt = await config.github.createReview({
            runId: input.runId,
            candidate,
            comparison,
            context,
          });
          result.prUrl = githubReceipt.prUrl;
          console.log(`  [pipeline] Step 8: PR created → ${githubReceipt.prUrl}`);
          await notify(input.runId, "REVIEW_ARTIFACT_CREATED", {
            prUrl: githubReceipt.prUrl,
            prNumber: githubReceipt.prNumber,
            githubReceiptFingerprint: githubReceipt.receiptFingerprint,
          });
        } catch (err: any) {
          console.error(`  [pipeline] Step 8 FAILED: ${err.message?.slice(0, 150)}`);
          await notify(input.runId, "FAILED_GITHUB");
          result.finalStatus = "FAILED_GITHUB" as RunStatus;
          return result;
        }
      } else {
        console.error(`  [pipeline] Step 8: No GitHub port configured — failing`);
        await notify(input.runId, "FAILED_GITHUB");
        result.finalStatus = "FAILED_GITHUB" as RunStatus;
        return result;
      }

      // ─── Step 9: DataHub writeback (REAL) ─────────────────────────────
      if (config.writeback) {
        console.log(`  [pipeline] Step 9: Writing decision back to DataHub...`);
        try {
          const writebackOutput = await config.writeback.write({
            runId: input.runId,
            comparison,
            context,
            candidate,
            githubPrUrl: githubReceipt?.prUrl ?? "",
            githubReceiptFingerprint: githubReceipt?.receiptFingerprint ?? "",
            validationReceiptFingerprint,
          });
          if (writebackOutput.status === "AMBIGUOUS") {
            console.error(`  [pipeline] Step 9: Writeback AMBIGUOUS — failing`);
            await notify(input.runId, "FAILED_WRITEBACK");
            result.finalStatus = "FAILED_WRITEBACK" as RunStatus;
            result.writebackStatus = "AMBIGUOUS";
            return result;
          }
          result.writebackStatus = writebackOutput.status;
          console.log(`  [pipeline] Step 9: Writeback ${writebackOutput.status}`);
          await notify(input.runId, "WRITEBACK_PENDING", {
            writebackStatus: writebackOutput.status,
            writebackReceiptFingerprint: writebackOutput.receiptFingerprint,
          });
        } catch (err: any) {
          console.error(`  [pipeline] Step 9 FAILED: ${err.message?.slice(0, 150)}`);
          await notify(input.runId, "FAILED_WRITEBACK");
          result.finalStatus = "FAILED_WRITEBACK" as RunStatus;
          return result;
        }
      } else {
        console.error(`  [pipeline] Step 9: No writeback port configured — failing`);
        await notify(input.runId, "FAILED_WRITEBACK");
        result.finalStatus = "FAILED_WRITEBACK" as RunStatus;
        return result;
      }

      // ─── Done ─────────────────────────────────────────────────────────
      result.finalStatus = "COMPLETED" as RunStatus;
      await notify(input.runId, "COMPLETED", {
        artifactsGenerated: result.artifactsGenerated,
        prUrl: result.prUrl,
        writebackStatus: result.writebackStatus,
      });
      console.log(`  [pipeline] ✅ Run ${input.runId} COMPLETED`);
      return result;
    },
  };
}
