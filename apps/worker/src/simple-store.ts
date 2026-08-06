/**
 * Lightweight run persistence for MVP.
 * Reads/writes directly to lineageguard.simple_runs table with full context
 * for evidence-backed Mission Control.
 */
import pg from "pg";

export interface SimpleRun {
  id: string;
  status: string;
  repository: string;
  field: string;
  baselineDecision: string | null;
  groundedDecision: string | null;
  consumersFound: number;
  evidenceItems: number;
  artifactsGenerated: number;
  patch: string;
  triggeredRules: string | null;
  prUrl: string | null;
  writebackStatus: string | null;
  validationReceiptFingerprint: string | null;
  githubReceiptFingerprint: string | null;
  writebackReceiptFingerprint: string | null;
  contextJson: unknown | null;
  candidateJson: unknown | null;
  comparisonJson: unknown | null;
  executionMode: string;
  sourcePrUrl: string | null;
  createdAt: Date;
  updatedAt: Date;
}

const POOL = new pg.Pool({
  connectionString:
    process.env.LINEAGEGUARD_DATABASE_URL ??
    "postgresql://lineageguard:lineageguard@127.0.0.1:5432/lineageguard",
  max: 5,
});

export async function ensureRunsTable(): Promise<void> {
  await POOL.query(`
    CREATE TABLE IF NOT EXISTS lineageguard.simple_runs (
      id TEXT PRIMARY KEY,
      status TEXT NOT NULL DEFAULT 'CREATED',
      repository TEXT NOT NULL,
      field TEXT NOT NULL,
      patch TEXT NOT NULL DEFAULT '',
      baseline_decision TEXT,
      grounded_decision TEXT,
      consumers_found INTEGER NOT NULL DEFAULT 0,
      evidence_items INTEGER NOT NULL DEFAULT 0,
      artifacts_generated INTEGER NOT NULL DEFAULT 0,
      triggered_rules TEXT,
      pr_url TEXT,
      writeback_status TEXT,
      validation_receipt_fingerprint TEXT,
      github_receipt_fingerprint TEXT,
      writeback_receipt_fingerprint TEXT,
      context_json JSONB,
      candidate_json JSONB,
      comparison_json JSONB,
      execution_mode TEXT NOT NULL DEFAULT 'LIVE',
      source_pr_url TEXT,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
    )
  `);
  // Add columns if table already exists from older schema (idempotent)
  await POOL.query(`
    DO $$ BEGIN
      ALTER TABLE lineageguard.simple_runs ADD COLUMN IF NOT EXISTS triggered_rules TEXT;
      ALTER TABLE lineageguard.simple_runs ADD COLUMN IF NOT EXISTS pr_url TEXT;
      ALTER TABLE lineageguard.simple_runs ADD COLUMN IF NOT EXISTS writeback_status TEXT;
      ALTER TABLE lineageguard.simple_runs ADD COLUMN IF NOT EXISTS evidence_items INTEGER DEFAULT 0;
      ALTER TABLE lineageguard.simple_runs ADD COLUMN IF NOT EXISTS validation_receipt_fingerprint TEXT;
      ALTER TABLE lineageguard.simple_runs ADD COLUMN IF NOT EXISTS github_receipt_fingerprint TEXT;
      ALTER TABLE lineageguard.simple_runs ADD COLUMN IF NOT EXISTS writeback_receipt_fingerprint TEXT;
      ALTER TABLE lineageguard.simple_runs ADD COLUMN IF NOT EXISTS context_json JSONB;
      ALTER TABLE lineageguard.simple_runs ADD COLUMN IF NOT EXISTS candidate_json JSONB;
      ALTER TABLE lineageguard.simple_runs ADD COLUMN IF NOT EXISTS comparison_json JSONB;
      ALTER TABLE lineageguard.simple_runs ADD COLUMN IF NOT EXISTS execution_mode TEXT DEFAULT 'LIVE';
      ALTER TABLE lineageguard.simple_runs ADD COLUMN IF NOT EXISTS source_pr_url TEXT;
    EXCEPTION WHEN OTHERS THEN NULL;
    END $$;
  `);
}

export async function createSimpleRun(input: {
  id: string;
  repository: string;
  field: string;
  patch: string;
}): Promise<SimpleRun> {
  await ensureRunsTable();
  const result = await POOL.query(
    `INSERT INTO lineageguard.simple_runs (id, repository, field, patch)
     VALUES ($1, $2, $3, $4)
     RETURNING *`,
    [input.id, input.repository, input.field, input.patch],
  );
  return mapRow(result.rows[0]);
}

export async function updateRunStatus(
  id: string,
  status: string,
  extra?: Partial<{
    baselineDecision: string;
    groundedDecision: string;
    consumersFound: number;
    evidenceItems: number;
    artifactsGenerated: number;
    triggeredRules: string[];
    prUrl: string;
    prNumber: number;
    writebackStatus: string;
    validationReceiptFingerprint: string;
    githubReceiptFingerprint: string;
    writebackReceiptFingerprint: string;
    contextJson: unknown;
    candidateJson: unknown;
    comparisonJson: unknown;
    sourcePrUrl: string;
    failedChecks: string[];
  }>,
): Promise<void> {
  const sets = ["status = $2", "updated_at = now()"];
  const values: unknown[] = [id, status];
  let idx = 3;

  if (extra?.baselineDecision !== undefined) {
    sets.push(`baseline_decision = $${idx++}`);
    values.push(extra.baselineDecision);
  }
  if (extra?.groundedDecision !== undefined) {
    sets.push(`grounded_decision = $${idx++}`);
    values.push(extra.groundedDecision);
  }
  if (extra?.consumersFound !== undefined) {
    sets.push(`consumers_found = $${idx++}`);
    values.push(extra.consumersFound);
  }
  if (extra?.evidenceItems !== undefined) {
    sets.push(`evidence_items = $${idx++}`);
    values.push(extra.evidenceItems);
  }
  if (extra?.artifactsGenerated !== undefined) {
    sets.push(`artifacts_generated = $${idx++}`);
    values.push(extra.artifactsGenerated);
  }
  if (extra?.triggeredRules !== undefined) {
    sets.push(`triggered_rules = $${idx++}`);
    values.push(extra.triggeredRules.join(","));
  }
  if (extra?.prUrl !== undefined) {
    sets.push(`pr_url = $${idx++}`);
    values.push(extra.prUrl);
  }
  if (extra?.writebackStatus !== undefined) {
    sets.push(`writeback_status = $${idx++}`);
    values.push(extra.writebackStatus);
  }
  if (extra?.validationReceiptFingerprint !== undefined) {
    sets.push(`validation_receipt_fingerprint = $${idx++}`);
    values.push(extra.validationReceiptFingerprint);
  }
  if (extra?.githubReceiptFingerprint !== undefined) {
    sets.push(`github_receipt_fingerprint = $${idx++}`);
    values.push(extra.githubReceiptFingerprint);
  }
  if (extra?.writebackReceiptFingerprint !== undefined) {
    sets.push(`writeback_receipt_fingerprint = $${idx++}`);
    values.push(extra.writebackReceiptFingerprint);
  }
  if (extra?.contextJson !== undefined) {
    sets.push(`context_json = $${idx++}`);
    values.push(JSON.stringify(extra.contextJson));
  }
  if (extra?.candidateJson !== undefined) {
    sets.push(`candidate_json = $${idx++}`);
    values.push(JSON.stringify(extra.candidateJson));
  }
  if (extra?.comparisonJson !== undefined) {
    sets.push(`comparison_json = $${idx++}`);
    values.push(JSON.stringify(extra.comparisonJson));
  }
  if (extra?.sourcePrUrl !== undefined) {
    sets.push(`source_pr_url = $${idx++}`);
    values.push(extra.sourcePrUrl);
  }

  await POOL.query(
    `UPDATE lineageguard.simple_runs SET ${sets.join(", ")} WHERE id = $1`,
    values,
  );
}

export async function listRuns(): Promise<SimpleRun[]> {
  await ensureRunsTable();
  const result = await POOL.query(
    "SELECT * FROM lineageguard.simple_runs ORDER BY created_at DESC LIMIT 50",
  );
  return result.rows.map(mapRow);
}

export async function getRun(id: string): Promise<SimpleRun | null> {
  await ensureRunsTable();
  const result = await POOL.query(
    "SELECT * FROM lineageguard.simple_runs WHERE id = $1",
    [id],
  );
  return result.rows[0] ? mapRow(result.rows[0]) : null;
}

function mapRow(row: any): SimpleRun {
  return {
    id: row.id,
    status: row.status,
    repository: row.repository,
    field: row.field,
    baselineDecision: row.baseline_decision,
    groundedDecision: row.grounded_decision,
    consumersFound: row.consumers_found ?? 0,
    evidenceItems: row.evidence_items ?? 0,
    artifactsGenerated: row.artifacts_generated ?? 0,
    patch: row.patch,
    triggeredRules: row.triggered_rules,
    prUrl: row.pr_url,
    writebackStatus: row.writeback_status,
    validationReceiptFingerprint: row.validation_receipt_fingerprint,
    githubReceiptFingerprint: row.github_receipt_fingerprint,
    writebackReceiptFingerprint: row.writeback_receipt_fingerprint,
    contextJson: row.context_json,
    candidateJson: row.candidate_json,
    comparisonJson: row.comparison_json,
    executionMode: row.execution_mode ?? "LIVE",
    sourcePrUrl: row.source_pr_url,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export async function closePool(): Promise<void> {
  await POOL.end();
}
