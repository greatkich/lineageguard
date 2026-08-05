import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";

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
        message: "Successfully added 1 tag(s) to 1 entity(ies)",
        success: true,
      },
    });
  });
});
