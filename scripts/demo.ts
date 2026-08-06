/**
 * LineageGuard Demo Script
 *
 * Creates a canonical run and executes it through the same worker path
 * used by the product. No separate adapters — uses orchestration.ts directly.
 *
 * Usage: pnpm demo
 *
 * Exit codes:
 *   0 — run completed successfully (COMPLETED)
 *   1 — run failed (any FAILED_* status or error)
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
  console.log(`Base SHA:    ${process.env.LINEAGEGUARD_BASE_SHA ? "✓ set" : "✗ not set"}`);
  console.log(`Head SHA:    ${process.env.LINEAGEGUARD_HEAD_SHA ? "✓ set" : "✗ not set"}`);
  console.log("");

  // Import and run the worker in --once mode
  const { runWorker } = await import("../apps/worker/src/index.js");

  const result = await runWorker({ once: true, workerId: "demo" });

  if (!result || result.finalStatus !== "COMPLETED") {
    const status = result?.finalStatus ?? "UNKNOWN";
    console.error(`\n=== Demo FAILED: ${status} ===`);
    console.error("The pipeline did not reach COMPLETED status.");
    if (result) {
      console.error(`  Baseline: ${result.baselineDecision}`);
      console.error(`  Grounded: ${result.groundedDecision}`);
      console.error(`  Consumers: ${result.consumersFound}`);
      console.error(`  Validation: ${result.validationPassed ? "PASS" : "FAIL"}`);
      console.error(`  PR: ${result.prUrl ?? "none"}`);
      console.error(`  Writeback: ${result.writebackStatus ?? "none"}`);
    }
    process.exit(1);
  }

  console.log("\n=== Demo Complete ===");
  console.log(`  Status: ${result.finalStatus}`);
  console.log(`  Decision: ${result.baselineDecision} → ${result.groundedDecision}`);
  console.log(`  Consumers protected: ${result.consumersFound}`);
  console.log(`  Artifacts generated: ${result.artifactsGenerated}`);
  console.log(`  Validation: ${result.validationPassed ? "ALL PASS" : "FAILED"}`);
  console.log(`  PR: ${result.prUrl ?? "none"}`);
  console.log(`  Writeback: ${result.writebackStatus ?? "none"}`);
  process.exit(0);
}

main().catch((err) => {
  console.error("Demo failed:", err.message ?? err);
  process.exit(1);
});
