import { createOpenAI } from "@ai-sdk/openai";
import type { LanguageModelV2 } from "@ai-sdk/provider";

export interface AgentLLMConfig {
  baseURL: string;
  model: string;
  apiKey: string;
}

export function agentLLMConfigFromEnv(): AgentLLMConfig {
  return {
    baseURL: process.env.OMNIROUTE_BASE_URL ?? "http://localhost:20128/v1",
    model: process.env.OMNIROUTE_MODEL ?? "auto",
    apiKey: process.env.OMNIROUTE_API_KEY ?? "local",
  };
}

export function createAgentModel(config: AgentLLMConfig): LanguageModelV2 {
  const provider = createOpenAI({
    baseURL: config.baseURL,
    apiKey: config.apiKey,
  });
  return provider(config.model);
}
