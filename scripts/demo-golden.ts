/**
 * demo:golden — capture the recording artifacts from one verified LIVE run.
 *
 * Fail-closed by construction. `golden: DONE` is printed only when every stage succeeded:
 * independent verification, evidence export, all eight LIVE recording screenshots, the exact
 * screenshot count, and manifest generation. An earlier version warned on screenshot failure and
 * still reported DONE, which let fixture renders stand in for live evidence.
 *
 * Usage: pnpm demo:golden -- --runId <id>
 */
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  argValue,
  type CheckResult,
  fail,
  isFixtureRunId,
  latestLiveRun,
  loadEnv,
  pass,
  printUsage,
  reportMatrix,
  run,
  wantsHelp,
  withRunStore,
} from "./demo-support.js";

loadEnv();

/** The eight recording states, matching tests/e2e/golden-recording.spec.ts. */
const requiredStates = [
  "01-baseline-allow",
  "02-datahub-consumers",
  "03-allow-to-block",
  "04-uuid-migration",
  "05-validation-pass",
  "06-generated-pr",
  "07-datahub-writeback",
  "08-completed-summary",
] as const;

const screenshotDir = "artifacts/demo-readiness/screenshots";

class GoldenFailure extends Error {}

/** Resolves the run to record, refusing fixtures and anything that is not a COMPLETED LIVE run. */
async function resolveRunId(): Promise<string> {
  const requested = argValue("--runId");
  return withRunStore(async (store) => {
    const record = requested ? await store.get(requested) : await latestLiveRun(store);
    if (!record) {
      throw new GoldenFailure(requested ? `run ${requested} not found` : "no LIVE runs recorded");
    }
    if (isFixtureRunId(record.id)) {
      throw new GoldenFailure(
        `run ${record.id} is a test fixture; golden evidence must come from a LIVE run`,
      );
    }
    if (record.executionMode !== "LIVE") {
      throw new GoldenFailure(
        `run ${record.id} has executionMode ${record.executionMode}; golden evidence requires LIVE`,
      );
    }
    if (record.status !== "COMPLETED") {
      throw new GoldenFailure(
        `run ${record.id} is ${record.status}; only COMPLETED may be recorded`,
      );
    }
    return record.id;
  });
}

async function gate(name: string, action: () => Promise<void>): Promise<CheckResult> {
  try {
    await action();
    return pass(name, "ok");
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return fail(name, message.split("\n")[0]?.slice(0, 200) ?? "failed");
  }
}

/** Asserts the recording produced exactly the required states, each a non-empty PNG. */
function verifyScreenshots(runId: string): CheckResult[] {
  const results: CheckResult[] = [];
  const missing: string[] = [];
  const empty: string[] = [];
  for (const state of requiredStates) {
    const path = join(screenshotDir, `${state}.png`);
    if (!existsSync(path)) {
      missing.push(state);
      continue;
    }
    if (statSync(path).size === 0) empty.push(state);
  }
  results.push(
    missing.length === 0 && empty.length === 0
      ? pass("recording screenshots", `all ${String(requiredStates.length)} LIVE states captured`)
      : fail(
          "recording screenshots",
          missing.length > 0 ? `missing: ${missing.join(", ")}` : `empty: ${empty.join(", ")}`,
        ),
  );

  const manifestPath = join(screenshotDir, "manifest.json");
  if (!existsSync(manifestPath)) {
    results.push(fail("recording manifest", "manifest.json was not written"));
    return results;
  }
  try {
    const manifest = JSON.parse(readFileSync(manifestPath, "utf8")) as {
      runId?: string;
      states?: string[];
      executionMode?: string;
    };
    const statesMatch =
      Array.isArray(manifest.states) &&
      manifest.states.length === requiredStates.length &&
      requiredStates.every((state, index) => manifest.states?.[index] === state);
    results.push(
      manifest.runId === runId && manifest.executionMode === "LIVE" && statesMatch
        ? pass("recording manifest", `binds ${String(requiredStates.length)} states to ${runId}`)
        : fail(
            "recording manifest",
            `manifest names run ${String(manifest.runId)} (${String(manifest.executionMode)}) with ${String(manifest.states?.length)} states`,
          ),
    );
  } catch (error) {
    results.push(
      fail("recording manifest", error instanceof Error ? error.message : String(error)),
    );
  }
  return results;
}

async function main(): Promise<void> {
  if (wantsHelp()) {
    printUsage("demo:golden -- --runId <id>", [
      "Captures the recording artifacts from one verified LIVE run: the evidence bundle,",
      "examples/canonical-run, and the eight Mission Control recording states.",
      "",
      "Refuses to run unless demo:verify passes, and exits non-zero unless every",
      "screenshot and the manifest were produced from that exact run.",
    ]);
    return;
  }

  let runId: string;
  try {
    runId = await resolveRunId();
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    console.log("\ngolden: FAILED\n");
    process.exitCode = 1;
    return;
  }

  console.log(`golden run: ${runId}\n`);
  const artifactsDir = join(process.cwd(), "artifacts/demo-runs", runId);
  mkdirSync(artifactsDir, { recursive: true });
  mkdirSync(screenshotDir, { recursive: true });

  const results: CheckResult[] = [];

  results.push(
    await gate("independent verification", async () => {
      await run("pnpm", ["demo:verify", "--runId", runId], { maxBuffer: 16 * 1024 * 1024 });
    }),
  );

  results.push(
    await gate("evidence export", async () => {
      await run("pnpm", ["export-evidence", runId], { maxBuffer: 16 * 1024 * 1024 });
    }),
  );

  results.push(
    await gate("live recording capture", async () => {
      await run("npx", ["playwright", "test", "tests/e2e/golden-recording.spec.ts"], {
        maxBuffer: 16 * 1024 * 1024,
        env: { ...process.env, LINEAGEGUARD_GOLDEN_RUN_ID: runId },
      });
    }),
  );

  results.push(...verifyScreenshots(runId));

  results.push(
    await gate("golden run snapshot", async () => {
      const summary = await withRunStore(async (store) => store.get(runId));
      if (!summary) throw new Error(`run ${runId} disappeared from the store`);
      writeFileSync(
        join(artifactsDir, "golden-run.json"),
        `${JSON.stringify({ runId, capturedAt: new Date().toISOString(), run: summary }, null, 2)}\n`,
      );
    }),
  );

  const ok = reportMatrix(`demo:golden ${runId}`, results);

  console.log(`\ngolden artifacts: ${artifactsDir}`);
  console.log(`screenshots:      ${screenshotDir}`);
  console.log(`mission control:  http://127.0.0.1:3000/runs/${runId}`);

  console.log(ok ? "\ngolden: DONE\n" : "\ngolden: FAILED\n");
  process.exitCode = ok ? 0 : 1;
}

await main();
