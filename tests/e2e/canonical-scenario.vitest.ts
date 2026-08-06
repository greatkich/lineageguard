import { describe, expect, it } from "vitest";
import { createAgentModel, agentLLMConfigFromEnv, createAgentPipeline } from "@lineageguard/agent";

describe("Canonical Scenario E2E", () => {
  it("changes decision from ALLOW to BLOCK when DataHub reveals consumers", async () => {
    const llmConfig = agentLLMConfigFromEnv();
    const hasLlm =
      llmConfig.baseURL !== "http://localhost:20128/v1" || process.env.OMNIROUTE_BASE_URL;

    // Skip if no LLM available — this test requires OmniRoute running
    if (!hasLlm && !process.env.CI) {
      // Run with mock context only (no actual LLM call needed for decision test)
    }

    const mockDatahub = {
      collect: async () =>
        ({
          outcome: "COLLECTED_LIVE",
          context: {
            evidence: [
              { kind: "DASHBOARD", title: "Finance Revenue Dashboard", criticality: "CRITICAL" },
              { kind: "DATASET", title: "analytics.customer_revenue", criticality: "HIGH" },
              { kind: "ML_MODEL", title: "Fraud Model v3", criticality: "CRITICAL" },
              { kind: "QUERY", title: "finance-monthly-close.sql", criticality: "HIGH" },
            ],
          },
        }) as any,
    };

    const llm = createAgentModel(llmConfig);

    const pipeline = createAgentPipeline({
      datahub: mockDatahub as any,
      llm,
      workerId: "test",
      clock: () => new Date("2026-08-06T10:00:00Z"),
    });

    const result = await pipeline.execute({
      runId: "run_000000000000000000000001",
      repository: "greatkich/lineageguard",
      baseSha: "a".repeat(40),
      headSha: "b".repeat(40),
      patch: "ALTER TABLE commerce.orders RENAME COLUMN customer_id TO buyer_id;",
      table: "commerce.orders",
      field: "customer_id",
      newName: "buyer_id",
    });

    // The core assertion: DataHub context changes the decision
    expect(result.baselineDecision).toBe("ALLOW");
    expect(result.groundedDecision).toBe("BLOCK");
    expect(result.consumersFound).toBeGreaterThanOrEqual(4);
  }, 60_000);
});
