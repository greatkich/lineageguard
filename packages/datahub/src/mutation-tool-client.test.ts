import { describe, expect, it, vi } from "vitest";
import { DataHubAdapterError } from "./errors.js";
import { createMutationToolClient, type MutationToolName } from "./mutation-tool-client.js";
import type { ToolSession } from "./tool-client.js";

const nullableString = { anyOf: [{ type: "string" }, { type: "null" }], default: null };
const nullableStringArray = {
  anyOf: [{ items: { type: "string" }, type: "array" }, { type: "null" }],
  default: null,
};
const inputSchemas = {
  add_tags: {
    additionalProperties: false,
    properties: {
      column_paths: {
        anyOf: [
          {
            items: { anyOf: [{ type: "string" }, { type: "null" }] },
            type: "array",
          },
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
} as const;

function declaration(name: "save_document" | "add_tags") {
  return { inputSchema: inputSchemas[name], name };
}

function session(overrides: Partial<ToolSession> = {}): ToolSession {
  return {
    async callTool(name, arguments_) {
      return name === "save_document"
        ? {
            structuredContent: {
              author: null,
              message: "Successfully created document: test",
              success: true,
              urn: arguments_.urn,
            },
          }
        : {
            structuredContent: {
              message: "Successfully added 1 tag(s) to 1 entit(ies)",
              success: true,
            },
          };
    },
    async close() {},
    async listTools() {
      return {
        tools: [declaration("save_document"), declaration("add_tags"), { name: "remove_tags" }],
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
        async callTool(name, arguments_) {
          called.push(name);
          return {
            structuredContent: {
              author: null,
              message: "Successfully created document: test",
              success: true,
              urn: arguments_.urn,
            },
          };
        },
      }),
    );
    await client.invoke("save_document", { urn: "urn:li:document:test" });
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
              tools: [{ ...declaration("save_document"), annotations }, declaration("add_tags")],
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
          return { tools: [declaration("save_document"), declaration("add_tags")] };
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
              tools: [
                declaration("save_document"),
                declaration("save_document"),
                declaration("add_tags"),
              ],
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
              tools: [declaration("save_document")],
            };
          },
        }),
      ),
    ).rejects.toMatchObject({ code: "TOOL_MISSING" });
  });

  it.each(["discovery", "schema"])(
    "closes the mutation session once on %s rejection",
    async (failure) => {
      const close = vi.fn(async () => {});
      const failing = session({
        close,
        async listTools() {
          if (failure === "discovery") throw new Error("provider secret");
          return {
            tools: [
              {
                inputSchema: { ...inputSchemas.save_document, additionalProperties: true },
                name: "save_document",
              },
              declaration("add_tags"),
            ],
          };
        },
      });
      await expect(createMutationToolClient(failing)).rejects.toBeInstanceOf(DataHubAdapterError);
      expect(close).toHaveBeenCalledTimes(1);
    },
  );

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
