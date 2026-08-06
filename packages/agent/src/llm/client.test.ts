import { describe, expect, it } from "vitest";
import { type AgentLLMConfig, agentLLMConfigFromEnv, createAgentModel } from "./client.js";

describe("createAgentModel", () => {
  it("returns a LanguageModelV2 instance with correct provider", () => {
    const config: AgentLLMConfig = {
      baseURL: "http://localhost:20128/v1",
      model: "auto",
      apiKey: "local",
    };
    const model = createAgentModel(config);
    expect(model.modelId).toBe("auto");
    expect(model.provider).toContain("openai");
  });
});

describe("agentLLMConfigFromEnv", () => {
  it("falls back to OmniRoute defaults when env vars are unset", () => {
    const originalBaseURL = process.env.OMNIROUTE_BASE_URL;
    const originalModel = process.env.OMNIROUTE_MODEL;
    const originalApiKey = process.env.OMNIROUTE_API_KEY;
    delete process.env.OMNIROUTE_BASE_URL;
    delete process.env.OMNIROUTE_MODEL;
    delete process.env.OMNIROUTE_API_KEY;

    try {
      expect(agentLLMConfigFromEnv()).toEqual({
        baseURL: "http://localhost:20128/v1",
        model: "auto",
        apiKey: "local",
      });
    } finally {
      if (originalBaseURL === undefined) delete process.env.OMNIROUTE_BASE_URL;
      else process.env.OMNIROUTE_BASE_URL = originalBaseURL;
      if (originalModel === undefined) delete process.env.OMNIROUTE_MODEL;
      else process.env.OMNIROUTE_MODEL = originalModel;
      if (originalApiKey === undefined) delete process.env.OMNIROUTE_API_KEY;
      else process.env.OMNIROUTE_API_KEY = originalApiKey;
    }
  });

  it("reads OmniRoute configuration from environment variables", () => {
    const originalBaseURL = process.env.OMNIROUTE_BASE_URL;
    const originalModel = process.env.OMNIROUTE_MODEL;
    const originalApiKey = process.env.OMNIROUTE_API_KEY;
    process.env.OMNIROUTE_BASE_URL = "http://example.test/v1";
    process.env.OMNIROUTE_MODEL = "gpt-4.1";
    process.env.OMNIROUTE_API_KEY = "secret";

    try {
      expect(agentLLMConfigFromEnv()).toEqual({
        baseURL: "http://example.test/v1",
        model: "gpt-4.1",
        apiKey: "secret",
      });
    } finally {
      if (originalBaseURL === undefined) delete process.env.OMNIROUTE_BASE_URL;
      else process.env.OMNIROUTE_BASE_URL = originalBaseURL;
      if (originalModel === undefined) delete process.env.OMNIROUTE_MODEL;
      else process.env.OMNIROUTE_MODEL = originalModel;
      if (originalApiKey === undefined) delete process.env.OMNIROUTE_API_KEY;
      else process.env.OMNIROUTE_API_KEY = originalApiKey;
    }
  });
});
