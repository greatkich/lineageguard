import {
  agentLLMConfigFromEnv,
  createAgentModel,
  createAgentPipeline,
  type PipelineResult,
} from "@lineageguard/agent";

async function main() {
  console.log("=== LineageGuard MVP Demo ===\n");

  const llmConfig = agentLLMConfigFromEnv();
  const llm = createAgentModel(llmConfig);

  console.log(`LLM: ${llmConfig.baseURL} (model: ${llmConfig.model})\n`);

  // MVP: mock DataHub context port (returns canonical 4 consumers)
  const mockDatahub = {
    collect: async (input: { changeId: string }) => {
      console.log(`  [DataHub] Collecting context for ${input.changeId}`);
      return {
        outcome: "COLLECTED_LIVE" as const,
        context: {
          evidence: [
            { kind: "DASHBOARD", title: "Finance Revenue Dashboard", criticality: "CRITICAL" },
            { kind: "DATASET", title: "analytics.customer_revenue", criticality: "HIGH" },
            { kind: "ML_MODEL", title: "Fraud Model v3", criticality: "CRITICAL" },
            { kind: "QUERY", title: "finance-monthly-close.sql", criticality: "HIGH" },
          ],
        },
      } as any;
    },
  };

  const pipeline = createAgentPipeline({
    datahub: mockDatahub as any,
    llm,
    workerId: "demo",
    clock: () => new Date(),
  });

  console.log("--- Running canonical scenario: RENAME customer_id → buyer_id ---\n");

  const result: PipelineResult = await pipeline.execute({
    runId: "run_000000000000000000000001",
    repository: "greatkich/lineageguard",
    baseSha: "a".repeat(40),
    headSha: "b".repeat(40),
    patch: "ALTER TABLE commerce.orders RENAME COLUMN customer_id TO buyer_id;",
    table: "commerce.orders",
    field: "customer_id",
    newName: "buyer_id",
  });

  console.log("\n=== Results ===");
  console.log(`Baseline decision:   ${result.baselineDecision}`);
  console.log(`Grounded decision:   ${result.groundedDecision}`);
  console.log(`Decision changed:    ${result.baselineDecision !== result.groundedDecision ? "YES" : "NO"}`);
  console.log(`Consumers found:     ${result.consumersFound}`);
  console.log(`Artifacts generated: ${result.artifactsGenerated}`);
  console.log(`Final status:        ${result.finalStatus}`);
  console.log("\n=== Demo Complete ===");

  if (result.groundedDecision === "BLOCK" && result.consumersFound >= 4) {
    console.log("\n✓ SUCCESS: DataHub changed the decision from ALLOW to BLOCK");
    process.exit(0);
  } else {
    console.error("\n✗ UNEXPECTED: Decision did not change as expected");
    process.exit(1);
  }
}

main().catch((err) => {
  console.error("Demo failed:", err);
  process.exit(1);
});
