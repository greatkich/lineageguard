/**
 * demo:preflight — read-only verification that this machine can run the canonical demo.
 *
 * Mutates nothing. Prints a PASS/FAIL matrix and exits non-zero when any mandatory check fails, so
 * a red preflight stops a recording before it wastes a take.
 *
 * Usage: pnpm demo:preflight
 */
import { readFileSync } from "node:fs";
import { access, constants } from "node:fs/promises";
import { join } from "node:path";
import {
  type CheckResult,
  databaseUrl,
  expectedRepository,
  fail,
  gmsUrl,
  hasFlag,
  loadEnv,
  pass,
  printUsage,
  readToken,
  reportMatrix,
  run,
  sourcePrNumber,
  wantsHelp,
} from "./demo-support.js";

loadEnv();

/** Credentials the validation authorities must never inherit. Their presence is reported, not fatal. */
const orchestrationCredentials = [
  "DATAHUB_TOKEN",
  "DATAHUB_GMS_TOKEN",
  "GITHUB_TOKEN",
  "OPENAI_API_KEY",
] as const;

async function checkToolVersions(): Promise<CheckResult[]> {
  const results: CheckResult[] = [];
  const pinned = readFileSync(join(process.cwd(), ".node-version"), "utf8").trim();
  const node = process.versions.node;
  results.push(
    node.startsWith("24.")
      ? pass("node", `${node} (pinned ${pinned})`)
      : fail("node", `${node} — repository requires 24.x (pinned ${pinned})`),
  );

  for (const [name, command, args, expect] of [
    ["pnpm", "pnpm", ["--version"], /^11\.20\./],
    ["python", "uv", ["run", "--python", "3.12", "python", "--version"], /^Python 3\.12\./],
    ["uv", "uv", ["--version"], /^uv /],
  ] as const) {
    try {
      const { stdout } = await run(command, [...args]);
      const version = stdout.trim();
      results.push(
        expect.test(version) ? pass(name, version) : fail(name, `${version} — unexpected version`),
      );
    } catch {
      results.push(fail(name, "not available"));
    }
  }
  return results;
}

async function checkDocker(): Promise<CheckResult[]> {
  const results: CheckResult[] = [];
  try {
    const { stdout } = await run("docker", ["info", "--format", "{{.ServerVersion}}"]);
    results.push(pass("docker", `server ${stdout.trim()}`));
  } catch {
    return [fail("docker", "daemon unavailable")];
  }
  try {
    const { stdout } = await run("docker", ["compose", "version"]);
    results.push(pass("docker compose", stdout.trim()));
  } catch {
    results.push(fail("docker compose", "not available"));
  }

  for (const [label, variable] of [
    ["validator runner image", "LINEAGEGUARD_VALIDATION_RUNNER_IMAGE_ID"],
    ["validator postgres image", "LINEAGEGUARD_VALIDATION_POSTGRES_IMAGE_ID"],
  ] as const) {
    const imageId = process.env[variable];
    if (!imageId) {
      results.push(fail(label, `${variable} is not set`));
      continue;
    }
    try {
      await run("docker", ["image", "inspect", imageId, "--format", "{{.Id}}"]);
      results.push(pass(label, `${imageId.slice(0, 19)}… present`));
    } catch {
      results.push(fail(label, `${imageId.slice(0, 19)}… not present locally`));
    }
  }

  const dockerPath = process.env.LINEAGEGUARD_DOCKER_EXECUTABLE;
  if (!dockerPath) {
    results.push(fail("docker executable", "LINEAGEGUARD_DOCKER_EXECUTABLE is not set"));
  } else {
    try {
      await access(dockerPath, constants.X_OK);
      results.push(pass("docker executable", dockerPath));
    } catch {
      results.push(fail("docker executable", `${dockerPath} is not executable`));
    }
  }
  return results;
}

async function checkDataHub(): Promise<CheckResult[]> {
  const results: CheckResult[] = [];
  const base = gmsUrl();
  try {
    const response = await fetch(`${base}/config`, {
      signal: AbortSignal.timeout(5_000),
    });
    results.push(
      response.ok
        ? pass("datahub gms", `${base} healthy`)
        : fail("datahub gms", `${base} returned HTTP ${String(response.status)}`),
    );
  } catch {
    results.push(fail("datahub gms", `${base} unreachable`));
  }

  const read = readToken();
  const mutation = process.env.DATAHUB_MUTATION_TOKEN ?? "";
  results.push(
    read.length > 8
      ? pass("datahub read token", "configured")
      : fail("datahub read token", "absent"),
  );
  results.push(
    mutation.length > 8
      ? read === mutation
        ? fail("credential separation", "read and mutation tokens are identical")
        : pass("credential separation", "read and mutation tokens differ")
      : fail("datahub mutation token", "absent — write-back cannot run"),
  );
  return results;
}

async function checkGitHub(): Promise<CheckResult[]> {
  const results: CheckResult[] = [];
  const token = process.env.GITHUB_TOKEN ?? "";
  if (token.length < 8) return [fail("github token", "absent")];
  results.push(pass("github token", "configured"));

  const repository = expectedRepository();
  const prNumber = sourcePrNumber();
  if (prNumber === undefined) {
    results.push(fail("source pr", "SOURCE_PR_NUMBER is not set"));
    return results;
  }
  try {
    const response = await fetch(
      `https://api.github.com/repos/${repository}/pulls/${String(prNumber)}`,
      {
        headers: {
          Accept: "application/vnd.github+json",
          Authorization: `Bearer ${token}`,
          "X-GitHub-Api-Version": "2022-11-28",
        },
        signal: AbortSignal.timeout(10_000),
      },
    );
    if (!response.ok) {
      results.push(
        fail("source pr", `HTTP ${String(response.status)} for ${repository}#${String(prNumber)}`),
      );
      return results;
    }
    const pr = (await response.json()) as { state: string; merged?: boolean; html_url: string };
    const state = pr.merged === true ? "merged" : pr.state;
    results.push(
      state === "open"
        ? pass("source pr", `${repository}#${String(prNumber)} open`)
        : fail("source pr", `${repository}#${String(prNumber)} is ${state} — it must stay open`),
    );
  } catch {
    results.push(fail("source pr", "GitHub API unreachable"));
  }
  return results;
}

async function checkDatabase(): Promise<CheckResult[]> {
  try {
    const pg = (await import("pg")).default;
    const pool = new pg.Pool({ connectionString: databaseUrl(), connectionTimeoutMillis: 5_000 });
    try {
      const { rows } = await pool.query<{ version: string }>("select version() as version");
      return [pass("postgres", (rows[0]?.version ?? "connected").slice(0, 40))];
    } finally {
      await pool.end();
    }
  } catch {
    return [fail("postgres", `${databaseUrl().replace(/:[^:@/]*@/, ":***@")} unreachable`)];
  }
}

function checkEnvironmentHygiene(): CheckResult[] {
  const results: CheckResult[] = [];
  const present = orchestrationCredentials.filter((name) => process.env[name]);
  // Not a failure: the authority runtimes project an allowlisted environment, so a
  // credential-bearing shell is supported. Reported so a leak into a validator is diagnosable.
  results.push(
    pass(
      "credential isolation",
      present.length === 0
        ? "no orchestration credentials in this shell"
        : `${present.join(", ")} present; authority runtimes project them away`,
      false,
    ),
  );
  for (const flag of ["LINEAGEGUARD_SKIP_VALIDATION", "LINEAGEGUARD_SKIP_WRITEBACK"]) {
    results.push(
      process.env[flag]
        ? fail("skip flags", `${flag} is set — the demo would not be authoritative`)
        : pass("skip flags", `${flag} unset`, false),
    );
  }
  return results;
}

async function checkEvidenceDirectory(): Promise<CheckResult[]> {
  for (const directory of ["artifacts", "examples/canonical-run"]) {
    try {
      await access(join(process.cwd(), directory), constants.W_OK);
    } catch {
      return [fail("evidence directory", `${directory} is not writable`)];
    }
  }
  return [pass("evidence directory", "artifacts/ and examples/canonical-run/ writable")];
}

async function main(): Promise<void> {
  if (wantsHelp()) {
    printUsage("demo:preflight", [
      "Read-only. Verifies tool versions, Docker and validator images, DataHub,",
      "credential separation, GitHub access, source PR #3, PostgreSQL, and",
      "evidence directories. Exits non-zero on any mandatory failure.",
      "",
      "--quiet  print only the final verdict",
    ]);
    return;
  }

  const results = [
    ...(await checkToolVersions()),
    ...(await checkDocker()),
    ...(await checkDataHub()),
    ...(await checkGitHub()),
    ...(await checkDatabase()),
    ...checkEnvironmentHygiene(),
    ...(await checkEvidenceDirectory()),
  ];

  const ok = hasFlag("--quiet")
    ? results.every((result) => result.ok || !result.mandatory)
    : reportMatrix("demo:preflight", results);

  console.log(ok ? "\npreflight: READY\n" : "\npreflight: NOT READY\n");
  process.exitCode = ok ? 0 : 1;
}

await main();
