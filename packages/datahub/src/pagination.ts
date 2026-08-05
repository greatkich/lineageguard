import { DataHubAdapterError } from "./errors.js";

const PAGE_SIZE = 50;
const MAX_PAGES = 4;
const MAX_ITEMS = 200;

export type DataHubPage<T> = Readonly<{
  items: readonly T[];
  nextOffset?: number;
}>;

export type DataHubPageFetcher<T> = (offset: number, pageSize: number) => Promise<DataHubPage<T>>;

export async function collectBoundedPages<T>(
  fetchPage: DataHubPageFetcher<T>,
): Promise<readonly T[]> {
  const collected: T[] = [];
  const visitedOffsets = new Set<number>([0]);
  let offset = 0;

  for (let pageNumber = 0; pageNumber < MAX_PAGES; pageNumber += 1) {
    const page = await fetchPage(offset, PAGE_SIZE);
    if (!Array.isArray(page.items)) {
      throw new DataHubAdapterError(
        "MALFORMED_RESPONSE",
        "DataHub pagination returned an invalid item collection.",
      );
    }
    if (page.items.length > PAGE_SIZE) {
      throw new DataHubAdapterError(
        "PAGINATION_LIMIT",
        "DataHub pagination exceeded the requested page size.",
      );
    }

    if (collected.length + page.items.length > MAX_ITEMS) {
      throw new DataHubAdapterError(
        "PAGINATION_LIMIT",
        "DataHub pagination exceeded the fixed item limit.",
      );
    }
    collected.push(...page.items);

    if (page.nextOffset === undefined) return Object.freeze(collected);
    if (
      page.items.length === 0 ||
      !Number.isSafeInteger(page.nextOffset) ||
      page.nextOffset < 0 ||
      page.nextOffset <= offset ||
      visitedOffsets.has(page.nextOffset)
    ) {
      throw new DataHubAdapterError(
        "CURSOR_CYCLE",
        "DataHub pagination did not make forward progress.",
      );
    }
    if (pageNumber + 1 >= MAX_PAGES) {
      throw new DataHubAdapterError(
        "PAGINATION_LIMIT",
        "DataHub pagination exceeded the fixed page limit.",
      );
    }

    offset = page.nextOffset;
    visitedOffsets.add(offset);
  }

  throw new DataHubAdapterError(
    "PAGINATION_LIMIT",
    "DataHub pagination exceeded the fixed page limit.",
  );
}
