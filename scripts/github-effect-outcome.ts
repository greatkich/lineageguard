export type GitHubEffectOutcome = "CREATED" | "UPDATED" | "SKIPPED_EXACT";

const githubEffectOutcomes = new Set<string>(["CREATED", "UPDATED", "SKIPPED_EXACT"]);

export function assessGitHubEffectOutcome(
  outcome: unknown,
): { ok: true; outcome: GitHubEffectOutcome } | { ok: false; reason: string } {
  if (typeof outcome === "string" && githubEffectOutcomes.has(outcome)) {
    return { ok: true, outcome: outcome as GitHubEffectOutcome };
  }
  return {
    ok: false,
    reason: `${String(outcome)} — expected CREATED, UPDATED, or SKIPPED_EXACT`,
  };
}

export function assessRepeatGitHubEffectOutcomes(options: {
  outcomes: readonly unknown[];
  expectedCount: number;
}): { ok: true; count: number } | { ok: false; reason: string } {
  if (options.outcomes.length !== options.expectedCount) {
    return {
      ok: false,
      reason: `${String(options.outcomes.length)} outcomes persisted; expected ${String(options.expectedCount)}`,
    };
  }
  if (!options.outcomes.every((outcome) => outcome === "SKIPPED_EXACT")) {
    return { ok: false, reason: `observed ${options.outcomes.map(String).join(", ")}` };
  }
  return { ok: true, count: options.outcomes.length };
}
