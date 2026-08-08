import { describe, expect, it } from "vitest";
import {
  assessGitHubEffectOutcome,
  assessRepeatGitHubEffectOutcomes,
} from "../scripts/github-effect-outcome.js";

describe("GitHub effect outcome acceptance", () => {
  it.each([null, undefined, "", "EXACT", "SKIPPED"])(
    "rejects a missing or unknown demo verification outcome (%s)",
    (outcome) => {
      expect(assessGitHubEffectOutcome(outcome)).toMatchObject({ ok: false });
    },
  );

  it.each(["CREATED", "UPDATED", "SKIPPED_EXACT"])(
    "accepts the persisted adapter outcome %s",
    (outcome) => {
      expect(assessGitHubEffectOutcome(outcome)).toEqual({ ok: true, outcome });
    },
  );

  it("requires three persisted SKIPPED_EXACT outcomes for the canonical repeat", () => {
    expect(
      assessRepeatGitHubEffectOutcomes({
        outcomes: ["SKIPPED_EXACT", "SKIPPED_EXACT", "SKIPPED_EXACT"],
        expectedCount: 3,
      }),
    ).toEqual({ ok: true, count: 3 });
  });

  it.each([
    { outcomes: ["SKIPPED_EXACT", "SKIPPED_EXACT"] },
    { outcomes: ["SKIPPED_EXACT", "CREATED", "SKIPPED_EXACT"] },
    { outcomes: ["SKIPPED_EXACT", null, "SKIPPED_EXACT"] },
  ])("rejects incomplete or non-exact canonical repeat outcomes", ({ outcomes }) => {
    expect(assessRepeatGitHubEffectOutcomes({ outcomes, expectedCount: 3 })).toMatchObject({
      ok: false,
    });
  });
});
