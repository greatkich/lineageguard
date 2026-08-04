import { randomUUID } from "node:crypto";
import { sha256, stableJson } from "@lineageguard/domain";
import { DataHubAdapterError } from "./errors.js";

export const requiredReadToolNames = Object.freeze([
  "search",
  "list_schema_fields",
  "get_entities",
  "get_lineage",
  "get_lineage_paths_between",
  "get_dataset_queries",
] as const);

export type ReadToolName = (typeof requiredReadToolNames)[number];

export type DiscoveredTool = Readonly<{
  annotations?: Readonly<{
    destructiveHint?: boolean;
    readOnlyHint?: boolean;
  }>;
  name: string;
}>;

export type ToolCallOptions = Readonly<{
  signal: AbortSignal;
  timeoutMs: number;
}>;

export interface ToolSession {
  callTool(
    name: string,
    arguments_: Readonly<Record<string, unknown>>,
    options: ToolCallOptions,
  ): Promise<unknown>;
  close(): Promise<void>;
  listTools(options: ToolCallOptions): Promise<Readonly<{ tools: readonly DiscoveredTool[] }>>;
}

export type RawToolInvocation = Readonly<{
  invocationId: string;
  payload: Readonly<Record<string, unknown>> | readonly unknown[];
  responseFingerprint: string;
  retrievedAt: string;
  tool: ReadToolName;
}>;

type ClientDependencies = Readonly<{
  clock?: () => Date;
  invocationId?: () => string;
}>;

const CALL_TIMEOUT_MS = 8_000;
const MAX_RESPONSE_BYTES = 256_000;
const MAX_COLLECTION_RESPONSE_BYTES = 1_000_000;
const requiredToolSet: ReadonlySet<string> = new Set(requiredReadToolNames);

function options(signal: AbortSignal): ToolCallOptions {
  return { signal, timeoutMs: CALL_TIMEOUT_MS };
}

async function withDeadline<T>(operation: (signal: AbortSignal) => Promise<T>): Promise<T> {
  const controller = new AbortController();
  let timeout: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<never>((_, reject) => {
    timeout = setTimeout(() => {
      controller.abort();
      reject(
        new DataHubAdapterError("TIMEOUT", "DataHub MCP request timed out.", { retryable: true }),
      );
    }, CALL_TIMEOUT_MS);
  });

  try {
    return await Promise.race([operation(controller.signal), deadline]);
  } finally {
    if (timeout !== undefined) clearTimeout(timeout);
  }
}

function responseBytes(value: unknown): { bytes: number; canonical: string } {
  try {
    const canonical = stableJson(value);
    return { bytes: Buffer.byteLength(canonical, "utf8"), canonical };
  } catch {
    throw new DataHubAdapterError(
      "MALFORMED_RESPONSE",
      "DataHub MCP returned a response that is not canonical JSON.",
    );
  }
}

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function extractPayload(value: unknown): Readonly<Record<string, unknown>> | readonly unknown[] {
  if (!isRecord(value)) {
    throw new DataHubAdapterError(
      "MALFORMED_RESPONSE",
      "DataHub MCP returned an invalid tool result envelope.",
    );
  }

  if (value.isError === true) {
    throw new DataHubAdapterError("TOOL_FAILURE", "DataHub MCP tool execution failed.");
  }

  let payload: unknown = value.structuredContent;
  if (payload === undefined) {
    const content = value.content;
    if (!Array.isArray(content) || content.length !== 1) {
      throw new DataHubAdapterError(
        "MALFORMED_RESPONSE",
        "DataHub MCP returned neither structured output nor one JSON text block.",
      );
    }
    const block = content[0];
    if (!isRecord(block) || block.type !== "text" || typeof block.text !== "string") {
      throw new DataHubAdapterError(
        "MALFORMED_RESPONSE",
        "DataHub MCP returned an unsupported content block.",
      );
    }
    try {
      payload = JSON.parse(block.text) as unknown;
    } catch {
      throw new DataHubAdapterError(
        "MALFORMED_RESPONSE",
        "DataHub MCP text output is not valid JSON.",
      );
    }
  }

  if (!isRecord(payload) && !Array.isArray(payload)) {
    throw new DataHubAdapterError(
      "MALFORMED_RESPONSE",
      "DataHub MCP tool output must be an object or array.",
    );
  }
  return payload;
}

function policyFailure(tool: ReadToolName, mutation: boolean): DataHubAdapterError {
  return new DataHubAdapterError(
    "TOOL_POLICY_VIOLATION",
    mutation
      ? `Required DataHub tool ${tool} reported mutation semantics.`
      : `Required DataHub tool ${tool} did not prove read-only semantics.`,
    { tool },
  );
}

export class ReadOnlyToolClient {
  readonly #clock: () => Date;
  readonly #invocationId: () => string;
  readonly #session: ToolSession;
  #responseBytes = 0;

  private constructor(session: ToolSession, dependencies: ClientDependencies) {
    this.#session = session;
    this.#clock = dependencies.clock ?? (() => new Date());
    this.#invocationId = dependencies.invocationId ?? (() => `mcp_${randomUUID()}`);
  }

  static async connect(
    session: ToolSession,
    dependencies: ClientDependencies = {},
  ): Promise<ReadOnlyToolClient> {
    let discovered: Readonly<{ tools: readonly DiscoveredTool[] }>;
    try {
      discovered = await withDeadline((signal) => session.listTools(options(signal)));
    } catch (error) {
      if (error instanceof DataHubAdapterError) throw error;
      throw new DataHubAdapterError("UNAVAILABLE", "DataHub MCP tool discovery failed.", {
        retryable: true,
      });
    }

    const byName = new Map(discovered.tools.map((tool) => [tool.name, tool]));
    for (const name of requiredReadToolNames) {
      const required = byName.get(name);
      if (required === undefined) {
        throw new DataHubAdapterError(
          "TOOL_MISSING",
          `Required read-only DataHub tool ${name} is unavailable.`,
          { tool: name },
        );
      }
      if (required.annotations?.destructiveHint === true) throw policyFailure(name, true);
      if (required.annotations?.readOnlyHint !== true) throw policyFailure(name, false);
    }

    return new ReadOnlyToolClient(session, dependencies);
  }

  availableTools(): readonly ReadToolName[] {
    return requiredReadToolNames;
  }

  async close(): Promise<void> {
    await this.#session.close();
  }

  async invoke(
    tool: ReadToolName,
    arguments_: Readonly<Record<string, unknown>>,
  ): Promise<RawToolInvocation> {
    if (!requiredToolSet.has(tool)) {
      throw new DataHubAdapterError(
        "TOOL_POLICY_VIOLATION",
        "A non-allowlisted DataHub tool call was rejected.",
        { tool },
      );
    }
    const invocationId = this.#invocationId();
    let raw: unknown;
    try {
      raw = await withDeadline((signal) =>
        this.#session.callTool(tool, arguments_, options(signal)),
      );
    } catch (error) {
      if (error instanceof DataHubAdapterError) {
        throw new DataHubAdapterError(error.code, error.message, {
          invocationId,
          retryable: error.retryable,
          tool,
        });
      }
      throw new DataHubAdapterError("UNAVAILABLE", "DataHub MCP request failed.", {
        invocationId,
        retryable: true,
        tool,
      });
    }

    const { bytes, canonical } = responseBytes(raw);
    this.#responseBytes += bytes;
    if (bytes > MAX_RESPONSE_BYTES || this.#responseBytes > MAX_COLLECTION_RESPONSE_BYTES) {
      throw new DataHubAdapterError("RESPONSE_LIMIT", "DataHub MCP response limit was exceeded.", {
        invocationId,
        tool,
      });
    }

    let payload: RawToolInvocation["payload"];
    try {
      payload = extractPayload(raw);
    } catch (error) {
      if (error instanceof DataHubAdapterError) {
        throw new DataHubAdapterError(error.code, error.message, {
          invocationId,
          retryable: error.retryable,
          tool,
        });
      }
      throw error;
    }

    return Object.freeze({
      invocationId,
      payload,
      responseFingerprint: sha256(canonical),
      retrievedAt: this.#clock().toISOString(),
      tool,
    });
  }
}

export function createReadOnlyToolClient(
  session: ToolSession,
  dependencies: ClientDependencies = {},
): Promise<ReadOnlyToolClient> {
  return ReadOnlyToolClient.connect(session, dependencies);
}
