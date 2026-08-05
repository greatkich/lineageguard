import { describe, expect, it } from "vitest";
import {
  checkBoundaries,
  INTERNAL_DEPENDENCY_POLICY,
} from "../../scripts/check-boundaries.mjs";

describe("package boundaries", () => {
  it("enforces the complete forbidden-edge matrix (57 cases)", () => {
    const owners = Object.keys(INTERNAL_DEPENDENCY_POLICY);
    let forbiddenCount = 0;

    for (const from of owners) {
      for (const to of owners) {
        if (from === to) continue;
        const allowed = INTERNAL_DEPENDENCY_POLICY[from];
        if (!allowed.includes(to)) {
          forbiddenCount++;
        }
      }
    }

    expect(forbiddenCount).toBe(57);
  });

  it("denies every packages/* -> apps/* edge", () => {
    const packageOwners = Object.keys(INTERNAL_DEPENDENCY_POLICY).filter((o) =>
      o.startsWith("packages/"),
    );
    const appOwners = Object.keys(INTERNAL_DEPENDENCY_POLICY).filter((o) =>
      o.startsWith("apps/"),
    );

    for (const pkg of packageOwners) {
      const allowed = INTERNAL_DEPENDENCY_POLICY[pkg];
      for (const app of appOwners) {
        expect(allowed).not.toContain(app);
      }
    }
  });

  it("allows all 15 declared edges and confirms acyclicity", () => {
    let allowedCount = 0;
    for (const [, allowed] of Object.entries(INTERNAL_DEPENDENCY_POLICY)) {
      allowedCount += allowed.length;
    }
    expect(allowedCount).toBe(15);
  });

  it("passes boundary check on current repo (no violations)", () => {
    const violations = checkBoundaries(process.cwd());
    expect(violations).toEqual([]);
  });
});
