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
    model: process.env.OMNIROUTE_MODEL ?? "claude",
    apiKey: process.env.OMNIROUTE_API_KEY ?? "local",
  };
}

export function createAgentModel(config: AgentLLMConfig): LanguageModelV2 {
  const provider = createOpenAI({
    baseURL: config.baseURL,
    apiKey: config.apiKey,
  });
  return provider.chat(config.model);
}

/**
 * Direct LLM call bypassing AI SDK streaming issues with OmniRoute.
 * OmniRoute always returns streaming responses, but we need non-streaming
 * for structured output. This calls the API directly with stream:false.
 */
export async function directLLMCall(
  config: AgentLLMConfig,
  prompt: string,
  maxTokens = 2000,
): Promise<string> {
  const res = await fetch(`${config.baseURL}/chat/completions`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${config.apiKey}`,
    },
    body: JSON.stringify({
      model: config.model,
      messages: [{ role: "user", content: prompt }],
      stream: false,
      max_tokens: maxTokens,
    }),
  });
  if (!res.ok) throw new Error(`LLM call failed: ${res.status}`);
  const data = (await res.json()) as any;
  return data.choices?.[0]?.message?.content ?? "";
}
