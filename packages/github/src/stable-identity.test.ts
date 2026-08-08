import { describe, expect, it } from "vitest";
import { deterministicHead } from "./validation.js";

const fingerprintA = "a".repeat(64);
const fingerprintB = "b".repeat(64);

/**
 * The generated effect identity must be content-addressed. A run-scoped branch produced a new
 * branch and a new draft PR per rehearsal, so `demo:repeat --count 3` could never prove that one
 * source and one candidate map to one PR.
 */
describe("generated branch identity", () => {
  it("is stable across runs for the same candidate", () => {
    expect(deterministicHead(fingerprintA, 3)).toBe(deterministicHead(fingerprintA, 3));
    expect(deterministicHead(fingerprintA, 3)).toBe(
      `lineageguard/generated/pr-3-${"a".repeat(12)}`,
    );
  });

  it("does not depend on the run id", () => {
    // The signature accepts no run identity at all, which is the guarantee.
    expect(deterministicHead.length).toBeLessThanOrEqual(2);
    expect(deterministicHead(fingerprintA, 3)).not.toContain("run_");
  });

  it("changes when the candidate changes", () => {
    expect(deterministicHead(fingerprintB, 3)).not.toBe(deterministicHead(fingerprintA, 3));
  });

  it("separates two source PRs carrying the same candidate", () => {
    expect(deterministicHead(fingerprintA, 4)).not.toBe(deterministicHead(fingerprintA, 3));
  });

  it("omits the PR segment when no source PR number is bound", () => {
    expect(deterministicHead(fingerprintA)).toBe(`lineageguard/generated/${"a".repeat(12)}`);
  });

  it("produces a valid Git ref name", () => {
    for (const candidate of [fingerprintA, fingerprintB]) {
      for (const prNumber of [undefined, 3, 12345]) {
        const head = deterministicHead(candidate, prNumber);
        expect(head).toMatch(/^[A-Za-z0-9._/-]+$/);
        expect(head).not.toContain("..");
        expect(head.endsWith("/")).toBe(false);
      }
    }
  });

  it.each([
    ["not hex", "z".repeat(64)],
    ["too short", "a".repeat(63)],
    ["a run id", "run_0123456789abcdef01234567"],
    ["empty", ""],
  ])("rejects a %s candidate fingerprint", (_label, value) => {
    expect(() => deterministicHead(value, 3)).toThrowError();
  });

  it.each([0, -1, 1.5])("rejects an invalid source PR number: %s", (prNumber) => {
    expect(() => deterministicHead(fingerprintA, prNumber)).toThrowError();
  });
});
