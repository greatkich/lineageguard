import { chmod, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { DEFAULT_INHERITED_ENV_VARS } from "@modelcontextprotocol/client/stdio";
import { describe, expect, it, vi } from "vitest";
import {
  createOfficialSdkTransport,
  createOfficialStdioSession,
  type OfficialSdkConnection,
  type OfficialSdkFactory,
  type OfficialSdkLaunch,
  officialDataHubMcpServer,
} from "./official-stdio.js";

const credentials = {
  dataHubGmsUrl: "http://127.0.0.1:8080",
  readToken: "read-token-only-123",
  uvCacheDir: "/Users/runtime/.cache/lineageguard-uv",
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
      ...Object.fromEntries(DEFAULT_INHERITED_ENV_VARS.map((name) => [name, ""])),
      DATAHUB_GMS_TOKEN: credentials.readToken,
      DATAHUB_GMS_URL: credentials.dataHubGmsUrl,
      DATAHUB_MCP_DOCUMENT_TOOLS_DISABLED: "true",
      DATA_QUALITY_TOOLS_ENABLED: "false",
      HOME: credentials.uvCacheDir,
      LOGNAME: "lineageguard",
      NO_COLOR: "1",
      PATH: dirname(credentials.uvxPath),
      SAVE_DOCUMENT_TOOL_ENABLED: "false",
      SEMANTIC_SEARCH_ENABLED: "false",
      SHELL: "",
      TERM: "dumb",
      TOOLS_IS_MUTATION_ENABLED: "false",
      TOOLS_IS_USER_ENABLED: "false",
      USER: "lineageguard",
      UV_CACHE_DIR: credentials.uvCacheDir,
      UV_NO_CONFIG: "1",
    });
    expect(connection.connect).toHaveBeenCalledWith(
      expect.objectContaining({ signal: expect.any(AbortSignal), timeoutMs: 8_000 }),
    );
  });

  it("overrides every SDK-inherited variable at the actual stdio spawn boundary", async () => {
    const probeRoot = await mkdtemp(join(tmpdir(), "lineageguard-stdio-"));
    const uvxPath = join(probeRoot, "uvx");
    const uvCacheDir = join(probeRoot, "cache");
    const poisoned = Object.fromEntries(
      [...DEFAULT_INHERITED_ENV_VARS, "AWS_SECRET_ACCESS_KEY"].map((name) => [
        name,
        `poisoned-${name}`,
      ]),
    );
    const previous = new Map(
      Object.keys(poisoned).map((name) => [name, process.env[name]] as const),
    );
    let spawnedEnvironment: Readonly<Record<string, string | undefined>> | undefined;

    try {
      await mkdir(uvCacheDir);
      await writeFile(
        uvxPath,
        `#!${process.execPath}\nconst names = ${JSON.stringify([
          ...DEFAULT_INHERITED_ENV_VARS,
          "AWS_SECRET_ACCESS_KEY",
          "UV_CACHE_DIR",
        ])};\nconst env = Object.fromEntries(names.map((name) => [name, process.env[name]]));\nprocess.stdout.write(JSON.stringify({ jsonrpc: "2.0", method: "probe/env", params: { env } }) + "\\n");\n`,
        { mode: 0o700 },
      );
      await chmod(uvxPath, 0o700);
      for (const [name, value] of Object.entries(poisoned)) process.env[name] = value;

      const factory: OfficialSdkFactory = (launch) => {
        const transport = createOfficialSdkTransport(launch);
        return {
          async callTool() {
            throw new Error("probe does not call tools");
          },
          async close() {
            await transport.close();
          },
          async connect() {
            const captured = new Promise<Readonly<Record<string, string | undefined>>>(
              (resolve, reject) => {
                transport.onerror = reject;
                transport.onmessage = (message) => {
                  const candidate = message as unknown as {
                    method?: string;
                    params?: { env?: Readonly<Record<string, string | undefined>> };
                  };
                  if (candidate.method === "probe/env" && candidate.params?.env !== undefined) {
                    resolve(candidate.params.env);
                  }
                };
              },
            );
            await transport.start();
            spawnedEnvironment = await captured;
          },
          async listTools() {
            return { tools: [] };
          },
        };
      };

      const session = await createOfficialStdioSession(
        { ...credentials, uvCacheDir, uvxPath },
        factory,
      );
      await session.close();

      expect(spawnedEnvironment).toMatchObject({
        HOME: uvCacheDir,
        LOGNAME: "lineageguard",
        PATH: dirname(uvxPath),
        SHELL: "",
        TERM: "dumb",
        USER: "lineageguard",
        UV_CACHE_DIR: uvCacheDir,
      });
      expect(spawnedEnvironment?.AWS_SECRET_ACCESS_KEY).toBeUndefined();
      for (const value of Object.values(spawnedEnvironment ?? {})) {
        expect(value?.startsWith("poisoned-")).not.toBe(true);
      }
    } finally {
      for (const [name, value] of previous) {
        if (value === undefined) delete process.env[name];
        else process.env[name] = value;
      }
      await rm(probeRoot, { force: true, recursive: true });
    }
  });

  it.each([
    [{ ...credentials, dataHubGmsUrl: "http://datahub.example.com" }, "remote HTTP"],
    [{ ...credentials, dataHubGmsUrl: "https://user@datahub.example.com" }, "URL credentials"],
    [{ ...credentials, dataHubGmsUrl: "https://datahub.example.com/?token=secret" }, "query"],
    [{ ...credentials, readToken: "token\nINJECTED=true" }, "token controls"],
    [{ ...credentials, uvCacheDir: "relative-cache" }, "relative cache"],
    [{ ...credentials, uvCacheDir: "/" }, "root cache"],
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
