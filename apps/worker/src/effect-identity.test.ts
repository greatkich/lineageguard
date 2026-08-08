import type { MigrationCandidate } from "@lineageguard/domain";
import { describe, expect, it } from "vitest";
import {
  canonicalCandidateFingerprint,
  decisionMarker,
  generatedBranchName,
} from "./effect-identity.js";

function candidate(overrides: Partial<MigrationCandidate> = {}): MigrationCandidate {
  return {
    strategy: "EXPAND_MIGRATE_CONTRACT",
    sourceChangeFingerprint: "1".repeat(64),
    sourcePatchFingerprint: "2".repeat(64),
    sourceImpactContextFingerprint: "3".repeat(64),
    sourceDecision: "BLOCK",
    sourceEvidenceIds: ["ev_0123456789abcdef01234567"],
    summary: "Expand, migrate, contract.",
    steps: [],
    artifacts: [
      { path: "b.sql", kind: "SQL_MIGRATION", content: "alter table ...", operation: "CREATE" },
      { path: "a.sql", kind: "ROLLBACK_SQL", content: "drop column ...", operation: "CREATE" },
    ],
    requiredReviewers: [],
    compatibilityWindowDays: 30,
    rollbackPlan: "Run the rollback artifact.",
    ...overrides,
  } as unknown as MigrationCandidate;
}

describe("content-addressed effect identity", () => {
  it("is stable for identical candidates", () => {
    expect(canonicalCandidateFingerprint(candidate())).toBe(
      canonicalCandidateFingerprint(candidate()),
    );
  });

  it("ignores artifact and evidence ordering", () => {
    const reordered = candidate({
      artifacts: [...candidate().artifacts].reverse(),
    } as Partial<MigrationCandidate>);
    expect(canonicalCandidateFingerprint(reordered)).toBe(
      canonicalCandidateFingerprint(candidate()),
    );
  });

  it.each([
    ["source change", { sourceChangeFingerprint: "9".repeat(64) }],
    ["source patch", { sourcePatchFingerprint: "9".repeat(64) }],
    ["impact context", { sourceImpactContextFingerprint: "9".repeat(64) }],
  ])("changes when the %s fingerprint moves", (_label, overrides) => {
    expect(
      canonicalCandidateFingerprint(candidate(overrides as Partial<MigrationCandidate>)),
    ).not.toBe(canonicalCandidateFingerprint(candidate()));
  });

  it("changes when generated artifact bytes change", () => {
    const mutated = candidate({
      artifacts: [
        {
          path: "b.sql",
          kind: "SQL_MIGRATION",
          content: "alter table DIFFERENT",
          operation: "CREATE",
        },
        { path: "a.sql", kind: "ROLLBACK_SQL", content: "drop column ...", operation: "CREATE" },
      ],
    } as unknown as Partial<MigrationCandidate>);
    expect(canonicalCandidateFingerprint(mutated)).not.toBe(
      canonicalCandidateFingerprint(candidate()),
    );
  });

  it("never derives the branch from a run id", () => {
    const fingerprint = canonicalCandidateFingerprint(candidate());
    const branch = generatedBranchName(fingerprint, 3);
    expect(branch).toBe(`lineageguard/generated/pr-3-${fingerprint.slice(0, 12)}`);
    expect(branch).not.toContain("run_");
    expect(branch).not.toContain("run-");
  });

  it("produces one branch and one marker per candidate", () => {
    const first = canonicalCandidateFingerprint(candidate());
    const second = canonicalCandidateFingerprint(candidate());
    expect(generatedBranchName(first, 3)).toBe(generatedBranchName(second, 3));
    expect(decisionMarker(first)).toBe(decisionMarker(second));
    expect(decisionMarker(first)).toBe(`lineageguard:decision:v1:candidate-${first.slice(0, 16)}`);
  });

  it.each(["", "z".repeat(64), "a".repeat(63), "run_0123456789abcdef01234567"])(
    "rejects a malformed fingerprint: %s",
    (value) => {
      expect(() => generatedBranchName(value)).toThrowError();
      expect(() => decisionMarker(value)).toThrowError();
    },
  );
});
