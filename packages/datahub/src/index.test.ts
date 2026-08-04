import { describe, expect, it } from "vitest";
import * as api from "./index.js";

describe("public DataHub adapter boundary", () => {
  it("exports normalized ports without exposing raw MCP payload APIs", () => {
    expect(Object.keys(api).sort()).toEqual([
      "DataHubAdapterError",
      "createOfficialLiveDataHubContextPort",
      "createVerifiedReplayBundle",
      "createVerifiedReplayDataHubContextPort",
      "officialDataHubMcpServer",
    ]);
    expect(api).not.toHaveProperty("collectCanonicalObservations");
    expect(api).not.toHaveProperty("createReadOnlyToolClient");
    expect(api).not.toHaveProperty("normalizeCanonicalLiveCollection");
  });
});
