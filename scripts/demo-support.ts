/**
 * Shared plumbing for the demo lifecycle commands: environment loading, a PASS/FAIL matrix printer,
 * and the run-store connection every command needs.
 *
 * Kept separate so each demo:* entrypoint stays small and states only its own policy.
 */
import { execFile } from "node:child_process";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { promisify } from "node:util";

export const run = promisify(execFile);

/** Loads .env without adding a dependency. Existing environment always wins. */
export function loadEnv(): void {
  try {
    const envPath = resolve(import.meta.dirname ?? ".", "..", ".env");
    for (const line of readFileSync(envPath, "utf8").split("\n")) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith("#")) continue;
      const eq = trimmed.indexOf("=");
      if (eq === -1) continue;
      const key = trimmed.slice(0, eq);
      if (!process.env[key]) process.env[key] = trimmed.slice(eq + 1);
    }
  } catch {
    // A missing .env is normal; every value has an explicit default or is reported as absent.
  }
}

export type CheckResult = Readonly<{
  name: string;
  ok: boolean;
  detail: string;
  mandatory: boolean;
}>;

export function pass(name: string, detail: string, mandatory = true): CheckResult {
  return { name, ok: true, detail, mandatory };
}

export function fail(name: string, detail: string, mandatory = true): CheckResult {
  return { name, ok: false, detail, mandatory };
}

/** Prints an aligned PASS/FAIL matrix and returns true when every mandatory check passed. */
export function reportMatrix(title: string, results: readonly CheckResult[]): boolean {
  const width = Math.max(...results.map((result) => result.name.length));
  console.log(`\n=== ${title} ===\n`);
  for (const result of results) {
    const status = result.ok ? "PASS" : result.mandatory ? "FAIL" : "WARN";
    console.log(`${result.name.padEnd(width)}  ${status.padEnd(4)}  ${result.detail}`);
  }
  const blocking = results.filter((result) => !result.ok && result.mandatory);
  console.log(
    `\n${String(results.filter((r) => r.ok).length)}/${String(results.length)} checks passed` +
      (blocking.length > 0 ? `, ${String(blocking.length)} blocking` : ""),
  );
  return blocking.length === 0;
}

export function databaseUrl(): string {
  return (
    process.env.LINEAGEGUARD_DATABASE_URL ??
    "postgresql://lineageguard:lineageguard@127.0.0.1:5432/lineageguard"
  );
}

export function gmsUrl(): string {
  return process.env.DATAHUB_GMS_URL ?? "http://127.0.0.1:8080";
}

export function readToken(): string {
  return process.env.DATAHUB_READ_TOKEN ?? process.env.DATAHUB_TOKEN ?? "";
}

export function sourcePrNumber(): number | undefined {
  const raw = process.env.SOURCE_PR_NUMBER;
  if (!raw) return undefined;
  const parsed = Number.parseInt(raw, 10);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : undefined;
}

export function expectedRepository(): string {
  return process.env.LINEAGEGUARD_REPOSITORY ?? "greatkich/lineageguard";
}

/** Opens the run store, runs the body, and always closes the pool. */
export async function withRunStore<T>(
  body: (store: Awaited<ReturnType<typeof openRunStore>>["store"]) => Promise<T>,
): Promise<T> {
  const opened = await openRunStore();
  try {
    return await body(opened.store);
  } finally {
    await opened.close();
  }
}

async function openRunStore() {
  const { createSimpleRunStore } = await import("@lineageguard/db");
  const pg = (await import("pg")).default;
  const pool = new pg.Pool({ connectionString: databaseUrl() });
  const store = createSimpleRunStore(pool);
  await store.ensureSchema();
  return { store, close: async () => void (await pool.end()) };
}

export function printUsage(command: string, lines: readonly string[]): void {
  console.log(`Usage: pnpm ${command}\n`);
  for (const line of lines) console.log(`  ${line}`);
}

export function wantsHelp(): boolean {
  return process.argv.slice(2).some((argument) => argument === "--help" || argument === "-h");
}

export function argValue(flag: string): string | undefined {
  const argv = process.argv.slice(2);
  const inline = argv.find((argument) => argument.startsWith(`${flag}=`));
  if (inline) return inline.slice(flag.length + 1);
  const index = argv.indexOf(flag);
  return index >= 0 ? argv[index + 1] : undefined;
}

export function hasFlag(flag: string): boolean {
  return process.argv.slice(2).includes(flag);
}
