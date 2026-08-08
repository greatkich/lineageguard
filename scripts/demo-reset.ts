/**
 * demo:reset — remove LineageGuard-owned demo state only.
 *
 * Every deletion is scoped by an explicit ownership marker and reported. Unrelated GitHub branches,
 * unrelated DataHub metadata, and unrelated containers are never touched: a reset that could damage
 * neighbouring state is worse than no reset at all.
 *
 * Usage: pnpm demo:reset            fast — clears run records and demo containers
 *        pnpm demo:reset -- --clean  also closes generated PRs and deletes generated branches
 */
import {
  databaseUrl,
  expectedRepository,
  hasFlag,
  loadEnv,
  printUsage,
  run,
  wantsHelp,
} from "./demo-support.js";

loadEnv();

/** Only branches under this prefix are ever deleted. */
const generatedBranchPrefix = "lineageguard/generated/";
/** Only containers named with this prefix are ever removed. */
const demoContainerPrefix = "lineageguard";

async function clearRunRecords(): Promise<number> {
  const pg = (await import("pg")).default;
  const pool = new pg.Pool({ connectionString: databaseUrl() });
  try {
    const { rowCount } = await pool.query("delete from lineageguard.simple_runs");
    return rowCount ?? 0;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (message.includes("does not exist")) return 0;
    throw error;
  } finally {
    await pool.end();
  }
}

async function removeDemoContainers(): Promise<string[]> {
  try {
    const { stdout } = await run("docker", ["ps", "-a", "--format", "{{.Names}}"]);
    const owned = stdout
      .split("\n")
      .map((name) => name.trim())
      .filter((name) => name.startsWith(demoContainerPrefix) && name.includes("validation"));
    for (const name of owned) {
      await run("docker", ["rm", "-f", name]).catch(() => undefined);
    }
    return owned;
  } catch {
    return [];
  }
}

async function closeGeneratedPullRequests(): Promise<string[]> {
  const token = process.env.GITHUB_TOKEN ?? "";
  if (token.length < 8) return [];
  const repository = expectedRepository();
  const headers = {
    Accept: "application/vnd.github+json",
    Authorization: `Bearer ${token}`,
    "Content-Type": "application/json",
    "X-GitHub-Api-Version": "2022-11-28",
  };
  const closed: string[] = [];

  const listed = await fetch(
    `https://api.github.com/repos/${repository}/pulls?state=open&per_page=100`,
    { headers, signal: AbortSignal.timeout(15_000) },
  );
  if (!listed.ok) return closed;
  const pulls = (await listed.json()) as Array<{
    number: number;
    head: { ref: string };
    html_url: string;
  }>;

  for (const pull of pulls) {
    // Ownership marker: only our content-addressed generated branches.
    if (!pull.head.ref.startsWith(generatedBranchPrefix)) continue;
    await fetch(`https://api.github.com/repos/${repository}/pulls/${String(pull.number)}`, {
      method: "PATCH",
      headers,
      body: JSON.stringify({ state: "closed" }),
      signal: AbortSignal.timeout(15_000),
    });
    await fetch(
      `https://api.github.com/repos/${repository}/git/refs/heads/${encodeURIComponent(pull.head.ref)}`,
      { method: "DELETE", headers, signal: AbortSignal.timeout(15_000) },
    );
    closed.push(`${pull.html_url} (${pull.head.ref})`);
  }
  return closed;
}

async function main(): Promise<void> {
  if (wantsHelp()) {
    printUsage("demo:reset", [
      "Fast reset clears run records and removes demo validation containers.",
      "--clean additionally closes generated draft PRs and deletes their branches.",
      "",
      "Only state carrying a LineageGuard ownership marker is removed. Source PR #3,",
      "unrelated branches, and unrelated DataHub metadata are never touched.",
    ]);
    return;
  }

  const clean = hasFlag("--clean");
  console.log(`=== demo:reset${clean ? " --clean" : " (fast)"} ===\n`);

  const cleared = await clearRunRecords();
  console.log(`run records removed:      ${String(cleared)}`);

  const containers = await removeDemoContainers();
  console.log(`demo containers removed:  ${String(containers.length)}`);
  for (const name of containers) console.log(`  - ${name}`);

  if (clean) {
    const closed = await closeGeneratedPullRequests();
    console.log(`generated PRs closed:     ${String(closed.length)}`);
    for (const entry of closed) console.log(`  - ${entry}`);
    console.log("\nsource PR #3 and every branch outside");
    console.log(`${generatedBranchPrefix}* were left untouched.`);
  } else {
    console.log("\ncanonical DataHub graph and generated PRs preserved (use --clean to remove).");
  }

  console.log("\nreset: DONE\n");
}

await main();
