import { describe, expect, it, vi } from "vitest";
import { DataHubAdapterError } from "./errors.js";
import {
  createReadOnlyToolClient,
  type ReadToolName,
  requiredReadToolNames,
  type ToolSession,
} from "./tool-client.js";

const tool = (
  name: string,
  annotations: { destructiveHint?: boolean; readOnlyHint?: boolean } = {
    readOnlyHint: true,
  },
) => ({ annotations, name });

function session(overrides: Partial<ToolSession> = {}): ToolSession {
  return {
    callTool: vi.fn(async () => ({ structuredContent: { ok: true } })),
    close: vi.fn(async () => undefined),
    listTools: vi.fn(async () => ({
      tools: [...requiredReadToolNames].map((name) => tool(name)),
    })),
    ...overrides,
  };
}

describe("read-only DataHub MCP tool policy", () => {
  it("accepts the exact required read surface and ignores unrelated tools", async () => {
    const transport = session({
      listTools: vi.fn(async () => ({
        tools: [
          ...requiredReadToolNames.map((name) => tool(name)),
          tool("add_tags", { destructiveHint: true, readOnlyHint: false }),
          tool("search_documents", { readOnlyHint: true }),
        ],
      })),
    });

    const client = await createReadOnlyToolClient(transport);

    expect(client.availableTools()).toEqual([...requiredReadToolNames]);
  });

  it("fails closed when a required tool is missing", async () => {
    const transport = session({
      listTools: vi.fn(async () => ({
        tools: requiredReadToolNames.slice(1).map((name) => tool(name)),
      })),
    });

    await expect(createReadOnlyToolClient(transport)).rejects.toMatchObject({
      code: "TOOL_MISSING",
    });
  });

  it.each([
    [{ readOnlyHint: false }, "read-only"],
    [{}, "read-only"],
    [{ destructiveHint: true, readOnlyHint: true }, "mutation"],
  ])("rejects unsafe annotations %j", async (annotations, expectedMessage) => {
    const transport = session({
      listTools: vi.fn(async () => ({
        tools: requiredReadToolNames.map((name) =>
          tool(name, name === "search" ? annotations : { readOnlyHint: true }),
        ),
      })),
    });

    const result = createReadOnlyToolClient(transport);

    await expect(result).rejects.toMatchObject({ code: "TOOL_POLICY_VIOLATION" });
    await expect(result).rejects.toThrow(expectedMessage);
  });

  it("rejects a mutation name before transport invocation", async () => {
    const transport = session();
    const client = await createReadOnlyToolClient(transport);

    await expect(
      client.invoke("add_tags" as ReadToolName, { urn: "urn:li:tag:test" }),
    ).rejects.toMatchObject({ code: "TOOL_POLICY_VIOLATION" });
    expect(transport.callTool).not.toHaveBeenCalled();
  });
});

describe("bounded MCP invocations", () => {
  it("returns canonical raw provenance for structured content", async () => {
    const transport = session({
      callTool: vi.fn(async () => ({
        content: [{ text: "ignored human rendering", type: "text" }],
        structuredContent: { count: 1, searchResults: [] },
      })),
    });
    const client = await createReadOnlyToolClient(transport, {
      clock: () => new Date("2026-08-04T08:00:00.000Z"),
      invocationId: () => "inv_search_001",
    });

    const result = await client.invoke("search", { query: "/q commerce+orders" });

    expect(result).toMatchObject({
      invocationId: "inv_search_001",
      payload: { count: 1, searchResults: [] },
      retrievedAt: "2026-08-04T08:00:00.000Z",
      tool: "search",
    });
    expect(result.responseFingerprint).toMatch(/^[a-f0-9]{64}$/);
    expect(transport.callTool).toHaveBeenCalledWith(
      "search",
      { query: "/q commerce+orders" },
      expect.objectContaining({ signal: expect.any(AbortSignal), timeoutMs: 8_000 }),
    );
  });

  it("accepts the official single JSON text fallback", async () => {
    const transport = session({
      callTool: vi.fn(async () => ({ content: [{ text: '{"total":0}', type: "text" }] })),
    });
    const client = await createReadOnlyToolClient(transport);

    await expect(client.invoke("search", { query: "/q missing" })).resolves.toMatchObject({
      payload: { total: 0 },
    });
  });

  it("distinguishes an empty result from a malformed response", async () => {
    const empty = session({
      callTool: vi.fn(async () => ({ structuredContent: { count: 0, searchResults: [] } })),
    });
    const malformed = session({
      callTool: vi.fn(async () => ({ content: [{ text: "not-json", type: "text" }] })),
    });

    await expect(
      (await createReadOnlyToolClient(empty)).invoke("search", { query: "/q missing" }),
    ).resolves.toMatchObject({ payload: { count: 0, searchResults: [] } });
    await expect(
      (await createReadOnlyToolClient(malformed)).invoke("search", { query: "/q missing" }),
    ).rejects.toMatchObject({ code: "MALFORMED_RESPONSE" });
  });

  it("redacts tool errors and never exposes raw server content", async () => {
    const secret = "dh_read_super_secret";
    const transport = session({
      callTool: vi.fn(async () => ({
        content: [{ text: `Bearer ${secret} SQL SELECT private_value`, type: "text" }],
        isError: true,
      })),
    });
    const client = await createReadOnlyToolClient(transport, {
      invocationId: () => "inv_queries_001",
    });

    let thrown: unknown;
    try {
      await client.invoke("get_dataset_queries", { urn: "urn:li:dataset:test" });
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toBeInstanceOf(DataHubAdapterError);
    expect(thrown).toMatchObject({ code: "TOOL_FAILURE", invocationId: "inv_queries_001" });
    expect(JSON.stringify(thrown)).not.toContain(secret);
    expect(String(thrown)).not.toContain(secret);
    expect(JSON.stringify((thrown as DataHubAdapterError).diagnostic())).not.toContain(secret);
  });

  it("enforces the response byte ceiling", async () => {
    const transport = session({
      callTool: vi.fn(async () => ({ structuredContent: { value: "x".repeat(300_000) } })),
    });
    const client = await createReadOnlyToolClient(transport);

    await expect(
      client.invoke("get_entities", { urns: ["urn:li:dataset:test"] }),
    ).rejects.toMatchObject({ code: "RESPONSE_LIMIT" });
  });

  it("enforces its own deadline even if a transport ignores abort", async () => {
    vi.useFakeTimers();
    const transport = session({
      callTool: vi.fn(() => new Promise(() => undefined)),
    });
    const client = await createReadOnlyToolClient(transport);

    const pending = client.invoke("get_lineage", { urn: "urn:li:dataset:test" });
    const assertion = expect(pending).rejects.toMatchObject({ code: "TIMEOUT" });
    await vi.advanceTimersByTimeAsync(8_001);

    await assertion;
    vi.useRealTimers();
  });
});
