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
const nullableString = { anyOf: [{ type: "string" }, { type: "null" }], default: null };
const nullableStringArray = {
  anyOf: [{ items: { type: "string" }, type: "array" }, { type: "null" }],
  default: null,
};
export const officialMutationInputSchemas = Object.freeze({
  add_tags: {
    additionalProperties: false,
    properties: {
      column_paths: {
        anyOf: [
          { items: { anyOf: [{ type: "string" }, { type: "null" }] }, type: "array" },
          { type: "null" },
        ],
        default: null,
      },
      entity_urns: { items: { type: "string" }, type: "array" },
      tag_urns: { items: { type: "string" }, type: "array" },
    },
    required: ["tag_urns", "entity_urns"],
    type: "object",
  },
  save_document: {
    additionalProperties: false,
    properties: {
      content: { type: "string" },
      document_type: {
        enum: [
          "Insight",
          "Decision",
          "FAQ",
          "Analysis",
          "Summary",
          "Recommendation",
          "Note",
          "Context",
        ],
        type: "string",
      },
      related_assets: nullableStringArray,
      related_documents: nullableStringArray,
      topics: nullableStringArray,
      title: { type: "string" },
      urn: nullableString,
    },
    required: ["document_type", "title", "content"],
    type: "object",
  },
} as const);
const expectedInputSchemaFingerprints: Readonly<Record<MutationToolName, string>> = Object.freeze({
  add_tags: "40f2f12ffad78a89567fac55077ea3888360d528dd186419b7ea813a34301515",
  save_document: "0c8f42c118274f923340ef0b569f595b6f4be890b7f2bf9df921b02cf3fc96f3",
});

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

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function exactKeys(value: Readonly<Record<string, unknown>>, keys: readonly string[]): boolean {
  return Object.keys(value).sort().join("\u0000") === [...keys].sort().join("\u0000");
}

function validateEnvelope(
  value: unknown,
  tool: MutationToolName,
  arguments_: Readonly<Record<string, unknown>>,
): string {
  let canonical: string;
  try {
    canonical = stableJson(value);
  } catch {
    throw new DataHubAdapterError(
      "MALFORMED_RESPONSE",
      "DataHub MCP mutation returned non-canonical output.",
      { retryable: true },
    );
  }
  if (Buffer.byteLength(canonical, "utf8") > MAX_RESPONSE_BYTES) {
    throw new DataHubAdapterError(
      "RESPONSE_LIMIT",
      "DataHub MCP mutation response limit was exceeded.",
      { retryable: true },
    );
  }
  if (!isRecord(value)) {
    throw new DataHubAdapterError(
      "MALFORMED_RESPONSE",
      "DataHub MCP mutation returned an invalid result envelope.",
      { retryable: true },
    );
  }
  const envelope = value;
  if (envelope.isError === true) {
    throw new DataHubAdapterError("TOOL_FAILURE", "DataHub MCP mutation failed.");
  }
  if (!isRecord(envelope.structuredContent)) {
    throw new DataHubAdapterError(
      "MALFORMED_RESPONSE",
      "DataHub MCP mutation returned no result content.",
      { retryable: true },
    );
  }
  const result = envelope.structuredContent;
  if (tool === "save_document") {
    if (
      !exactKeys(result, ["author", "message", "success", "urn"]) ||
      result.success !== true ||
      result.urn !== arguments_.urn ||
      typeof result.message !== "string" ||
      !/^Successfully (?:created|updated) document: /u.test(result.message) ||
      (result.author !== null && typeof result.author !== "string")
    ) {
      throw new DataHubAdapterError(
        "MALFORMED_RESPONSE",
        "DataHub save_document response contract drifted.",
        { retryable: true },
      );
    }
  } else if (
    !exactKeys(result, ["message", "success"]) ||
    result.success !== true ||
    result.message !== "Successfully added 1 tag(s) to 1 entit(ies)"
  ) {
    throw new DataHubAdapterError(
      "MALFORMED_RESPONSE",
      "DataHub add_tags response contract drifted.",
      { retryable: true },
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

function normalizeInputSchema(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(normalizeInputSchema);
  if (value !== null && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as Readonly<Record<string, unknown>>)
        .filter(([key]) => key !== "description" && key !== "title")
        .map(([key, item]) => [key, normalizeInputSchema(item)]),
    );
  }
  return value;
}

function validateDeclaration(name: MutationToolName, declaration: DiscoveredTool): void {
  if (declaration.annotations !== undefined) {
    throw declarationFailure(name);
  }
  let actualFingerprint: string;
  try {
    actualFingerprint = sha256(normalizeInputSchema(declaration.inputSchema));
  } catch {
    throw declarationFailure(name);
  }
  if (actualFingerprint !== expectedInputSchemaFingerprints[name]) {
    throw new DataHubAdapterError(
      "TOOL_POLICY_VIOLATION",
      `Required DataHub mutation tool ${name} input schema drifted.`,
      { tool: name },
    );
  }
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
      await Promise.allSettled([session.close()]);
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
        await Promise.allSettled([session.close()]);
        throw new DataHubAdapterError(
          "TOOL_POLICY_VIOLATION",
          `Required DataHub mutation tool ${name} was declared more than once.`,
          { tool: name },
        );
      }
      found.set(name, declaration);
      try {
        validateDeclaration(name, declaration);
      } catch (error) {
        await Promise.allSettled([session.close()]);
        throw error;
      }
    }
    for (const name of mutationToolNames) {
      if (!found.has(name)) {
        await Promise.allSettled([session.close()]);
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
    const canonical = validateEnvelope(raw, tool, arguments_);
    this.#totalResponseBytes += Buffer.byteLength(canonical, "utf8");
    if (this.#totalResponseBytes > MAX_TOTAL_RESPONSE_BYTES) {
      throw new DataHubAdapterError(
        "RESPONSE_LIMIT",
        "DataHub MCP mutation response limit was exceeded.",
        { invocationId, retryable: true, tool },
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
