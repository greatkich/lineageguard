import { describe, expect, it, vi } from "vitest";
import { collectBoundedPages } from "./pagination.js";

describe("bounded DataHub pagination", () => {
  it("collects ordered pages within fixed limits", async () => {
    const fetchPage = vi
      .fn()
      .mockResolvedValueOnce({ items: ["a", "b"], nextOffset: 2 })
      .mockResolvedValueOnce({ items: ["c"] });

    await expect(collectBoundedPages(fetchPage)).resolves.toEqual(["a", "b", "c"]);
    expect(fetchPage).toHaveBeenNthCalledWith(1, 0, 50);
    expect(fetchPage).toHaveBeenNthCalledWith(2, 2, 50);
  });

  it.each([
    ["cursor cycle", vi.fn(async () => ({ items: [0], nextOffset: 0 })), "CURSOR_CYCLE"],
    [
      "page limit",
      vi.fn(async (offset: number) => ({ items: [offset], nextOffset: offset + 1 })),
      "PAGINATION_LIMIT",
    ],
    [
      "item limit",
      vi.fn(async () => ({ items: Array.from({ length: 201 }, (_, index) => index) })),
      "PAGINATION_LIMIT",
    ],
  ])("rejects %s", async (_name, fetchPage, code) => {
    await expect(collectBoundedPages(fetchPage)).rejects.toMatchObject({ code });
  });

  it("rejects a stalled page that claims continuation with zero items", async () => {
    await expect(
      collectBoundedPages(async () => ({ items: [], nextOffset: 1 })),
    ).rejects.toMatchObject({ code: "CURSOR_CYCLE" });
  });
});
