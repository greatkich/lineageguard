import { describe, expect, it, vi } from "vitest";
import {
  createOfficialStdioSession,
  type OfficialSdkConnection,
  type OfficialSdkFactory,
  type OfficialSdkLaunch,
  officialDataHubMcpServer,
} from "./official-stdio.js";

const credentials = {
  dataHubGmsUrl: "http://127.0.0.1:8080",
  readToken: "read-token-only-123",
  uvxPath: "/Users/runtime/.local/bin/uvx",
};

function sdk(overrides: Partial<OfficialSdkConnection> = {}): OfficialSdkConnection {
  return {
    callTool: vi.fn(async () => ({ structuredContent: { ok: true } })),
    close: vi.fn(async () => undefined),
    connect: vi.fn(async () => undefined),
    listTools: vi.fn(async () => ({ tools: [] })),
    ...overrides,
  };
}

describe("official DataHub MCP stdio configuration", () => {
  it("pins server 0.6.0 and spawns it with only the read credential and bounded flags", async () => {
    let launch: OfficialSdkLaunch | undefined;
    const connection = sdk();
    const factory: OfficialSdkFactory = (input) => {
      launch = input;
      return connection;
    };

    await createOfficialStdioSession(credentials, factory);

    expect(officialDataHubMcpServer).toEqual({
      executable: "mcp-server-datahub",
      package: "mcp-server-datahub",
      transport: "stdio",
      version: "0.6.0",
    });
    expect(launch).toMatchObject({
      client: {
        enforceStrictCapabilities: true,
        listMaxPages: 4,
        name: "lineageguard-datahub-context",
        version: "0.1.0",
      },
      process: {
        args: [
          "--isolated",
          "--no-env-file",
          "--no-sources",
          "--keyring-provider",
          "disabled",
          "--exclude-newer",
          "2026-05-19T00:00:00Z",
          "--from",
          "mcp-server-datahub==0.6.0",
          "mcp-server-datahub",
          "--transport",
          "stdio",
        ],
        command: credentials.uvxPath,
        maxBufferSize: 300_000,
        stderr: "ignore",
      },
    });
    expect(launch?.process.env).toEqual({
      DATAHUB_GMS_TOKEN: credentials.readToken,
      DATAHUB_GMS_URL: credentials.dataHubGmsUrl,
      DATAHUB_MCP_DOCUMENT_TOOLS_DISABLED: "true",
      DATA_QUALITY_TOOLS_ENABLED: "false",
      NO_COLOR: "1",
      SAVE_DOCUMENT_TOOL_ENABLED: "false",
      SEMANTIC_SEARCH_ENABLED: "false",
      TOOLS_IS_MUTATION_ENABLED: "false",
      TOOLS_IS_USER_ENABLED: "false",
      UV_NO_CONFIG: "1",
    });
    expect(connection.connect).toHaveBeenCalledWith(
      expect.objectContaining({ signal: expect.any(AbortSignal), timeoutMs: 8_000 }),
    );
  });

  it.each([
    [{ ...credentials, dataHubGmsUrl: "http://datahub.example.com" }, "remote HTTP"],
    [{ ...credentials, dataHubGmsUrl: "https://user@datahub.example.com" }, "URL credentials"],
    [{ ...credentials, dataHubGmsUrl: "https://datahub.example.com/?token=secret" }, "query"],
    [{ ...credentials, readToken: "token\nINJECTED=true" }, "token controls"],
    [{ ...credentials, uvxPath: "uvx" }, "relative command"],
    [{ ...credentials, uvxPath: "/usr/local/bin/python" }, "unexpected command"],
  ])("rejects unsafe configuration: %s (%s)", async (input) => {
    const factory = vi.fn<OfficialSdkFactory>(() => sdk());

    await expect(createOfficialStdioSession(input, factory)).rejects.toMatchObject({
      code: "CONFIGURATION",
    });
    expect(factory).not.toHaveBeenCalled();
  });

  it("does not retain or expose credentials when connection fails", async () => {
    const secret = "read-token-never-log-this";
    const connection = sdk({ connect: vi.fn(async () => Promise.reject(new Error(secret))) });

    let thrown: unknown;
    try {
      await createOfficialStdioSession({ ...credentials, readToken: secret }, () => connection);
    } catch (error) {
      thrown = error;
    }

    expect(String(thrown)).not.toContain(secret);
    expect(JSON.stringify(thrown)).not.toContain(secret);
    expect(thrown).toMatchObject({ code: "UNAVAILABLE", retryable: true });
    expect(connection.close).toHaveBeenCalledOnce();
  });

  it("forwards only bounded list and call operations and closes idempotently", async () => {
    const connection = sdk({
      listTools: vi.fn(async () => ({
        tools: [{ annotations: { readOnlyHint: true }, name: "search" }],
      })),
    });
    const session = await createOfficialStdioSession(credentials, () => connection);
    const signal = new AbortController().signal;

    await expect(session.listTools({ signal, timeoutMs: 8_000 })).resolves.toEqual({
      tools: [{ annotations: { readOnlyHint: true }, name: "search" }],
    });
    await expect(
      session.callTool("search", { query: "/q orders" }, { signal, timeoutMs: 8_000 }),
    ).resolves.toEqual({ structuredContent: { ok: true } });
    expect(connection.listTools).toHaveBeenCalledWith({ signal, timeoutMs: 8_000 });
    expect(connection.callTool).toHaveBeenCalledWith(
      { arguments: { query: "/q orders" }, name: "search" },
      { signal, timeoutMs: 8_000 },
    );

    await session.close();
    await session.close();
    expect(connection.close).toHaveBeenCalledOnce();
  });
});
