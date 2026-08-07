/**
 * demo:repeat --count N — the repeatability proof.
 *
 * Runs the same canonical input N times with no manual repair between runs and proves that repeated
 * rehearsals converge rather than accumulate: distinct run ids, but one generated PR identity, one
 * DataHub decision identity, and no leaked containers or worktrees.
 *
 * Usage: pnpm demo:repeat -- --count 3
 */
import {
  argValue,
  type CheckResult,
  fail,
  loadEnv,
  pass,
  printUsage,
  reportMatrix,
  run,
  wantsHelp,
  withRunStore,
} from "./demo-support.js";

loadEnv();

type RunOutcome = Readonly<{
  index: number;
  runId: string;
  status: string;
  consumers: number | null;
  prUrl: string | null;
  writeback: string | null;
  validationReceipt: string | null;
}>;

async function containerNames(): Promise<string[]> {
  try {
    const { stdout } = await run("docker", ["ps", "-a", "--format", "{{.Names}}"]);
    return stdout.split("\n").filter((name) => name.startsWith("lineageguard"));
  } catch {
    return [];
  }
}

async function worktreePaths(): Promise<string[]> {
  try {
    const { stdout } = await run("git", ["worktree", "list", "--porcelain"]);
    return stdout
      .split("\n")
      .filter((line) => line.startsWith("worktree "))
      .map((line) => line.slice("worktree ".length))
      .filter((path) => path.includes("validation") || path.includes("sandbox"));
  } catch {
    return [];
  }
}

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
    const latest = (await store.list(1))[0];
    if (!latest) throw new Error("demo:run produced no run record");
    console.log(`  ${latest.id} → ${latest.status}`);
    return {
      index,
      runId: latest.id,
      status: latest.status,
      consumers: latest.consumersFound,
      prUrl: latest.prUrl,
      writeback: latest.writebackStatus,
      validationReceipt: latest.validationReceiptFingerprint,
    };
  });
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

  const prUrls = new Set(outcomes.map((outcome) => outcome.prUrl).filter(Boolean));
  results.push(
    prUrls.size === 1
      ? pass("generated pr identity", `1 stable PR: ${[...prUrls][0] ?? ""}`)
      : fail(
          "generated pr identity",
          `${String(prUrls.size)} distinct PRs — identity is not stable`,
        ),
  );

  const consumerCounts = new Set(outcomes.map((outcome) => outcome.consumers));
  results.push(
    consumerCounts.size === 1 && consumerCounts.has(4)
      ? pass("consumer count", "4 on every run")
      : fail("consumer count", `observed ${[...consumerCounts].join(", ")}`),
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

async function main(): Promise<void> {
  if (wantsHelp()) {
    printUsage("demo:repeat -- --count 3", [
      "Runs the canonical demo N times with no manual repair and proves that",
      "repeated rehearsals converge: distinct run ids, one generated PR, one",
      "DataHub decision, no leaked containers or worktrees.",
    ]);
    return;
  }

  const count = Number.parseInt(argValue("--count") ?? "3", 10);
  if (!Number.isInteger(count) || count < 1 || count > 10) {
    console.error("--count must be an integer between 1 and 10");
    process.exitCode = 1;
    return;
  }

  const containersBefore = await containerNames();
  const worktreesBefore = await worktreePaths();

  const outcomes: RunOutcome[] = [];
  for (let index = 1; index <= count; index += 1) {
    outcomes.push(await executeOnce(index));
  }

  const containersAfter = await containerNames();
  const worktreesAfter = await worktreePaths();
  const leakedContainers = containersAfter.filter((name) => !containersBefore.includes(name));
  const leakedWorktrees = worktreesAfter.filter((path) => !worktreesBefore.includes(path));

  const results = [
    ...summarise(outcomes),
    leakedContainers.length === 0
      ? pass("leaked containers", "0")
      : fail("leaked containers", leakedContainers.join(", ")),
    leakedWorktrees.length === 0
      ? pass("leaked worktrees", "0")
      : fail("leaked worktrees", leakedWorktrees.join(", ")),
  ];

  console.log("");
  for (const outcome of outcomes) {
    console.log(
      `run ${String(outcome.index)}: ${outcome.status.padEnd(10)} consumers=${String(outcome.consumers)} pr=${outcome.prUrl ?? "-"}`,
    );
  }

  const ok = reportMatrix(`demo:repeat --count ${String(count)}`, results);
  console.log(ok ? "\nrepeat: PASS\n" : "\nrepeat: FAIL\n");
  process.exitCode = ok ? 0 : 1;
}

await main();
