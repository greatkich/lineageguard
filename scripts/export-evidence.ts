/**
 * Exports reviewer-readable evidence from one COMPLETED run.
 * Usage: pnpm export-evidence <run-id>
 */
import { createHash } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { createSimpleRunStore, type SimpleRun } from "@lineageguard/db";
import {
  assertExactlyFourConsumers,
  deriveImpactConsumers,
  impactContextSchema,
} from "@lineageguard/domain";
import pg from "pg";
import {
  type AcceptanceCodeStateReader,
  goldenEvidenceRoots,
  withAcceptanceCodeState,
} from "./acceptance-code-state.js";

interface ExportFacts {
  applicationCodeSha: string;
  changeFingerprint: string;
  impactContextFingerprint: string;
  candidateFingerprint: string;
  comparisonFingerprint: string;
  impactConsumers: number;
  exportedAt: string;
}

interface ExportPaths {
  examplesDir: string;
  artifactsDir: string;
}

function fingerprintOf(value: unknown): string {
  if (value === null || value === undefined) return "";
  return `sha256:${createHash("sha256").update(JSON.stringify(value)).digest("hex")}`;
}

function writeJson(path: string, value: unknown): void {
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`);
}

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

function buildExportFacts(run: SimpleRun, applicationCodeSha: string): ExportFacts {
  return {
    applicationCodeSha,
    changeFingerprint: run.sourceDiffFingerprint ?? "",
    impactContextFingerprint: fingerprintOf(run.contextJson),
    candidateFingerprint: fingerprintOf(run.candidateJson),
    comparisonFingerprint: fingerprintOf(run.comparisonJson),
    impactConsumers: derivedConsumerCount(run.contextJson, run.consumersFound),
    exportedAt: new Date().toISOString(),
  };
}

function canonicalManifest(run: SimpleRun, facts: ExportFacts): unknown {
  return {
    schemaVersion: 1,
    scenario: "canonical-customer-id-rename",
    description: "ALTER TABLE commerce.orders RENAME COLUMN customer_id TO buyer_id",
    executionMode: run.executionMode,
    runId: run.id,
    applicationCodeSha: facts.applicationCodeSha,
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
      change: facts.changeFingerprint || "UNAVAILABLE",
      impactContext: facts.impactContextFingerprint || "UNAVAILABLE",
      candidate: facts.candidateFingerprint || "UNAVAILABLE",
      comparison: facts.comparisonFingerprint || "UNAVAILABLE",
      validation: run.validationReceiptFingerprint ?? "UNAVAILABLE",
      github: run.githubReceiptFingerprint ?? "UNAVAILABLE",
      writeback: run.writebackReceiptFingerprint ?? "UNAVAILABLE",
    },
    expectedOutcome: outcomeSummary(run, facts),
    createdAt: run.createdAt,
    exportedAt: facts.exportedAt,
  };
}

function outcomeSummary(run: SimpleRun, facts: ExportFacts): unknown {
  return {
    baselineDecision: run.baselineDecision,
    groundedDecision: run.groundedDecision,
    impactConsumers: facts.impactConsumers,
    triggeredRules: (run.triggeredRules ?? "").split(",").filter(Boolean),
    generatedArtifacts: run.artifactsGenerated,
    validationReceiptFingerprint: run.validationReceiptFingerprint,
    prUrl: run.prUrl,
    githubEffectOutcome: run.githubEffectOutcome,
    writebackStatus: run.writebackStatus,
    writebackReceiptFingerprint: run.writebackReceiptFingerprint,
  };
}

function replayManifest(run: SimpleRun, facts: ExportFacts): unknown {
  return {
    sourceRunId: run.id,
    applicationCodeSha: facts.applicationCodeSha,
    sourceCommitSha: run.sourceHeadSha,
    sourceChangeFingerprint: facts.changeFingerprint,
    impactContextFingerprint: facts.impactContextFingerprint,
    riskComparisonFingerprint: facts.comparisonFingerprint,
    candidateFingerprint: facts.candidateFingerprint,
    validationReceiptFingerprint: run.validationReceiptFingerprint,
    githubReceiptFingerprint: run.githubReceiptFingerprint,
    githubEffectOutcome: run.githubEffectOutcome,
    writebackReceiptFingerprint: run.writebackReceiptFingerprint,
    exportedAt: facts.exportedAt,
  };
}

function runSummary(run: SimpleRun, facts: ExportFacts): unknown {
  return {
    schemaVersion: 2,
    runId: run.id,
    executionMode: run.executionMode,
    status: run.status,
    applicationCodeSha: facts.applicationCodeSha,
    codeCommitSha: facts.applicationCodeSha,
    generatedAt: facts.exportedAt,
    note:
      "Generated by pnpm export-evidence from the persisted LIVE run named above. Every value " +
      "below is read from that run's row; none is hand-written.",
    outcome: outcomeSummary(run, facts),
    source: {
      prUrl: run.sourcePrUrl,
      prNumber: run.sourcePrNumber,
      baseSha: run.sourceBaseSha,
      headSha: run.sourceHeadSha,
      diffFingerprint: run.sourceDiffFingerprint,
      filePath: run.sourceFilePath,
    },
    verification: {
      command: `pnpm demo:verify -- --runId ${run.id}`,
      note: "demo:verify re-reads GitHub and DataHub; it does not trust these values.",
    },
  };
}

function writePayloadArtifacts(run: SimpleRun, paths: ExportPaths): void {
  if (run.contextJson !== null) {
    writeJson(join(paths.examplesDir, "impact-context.json"), run.contextJson);
    writeJson(join(paths.artifactsDir, "datahub-impact-context.json"), run.contextJson);
  }
  if (run.comparisonJson !== null) {
    writeJson(join(paths.examplesDir, "risk-comparison.json"), run.comparisonJson);
    writeJson(join(paths.artifactsDir, "risk-comparison.json"), run.comparisonJson);
  }
  if (run.candidateJson !== null) {
    writeJson(join(paths.examplesDir, "migration-candidate.json"), run.candidateJson);
    writeJson(join(paths.artifactsDir, "migration-candidate.json"), run.candidateJson);
  }
}

function writeEnvironment(run: SimpleRun, facts: ExportFacts, artifactsDir: string): void {
  writeFileSync(join(artifactsDir, "commit-sha.txt"), `${facts.applicationCodeSha}\n`);
  writeFileSync(
    join(artifactsDir, "environment.txt"),
    [
      `node ${process.version}`,
      `platform ${process.platform}`,
      `runId ${run.id}`,
      `applicationCodeSha ${facts.applicationCodeSha}`,
      `codeCommitSha ${facts.applicationCodeSha}`,
      `exportedAt ${facts.exportedAt}`,
      "",
    ].join("\n"),
  );
}

function exportEvidenceFiles(run: SimpleRun, applicationCodeSha: string): ExportPaths {
  const paths = {
    examplesDir: join(process.cwd(), "examples/canonical-run"),
    artifactsDir: join(process.cwd(), "artifacts/demo-readiness"),
  };
  mkdirSync(paths.examplesDir, { recursive: true });
  mkdirSync(paths.artifactsDir, { recursive: true });
  const facts = buildExportFacts(run, applicationCodeSha);
  writeJson(join(paths.examplesDir, "manifest.json"), canonicalManifest(run, facts));
  writePayloadArtifacts(run, paths);
  writeJson(join(paths.artifactsDir, "replay-manifest.json"), replayManifest(run, facts));
  writeJson(join(paths.artifactsDir, "run-summary.json"), runSummary(run, facts));
  writeEnvironment(run, facts, paths.artifactsDir);
  return paths;
}

export async function exportEvidenceWithCodeState<T>(options: {
  applicationCodeSha: string;
  readState?: AcceptanceCodeStateReader;
  writeEvidence: (applicationCodeSha: string) => T | Promise<T>;
}): Promise<T> {
  const guarded = await withAcceptanceCodeState({
    expectedApplicationCodeSha: options.applicationCodeSha,
    allowedDirtyPathsAtStart: goldenEvidenceRoots,
    allowedDirtyPathsAfterAction: goldenEvidenceRoots,
    ...(options.readState ? { readState: options.readState } : {}),
    action: async (accepted) => options.writeEvidence(accepted.applicationCodeSha),
  });
  return guarded.value;
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
  try {
    const run = await createSimpleRunStore(pool).get(runId);
    if (!run) throw new Error(`Run ${runId} not found`);
    if (run.status !== "COMPLETED") {
      throw new Error(`Run ${runId} status is ${run.status}, not COMPLETED — refusing to export`);
    }
    const paths = await exportEvidenceWithCodeState({
      applicationCodeSha: run.applicationCodeSha ?? "",
      writeEvidence: async (applicationCodeSha) => exportEvidenceFiles(run, applicationCodeSha),
    });
    console.log(`Evidence exported successfully for run: ${runId}`);
    console.log(`  -> ${paths.examplesDir}`);
    console.log(`  -> ${paths.artifactsDir}`);
  } finally {
    await pool.end();
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error: unknown) => {
    console.error(error);
    process.exitCode = 1;
  });
}
