import pg from "pg";

const pool = new pg.Pool({
  connectionString:
    process.env.LINEAGEGUARD_DATABASE_URL ??
    "postgresql://lineageguard:lineageguard@127.0.0.1:5432/lineageguard",
  max: 3,
});

export interface RunRow {
  id: string;
  status: string;
  repository: string;
  field: string;
  patch: string;
  baselineDecision: string | null;
  groundedDecision: string | null;
  consumersFound: number;
  artifactsGenerated: number;
  triggeredRules: string | null;
  prUrl: string | null;
  writebackStatus: string | null;
  createdAt: string;
  updatedAt: string;
}

function mapRow(row: any): RunRow {
  return {
    id: row.id,
    status: row.status,
    repository: row.repository,
    field: row.field,
    patch: row.patch ?? "",
    baselineDecision: row.baseline_decision,
    groundedDecision: row.grounded_decision,
    consumersFound: row.consumers_found ?? 0,
    artifactsGenerated: row.artifacts_generated ?? 0,
    triggeredRules: row.triggered_rules ?? null,
    prUrl: row.pr_url ?? null,
    writebackStatus: row.writeback_status ?? null,
    createdAt: row.created_at?.toISOString() ?? "",
    updatedAt: row.updated_at?.toISOString() ?? "",
  };
}

export async function fetchRuns(): Promise<RunRow[]> {
  const result = await pool.query(
    "SELECT * FROM lineageguard.simple_runs ORDER BY created_at DESC LIMIT 50",
  );
  return result.rows.map(mapRow);
}

export async function fetchRun(id: string): Promise<RunRow | null> {
  const result = await pool.query(
    "SELECT * FROM lineageguard.simple_runs WHERE id = $1",
    [id],
  );
  return result.rows[0] ? mapRow(result.rows[0]) : null;
}
