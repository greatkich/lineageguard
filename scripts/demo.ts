/**
 * LineageGuard Demo Script
 *
 * Creates a canonical run and executes it through the same worker path
 * used by the product. No separate adapters — uses orchestration.ts directly.
 *
 * Usage: pnpm demo
 */
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

// Load .env file manually (no dotenv dependency)
function loadEnv() {
  try {
    const envPath = resolve(import.meta.dirname ?? ".", "..", ".env");
    const content = readFileSync(envPath, "utf8");
    for (const line of content.split("\n")) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith("#")) continue;
      const eqIdx = trimmed.indexOf("=");
      if (eqIdx === -1) continue;
      const key = trimmed.slice(0, eqIdx);
      const value = trimmed.slice(eqIdx + 1);
      if (!process.env[key]) process.env[key] = value;
    }
  } catch {}
}
loadEnv();

async function main() {
  console.log("=== LineageGuard Demo ===\n");
  console.log("Using the same worker path as production (no separate adapters).\n");

  console.log(`DataHub:     ${process.env.DATAHUB_GMS_URL ?? "http://127.0.0.1:8080"}`);
  console.log(`Token:       ${(process.env.DATAHUB_READ_TOKEN ?? process.env.DATAHUB_TOKEN ?? "").length > 8 ? "✓ configured" : "✗ not configured"}`);
  console.log(`GitHub:      ${process.env.GITHUB_TOKEN ? "✓ configured" : "✗ not configured"}`);
  console.log(`Writeback:   ${process.env.DATAHUB_MUTATION_TOKEN ? "✓ configured" : "✗ not configured"}`);
  console.log(`Validation:  ${process.env.VALIDATION_ENABLED !== "false" ? "✓ enabled" : "✗ disabled"}`);
  console.log("");

  // Import and run the worker in --once mode
  const { runWorker } = await import("../apps/worker/src/index.js");

  await runWorker({ once: true, workerId: "demo" });

  console.log("\n=== Demo Complete ===");
}

main().catch((err) => {
  console.error("Demo failed:", err);
  process.exit(1);
});
