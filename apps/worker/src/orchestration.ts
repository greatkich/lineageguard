import {
  agentLLMConfigFromEnv,
  createAgentModel,
  createAgentPipeline,
} from "@lineageguard/agent";
import { createRestDataHubPort } from "./datahub-rest-port.js";

export function createOrchestrator(workerId: string) {
  const llmConfig = agentLLMConfigFromEnv();
  const llm = createAgentModel(llmConfig);

  // Real DataHub context port — queries GMS REST API directly
  const datahub = createRestDataHubPort({
    gmsUrl: process.env.DATAHUB_GMS_URL ?? "http://127.0.0.1:8080",
    token: process.env.DATAHUB_READ_TOKEN ?? process.env.DATAHUB_TOKEN ?? "",
  });

  return createAgentPipeline({
    datahub: datahub as any,
    llm,
    workerId,
    clock: () => new Date(),
  });
}
