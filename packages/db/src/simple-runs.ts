import type pg from "pg";

// ─── Types ──────────────────────────────────────────────────────────────────

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
  /**
   * The full validation receipt: every executed check with its status, plus the artifact
   * observations the validator recorded. Persisted so acceptance can re-inspect the eight
   * canonical checks instead of trusting a bare fingerprint.
   */
  validationReceiptJson: unknown | null;
  /** The commit the generated PR was published at, so acceptance can detect later tampering. */
  githubHeadSha: string | null;
  /** The content-addressed branch the generated PR was published onto. */
  githubHeadBranch: string | null;
  /** The base commit the generated commit was parented on. */
  githubBaseSha: string | null;
  executionMode: string;
  sourcePrUrl: string | null;
  sourcePrNumber: number | null;
  sourceBaseSha: string | null;
  sourceHeadSha: string | null;
  sourceDiffFingerprint: string | null;
  sourceFilePath: string | null;
  /** The git HEAD of the application code at the moment the run was created. */
  applicationCodeSha: string | null;
  createdAt: Date;
  updatedAt: Date;
}

export interface SimpleRunUpdateExtra {
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
  validationReceiptJson: unknown;
  githubHeadSha: string;
  githubHeadBranch: string;
  githubBaseSha: string;
  sourcePrUrl: string;
  sourcePrNumber: number;
  sourceBaseSha: string;
  sourceHeadSha: string;
  sourceDiffFingerprint: string;
  sourceFilePath: string;
  failedChecks: string[];
}

export interface SimpleRunStore {
  ensureSchema(): Promise<void>;
  create(input: {
    id: string;
    repository: string;
    field: string;
    patch: string;
    applicationCodeSha?: string;
    sourcePrUrl?: string;
    sourcePrNumber?: number;
    sourceBaseSha?: string;
    sourceHeadSha?: string;
    sourceDiffFingerprint?: string;
    sourceFilePath?: string;
  }): Promise<SimpleRun>;
  update(id: string, status: string, extra?: Partial<SimpleRunUpdateExtra>): Promise<void>;
  get(id: string): Promise<SimpleRun | null>;
  list(limit?: number): Promise<SimpleRun[]>;
  close(): Promise<void>;
}

// ─── Row mapper ─────────────────────────────────────────────────────────────

function mapRow(row: Record<string, unknown>): SimpleRun {
  return {
    id: row.id as string,
    status: row.status as string,
    repository: row.repository as string,
    field: row.field as string,
    baselineDecision: (row.baseline_decision as string) ?? null,
    groundedDecision: (row.grounded_decision as string) ?? null,
    consumersFound: (row.consumers_found as number) ?? 0,
    evidenceItems: (row.evidence_items as number) ?? 0,
    artifactsGenerated: (row.artifacts_generated as number) ?? 0,
    patch: (row.patch as string) ?? "",
    triggeredRules: (row.triggered_rules as string) ?? null,
    prUrl: (row.pr_url as string) ?? null,
    writebackStatus: (row.writeback_status as string) ?? null,
    validationReceiptFingerprint: (row.validation_receipt_fingerprint as string) ?? null,
    githubReceiptFingerprint: (row.github_receipt_fingerprint as string) ?? null,
    writebackReceiptFingerprint: (row.writeback_receipt_fingerprint as string) ?? null,
    contextJson: (row.context_json as unknown) ?? null,
    candidateJson: (row.candidate_json as unknown) ?? null,
    comparisonJson: (row.comparison_json as unknown) ?? null,
    validationReceiptJson: (row.validation_receipt_json as unknown) ?? null,
    githubHeadSha: (row.github_head_sha as string) ?? null,
    githubHeadBranch: (row.github_head_branch as string) ?? null,
    githubBaseSha: (row.github_base_sha as string) ?? null,
    executionMode: (row.execution_mode as string) ?? "LIVE",
    sourcePrUrl: (row.source_pr_url as string) ?? null,
    sourcePrNumber: (row.source_pr_number as number) ?? null,
    sourceBaseSha: (row.source_base_sha as string) ?? null,
    sourceHeadSha: (row.source_head_sha as string) ?? null,
    sourceDiffFingerprint: (row.source_diff_fingerprint as string) ?? null,
    sourceFilePath: (row.source_file_path as string) ?? null,
    applicationCodeSha: (row.application_code_sha as string) ?? null,
    createdAt: row.created_at as Date,
    updatedAt: row.updated_at as Date,
  };
}

// ─── Factory ────────────────────────────────────────────────────────────────

export function createSimpleRunStore(pool: pg.Pool): SimpleRunStore {
  return {
    async ensureSchema(): Promise<void> {
      await pool.query(`
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
          validation_receipt_json JSONB,
          github_head_sha TEXT,
          github_head_branch TEXT,
          github_base_sha TEXT,
          execution_mode TEXT NOT NULL DEFAULT 'LIVE',
          source_pr_url TEXT,
          source_pr_number INTEGER,
          source_base_sha TEXT,
          source_head_sha TEXT,
          source_diff_fingerprint TEXT,
          source_file_path TEXT,
          application_code_sha TEXT,
          created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
          updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
        )
      `);
      // Add columns for older schemas — each ALTER propagates errors on failure
      const columns = [
        "triggered_rules TEXT",
        "pr_url TEXT",
        "writeback_status TEXT",
        "evidence_items INTEGER DEFAULT 0",
        "validation_receipt_fingerprint TEXT",
        "github_receipt_fingerprint TEXT",
        "writeback_receipt_fingerprint TEXT",
        "context_json JSONB",
        "candidate_json JSONB",
        "comparison_json JSONB",
        "validation_receipt_json JSONB",
        "github_head_sha TEXT",
        "github_head_branch TEXT",
        "github_base_sha TEXT",
        "execution_mode TEXT DEFAULT 'LIVE'",
        "source_pr_url TEXT",
        "source_pr_number INTEGER",
        "source_base_sha TEXT",
        "source_head_sha TEXT",
        "source_diff_fingerprint TEXT",
        "source_file_path TEXT",
        "application_code_sha TEXT",
      ];
      for (const col of columns) {
        await pool.query(`ALTER TABLE lineageguard.simple_runs ADD COLUMN IF NOT EXISTS ${col}`);
      }
    },

    async create(input): Promise<SimpleRun> {
      const result = await pool.query(
        `INSERT INTO lineageguard.simple_runs
           (id, repository, field, patch, application_code_sha, source_pr_url, source_pr_number,
            source_base_sha, source_head_sha, source_diff_fingerprint, source_file_path)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
         RETURNING *`,
        [
          input.id,
          input.repository,
          input.field,
          input.patch,
          input.applicationCodeSha ?? null,
          input.sourcePrUrl ?? null,
          input.sourcePrNumber ?? null,
          input.sourceBaseSha ?? null,
          input.sourceHeadSha ?? null,
          input.sourceDiffFingerprint ?? null,
          input.sourceFilePath ?? null,
        ],
      );
      return mapRow(result.rows[0]);
    },

    async update(id, status, extra?): Promise<void> {
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
      if (extra?.validationReceiptJson !== undefined) {
        sets.push(`validation_receipt_json = $${idx++}`);
        values.push(JSON.stringify(extra.validationReceiptJson));
      }
      if (extra?.githubHeadSha !== undefined) {
        sets.push(`github_head_sha = $${idx++}`);
        values.push(extra.githubHeadSha);
      }
      if (extra?.githubHeadBranch !== undefined) {
        sets.push(`github_head_branch = $${idx++}`);
        values.push(extra.githubHeadBranch);
      }
      if (extra?.githubBaseSha !== undefined) {
        sets.push(`github_base_sha = $${idx++}`);
        values.push(extra.githubBaseSha);
      }
      if (extra?.sourcePrUrl !== undefined) {
        sets.push(`source_pr_url = $${idx++}`);
        values.push(extra.sourcePrUrl);
      }
      if (extra?.sourcePrNumber !== undefined) {
        sets.push(`source_pr_number = $${idx++}`);
        values.push(extra.sourcePrNumber);
      }
      if (extra?.sourceBaseSha !== undefined) {
        sets.push(`source_base_sha = $${idx++}`);
        values.push(extra.sourceBaseSha);
      }
      if (extra?.sourceHeadSha !== undefined) {
        sets.push(`source_head_sha = $${idx++}`);
        values.push(extra.sourceHeadSha);
      }
      if (extra?.sourceDiffFingerprint !== undefined) {
        sets.push(`source_diff_fingerprint = $${idx++}`);
        values.push(extra.sourceDiffFingerprint);
      }
      if (extra?.sourceFilePath !== undefined) {
        sets.push(`source_file_path = $${idx++}`);
        values.push(extra.sourceFilePath);
      }

      await pool.query(
        `UPDATE lineageguard.simple_runs SET ${sets.join(", ")} WHERE id = $1`,
        values,
      );
    },

    async get(id): Promise<SimpleRun | null> {
      const result = await pool.query("SELECT * FROM lineageguard.simple_runs WHERE id = $1", [id]);
      return result.rows[0] ? mapRow(result.rows[0]) : null;
    },

    async list(limit = 50): Promise<SimpleRun[]> {
      const result = await pool.query(
        "SELECT * FROM lineageguard.simple_runs ORDER BY created_at DESC LIMIT $1",
        [limit],
      );
      return result.rows.map(mapRow);
    },

    async close(): Promise<void> {
      await pool.end();
    },
  };
}
