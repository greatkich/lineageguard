import { basename, dirname, isAbsolute, parse, resolve } from "node:path";
import { Client } from "@modelcontextprotocol/client";
import {
  DEFAULT_INHERITED_ENV_VARS,
  StdioClientTransport,
} from "@modelcontextprotocol/client/stdio";
import { z } from "zod";
import { DataHubAdapterError } from "./errors.js";
import type { DiscoveredTool, ToolCallOptions, ToolSession } from "./tool-client.js";

export const officialDataHubMcpServer = Object.freeze({
  executable: "mcp-server-datahub",
  package: "mcp-server-datahub",
  transport: "stdio",
  version: "0.6.0",
} as const);

const CONNECT_TIMEOUT_MS = 8_000;

const credentialsSchema = z
  .object({
    dataHubGmsUrl: z.string().min(1).max(2_048),
    readToken: z
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

export type OfficialStdioCredentials = z.infer<typeof credentialsSchema>;

export type OfficialSdkLaunch = Readonly<{
  client: Readonly<{
    enforceStrictCapabilities: true;
    listMaxPages: 4;
    name: "lineageguard-datahub-context";
    version: "0.1.0";
  }>;
  process: Readonly<{
    args: readonly string[];
    command: string;
    env: Readonly<Record<string, string>>;
    maxBufferSize: 300_000;
    stderr: "ignore";
  }>;
}>;

export interface OfficialSdkConnection {
  callTool(
    input: Readonly<{ arguments: Readonly<Record<string, unknown>>; name: string }>,
    options: ToolCallOptions,
  ): Promise<unknown>;
  close(): Promise<void>;
  connect(options: ToolCallOptions): Promise<void>;
  listTools(options: ToolCallOptions): Promise<
    Readonly<{
      tools: readonly Readonly<{
        annotations?:
          | Readonly<{
              destructiveHint?: boolean | undefined;
              readOnlyHint?: boolean | undefined;
            }>
          | undefined;
        name: string;
      }>[];
    }>
  >;
}

export type OfficialSdkFactory = (launch: OfficialSdkLaunch) => OfficialSdkConnection;

function safeCredentials(input: unknown): OfficialStdioCredentials {
  const parsed = credentialsSchema.safeParse(input);
  if (!parsed.success) {
    throw new DataHubAdapterError("CONFIGURATION", "DataHub MCP configuration is invalid.");
  }

  if (
    !isAbsolute(parsed.data.uvxPath) ||
    !["uvx", "uvx.exe"].includes(basename(parsed.data.uvxPath))
  ) {
    throw new DataHubAdapterError("CONFIGURATION", "DataHub MCP command path is invalid.");
  }
  if (
    !isAbsolute(parsed.data.uvCacheDir) ||
    resolve(parsed.data.uvCacheDir) !== parsed.data.uvCacheDir ||
    parse(parsed.data.uvCacheDir).root === parsed.data.uvCacheDir
  ) {
    throw new DataHubAdapterError("CONFIGURATION", "DataHub MCP cache path is invalid.");
  }

  let url: URL;
  try {
    url = new URL(parsed.data.dataHubGmsUrl);
  } catch {
    throw new DataHubAdapterError("CONFIGURATION", "DataHub GMS URL is invalid.");
  }
  if (url.username || url.password || url.search || url.hash) {
    throw new DataHubAdapterError("CONFIGURATION", "DataHub GMS URL contains unsafe components.");
  }
  const loopback = ["127.0.0.1", "[::1]", "localhost"].includes(url.hostname.toLowerCase());
  if (url.protocol !== "https:" && !(url.protocol === "http:" && loopback)) {
    throw new DataHubAdapterError("CONFIGURATION", "Remote DataHub GMS connections require HTTPS.");
  }

  return parsed.data;
}

function controlledProcessEnvironment(
  credentials: OfficialStdioCredentials,
): Readonly<Record<string, string>> {
  return Object.freeze({
    ...Object.fromEntries(DEFAULT_INHERITED_ENV_VARS.map((name) => [name, ""])),
    DATAHUB_GMS_TOKEN: credentials.readToken,
    DATAHUB_GMS_URL: credentials.dataHubGmsUrl,
    DATAHUB_MCP_DOCUMENT_TOOLS_DISABLED: "true",
    DATA_QUALITY_TOOLS_ENABLED: "false",
    HOME: credentials.uvCacheDir,
    LOGNAME: "lineageguard",
    NO_COLOR: "1",
    PATH: `${dirname(credentials.uvxPath)}:/usr/bin:/bin`,
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
}

function launchFor(credentials: OfficialStdioCredentials): OfficialSdkLaunch {
  return Object.freeze({
    client: Object.freeze({
      enforceStrictCapabilities: true,
      listMaxPages: 4,
      name: "lineageguard-datahub-context",
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
      env: controlledProcessEnvironment(credentials),
      maxBufferSize: 300_000,
      stderr: "ignore",
    }),
  });
}

export function createOfficialSdkTransport(launch: OfficialSdkLaunch): StdioClientTransport {
  return new StdioClientTransport({
    args: [...launch.process.args],
    command: launch.process.command,
    env: { ...launch.process.env },
    maxBufferSize: launch.process.maxBufferSize,
    stderr: launch.process.stderr,
  });
}

function defaultFactory(launch: OfficialSdkLaunch): OfficialSdkConnection {
  const client = new Client(
    { name: launch.client.name, version: launch.client.version },
    {
      enforceStrictCapabilities: launch.client.enforceStrictCapabilities,
      inputRequired: { autoFulfill: false },
      listMaxPages: launch.client.listMaxPages,
      versionNegotiation: { mode: "legacy" },
    },
  );
  const transport = createOfficialSdkTransport(launch);

  return {
    async callTool(input, options) {
      return client.callTool(
        { arguments: { ...input.arguments }, name: input.name },
        {
          maxTotalTimeout: options.timeoutMs,
          signal: options.signal,
          timeout: options.timeoutMs,
        },
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
      return client.listTools(undefined, {
        cacheMode: "refresh",
        maxTotalTimeout: options.timeoutMs,
        signal: options.signal,
        timeout: options.timeoutMs,
      });
    },
  };
}

function discoveredTool(tool: {
  annotations?:
    | Readonly<{
        destructiveHint?: boolean | undefined;
        readOnlyHint?: boolean | undefined;
      }>
    | undefined;
  name: string;
}): DiscoveredTool {
  const readOnlyHint = tool.annotations?.readOnlyHint;
  const destructiveHint = tool.annotations?.destructiveHint;
  const annotations =
    readOnlyHint === undefined && destructiveHint === undefined
      ? undefined
      : {
          ...(destructiveHint === undefined ? {} : { destructiveHint }),
          ...(readOnlyHint === undefined ? {} : { readOnlyHint }),
        };
  return Object.freeze({
    ...(annotations === undefined ? {} : { annotations: Object.freeze(annotations) }),
    name: tool.name,
  });
}

class OfficialStdioSession implements ToolSession {
  readonly #connection: OfficialSdkConnection;
  #closed = false;

  constructor(connection: OfficialSdkConnection) {
    this.#connection = connection;
  }

  async callTool(
    name: string,
    arguments_: Readonly<Record<string, unknown>>,
    options: ToolCallOptions,
  ): Promise<unknown> {
    return this.#connection.callTool({ arguments: arguments_, name }, options);
  }

  async close(): Promise<void> {
    if (this.#closed) return;
    this.#closed = true;
    await this.#connection.close();
  }

  async listTools(
    options: ToolCallOptions,
  ): Promise<Readonly<{ tools: readonly DiscoveredTool[] }>> {
    const result = await this.#connection.listTools(options);
    return Object.freeze({ tools: Object.freeze(result.tools.map(discoveredTool)) });
  }
}

async function connectWithDeadline(connection: OfficialSdkConnection): Promise<void> {
  const controller = new AbortController();
  let timeout: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<never>((_, reject) => {
    timeout = setTimeout(() => {
      controller.abort();
      reject(
        new DataHubAdapterError("TIMEOUT", "DataHub MCP connection timed out.", {
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
  } finally {
    if (timeout !== undefined) clearTimeout(timeout);
  }
}

export async function createOfficialStdioSession(
  input: OfficialStdioCredentials,
  factory: OfficialSdkFactory = defaultFactory,
): Promise<ToolSession> {
  const credentials = safeCredentials(input);
  const connection = factory(launchFor(credentials));
  try {
    await connectWithDeadline(connection);
    return new OfficialStdioSession(connection);
  } catch (error) {
    try {
      await connection.close();
    } catch {
      // The original connection failure remains authoritative and secret-safe.
    }
    if (error instanceof DataHubAdapterError) throw error;
    throw new DataHubAdapterError("UNAVAILABLE", "DataHub MCP connection failed.", {
      retryable: true,
    });
  }
}
