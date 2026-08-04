import { describe, expect, it } from "vitest";

describe("repository test discovery", () => {
  it("includes tests outside apps and packages", () => {
    expect("tests/foundation.test.ts").toMatch(/^tests\//);
  });
});
