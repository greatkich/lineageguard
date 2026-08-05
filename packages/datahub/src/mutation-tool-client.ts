import { randomUUID } from "node:crypto";
import { sha256, stableJson } from "@lineageguard/domain";
import { DataHubAdapterError } from "./errors.js";
import type { DiscoveredTool, ToolCallOptions, ToolSession } from "./tool-client.js";

const MUTATION_TIMEOUT_MS = 8_000;
const MAX_RESPONSE_BYTES = 64_000;
const MAX_TOTAL_RESPONSE_BYTES = 128_000;

export const mutationToolNames = Object.freeze(["save_document", "add_tags"] as const);
export type MutationToolName = (typeof mutationToolNames)[number];
const mutationToolSet: ReadonlySet<string> = new Set(mutationToolNames);

export type MutationInvocation = Readonly<{
  invocationId: string;
  responseFingerprint: string;
  tool: MutationToolName;
}>;

type Dependencies = Readonly<{ invocationId?: () => string }>;

function options(signal: AbortSignal): ToolCallOptions {
  return { signal, timeoutMs: MUTATION_TIMEOUT_MS };
}

async function withDeadline<T>(operation: (signal: AbortSignal) => Promise<T>): Promise<T> {
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      controller.abort();
      reject(
        new DataHubAdapterError("TIMEOUT", "DataHub MCP mutation timed out.", {
          retryable: true,
        }),
      );
    }, MUTATION_TIMEOUT_MS);
  });
  try {
    return await Promise.race([operation(controller.signal), deadline]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

function validateEnvelope(value: unknown): string {
  let canonical: string;
  try {
    canonical = stableJson(value);
  } catch {
    throw new DataHubAdapterError(
      "MALFORMED_RESPONSE",
      "DataHub MCP mutation returned non-canonical output.",
    );
  }
  if (Buffer.byteLength(canonical, "utf8") > MAX_RESPONSE_BYTES) {
    throw new DataHubAdapterError(
      "RESPONSE_LIMIT",
      "DataHub MCP mutation response limit was exceeded.",
    );
  }
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new DataHubAdapterError(
      "MALFORMED_RESPONSE",
      "DataHub MCP mutation returned an invalid result envelope.",
    );
  }
  const envelope = value as Readonly<Record<string, unknown>>;
  if (envelope.isError === true) {
    throw new DataHubAdapterError("TOOL_FAILURE", "DataHub MCP mutation failed.");
  }
  if (envelope.structuredContent === undefined && envelope.content === undefined) {
    throw new DataHubAdapterError(
      "MALFORMED_RESPONSE",
      "DataHub MCP mutation returned no result content.",
    );
  }
  return canonical;
}

function declarationFailure(name: MutationToolName): DataHubAdapterError {
  return new DataHubAdapterError(
    "TOOL_POLICY_VIOLATION",
    `Required DataHub mutation tool ${name} did not declare mutation semantics.`,
    { tool: name },
  );
}

export class MutationToolClient {
  readonly #session: ToolSession;
  readonly #invocationId: () => string;
  #totalResponseBytes = 0;

  private constructor(session: ToolSession, dependencies: Dependencies) {
    this.#session = session;
    this.#invocationId = dependencies.invocationId ?? (() => `mcp_mut_${randomUUID()}`);
  }

  static async connect(
    session: ToolSession,
    dependencies: Dependencies = {},
  ): Promise<MutationToolClient> {
    let discovered: Readonly<{ tools: readonly DiscoveredTool[] }>;
    try {
      discovered = await withDeadline((signal) => session.listTools(options(signal)));
    } catch (error) {
      if (error instanceof DataHubAdapterError) throw error;
      throw new DataHubAdapterError("UNAVAILABLE", "DataHub MCP mutation discovery failed.", {
        retryable: true,
      });
    }

    const found = new Map<MutationToolName, DiscoveredTool>();
    for (const declaration of discovered.tools) {
      if (!mutationToolSet.has(declaration.name)) continue;
      const name = declaration.name as MutationToolName;
      if (found.has(name)) {
        throw new DataHubAdapterError(
          "TOOL_POLICY_VIOLATION",
          `Required DataHub mutation tool ${name} was declared more than once.`,
          { tool: name },
        );
      }
      found.set(name, declaration);
      if (
        declaration.annotations?.readOnlyHint !== false ||
        declaration.annotations.destructiveHint !== true
      ) {
        throw declarationFailure(name);
      }
    }
    for (const name of mutationToolNames) {
      if (!found.has(name)) {
        throw new DataHubAdapterError(
          "TOOL_MISSING",
          `Required DataHub mutation tool ${name} is unavailable.`,
          { tool: name },
        );
      }
    }
    return new MutationToolClient(session, dependencies);
  }

  async invoke(
    tool: MutationToolName,
    arguments_: Readonly<Record<string, unknown>>,
  ): Promise<MutationInvocation> {
    if (!mutationToolSet.has(tool)) {
      throw new DataHubAdapterError(
        "TOOL_POLICY_VIOLATION",
        "A non-allowlisted DataHub mutation was rejected.",
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
      throw new DataHubAdapterError("UNAVAILABLE", "DataHub MCP mutation failed.", {
        invocationId,
        retryable: true,
        tool,
      });
    }
    const canonical = validateEnvelope(raw);
    this.#totalResponseBytes += Buffer.byteLength(canonical, "utf8");
    if (this.#totalResponseBytes > MAX_TOTAL_RESPONSE_BYTES) {
      throw new DataHubAdapterError(
        "RESPONSE_LIMIT",
        "DataHub MCP mutation response limit was exceeded.",
        { invocationId, tool },
      );
    }
    return Object.freeze({ invocationId, responseFingerprint: sha256(canonical), tool });
  }

  async close(): Promise<void> {
    await this.#session.close();
  }
}

export function createMutationToolClient(
  session: ToolSession,
  dependencies: Dependencies = {},
): Promise<MutationToolClient> {
  return MutationToolClient.connect(session, dependencies);
}
