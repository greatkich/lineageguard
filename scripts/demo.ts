import {
  agentLLMConfigFromEnv,
  createAgentModel,
  createAgentPipeline,
  type PipelineResult,
} from "@lineageguard/agent";
import { createRestDataHubPort } from "../apps/worker/src/datahub-rest-port.js";

async function main() {
  console.log("=== LineageGuard MVP Demo ===\n");

  const llmConfig = agentLLMConfigFromEnv();
  const llm = createAgentModel(llmConfig);
  const gmsUrl = process.env.DATAHUB_GMS_URL ?? "http://127.0.0.1:8080";
  const token = process.env.DATAHUB_READ_TOKEN ?? process.env.DATAHUB_TOKEN ?? "";

  console.log(`LLM: ${llmConfig.baseURL} (model: ${llmConfig.model})`);
  console.log(`DataHub: ${gmsUrl}\n`);

  // Real DataHub context port — no mocks
  const datahub = createRestDataHubPort({ gmsUrl, token });

  const pipeline = createAgentPipeline({
    datahub: datahub as any,
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

  if (result.groundedDecision === "BLOCK" && result.consumersFound >= 2) {
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
