/**
 * demo:golden — capture the recording artifacts from one verified run.
 *
 * Refuses to run unless the run it is given independently passes demo:verify, so golden evidence can
 * never be produced from a run that merely claimed success.
 *
 * Usage: pnpm demo:golden -- --runId <id>
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { argValue, loadEnv, printUsage, run, wantsHelp, withRunStore } from "./demo-support.js";

loadEnv();

async function verifiedRunId(): Promise<string> {
  const requested = argValue("--runId");
  const runId = await withRunStore(async (store) => {
    if (requested) {
      const found = await store.get(requested);
      if (!found) throw new Error(`run ${requested} not found`);
      return found.id;
    }
    const latest = (await store.list(1))[0];
    if (!latest) throw new Error("no runs recorded");
    return latest.id;
  });

  console.log(`gating on demo:verify for ${runId}…`);
  try {
    await run("pnpm", ["demo:verify", "--runId", runId], { maxBuffer: 16 * 1024 * 1024 });
  } catch {
    throw new Error(
      `run ${runId} does not pass demo:verify; golden evidence must come from a verified run`,
    );
  }
  return runId;
}

async function main(): Promise<void> {
  if (wantsHelp()) {
    printUsage("demo:golden -- --runId <id>", [
      "Captures the recording artifacts from one verified run: the evidence bundle,",
      "examples/canonical-run, and the Mission Control screenshots.",
      "",
      "Refuses to run unless demo:verify passes for that run.",
    ]);
    return;
  }

  const runId = await verifiedRunId();
  const artifactsDir = join(process.cwd(), "artifacts/demo-runs", runId);
  mkdirSync(artifactsDir, { recursive: true });

  console.log("exporting evidence…");
  await run("pnpm", ["export-evidence", runId], { maxBuffer: 16 * 1024 * 1024 });

  console.log("capturing Mission Control screenshots at 1440x900…");
  try {
    await run("npx", ["playwright", "test", "--grep", "Demo readiness screenshots"], {
      maxBuffer: 16 * 1024 * 1024,
    });
  } catch {
    console.warn("screenshot capture failed; the evidence bundle was still written");
  }

  const summary = await withRunStore(async (store) => store.get(runId));
  writeFileSync(
    join(artifactsDir, "golden-run.json"),
    `${JSON.stringify({ runId, capturedAt: new Date().toISOString(), run: summary }, null, 2)}\n`,
  );

  console.log(`\ngolden artifacts: ${artifactsDir}`);
  console.log(`mission control:  http://127.0.0.1:3000/runs/${runId}`);
  console.log("\ngolden: DONE\n");
}

await main();
