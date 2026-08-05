import { expect, it } from "vitest";
import { FOUNDATION_STATUS } from "./index.js";

it("labels the repository as foundation only", () => {
  expect(FOUNDATION_STATUS).toEqual({
    phase: "FOUNDATION",
    productReady: false,
  });
});
