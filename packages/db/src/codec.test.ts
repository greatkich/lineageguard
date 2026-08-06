import { describe, expect, it } from "vitest";
import { parsePersisted } from "./codec.js";
import {
  CorruptDataError,
  IdempotencyConflictError,
  mapPostgresError,
  StateConflictError,
} from "./errors.js";

describe("persisted payload parsing", () => {
  it("fails closed and preserves a safe location label", () => {
    expect(() =>
      parsePersisted(
        {
          parse() {
            throw new Error("missing required field");
          },
        },
        {},
        "decision payload",
      ),
    ).toThrow(
      new CorruptDataError("persisted decision payload is corrupt: missing required field"),
    );
  });
});

describe("PostgreSQL error mapping", () => {
  it("maps uniqueness and constraint errors to stable public errors", () => {
    expect(mapPostgresError({ code: "23505", message: "duplicate" })).toBeInstanceOf(
      IdempotencyConflictError,
    );
    expect(mapPostgresError({ code: "23514", message: "check" })).toBeInstanceOf(
      StateConflictError,
    );
  });
});
