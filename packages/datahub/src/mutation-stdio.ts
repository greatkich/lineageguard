import { basename, dirname, isAbsolute, parse, resolve } from "node:path";
import { Client } from "@modelcontextprotocol/client";
import {
  DEFAULT_INHERITED_ENV_VARS,
  StdioClientTransport,
} from "@modelcontextprotocol/client/stdio";
import { z } from "zod";
import { DataHubAdapterError } from "./errors.js";
import { officialDataHubMcpServer } from "./official-stdio.js";
import type { DiscoveredTool, ToolCallOptions, ToolSession } from "./tool-client.js";

const CONNECT_TIMEOUT_MS = 8_000;

const mutationCredentialsSchema = z
  .object({
    dataHubGmsUrl: z.string().min(1).max(2_048),
    mutationToken: z
      .string()
      .min(8)
      .max(4_096)
      .refine((value) =>
        [...value].every((character) => {
          const codePoint = character.codePointAt(0) ?? 0;
          return codePoint >= 32 && codePoint !== 127;
        }),
      ),
    uvCacheDir: z.string().min(1).max(1_024),
    uvxPath: z.string().min(1).max(1_024),
  })
  .strict();

export type OfficialMutationCredentials = z.infer<typeof mutationCredentialsSchema>;

export type OfficialMutationSdkLaunch = Readonly<{
  client: Readonly<{
    enforceStrictCapabilities: true;
    listMaxPages: 4;
    name: "lineageguard-datahub-writeback";
    version: "0.1.0";
  }>;
  process: Readonly<{
    args: readonly string[];
    command: string;
    env: Readonly<Record<string, string>>;
    maxBufferSize: 160_000;
    stderr: "ignore";
  }>;
}>;

export interface OfficialMutationSdkConnection {
  callTool(
    input: Readonly<{ arguments: Readonly<Record<string, unknown>>; name: string }>,
    options: ToolCallOptions,
  ): Promise<unknown>;
  close(): Promise<void>;
  connect(options: ToolCallOptions): Promise<void>;
  listTools(options: ToolCallOptions): Promise<Readonly<{ tools: readonly DiscoveredTool[] }>>;
}

export type OfficialMutationSdkFactory = (
  launch: OfficialMutationSdkLaunch,
) => OfficialMutationSdkConnection;

function safeCredentials(input: unknown): OfficialMutationCredentials {
  const parsed = mutationCredentialsSchema.safeParse(input);
  if (!parsed.success) {
    throw new DataHubAdapterError(
      "CONFIGURATION",
      "DataHub MCP mutation configuration is invalid.",
    );
  }
  if (
    !isAbsolute(parsed.data.uvxPath) ||
    !["uvx", "uvx.exe"].includes(basename(parsed.data.uvxPath))
  ) {
    throw new DataHubAdapterError("CONFIGURATION", "DataHub MCP mutation command is invalid.");
  }
  if (
    !isAbsolute(parsed.data.uvCacheDir) ||
    resolve(parsed.data.uvCacheDir) !== parsed.data.uvCacheDir ||
    parse(parsed.data.uvCacheDir).root === parsed.data.uvCacheDir
  ) {
    throw new DataHubAdapterError("CONFIGURATION", "DataHub MCP mutation cache is invalid.");
  }
  let url: URL;
  try {
    url = new URL(parsed.data.dataHubGmsUrl);
  } catch {
    throw new DataHubAdapterError("CONFIGURATION", "DataHub GMS mutation URL is invalid.");
  }
  if (url.username || url.password || url.search || url.hash) {
    throw new DataHubAdapterError("CONFIGURATION", "DataHub GMS mutation URL is unsafe.");
  }
  const loopback = ["127.0.0.1", "[::1]", "localhost"].includes(url.hostname.toLowerCase());
  if (url.protocol !== "https:" && !(url.protocol === "http:" && loopback)) {
    throw new DataHubAdapterError(
      "CONFIGURATION",
      "Remote DataHub GMS mutation connections require HTTPS.",
    );
  }
  return parsed.data;
}

function processEnvironment(
  credentials: OfficialMutationCredentials,
): Readonly<Record<string, string>> {
  return Object.freeze({
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
}

function launchFor(credentials: OfficialMutationCredentials): OfficialMutationSdkLaunch {
  return Object.freeze({
    client: Object.freeze({
      enforceStrictCapabilities: true,
      listMaxPages: 4,
      name: "lineageguard-datahub-writeback",
      version: "0.1.0",
    }),
    process: Object.freeze({
      args: Object.freeze([
        "--isolated",
        "--no-env-file",
        "--no-sources",
        "--keyring-provider",
        "disabled",
        "--exclude-newer",
        "2026-05-19T00:00:00Z",
        "--from",
        `${officialDataHubMcpServer.package}==${officialDataHubMcpServer.version}`,
        officialDataHubMcpServer.executable,
        "--transport",
        officialDataHubMcpServer.transport,
      ]),
      command: credentials.uvxPath,
      env: processEnvironment(credentials),
      maxBufferSize: 160_000,
      stderr: "ignore",
    }),
  });
}

export function createOfficialMutationSdkTransport(
  launch: OfficialMutationSdkLaunch,
): StdioClientTransport {
  return new StdioClientTransport({
    args: [...launch.process.args],
    command: launch.process.command,
    env: { ...launch.process.env },
    maxBufferSize: launch.process.maxBufferSize,
    stderr: launch.process.stderr,
  });
}

function defaultFactory(launch: OfficialMutationSdkLaunch): OfficialMutationSdkConnection {
  const client = new Client(
    { name: launch.client.name, version: launch.client.version },
    {
      enforceStrictCapabilities: launch.client.enforceStrictCapabilities,
      inputRequired: { autoFulfill: false },
      listMaxPages: launch.client.listMaxPages,
      versionNegotiation: { mode: "legacy" },
    },
  );
  const transport = createOfficialMutationSdkTransport(launch);
  return {
    async callTool(input, options) {
      return client.callTool(
        { arguments: { ...input.arguments }, name: input.name },
        { maxTotalTimeout: options.timeoutMs, signal: options.signal, timeout: options.timeoutMs },
      );
    },
    async close() {
      await client.close();
    },
    async connect(options) {
      await client.connect(transport, {
        maxTotalTimeout: options.timeoutMs,
        signal: options.signal,
        timeout: options.timeoutMs,
      });
    },
    async listTools(options) {
      const result = await client.listTools(undefined, {
        cacheMode: "refresh",
        maxTotalTimeout: options.timeoutMs,
        signal: options.signal,
        timeout: options.timeoutMs,
      });
      return {
        tools: result.tools.map((tool) => ({
          ...(tool.annotations === undefined
            ? {}
            : {
                annotations: {
                  ...(tool.annotations.destructiveHint === undefined
                    ? {}
                    : { destructiveHint: tool.annotations.destructiveHint }),
                  ...(tool.annotations.readOnlyHint === undefined
                    ? {}
                    : { readOnlyHint: tool.annotations.readOnlyHint }),
                },
              }),
          inputSchema: tool.inputSchema,
          name: tool.name,
        })),
      };
    },
  };
}

function sessionFor(connection: OfficialMutationSdkConnection): ToolSession {
  let closed = false;
  return {
    async callTool(name, arguments_, options) {
      return connection.callTool({ arguments: arguments_, name }, options);
    },
    async close() {
      if (closed) return;
      closed = true;
      await connection.close();
    },
    async listTools(options) {
      return connection.listTools(options);
    },
  };
}

export async function createOfficialMutationSession(
  input: OfficialMutationCredentials,
  factory: OfficialMutationSdkFactory = defaultFactory,
): Promise<ToolSession> {
  const credentials = safeCredentials(input);
  const connection = factory(launchFor(credentials));
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      controller.abort();
      reject(
        new DataHubAdapterError("TIMEOUT", "DataHub MCP mutation connection timed out.", {
          retryable: true,
        }),
      );
    }, CONNECT_TIMEOUT_MS);
  });
  try {
    await Promise.race([
      connection.connect({ signal: controller.signal, timeoutMs: CONNECT_TIMEOUT_MS }),
      deadline,
    ]);
    return sessionFor(connection);
  } catch (error) {
    try {
      await connection.close();
    } catch {
      // Preserve the authoritative secret-safe connection error.
    }
    if (error instanceof DataHubAdapterError) throw error;
    throw new DataHubAdapterError("UNAVAILABLE", "DataHub MCP mutation connection failed.", {
      retryable: true,
    });
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}
