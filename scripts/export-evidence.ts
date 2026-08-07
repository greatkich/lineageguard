/**
 * Evidence export script — populates examples/canonical-run/ and
 * artifacts/demo-readiness/ from a COMPLETED run in the database.
 *
 * Run only AFTER a successful `pnpm demo`. Reads the persisted run record
 * and writes its evidence to disk for reviewer inspection and replay.
 *
 * Usage: pnpm export-evidence <run-id>
 */
import { createHash } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { createSimpleRunStore } from "@lineageguard/db";
import {
  assertExactlyFourConsumers,
  deriveImpactConsumers,
  impactContextSchema,
} from "@lineageguard/domain";
import pg from "pg";

function fingerprintOf(value: unknown): string {
  if (value === null || value === undefined) return "";
  return `sha256:${createHash("sha256").update(JSON.stringify(value)).digest("hex")}`;
}

function writeJson(path: string, value: unknown): void {
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`);
}

/**
 * Re-derives the consumer count from the persisted context instead of trusting the run's stored
 * scalar, and refuses to export when the two disagree. A stale or wrong column must never become
 * golden evidence that reviewers read as verified.
 */
function derivedConsumerCount(contextJson: unknown, persisted: number): number {
  if (contextJson === null || contextJson === undefined) {
    throw new Error(
      "EVIDENCE_EXPORT_BLOCKED: run has no persisted impact context to re-derive from",
    );
  }
  const parsed = impactContextSchema.safeParse(contextJson);
  if (!parsed.success) {
    throw new Error("EVIDENCE_EXPORT_BLOCKED: persisted impact context failed schema validation");
  }
  const consumers = deriveImpactConsumers(parsed.data);
  assertExactlyFourConsumers(consumers);
  if (consumers.length !== persisted) {
    throw new Error(
      `EVIDENCE_EXPORT_BLOCKED: persisted consumersFound=${String(persisted)} disagrees with derived=${String(consumers.length)}`,
    );
  }
  return consumers.length;
}

async function main(): Promise<void> {
  const runId = process.argv[2];
  if (!runId) {
    console.error("Usage: pnpm export-evidence <run-id>");
    process.exitCode = 1;
    return;
  }

  const pool = new pg.Pool({
    connectionString:
      process.env.LINEAGEGUARD_DATABASE_URL ??
      "postgresql://lineageguard:lineageguard@127.0.0.1:5432/lineageguard",
    max: 2,
  });
  const store = createSimpleRunStore(pool);

  try {
    const run = await store.get(runId);
    if (!run) {
      console.error(`Run ${runId} not found`);
      process.exitCode = 1;
      return;
    }
    if (run.status !== "COMPLETED") {
      console.error(`Run ${runId} status is ${run.status}, not COMPLETED — refusing to export`);
      process.exitCode = 1;
      return;
    }

    const examplesDir = join(process.cwd(), "examples/canonical-run");
    const artifactsDir = join(process.cwd(), "artifacts/demo-readiness");
    mkdirSync(examplesDir, { recursive: true });
    mkdirSync(artifactsDir, { recursive: true });

    const changeFingerprint = run.sourceDiffFingerprint ?? "";
    const impactContextFingerprint = fingerprintOf(run.contextJson);
    const candidateFingerprint = fingerprintOf(run.candidateJson);
    const comparisonFingerprint = fingerprintOf(run.comparisonJson);

    // The exported consumer count is re-derived from the persisted context rather than copied from
    // the run's stored scalar, so a stale or wrong column can never become golden evidence.
    const impactConsumers = derivedConsumerCount(run.contextJson, run.consumersFound);

    const manifest = {
      schemaVersion: 1,
      scenario: "canonical-customer-id-rename",
      description: "ALTER TABLE commerce.orders RENAME COLUMN customer_id TO buyer_id",
      executionMode: run.executionMode,
      runId: run.id,
      status: run.status,
      repository: run.repository,
      source: {
        prUrl: run.sourcePrUrl,
        prNumber: run.sourcePrNumber,
        baseSha: run.sourceBaseSha,
        headSha: run.sourceHeadSha,
        diffFingerprint: run.sourceDiffFingerprint,
        filePath: run.sourceFilePath,
      },
      fingerprints: {
        change: changeFingerprint || "UNAVAILABLE",
        impactContext: impactContextFingerprint || "UNAVAILABLE",
        candidate: candidateFingerprint || "UNAVAILABLE",
        comparison: comparisonFingerprint || "UNAVAILABLE",
        validation: run.validationReceiptFingerprint ?? "UNAVAILABLE",
        github: run.githubReceiptFingerprint ?? "UNAVAILABLE",
        writeback: run.writebackReceiptFingerprint ?? "UNAVAILABLE",
      },
      expectedOutcome: {
        baselineDecision: run.baselineDecision,
        groundedDecision: run.groundedDecision,
        impactConsumers,
        triggeredRules: (run.triggeredRules ?? "").split(",").filter(Boolean),
        generatedArtifacts: run.artifactsGenerated,
        prUrl: run.prUrl,
        writebackStatus: run.writebackStatus,
      },
      createdAt: run.createdAt,
      exportedAt: new Date().toISOString(),
    };

    writeJson(join(examplesDir, "manifest.json"), manifest);

    if (run.contextJson !== null) {
      writeJson(join(examplesDir, "impact-context.json"), run.contextJson);
      writeJson(join(artifactsDir, "datahub-impact-context.json"), run.contextJson);
    }
    if (run.comparisonJson !== null) {
      writeJson(join(examplesDir, "risk-comparison.json"), run.comparisonJson);
      writeJson(join(artifactsDir, "risk-comparison.json"), run.comparisonJson);
    }
    if (run.candidateJson !== null) {
      writeJson(join(examplesDir, "migration-candidate.json"), run.candidateJson);
      writeJson(join(artifactsDir, "migration-candidate.json"), run.candidateJson);
    }

    const replayManifest = {
      sourceRunId: run.id,
      sourceCommitSha: run.sourceHeadSha,
      sourceChangeFingerprint: changeFingerprint,
      impactContextFingerprint,
      riskComparisonFingerprint: comparisonFingerprint,
      candidateFingerprint,
      validationReceiptFingerprint: run.validationReceiptFingerprint,
      githubReceiptFingerprint: run.githubReceiptFingerprint,
      writebackReceiptFingerprint: run.writebackReceiptFingerprint,
      exportedAt: new Date().toISOString(),
    };
    writeJson(join(artifactsDir, "replay-manifest.json"), replayManifest);

    console.log(`Evidence exported successfully for run: ${runId}`);
    console.log(`  -> ${examplesDir}`);
    console.log(`  -> ${artifactsDir}`);
  } finally {
    await pool.end();
  }
}

main().catch((err: unknown) => {
  console.error(err);
  process.exitCode = 1;
});
