import { dirname } from "node:path";
import { DEFAULT_INHERITED_ENV_VARS } from "@modelcontextprotocol/client/stdio";
import { describe, expect, it } from "vitest";
import { createOfficialMutationSession, type OfficialMutationSdkLaunch } from "./mutation-stdio.js";

const credentials = {
  dataHubGmsUrl: "https://datahub.example.test",
  mutationToken: "mutation-token-value",
  uvCacheDir: "/tmp/lineageguard-mutation-cache",
  uvxPath: "/usr/local/bin/uvx",
};

describe("official DataHub mutation stdio", () => {
  it("uses a separate pinned, controlled mutation environment", async () => {
    let launch: OfficialMutationSdkLaunch | undefined;
    const session = await createOfficialMutationSession(credentials, (captured) => {
      launch = captured;
      return {
        async callTool() {
          return { structuredContent: { success: true } };
        },
        async close() {},
        async connect() {},
        async listTools() {
          return { tools: [] };
        },
      };
    });
    expect(launch?.process.args).toContain("mcp-server-datahub==0.6.0");
    expect(launch?.process.env).toEqual({
      ...Object.fromEntries(DEFAULT_INHERITED_ENV_VARS.map((name) => [name, ""])),
      DATAHUB_GMS_TOKEN: credentials.mutationToken,
      DATAHUB_GMS_URL: credentials.dataHubGmsUrl,
      DATAHUB_MCP_DOCUMENT_TOOLS_DISABLED: "false",
      DATA_QUALITY_TOOLS_ENABLED: "false",
      HOME: credentials.uvCacheDir,
      LOGNAME: "lineageguard",
      NO_COLOR: "1",
      PATH: dirname(credentials.uvxPath),
      SAVE_DOCUMENT_TOOL_ENABLED: "true",
      SEMANTIC_SEARCH_ENABLED: "false",
      SHELL: "",
      TERM: "dumb",
      TOOLS_IS_MUTATION_ENABLED: "true",
      TOOLS_IS_USER_ENABLED: "false",
      USER: "lineageguard",
      UV_CACHE_DIR: credentials.uvCacheDir,
      UV_NO_CONFIG: "1",
    });
    expect(JSON.stringify(launch)).not.toContain("readToken");
    await session.close();
  });
});
