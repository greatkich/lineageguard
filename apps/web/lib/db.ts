import { createSimpleRunStore, type SimpleRun } from "@lineageguard/db";
import pg from "pg";

const pool = new pg.Pool({
  connectionString:
    process.env.LINEAGEGUARD_DATABASE_URL ??
    "postgresql://lineageguard:lineageguard@127.0.0.1:5432/lineageguard",
  max: 3,
});

const store = createSimpleRunStore(pool);

export interface RunRow {
  id: string;
  status: string;
  repository: string;
  field: string;
  patch: string;
  baselineDecision: string | null;
  groundedDecision: string | null;
  consumersFound: number;
  evidenceItems: number;
  artifactsGenerated: number;
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
  createdAt: string;
  updatedAt: string;
}

function toRunRow(run: SimpleRun): RunRow {
  return {
    ...run,
    createdAt: run.createdAt?.toISOString() ?? "",
    updatedAt: run.updatedAt?.toISOString() ?? "",
  };
}

export async function fetchRuns(): Promise<RunRow[]> {
  const runs = await store.list(50);
  return runs.map(toRunRow);
}

export async function fetchRun(id: string): Promise<RunRow | null> {
  const run = await store.get(id);
  return run ? toRunRow(run) : null;
}
