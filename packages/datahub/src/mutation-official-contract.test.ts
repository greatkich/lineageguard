import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";

async function fixture(name: string): Promise<unknown> {
  return JSON.parse(
    await readFile(new URL(`./__fixtures__/official-v0.6.0/${name}.json`, import.meta.url), "utf8"),
  );
}

describe("sanitized official DataHub MCP v0.6.0 mutation envelopes", () => {
  it.each(["save-document-result", "add-tags-result"])("records %s", async (name) => {
    expect(await fixture(name)).toMatchObject({ structuredContent: { success: true } });
  });
});
