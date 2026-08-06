import {
  agentLLMConfigFromEnv,
  createAgentModel,
  createAgentPipeline,
} from "@lineageguard/agent";
import { createRestDataHubPort } from "./datahub-rest-port.js";
import { updateRunStatus } from "./simple-store.js";

export function createOrchestrator(workerId: string) {
  const llmConfig = agentLLMConfigFromEnv();
  const llm = createAgentModel(llmConfig);

  const datahub = createRestDataHubPort({
    gmsUrl: process.env.DATAHUB_GMS_URL ?? "http://127.0.0.1:8080",
    token: process.env.DATAHUB_READ_TOKEN ?? process.env.DATAHUB_TOKEN ?? "",
  });

  return createAgentPipeline({
    datahub: datahub as any,
    llm,
    workerId,
    clock: () => new Date(),
    onStatusChange: async (runId, status, extra) => {
      await updateRunStatus(runId, status, extra as any);
    },
  });
}
