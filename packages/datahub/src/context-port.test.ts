import { canonicalImpactRequest } from "@lineageguard/domain";
import { describe, expect, it, vi } from "vitest";
import { createLiveDataHubContextPort } from "./context-port.js";
import { requiredReadToolNames, type ToolSession } from "./tool-client.js";

function session(overrides: Partial<ToolSession> = {}): ToolSession {
  return {
    callTool: vi.fn(async () => ({
      structuredContent: { count: 0, searchResults: [], start: 0, total: 0 },
    })),
    close: vi.fn(async () => undefined),
    listTools: vi.fn(async () => ({
      tools: requiredReadToolNames.map((name) => ({
        annotations: { destructiveHint: false, readOnlyHint: true },
        name,
      })),
    })),
    ...overrides,
  };
}

describe("live DataHub context port", () => {
  it("returns a typed resolution failure and always closes the MCP session", async () => {
    const transport = session();
    const port = createLiveDataHubContextPort({
      clock: () => new Date("2026-08-04T08:00:01.000Z"),
      invocationId: () => "inv_resolution_missing",
      sessionFactory: vi.fn(async () => transport),
    });

    const result = await port.collect({
      changeId: "chg_0123456789abcdef01234567",
      request: canonicalImpactRequest,
    });

    expect(result).toMatchObject({
      mode: "LIVE",
      outcome: "FAILED",
      report: {
        failedAt: "2026-08-04T08:00:01.000Z",
        failures: [
          {
            code: "NOT_FOUND",
            invocationId: "inv_resolution_missing",
            tool: "search",
          },
        ],
      },
    });
    expect(transport.callTool).toHaveBeenCalledTimes(1);
    expect(transport.close).toHaveBeenCalledTimes(1);
  });

  it("rejects a non-canonical request before creating transport", async () => {
    const sessionFactory = vi.fn(async () => session());
    const port = createLiveDataHubContextPort({ sessionFactory });

    await expect(
      port.collect({
        changeId: "chg_0123456789abcdef01234567",
        request: {
          ...canonicalImpactRequest,
          field: "account_id",
        } as unknown as typeof canonicalImpactRequest,
      }),
    ).rejects.toMatchObject({ code: "CONFIGURATION" });
    expect(sessionFactory).not.toHaveBeenCalled();
  });

  it("closes after discovery failure without exposing transport diagnostics", async () => {
    const secret = "dh_read_super_secret";
    const transport = session({
      listTools: vi.fn(async () => ({
        tools: requiredReadToolNames.slice(1).map((name) => ({
          annotations: { readOnlyHint: true },
          name,
        })),
      })),
    });
    const port = createLiveDataHubContextPort({
      sessionFactory: vi.fn(async () => transport),
    });

    let thrown: unknown;
    try {
      await port.collect({
        changeId: "chg_0123456789abcdef01234567",
        request: canonicalImpactRequest,
      });
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toMatchObject({ code: "TOOL_MISSING" });
    expect(JSON.stringify(thrown)).not.toContain(secret);
    expect(transport.close).toHaveBeenCalledTimes(1);
  });
});
