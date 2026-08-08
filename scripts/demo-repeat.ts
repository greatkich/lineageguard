/**
 * demo:repeat --count N — the repeatability proof.
 *
 * Runs the same canonical input N times with no manual repair between runs and proves that repeated
 * rehearsals *converge* rather than accumulate: distinct run ids, but one derived candidate identity,
 * one generated PR, one DataHub decision identity, and no leaked sandbox state.
 *
 * Every claim is derived from evidence:
 *   - fingerprints are re-derived from each run's persisted candidate, not read from a log line;
 *   - the DataHub decision identity is re-read from institutional memory after the runs;
 *   - duplicate documents and duplicate LineageGuard tags are counted, not assumed absent;
 *   - Docker and worktree inspection failures are failed checks, not empty lists.
 *
 * Usage: pnpm demo:repeat -- --count 3
 */
import { canonicalCandidateFingerprint, type MigrationCandidate } from "@lineageguard/domain";
import {
  candidateView,
  expectedDecisionMarker,
  listValidationWorktrees,
  listValidatorContainers,
  readDataHubDecisionState,
} from "./acceptance-inspect.js";
import {
  argValue,
  type CheckResult,
  fail,
  latestLiveRun,
  loadEnv,
  pass,
  printUsage,
  reportMatrix,
  run,
  wantsHelp,
  withRunStore,
} from "./demo-support.js";
import { assessRepeatGitHubEffectOutcomes } from "./github-effect-outcome.js";

loadEnv();

type RunOutcome = Readonly<{
  index: number;
  runId: string;
  status: string;
  applicationCodeSha: string | null;
  consumers: number | null;
  prUrl: string | null;
  writeback: string | null;
  validationReceipt: string | null;
  /** Derived from the persisted candidate, so identity claims are recomputed rather than trusted. */
  candidateFingerprint: string | null;
  sourceFingerprint: string | null;
  impactContextFingerprint: string | null;
  validationCheckCount: number | null;
  validationAllPass: boolean | null;
  githubHeadSha: string | null;
  githubEffectOutcome: string | null;
}>;

async function executeOnce(index: number): Promise<RunOutcome> {
  console.log(`\n--- run ${String(index)} ---`);
  try {
    await run("pnpm", ["demo:run"], { maxBuffer: 32 * 1024 * 1024 });
  } catch (error) {
    // A non-zero exit is itself the signal; the persisted record below tells us how far it got.
    const message = error instanceof Error ? error.message : String(error);
    console.log(`  demo:run exited non-zero: ${message.slice(0, 160)}`);
  }
  return withRunStore(async (store) => {
    const latest = await latestLiveRun(store);
    if (!latest) throw new Error("demo:run produced no LIVE run record");
    console.log(`  ${latest.id} → ${latest.status}`);

    const candidate = candidateView(latest.candidateJson);
    const receipt = latest.validationReceiptJson as
      | { allPass?: boolean; checks?: unknown[] }
      | null
      | undefined;
    return {
      index,
      runId: latest.id,
      status: latest.status,
      applicationCodeSha: latest.applicationCodeSha,
      consumers: latest.consumersFound,
      prUrl: latest.prUrl,
      writeback: latest.writebackStatus,
      validationReceipt: latest.validationReceiptFingerprint,
      candidateFingerprint: candidate.ok
        ? canonicalCandidateFingerprint(latest.candidateJson as MigrationCandidate)
        : null,
      sourceFingerprint: latest.sourceDiffFingerprint,
      impactContextFingerprint: candidate.ok
        ? candidate.value.sourceImpactContextFingerprint
        : null,
      validationCheckCount: Array.isArray(receipt?.checks) ? receipt.checks.length : null,
      validationAllPass: typeof receipt?.allPass === "boolean" ? receipt.allPass : null,
      githubHeadSha: latest.githubHeadSha,
      githubEffectOutcome: latest.githubEffectOutcome,
    };
  });
}

/** Asserts that a value is identical across every run, reporting the distinct values when not. */
function invariant(
  name: string,
  outcomes: readonly RunOutcome[],
  select: (outcome: RunOutcome) => string | null,
  describe: (value: string) => string,
): CheckResult {
  const values = outcomes.map(select);
  if (values.some((value) => value === null || value.length === 0)) {
    return fail(name, "at least one run did not record this value");
  }
  const distinct = [...new Set(values as string[])];
  return distinct.length === 1 && distinct[0] !== undefined
    ? pass(name, describe(distinct[0]))
    : fail(name, `${String(distinct.length)} distinct values across runs — not convergent`);
}

function summarise(outcomes: readonly RunOutcome[]): CheckResult[] {
  const results: CheckResult[] = [];
  const completed = outcomes.filter((outcome) => outcome.status === "COMPLETED");
  results.push(
    completed.length === outcomes.length
      ? pass("all runs completed", `${String(completed.length)}/${String(outcomes.length)}`)
      : fail(
          "all runs completed",
          `${String(completed.length)}/${String(outcomes.length)}: ${outcomes.map((o) => `${o.runId}=${o.status}`).join(", ")}`,
        ),
  );

  const runIds = new Set(outcomes.map((outcome) => outcome.runId));
  results.push(
    runIds.size === outcomes.length
      ? pass("distinct run ids", `${String(runIds.size)} distinct`)
      : fail("distinct run ids", `${String(runIds.size)} for ${String(outcomes.length)} runs`),
  );

  results.push(
    invariant(
      "application code sha",
      outcomes,
      (outcome) => outcome.applicationCodeSha,
      (value) => `identical across runs (${value.slice(0, 12)})`,
    ),
  );

  const githubOutcomes = assessRepeatGitHubEffectOutcomes({
    outcomes: outcomes.map((outcome) => outcome.githubEffectOutcome),
    expectedCount: outcomes.length,
  });
  results.push(
    githubOutcomes.ok
      ? pass(
          "github effect outcome",
          `${String(githubOutcomes.count)} SKIPPED_EXACT outcomes persisted`,
        )
      : fail("github effect outcome", githubOutcomes.reason),
  );

  results.push(
    invariant(
      "source fingerprint",
      outcomes,
      (outcome) => outcome.sourceFingerprint,
      (value) => `identical across runs (${value.slice(0, 16)})`,
    ),
  );
  results.push(
    invariant(
      "impact context fingerprint",
      outcomes,
      (outcome) => outcome.impactContextFingerprint,
      (value) => `identical across runs (${value.slice(0, 16)})`,
    ),
  );
  results.push(
    invariant(
      "candidate fingerprint",
      outcomes,
      (outcome) => outcome.candidateFingerprint,
      (value) => `identical across runs (${value.slice(0, 16)})`,
    ),
  );
  results.push(
    invariant(
      "generated pr identity",
      outcomes,
      (outcome) => outcome.prUrl,
      (value) => `1 stable PR: ${value}`,
    ),
  );
  results.push(
    invariant(
      "generated branch head sha",
      outcomes,
      (outcome) => outcome.githubHeadSha,
      (value) => `1 stable commit: ${value.slice(0, 12)}`,
    ),
  );

  const consumerCounts = new Set(outcomes.map((outcome) => outcome.consumers));
  results.push(
    consumerCounts.size === 1 && consumerCounts.has(4)
      ? pass("consumer count", "4 on every run")
      : fail("consumer count", `observed ${[...consumerCounts].join(", ")}`),
  );

  const badValidation = outcomes.filter(
    (outcome) => outcome.validationCheckCount !== 8 || outcome.validationAllPass !== true,
  );
  results.push(
    badValidation.length === 0
      ? pass("validation 8/8 every run", "eight canonical checks passed on every run")
      : fail(
          "validation 8/8 every run",
          badValidation
            .map(
              (outcome) =>
                `${outcome.runId}=${String(outcome.validationCheckCount)} checks/allPass=${String(outcome.validationAllPass)}`,
            )
            .join(", "),
        ),
  );

  const receipts = new Set(outcomes.map((outcome) => outcome.validationReceipt).filter(Boolean));
  results.push(
    receipts.size === 1
      ? pass("validation receipt", "identical across runs — validation is deterministic")
      : pass(
          "validation receipt",
          `${String(receipts.size)} distinct; receipts bind per-run timing, so this is expected`,
          false,
        ),
  );

  const writebacks = new Set(outcomes.map((outcome) => outcome.writeback));
  results.push(
    writebacks.size === 1 && writebacks.has("SUCCEEDED")
      ? pass("writeback", "SUCCEEDED on every run")
      : fail("writeback", `observed ${[...writebacks].join(", ")}`),
  );
  return results;
}

/**
 * Re-reads DataHub after the runs and proves the decision converged onto exactly one identity that
 * matches the candidate every run derived.
 */
async function verifyConvergedDecision(outcomes: readonly RunOutcome[]): Promise<CheckResult[]> {
  const state = await readDataHubDecisionState();
  if (!state.ok) {
    return [
      fail("datahub decision identity", state.reason),
      fail("datahub decision documents", "DataHub could not be inspected"),
      fail("datahub duplicate metadata", "DataHub could not be inspected"),
    ];
  }

  const results: CheckResult[] = [
    state.value.markers.length === 1
      ? pass("datahub decision identity", `exactly one: ${state.value.markers[0] ?? ""}`)
      : fail(
          "datahub decision identity",
          `${String(state.value.markers.length)} decision identities after ${String(outcomes.length)} runs`,
        ),
    state.value.decisionElementCount === 1
      ? pass("datahub decision documents", "exactly one LineageGuard decision document")
      : fail(
          "datahub decision documents",
          `${String(state.value.decisionElementCount)} LineageGuard decision documents`,
        ),
    state.value.duplicateTags
      ? fail("datahub duplicate metadata", "a LineageGuard tag is attached more than once")
      : pass(
          "datahub duplicate metadata",
          `${String(state.value.lineageguardTags.length)} LineageGuard tags, none duplicated`,
        ),
  ];

  const fingerprints = [
    ...new Set(outcomes.map((outcome) => outcome.candidateFingerprint).filter(Boolean)),
  ] as string[];
  if (fingerprints.length !== 1 || fingerprints[0] === undefined) {
    results.push(
      fail("datahub decision matches candidate", "runs did not converge on one candidate identity"),
    );
    return results;
  }
  const expected = expectedDecisionMarker(fingerprints[0]);
  results.push(
    state.value.markers[0] === expected
      ? pass("datahub decision matches candidate", `${expected} derived from every run's candidate`)
      : fail(
          "datahub decision matches candidate",
          `DataHub holds ${String(state.value.markers[0])} but the runs derive ${expected}`,
        ),
  );
  return results;
}

/** Sandbox hygiene, with inspection failure treated as a failed check. */
async function verifySandboxHygiene(
  containersBefore: readonly string[],
  worktreesBefore: readonly string[],
): Promise<CheckResult[]> {
  const results: CheckResult[] = [];
  const containersAfter = await listValidatorContainers();
  if (!containersAfter.ok) {
    results.push(fail("leaked containers", containersAfter.reason));
  } else {
    const leaked = containersAfter.value.filter((name) => !containersBefore.includes(name));
    results.push(
      leaked.length === 0
        ? pass("leaked containers", "0")
        : fail("leaked containers", leaked.join(", ")),
    );
  }

  const worktreesAfter = await listValidationWorktrees();
  if (!worktreesAfter.ok) {
    results.push(fail("leaked worktrees", worktreesAfter.reason));
  } else {
    const leaked = worktreesAfter.value.filter((path) => !worktreesBefore.includes(path));
    results.push(
      leaked.length === 0
        ? pass("leaked worktrees", "0")
        : fail("leaked worktrees", leaked.join(", ")),
    );
  }
  return results;
}

async function main(): Promise<void> {
  if (wantsHelp()) {
    printUsage("demo:repeat -- --count 3", [
      "Runs the canonical demo N times with no manual repair and proves that",
      "repeated rehearsals converge: distinct run ids, one candidate identity,",
      "one generated PR, one DataHub decision, and no leaked sandbox state.",
    ]);
    return;
  }

  const count = Number.parseInt(argValue("--count") ?? "3", 10);
  if (!Number.isInteger(count) || count < 1 || count > 10) {
    console.error("--count must be an integer between 1 and 10");
    process.exitCode = 1;
    return;
  }

  // A pre-run inspection that fails is fatal: without a baseline we cannot claim zero leaks.
  const containersBefore = await listValidatorContainers();
  const worktreesBefore = await listValidationWorktrees();
  if (!containersBefore.ok || !worktreesBefore.ok) {
    const reason = !containersBefore.ok
      ? containersBefore.reason
      : !worktreesBefore.ok
        ? worktreesBefore.reason
        : "unknown";
    console.error(`cannot establish a sandbox baseline: ${reason}`);
    console.log("\nrepeat: FAIL\n");
    process.exitCode = 1;
    return;
  }

  const outcomes: RunOutcome[] = [];
  for (let index = 1; index <= count; index += 1) {
    outcomes.push(await executeOnce(index));
  }

  const results = [
    ...summarise(outcomes),
    ...(await verifyConvergedDecision(outcomes)),
    ...(await verifySandboxHygiene(containersBefore.value, worktreesBefore.value)),
  ];

  console.log("");
  for (const outcome of outcomes) {
    console.log(
      `  run ${String(outcome.index)}: ${outcome.runId} → ${outcome.status}` +
        ` (GitHub ${outcome.githubEffectOutcome ?? "missing"}; candidate ${outcome.candidateFingerprint?.slice(0, 12) ?? "none"})`,
    );
  }

  const ok = reportMatrix(`demo:repeat ×${String(count)}`, results);

  console.log("\nstable identities");
  const prUrls = [...new Set(outcomes.map((outcome) => outcome.prUrl).filter(Boolean))];
  const candidates = [
    ...new Set(outcomes.map((outcome) => outcome.candidateFingerprint).filter(Boolean)),
  ];
  const codeShas = [
    ...new Set(outcomes.map((outcome) => outcome.applicationCodeSha).filter(Boolean)),
  ];
  const headShas = [...new Set(outcomes.map((outcome) => outcome.githubHeadSha).filter(Boolean))];
  console.log(`  run ids:              ${outcomes.map((outcome) => outcome.runId).join(", ")}`);
  console.log(`  application code sha: ${codeShas.join(", ") || "none"}`);
  console.log(`  candidate identity:   ${candidates.join(", ") || "none"}`);
  console.log(`  generated pr:         ${prUrls.join(", ") || "none"}`);
  console.log(`  generated head sha:   ${headShas.join(", ") || "none"}`);
  console.log(
    `  github outcomes:      ${outcomes.map((outcome) => outcome.githubEffectOutcome ?? "missing").join(", ")}`,
  );
  const state = await readDataHubDecisionState();
  console.log(
    `  datahub decision:     ${
      state.ok ? state.value.markers.join(", ") || "none" : `uninspectable (${state.reason})`
    }`,
  );

  console.log(ok ? "\nrepeat: PASS\n" : "\nrepeat: FAIL\n");
  process.exitCode = ok ? 0 : 1;
}

await main();
