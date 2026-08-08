/**
 * demo:bootstrap — prepare and verify the canonical DataHub graph.
 *
 * Orchestrates the existing Python tooling chain rather than reimplementing it. On repeated runs it
 * first checks whether the graph is already complete (via `verify`); if so, it skips the seeding
 * chain entirely and reports READY.
 *
 * Usage: pnpm demo:bootstrap
 *        pnpm demo:bootstrap -- --plan   print the plan without mutating anything
 */
import {
  type CheckResult,
  fail,
  gmsUrl,
  hasFlag,
  loadEnv,
  pass,
  printUsage,
  readToken,
  reportMatrix,
  run,
  wantsHelp,
} from "./demo-support.js";

loadEnv();

/**
 * The canonical chain. Order matters: each step consumes the previous step's receipt.
 * `reconcile-live-query` is what registers the observed Finance SYSTEM query entity, whose absence
 * is what stops live context collection.
 */
const chain = [
  ["warehouse-seed", "schemas, tables, roles, scenario registry"],
  ["dbt-build", "dbt build plus manifest and catalog"],
  ["query", "execute the observed Finance query"],
  ["ingest", "postgres and dbt ingestion into DataHub"],
  ["metadata-seed", "glossary, owners, dashboard, ML model, lineage"],
  ["reconcile-live-query", "register the observed SYSTEM query entity"],
] as const;

const walkthroughEnv = {
  LINEAGEGUARD_WALKTHROUGH_ENV: "canonical",
  LINEAGEGUARD_SKIP_SERVER_IDENTITY: "1",
  LINEAGEGUARD_POSTGRES_MODE: "local",
} as const;

async function runStep(
  command: string,
  description: string,
  execute: boolean,
): Promise<CheckResult> {
  const args = ["run", "--project", "tools/datahub", "lineageguard-datahub", command];
  if (execute) args.push("--execute");
  if (command.startsWith("reconcile") && execute) {
    args.push("--confirm", process.env.LINEAGEGUARD_SCENARIO_ID ?? "canonical-customer-id-rename");
  }
  process.stdout.write(`  ${command.padEnd(22)} ${description}\n`);
  try {
    const { stdout } = await run("uv", args, {
      env: { ...process.env, ...walkthroughEnv },
      maxBuffer: 32 * 1024 * 1024,
    });
    const tail = stdout.trim().split("\n").at(-1) ?? "";
    return pass(command, tail.slice(0, 90) || (execute ? "executed" : "planned"));
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    // These exits indicate the entity already exists — success for our purposes.
    if (
      message.includes("LIVE_QUERY_RECONCILIATION_NOT_REQUIRED") ||
      message.includes("SCENARIO_RECONCILIATION_REQUIRED")
    ) {
      return pass(command, "already seeded (reconciliation state)");
    }
    return fail(command, message.split("\n").slice(0, 2).join(" ").slice(0, 140));
  }
}

/** Proves the four consumer groups are actually reachable, not merely that the tooling exited 0. */
async function verifyCanonicalGraph(): Promise<CheckResult[]> {
  const token = readToken();
  const results: CheckResult[] = [];
  const revenueUrn =
    "urn:li:dataset:(urn:li:dataPlatform:postgres,lineageguard-canonical.lineageguard.analytics.customer_revenue,PROD)";

  try {
    const response = await fetch(
      `${gmsUrl()}/relationships?direction=INCOMING&urn=${encodeURIComponent(revenueUrn)}&types=IsAssociatedWith`,
      { headers: { Authorization: `Bearer ${token}` }, signal: AbortSignal.timeout(10_000) },
    );
    results.push(
      response.ok
        ? pass("graph reachable", "GMS answered a relationship query")
        : fail("graph reachable", `HTTP ${String(response.status)}`),
    );
  } catch {
    results.push(fail("graph reachable", "GMS unreachable"));
  }

  try {
    const { stdout } = await run(
      "uv",
      ["run", "--project", "tools/datahub", "lineageguard-datahub", "verify"],
      { env: { ...process.env, ...walkthroughEnv }, maxBuffer: 32 * 1024 * 1024 },
    );
    // The verify command outputs JSON with "ok": true/false. Check for that first.
    const parsed = JSON.parse(stdout) as { ok?: boolean; failures?: unknown[] };
    const ok = parsed.ok === true && (!parsed.failures || parsed.failures.length === 0);
    results.push(
      ok
        ? pass("canonical graph", "verify reported no gaps")
        : fail(
            "canonical graph",
            stdout.trim().split("\n").at(-1)?.slice(0, 120) ?? "verify reported gaps",
          ),
    );
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    results.push(fail("canonical graph", message.split("\n").slice(0, 2).join(" ").slice(0, 140)));
  }
  return results;
}

async function main(): Promise<void> {
  if (wantsHelp()) {
    printUsage("demo:bootstrap", [
      "Seeds and verifies the canonical DataHub graph by orchestrating the Python",
      "tooling chain. Every step is idempotent, so a second run is a safe refresh.",
      "",
      "--plan  print each step's plan without mutating anything",
    ]);
    return;
  }

  const execute = !hasFlag("--plan");
  console.log(`=== demo:bootstrap${execute ? "" : " --plan"} ===\n`);

  // Fast path: if the graph is already complete, skip the seeding chain entirely.
  if (execute) {
    const earlyVerify = await verifyCanonicalGraph();
    if (earlyVerify.every((r) => r.ok)) {
      console.log("  Graph already verified complete; skipping seed chain.\n");
      const ok = reportMatrix("demo:bootstrap", earlyVerify);
      console.log(ok ? "\nbootstrap: READY\n" : "\nbootstrap: FAILED\n");
      process.exitCode = ok ? 0 : 1;
      return;
    }
  }

  const results: CheckResult[] = [];
  for (const [command, description] of chain) {
    const result = await runStep(command, description, execute);
    results.push(result);
    if (!result.ok) {
      console.log(`\n  ${command} failed; later steps depend on it, stopping.\n`);
      break;
    }
  }

  if (results.every((result) => result.ok) && execute) {
    results.push(...(await verifyCanonicalGraph()));
  }

  const ok = reportMatrix("demo:bootstrap", results);
  console.log(ok ? "\nbootstrap: READY\n" : "\nbootstrap: FAILED\n");
  process.exitCode = ok ? 0 : 1;
}

await main();
