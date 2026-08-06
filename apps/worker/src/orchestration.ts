import {
  agentLLMConfigFromEnv,
  type AgentDataHubContextPort,
  createAgentModel,
  createAgentPipeline,
} from "@lineageguard/agent";

// MVP stand-in for the real DataHub context port. `createCanonicalImpactContextFixture`
// (packages/domain/src/evidence.ts) exists but is intentionally not part of domain's
// public surface (see packages/domain/src/domain.test.ts), so the worker builds a
// minimal evidence shape here instead of depending on it. This mock is expected to be
// replaced by the real @lineageguard/datahub adapter in a follow-up task.
const mockDatahub: AgentDataHubContextPort = {
  collect: async (_input) =>
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

export function createOrchestrator(workerId: string) {
  const llmConfig = agentLLMConfigFromEnv();
  const llm = createAgentModel(llmConfig);

  return createAgentPipeline({
    datahub: mockDatahub,
    llm,
    workerId,
    clock: () => new Date(),
  });
}
