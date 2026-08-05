import { describe, expect, it } from "vitest";
import { DataHubAdapterError } from "./errors.js";
import { createMutationToolClient, type MutationToolName } from "./mutation-tool-client.js";
import type { ToolSession } from "./tool-client.js";

function session(overrides: Partial<ToolSession> = {}): ToolSession {
  return {
    async callTool() {
      return { structuredContent: { success: true } };
    },
    async close() {},
    async listTools() {
      return {
        tools: ["save_document", "add_tags", "remove_tags"].map((name) => ({
          annotations: { destructiveHint: true, readOnlyHint: false },
          name,
        })),
      };
    },
    ...overrides,
  };
}

describe("DataHub mutation tool client", () => {
  it("makes only save_document and add_tags reachable", async () => {
    const called: string[] = [];
    const client = await createMutationToolClient(
      session({
        async callTool(name) {
          called.push(name);
          return { structuredContent: { success: true } };
        },
      }),
    );
    await client.invoke("save_document", {});
    await expect(client.invoke("remove_tags" as MutationToolName, {})).rejects.toMatchObject({
      code: "TOOL_POLICY_VIOLATION",
    });
    expect(called).toEqual(["save_document"]);
  });

  it.each([
    [{ destructiveHint: false, readOnlyHint: false }],
    [{ destructiveHint: true, readOnlyHint: true }],
  ])("requires explicit mutation semantics %#", async (annotations) => {
    await expect(
      createMutationToolClient(
        session({
          async listTools() {
            return {
              tools: [
                { ...(annotations === undefined ? {} : { annotations }), name: "save_document" },
                {
                  annotations: { destructiveHint: true, readOnlyHint: false },
                  name: "add_tags",
                },
              ],
            };
          },
        }),
      ),
    ).rejects.toMatchObject({ code: "TOOL_POLICY_VIOLATION" });
  });

  it("accepts the pinned official declarations that omit annotations", async () => {
    const client = await createMutationToolClient(
      session({
        async listTools() {
          return { tools: [{ name: "save_document" }, { name: "add_tags" }] };
        },
      }),
    );
    await expect(client.invoke("add_tags", {})).resolves.toMatchObject({ tool: "add_tags" });
  });

  it("rejects duplicate declarations and missing required tools", async () => {
    await expect(
      createMutationToolClient(
        session({
          async listTools() {
            return {
              tools: ["save_document", "save_document", "add_tags"].map((name) => ({
                annotations: { destructiveHint: true, readOnlyHint: false },
                name,
              })),
            };
          },
        }),
      ),
    ).rejects.toMatchObject({ code: "TOOL_POLICY_VIOLATION" });
    await expect(
      createMutationToolClient(
        session({
          async listTools() {
            return {
              tools: [
                {
                  annotations: { destructiveHint: true, readOnlyHint: false },
                  name: "save_document",
                },
              ],
            };
          },
        }),
      ),
    ).rejects.toMatchObject({ code: "TOOL_MISSING" });
  });

  it("enforces response limits without retaining provider secrets", async () => {
    const secret = "datahub-super-secret-token";
    const client = await createMutationToolClient(
      session({
        async callTool() {
          return { structuredContent: { secret, value: "x".repeat(70_000) } };
        },
      }),
    );
    let thrown: unknown;
    try {
      await client.invoke("add_tags", {});
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(DataHubAdapterError);
    expect(JSON.stringify(thrown)).not.toContain(secret);
    expect(thrown).toMatchObject({ code: "RESPONSE_LIMIT" });
  });
});
