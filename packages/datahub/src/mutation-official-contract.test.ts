import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";
import { createMutationToolClient, officialMutationInputSchemas } from "./mutation-tool-client.js";
import type { ToolSession } from "./tool-client.js";

async function fixture(name: string): Promise<unknown> {
  return JSON.parse(
    await readFile(new URL(`./__fixtures__/official-v0.6.0/${name}.json`, import.meta.url), "utf8"),
  );
}

describe("sanitized official DataHub MCP v0.6.0 mutation envelopes", () => {
  it("records the exact save_document success projection", async () => {
    expect(await fixture("save-document-result")).toEqual({
      structuredContent: {
        author: null,
        message: "Successfully created document: LineageGuard migration decision",
        success: true,
        urn: "urn:li:document:lineageguard-migration-decision_example",
      },
    });
  });

  it("records the exact add_tags success projection", async () => {
    expect(await fixture("add-tags-result")).toEqual({
      structuredContent: {
        message: "Successfully added 1 tag(s) to 1 entit(ies)",
        success: true,
      },
    });
  });

  it.each([
    [
      "save_document" as const,
      "save-document-result",
      { urn: "urn:li:document:lineageguard-migration-decision_example" },
    ],
    ["add_tags" as const, "add-tags-result", {}],
  ])("passes %s fixture through the production parser", async (tool, name, arguments_) => {
    const raw = await fixture(name);
    const session: ToolSession = {
      async callTool() {
        return raw;
      },
      async close() {},
      async listTools() {
        return {
          tools: [
            { inputSchema: officialMutationInputSchemas.save_document, name: "save_document" },
            { inputSchema: officialMutationInputSchemas.add_tags, name: "add_tags" },
          ],
        };
      },
    };
    const client = await createMutationToolClient(session);
    await expect(client.invoke(tool, arguments_)).resolves.toMatchObject({ tool });
  });
});
