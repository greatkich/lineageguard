import { describe, expect, it } from "vitest";
import * as api from "./index.js";

describe("public DataHub adapter boundary", () => {
  it("exports normalized ports without exposing raw MCP payload APIs", () => {
    expect(Object.keys(api).sort()).toEqual([
      "DataHubAdapterError",
      "createOfficialLiveDataHubContextPort",
      "createOfficialLiveDataHubWritebackPort",
      "dataHubWritebackBindingFingerprint",
      "deriveDataHubWritebackPayloads",
      "officialDataHubMcpServer",
    ]);
    expect(api).not.toHaveProperty("collectCanonicalObservations");
    expect(api).not.toHaveProperty("createReadOnlyToolClient");
    expect(api).not.toHaveProperty("createMutationToolClient");
    expect(api).not.toHaveProperty("createOfficialMutationSession");
    expect(api).not.toHaveProperty("createVerifiedReplayBundle");
    expect(api).not.toHaveProperty("createVerifiedReplayDataHubContextPort");
    expect(api).not.toHaveProperty("createVerifiedReplayDataHubWritebackPort");
    expect(api).not.toHaveProperty("normalizeCanonicalLiveCollection");
  });
});
