import { createHash } from "node:crypto";
import type pg from "pg";
import { inTransaction } from "./client.js";

const STATUS_SQL = [
  "CREATED",
  "CHANGE_PARSED",
  "BASELINE_ASSESSED",
  "CONTEXT_COLLECTING",
  "CONTEXT_COLLECTED",
  "RISK_DECIDED",
  "MIGRATION_PLANNED",
  "PATCH_GENERATED",
  "VALIDATING",
  "VALIDATED",
  "REVIEW_ARTIFACT_CREATED",
  "WRITEBACK_PENDING",
  "COMPLETED",
  "CANCELLED",
  "FAILED_CONTEXT",
  "FAILED_GENERATION",
  "FAILED_VALIDATION",
  "FAILED_GITHUB",
  "FAILED_WRITEBACK",
]
  .map((status) => `'${status}'`)
  .join(", ");

export interface Migration {
  id: string;
  sql: string;
}

export const MIGRATIONS: readonly Migration[] = [
  {
    id: "0001_durable_run_store",
    sql: `
      CREATE EXTENSION IF NOT EXISTS pg_stat_statements;
      CREATE SCHEMA IF NOT EXISTS lineageguard;

      CREATE TABLE lineageguard.runs (
        id uuid PRIMARY KEY,
        request_key text NOT NULL UNIQUE CHECK (length(request_key) BETWEEN 1 AND 512),
        input_fingerprint text NOT NULL CHECK (input_fingerprint ~ '^[0-9a-f]{64}$'),
        status text NOT NULL CHECK (status IN (${STATUS_SQL})),
        payload jsonb NOT NULL CHECK (jsonb_typeof(payload) = 'object'),
        version bigint NOT NULL DEFAULT 0 CHECK (version >= 0),
        next_attempt_at timestamptz NOT NULL,
        lease_id uuid,
        worker_id text,
        lease_expires_at timestamptz,
        created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
        updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
        CHECK ((lease_id IS NULL AND worker_id IS NULL AND lease_expires_at IS NULL) OR
               (lease_id IS NOT NULL AND length(worker_id) BETWEEN 1 AND 256 AND lease_expires_at IS NOT NULL))
      );

      CREATE TABLE lineageguard.run_leases (
        lease_id uuid PRIMARY KEY,
        run_id uuid NOT NULL REFERENCES lineageguard.runs(id) ON DELETE RESTRICT,
        worker_id text NOT NULL CHECK (length(worker_id) BETWEEN 1 AND 256),
        acquired_at timestamptz NOT NULL DEFAULT clock_timestamp(),
        expires_at timestamptz NOT NULL,
        UNIQUE (run_id, lease_id)
      );

      CREATE TABLE lineageguard.retry_attempts (
        id uuid PRIMARY KEY,
        run_id uuid NOT NULL REFERENCES lineageguard.runs(id) ON DELETE RESTRICT,
        operation text NOT NULL CHECK (length(operation) BETWEEN 1 AND 128),
        attempt integer NOT NULL CHECK (attempt BETWEEN 1 AND 3),
        retry_at timestamptz NOT NULL,
        created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
        UNIQUE (run_id, operation, attempt)
      );

      CREATE INDEX runs_due_idx ON lineageguard.runs (next_attempt_at, created_at, id)
        WHERE status NOT IN ('COMPLETED','CANCELLED','FAILED_CONTEXT','FAILED_GENERATION','FAILED_VALIDATION','FAILED_GITHUB','FAILED_WRITEBACK');

      CREATE TABLE lineageguard.run_events (
        id uuid PRIMARY KEY,
        run_id uuid NOT NULL REFERENCES lineageguard.runs(id) ON DELETE RESTRICT,
        sequence bigint NOT NULL CHECK (sequence > 0),
        type text NOT NULL CHECK (length(type) BETWEEN 1 AND 256),
        payload jsonb NOT NULL CHECK (jsonb_typeof(payload) = 'object'),
        created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
        UNIQUE (run_id, sequence)
      );

      CREATE FUNCTION lineageguard.enforce_contiguous_event() RETURNS trigger LANGUAGE plpgsql AS $$
      DECLARE expected_sequence bigint;
      BEGIN
        PERFORM 1 FROM lineageguard.runs WHERE id = NEW.run_id FOR UPDATE;
        SELECT COALESCE(MAX(sequence), 0) + 1 INTO expected_sequence
          FROM lineageguard.run_events WHERE run_id = NEW.run_id;
        IF NEW.sequence <> expected_sequence THEN
          RAISE EXCEPTION 'event sequence must be contiguous: expected %, received %', expected_sequence, NEW.sequence
            USING ERRCODE = '23514';
        END IF;
        RETURN NEW;
      END $$;

      CREATE TRIGGER run_events_contiguous BEFORE INSERT ON lineageguard.run_events
        FOR EACH ROW EXECUTE FUNCTION lineageguard.enforce_contiguous_event();

      CREATE FUNCTION lineageguard.reject_immutable_change() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN
        RAISE EXCEPTION 'immutable records cannot be updated or deleted' USING ERRCODE = '55000';
      END $$;

      CREATE TRIGGER run_events_immutable BEFORE UPDATE OR DELETE ON lineageguard.run_events
        FOR EACH ROW EXECUTE FUNCTION lineageguard.reject_immutable_change();
      CREATE TRIGGER run_leases_immutable BEFORE UPDATE OR DELETE ON lineageguard.run_leases
        FOR EACH ROW EXECUTE FUNCTION lineageguard.reject_immutable_change();
      CREATE TRIGGER retry_attempts_immutable BEFORE UPDATE OR DELETE ON lineageguard.retry_attempts
        FOR EACH ROW EXECUTE FUNCTION lineageguard.reject_immutable_change();

      CREATE TABLE lineageguard.run_bundles (
        id uuid PRIMARY KEY,
        run_id uuid NOT NULL REFERENCES lineageguard.runs(id) ON DELETE RESTRICT,
        kind text NOT NULL CHECK (kind IN ('EVIDENCE','CONTEXT')),
        position integer NOT NULL CHECK (position > 0),
        payload jsonb NOT NULL CHECK (jsonb_typeof(payload) = 'object'),
        created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
        UNIQUE (run_id, kind, position)
      );

      CREATE TABLE lineageguard.run_decisions (
        id uuid PRIMARY KEY,
        run_id uuid NOT NULL REFERENCES lineageguard.runs(id) ON DELETE RESTRICT,
        scope text NOT NULL CHECK (scope IN ('BASELINE','GROUNDED')),
        position integer NOT NULL DEFAULT 1 CHECK (position = 1),
        payload jsonb NOT NULL CHECK (jsonb_typeof(payload) = 'object'),
        created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
        UNIQUE (run_id, scope)
      );

      CREATE TABLE lineageguard.migration_candidates (
        id uuid PRIMARY KEY,
        run_id uuid NOT NULL REFERENCES lineageguard.runs(id) ON DELETE RESTRICT,
        position integer NOT NULL CHECK (position > 0),
        payload jsonb NOT NULL CHECK (jsonb_typeof(payload) = 'object'),
        created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
        UNIQUE (run_id, position)
      );

      CREATE TABLE lineageguard.validation_receipts (
        id uuid PRIMARY KEY,
        run_id uuid NOT NULL REFERENCES lineageguard.runs(id) ON DELETE RESTRICT,
        position integer NOT NULL CHECK (position > 0),
        payload jsonb NOT NULL CHECK (jsonb_typeof(payload) = 'object'),
        created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
        UNIQUE (run_id, position)
      );

      CREATE TABLE lineageguard.external_effect_intents (
        id uuid PRIMARY KEY,
        run_id uuid NOT NULL REFERENCES lineageguard.runs(id) ON DELETE RESTRICT,
        kind text NOT NULL CHECK (length(kind) BETWEEN 1 AND 128),
        target text NOT NULL CHECK (length(target) BETWEEN 1 AND 500),
        idempotency_key text NOT NULL CHECK (length(idempotency_key) BETWEEN 1 AND 512),
        input_fingerprint text NOT NULL CHECK (input_fingerprint ~ '^[0-9a-f]{64}$'),
        input jsonb NOT NULL CHECK (jsonb_typeof(input) = 'object'),
        created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
        UNIQUE (kind, target, idempotency_key)
      );

      CREATE TABLE lineageguard.external_effect_receipts (
        id uuid PRIMARY KEY,
        intent_id uuid NOT NULL UNIQUE REFERENCES lineageguard.external_effect_intents(id) ON DELETE RESTRICT,
        payload jsonb NOT NULL CHECK (jsonb_typeof(payload) = 'object'),
        created_at timestamptz NOT NULL DEFAULT clock_timestamp()
      );

      CREATE TABLE lineageguard.external_effect_failures (
        id uuid PRIMARY KEY,
        intent_id uuid NOT NULL REFERENCES lineageguard.external_effect_intents(id) ON DELETE RESTRICT,
        run_id uuid NOT NULL REFERENCES lineageguard.runs(id) ON DELETE RESTRICT,
        position integer NOT NULL CHECK (position BETWEEN 1 AND 100),
        outcome text NOT NULL CHECK (outcome IN ('FAILED','RECONCILIATION_REQUIRED')),
        payload jsonb NOT NULL CHECK (jsonb_typeof(payload) = 'object' AND pg_column_size(payload) <= 65536),
        created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
        UNIQUE (intent_id, position)
      );

      CREATE TRIGGER run_bundles_immutable BEFORE UPDATE OR DELETE ON lineageguard.run_bundles
        FOR EACH ROW EXECUTE FUNCTION lineageguard.reject_immutable_change();
      CREATE TRIGGER run_decisions_immutable BEFORE UPDATE OR DELETE ON lineageguard.run_decisions
        FOR EACH ROW EXECUTE FUNCTION lineageguard.reject_immutable_change();
      CREATE TRIGGER migration_candidates_immutable BEFORE UPDATE OR DELETE ON lineageguard.migration_candidates
        FOR EACH ROW EXECUTE FUNCTION lineageguard.reject_immutable_change();
      CREATE TRIGGER validation_receipts_immutable BEFORE UPDATE OR DELETE ON lineageguard.validation_receipts
        FOR EACH ROW EXECUTE FUNCTION lineageguard.reject_immutable_change();
      CREATE TRIGGER external_effect_intents_immutable BEFORE UPDATE OR DELETE ON lineageguard.external_effect_intents
        FOR EACH ROW EXECUTE FUNCTION lineageguard.reject_immutable_change();
      CREATE TRIGGER external_effect_receipts_immutable BEFORE UPDATE OR DELETE ON lineageguard.external_effect_receipts
        FOR EACH ROW EXECUTE FUNCTION lineageguard.reject_immutable_change();
      CREATE TRIGGER external_effect_failures_immutable BEFORE UPDATE OR DELETE ON lineageguard.external_effect_failures
        FOR EACH ROW EXECUTE FUNCTION lineageguard.reject_immutable_change();
    `,
  },
  {
    id: "0002_domain_workflow_and_safe_effects",
    sql: `
      ALTER TABLE lineageguard.run_events DROP CONSTRAINT run_events_run_id_fkey;
      ALTER TABLE lineageguard.run_bundles DROP CONSTRAINT run_bundles_run_id_fkey;
      ALTER TABLE lineageguard.run_decisions DROP CONSTRAINT run_decisions_run_id_fkey;
      ALTER TABLE lineageguard.migration_candidates DROP CONSTRAINT migration_candidates_run_id_fkey;
      ALTER TABLE lineageguard.validation_receipts DROP CONSTRAINT validation_receipts_run_id_fkey;
      ALTER TABLE lineageguard.external_effect_intents DROP CONSTRAINT external_effect_intents_run_id_fkey;
      ALTER TABLE lineageguard.external_effect_receipts DROP CONSTRAINT external_effect_receipts_intent_id_fkey;
      ALTER TABLE lineageguard.external_effect_failures DROP CONSTRAINT external_effect_failures_intent_id_fkey;
      ALTER TABLE lineageguard.external_effect_failures DROP CONSTRAINT external_effect_failures_run_id_fkey;
      ALTER TABLE lineageguard.run_leases DROP CONSTRAINT run_leases_run_id_fkey;
      ALTER TABLE lineageguard.retry_attempts DROP CONSTRAINT retry_attempts_run_id_fkey;

      ALTER TABLE lineageguard.runs ALTER COLUMN id TYPE text USING 'run_' || left(replace(id::text, '-', ''), 24);
      ALTER TABLE lineageguard.runs ALTER COLUMN lease_id TYPE text USING
        CASE WHEN lease_id IS NULL THEN NULL ELSE 'lease_' || left(replace(lease_id::text, '-', ''), 24) END;
      ALTER TABLE lineageguard.runs ADD COLUMN lease_generation integer NOT NULL DEFAULT 0 CHECK (lease_generation BETWEEN 0 AND 1000000);
      ALTER TABLE lineageguard.runs ALTER COLUMN status SET DEFAULT 'CREATED';

      ALTER TABLE lineageguard.run_events DISABLE TRIGGER run_events_immutable;
      ALTER TABLE lineageguard.run_events DROP CONSTRAINT run_events_sequence_check;
      UPDATE lineageguard.run_events SET sequence = sequence - 1;
      ALTER TABLE lineageguard.run_events ENABLE TRIGGER run_events_immutable;
      ALTER TABLE lineageguard.run_events ALTER COLUMN id TYPE text USING 'evt_' || left(replace(id::text, '-', ''), 24);
      ALTER TABLE lineageguard.run_events ALTER COLUMN run_id TYPE text USING 'run_' || left(replace(run_id::text, '-', ''), 24);
      ALTER TABLE lineageguard.run_events ADD COLUMN lease_id text;
      ALTER TABLE lineageguard.run_events ADD COLUMN worker_id text;
      ALTER TABLE lineageguard.run_events ADD COLUMN generation integer;
      ALTER TABLE lineageguard.run_events ADD COLUMN from_status text;
      ALTER TABLE lineageguard.run_events ADD COLUMN to_status text;
      ALTER TABLE lineageguard.run_events ADD CONSTRAINT run_events_sequence_domain_check CHECK (sequence BETWEEN 0 AND 299) NOT VALID;

      ALTER TABLE lineageguard.run_bundles ALTER COLUMN id TYPE text USING 'bundle_' || left(replace(id::text, '-', ''), 24);
      ALTER TABLE lineageguard.run_bundles ALTER COLUMN run_id TYPE text USING 'run_' || left(replace(run_id::text, '-', ''), 24);
      ALTER TABLE lineageguard.run_decisions ALTER COLUMN id TYPE text USING 'decision_' || left(replace(id::text, '-', ''), 24);
      ALTER TABLE lineageguard.run_decisions ALTER COLUMN run_id TYPE text USING 'run_' || left(replace(run_id::text, '-', ''), 24);
      ALTER TABLE lineageguard.migration_candidates ALTER COLUMN id TYPE text USING 'migration_' || left(replace(id::text, '-', ''), 24);
      ALTER TABLE lineageguard.migration_candidates ALTER COLUMN run_id TYPE text USING 'run_' || left(replace(run_id::text, '-', ''), 24);
      ALTER TABLE lineageguard.validation_receipts ALTER COLUMN id TYPE text USING 'val_' || left(replace(id::text, '-', ''), 24);
      ALTER TABLE lineageguard.validation_receipts ALTER COLUMN run_id TYPE text USING 'run_' || left(replace(run_id::text, '-', ''), 24);
      ALTER TABLE lineageguard.external_effect_intents ALTER COLUMN id TYPE text USING 'effect_' || left(replace(id::text, '-', ''), 24);
      ALTER TABLE lineageguard.external_effect_intents ALTER COLUMN run_id TYPE text USING 'run_' || left(replace(run_id::text, '-', ''), 24);
      ALTER TABLE lineageguard.external_effect_intents ADD COLUMN validation_receipt_id text;
      ALTER TABLE lineageguard.external_effect_intents ADD COLUMN candidate_fingerprint text;
      ALTER TABLE lineageguard.external_effect_intents ADD COLUMN artifact_set_fingerprint text;
      ALTER TABLE lineageguard.external_effect_receipts ALTER COLUMN id TYPE text USING 'receipt_' || left(replace(id::text, '-', ''), 24);
      ALTER TABLE lineageguard.external_effect_receipts ALTER COLUMN intent_id TYPE text USING 'effect_' || left(replace(intent_id::text, '-', ''), 24);
      ALTER TABLE lineageguard.external_effect_receipts ADD COLUMN validation_receipt_id text;
      ALTER TABLE lineageguard.external_effect_receipts ADD COLUMN candidate_fingerprint text;
      ALTER TABLE lineageguard.external_effect_receipts ADD COLUMN artifact_set_fingerprint text;
      ALTER TABLE lineageguard.external_effect_failures ALTER COLUMN id TYPE text USING 'failure_' || left(replace(id::text, '-', ''), 24);
      ALTER TABLE lineageguard.external_effect_failures ALTER COLUMN intent_id TYPE text USING 'effect_' || left(replace(intent_id::text, '-', ''), 24);
      ALTER TABLE lineageguard.external_effect_failures ALTER COLUMN run_id TYPE text USING 'run_' || left(replace(run_id::text, '-', ''), 24);
      ALTER TABLE lineageguard.run_leases ALTER COLUMN lease_id TYPE text USING 'lease_' || left(replace(lease_id::text, '-', ''), 24);
      ALTER TABLE lineageguard.run_leases ALTER COLUMN run_id TYPE text USING 'run_' || left(replace(run_id::text, '-', ''), 24);
      ALTER TABLE lineageguard.run_leases ADD COLUMN generation integer NOT NULL DEFAULT 1 CHECK (generation BETWEEN 1 AND 1000000);
      ALTER TABLE lineageguard.retry_attempts ALTER COLUMN id TYPE text USING 'retry_' || left(replace(id::text, '-', ''), 24);
      ALTER TABLE lineageguard.retry_attempts ALTER COLUMN run_id TYPE text USING 'run_' || left(replace(run_id::text, '-', ''), 24);

      ALTER TABLE lineageguard.run_events ADD FOREIGN KEY (run_id) REFERENCES lineageguard.runs(id) ON DELETE RESTRICT;
      ALTER TABLE lineageguard.run_bundles ADD FOREIGN KEY (run_id) REFERENCES lineageguard.runs(id) ON DELETE RESTRICT;
      ALTER TABLE lineageguard.run_decisions ADD FOREIGN KEY (run_id) REFERENCES lineageguard.runs(id) ON DELETE RESTRICT;
      ALTER TABLE lineageguard.migration_candidates ADD FOREIGN KEY (run_id) REFERENCES lineageguard.runs(id) ON DELETE RESTRICT;
      ALTER TABLE lineageguard.validation_receipts ADD FOREIGN KEY (run_id) REFERENCES lineageguard.runs(id) ON DELETE RESTRICT;
      ALTER TABLE lineageguard.external_effect_intents ADD FOREIGN KEY (run_id) REFERENCES lineageguard.runs(id) ON DELETE RESTRICT;
      ALTER TABLE lineageguard.external_effect_intents ADD FOREIGN KEY (validation_receipt_id) REFERENCES lineageguard.validation_receipts(id) ON DELETE RESTRICT;
      ALTER TABLE lineageguard.external_effect_receipts ADD FOREIGN KEY (intent_id) REFERENCES lineageguard.external_effect_intents(id) ON DELETE RESTRICT;
      ALTER TABLE lineageguard.external_effect_receipts ADD FOREIGN KEY (validation_receipt_id) REFERENCES lineageguard.validation_receipts(id) ON DELETE RESTRICT;
      ALTER TABLE lineageguard.external_effect_failures ADD FOREIGN KEY (intent_id) REFERENCES lineageguard.external_effect_intents(id) ON DELETE RESTRICT;
      ALTER TABLE lineageguard.external_effect_failures ADD FOREIGN KEY (run_id) REFERENCES lineageguard.runs(id) ON DELETE RESTRICT;
      ALTER TABLE lineageguard.run_leases ADD FOREIGN KEY (run_id) REFERENCES lineageguard.runs(id) ON DELETE RESTRICT;
      ALTER TABLE lineageguard.retry_attempts ADD FOREIGN KEY (run_id) REFERENCES lineageguard.runs(id) ON DELETE RESTRICT;

      ALTER TABLE lineageguard.runs ADD CONSTRAINT runs_domain_id_check CHECK (id ~ '^run_[a-f0-9]{24}$') NOT VALID;
      ALTER TABLE lineageguard.runs ADD CONSTRAINT runs_payload_bound CHECK (pg_column_size(payload) <= 1048576) NOT VALID;
      ALTER TABLE lineageguard.run_events ADD CONSTRAINT run_events_domain_id_check CHECK (id ~ '^evt_[a-f0-9]{24}$' AND run_id ~ '^run_[a-f0-9]{24}$') NOT VALID;
      ALTER TABLE lineageguard.run_events ADD CONSTRAINT run_events_domain_type_check CHECK
        (type IN ('RUN_STATUS_CHANGED','RUN_LEASE_ACQUIRED','RUN_LEASE_RENEWED','RUN_LEASE_RELEASED','RUN_LEASE_EXPIRED','RUN_RETRY_SCHEDULED')) NOT VALID;
      ALTER TABLE lineageguard.run_events ADD CONSTRAINT run_events_domain_binding_check CHECK (
        type NOT IN ('RUN_STATUS_CHANGED','RUN_LEASE_ACQUIRED','RUN_LEASE_RENEWED','RUN_LEASE_RELEASED','RUN_LEASE_EXPIRED','RUN_RETRY_SCHEDULED') OR
        (lease_id IS NOT NULL AND worker_id IS NOT NULL AND generation IS NOT NULL AND
          payload ? 'eventId' AND payload ? 'runId' AND payload ? 'sequence' AND payload ? 'type' AND
          payload ? 'leaseId' AND payload ? 'workerId' AND payload ? 'generation' AND payload ? 'occurredAt' AND
          payload->>'eventId' = id AND payload->>'runId' = run_id AND (payload->>'sequence')::bigint = sequence
          AND payload->>'type' = type AND payload->>'leaseId' = lease_id AND payload->>'workerId' = worker_id
          AND (payload->>'generation')::integer = generation AND (payload->>'occurredAt')::timestamptz = created_at)
      ) NOT VALID;
      ALTER TABLE lineageguard.run_events ADD CONSTRAINT run_events_status_binding_check CHECK (
        type <> 'RUN_STATUS_CHANGED' OR
        (from_status IS NOT NULL AND to_status IS NOT NULL AND payload ? 'from' AND payload ? 'to' AND
          payload->>'from' = from_status AND payload->>'to' = to_status AND
          ((from_status, to_status) IN (
            ('CREATED','CHANGE_PARSED'),('CHANGE_PARSED','BASELINE_ASSESSED'),
            ('BASELINE_ASSESSED','CONTEXT_COLLECTING'),('CONTEXT_COLLECTING','CONTEXT_COLLECTED'),
            ('CONTEXT_COLLECTING','FAILED_CONTEXT'),('CONTEXT_COLLECTED','RISK_DECIDED'),
            ('CONTEXT_COLLECTED','FAILED_CONTEXT'),('RISK_DECIDED','MIGRATION_PLANNED'),
            ('RISK_DECIDED','FAILED_GENERATION'),('MIGRATION_PLANNED','PATCH_GENERATED'),
            ('MIGRATION_PLANNED','FAILED_GENERATION'),('PATCH_GENERATED','VALIDATING'),
            ('PATCH_GENERATED','FAILED_GENERATION'),('VALIDATING','VALIDATED'),
            ('VALIDATING','FAILED_VALIDATION'),('VALIDATED','REVIEW_ARTIFACT_CREATED'),
            ('VALIDATED','FAILED_GITHUB'),('REVIEW_ARTIFACT_CREATED','WRITEBACK_PENDING'),
            ('REVIEW_ARTIFACT_CREATED','FAILED_GITHUB'),('WRITEBACK_PENDING','COMPLETED'),
            ('WRITEBACK_PENDING','FAILED_WRITEBACK')
          ) OR to_status = 'CANCELLED'))
      ) NOT VALID;
      ALTER TABLE lineageguard.run_events ADD CONSTRAINT run_events_payload_bound CHECK (pg_column_size(payload) <= 131072) NOT VALID;
      ALTER TABLE lineageguard.run_bundles ADD CONSTRAINT run_bundles_bound CHECK (position <= 200 AND pg_column_size(payload) <= 1048576) NOT VALID;
      ALTER TABLE lineageguard.migration_candidates ADD CONSTRAINT migration_candidates_bound CHECK (position <= 20 AND pg_column_size(payload) <= 2097152) NOT VALID;
      ALTER TABLE lineageguard.validation_receipts ADD CONSTRAINT validation_receipts_bound CHECK (position <= 20 AND pg_column_size(payload) <= 1048576) NOT VALID;
      ALTER TABLE lineageguard.validation_receipts ADD CONSTRAINT validation_receipts_authenticated_check CHECK (
        id ~ '^val_[a-f0-9]{24}$' AND payload ? 'protectedHeaders' AND payload ? 'payload' AND
        payload#>>'{payload,status}'='PASS' AND
        payload#>>'{protectedHeaders,purpose}'='LINEAGEGUARD_VALIDATION_LIVE' AND
        payload#>>'{protectedHeaders,algorithm}'='ED25519'
      ) NOT VALID;
      ALTER TABLE lineageguard.external_effect_intents ADD CONSTRAINT external_effect_kind_check
        CHECK (kind IN ('GITHUB_REVIEW','DATAHUB_WRITEBACK')) NOT VALID;
      ALTER TABLE lineageguard.external_effect_intents ADD CONSTRAINT external_effect_target_bound
        CHECK (length(target) BETWEEN 1 AND 500) NOT VALID;
      ALTER TABLE lineageguard.external_effect_intents ADD CONSTRAINT external_effect_validation_binding_check CHECK (
        validation_receipt_id IS NOT NULL AND validation_receipt_id ~ '^val_[a-f0-9]{24}$' AND
        candidate_fingerprint IS NOT NULL AND candidate_fingerprint ~ '^[a-f0-9]{64}$' AND
        artifact_set_fingerprint IS NOT NULL AND artifact_set_fingerprint ~ '^[a-f0-9]{64}$'
      ) NOT VALID;
      ALTER TABLE lineageguard.external_effect_receipts ADD CONSTRAINT external_effect_receipt_binding_check CHECK (
        validation_receipt_id IS NOT NULL AND validation_receipt_id ~ '^val_[a-f0-9]{24}$' AND
        candidate_fingerprint IS NOT NULL AND candidate_fingerprint ~ '^[a-f0-9]{64}$' AND
        artifact_set_fingerprint IS NOT NULL AND artifact_set_fingerprint ~ '^[a-f0-9]{64}$'
      ) NOT VALID;

      CREATE OR REPLACE FUNCTION lineageguard.enforce_contiguous_event() RETURNS trigger LANGUAGE plpgsql AS $$
      DECLARE expected_sequence bigint;
      BEGIN
        PERFORM 1 FROM lineageguard.runs WHERE id = NEW.run_id FOR UPDATE;
        SELECT COALESCE(MAX(sequence), -1) + 1 INTO expected_sequence
          FROM lineageguard.run_events WHERE run_id = NEW.run_id;
        IF NEW.sequence <> expected_sequence THEN
          RAISE EXCEPTION 'event sequence must be contiguous: expected %, received %', expected_sequence, NEW.sequence
            USING ERRCODE = '23514';
        END IF;
        RETURN NEW;
      END $$;

      ALTER TABLE lineageguard.retry_attempts ADD CONSTRAINT retry_operation_domain_check
        CHECK (operation IN ('DATAHUB_READ','GENERATION','GITHUB_WRITE','DATAHUB_WRITE')) NOT VALID;
      ALTER TABLE lineageguard.retry_attempts ADD CONSTRAINT retry_schedule_domain_check CHECK (
        retry_at - created_at = CASE attempt WHEN 1 THEN interval '1 second'
          WHEN 2 THEN interval '5 seconds' WHEN 3 THEN interval '30 seconds' END
      ) NOT VALID;

      CREATE FUNCTION lineageguard.authorize_retry_attempt() RETURNS trigger LANGUAGE plpgsql AS $$
      DECLARE current_status text;
      BEGIN
        SELECT status INTO current_status FROM lineageguard.runs WHERE id=NEW.run_id FOR UPDATE;
        IF NOT (
          (NEW.operation='DATAHUB_READ' AND current_status='CONTEXT_COLLECTING') OR
          (NEW.operation='GENERATION' AND current_status IN ('RISK_DECIDED','MIGRATION_PLANNED')) OR
          (NEW.operation='GITHUB_WRITE' AND current_status='VALIDATED') OR
          (NEW.operation='DATAHUB_WRITE' AND current_status='WRITEBACK_PENDING')
        ) THEN
          RAISE EXCEPTION 'retry operation % is not allowed in state %',NEW.operation,current_status
            USING ERRCODE='23514';
        END IF;
        RETURN NEW;
      END $$;
      CREATE TRIGGER retry_attempts_authorized BEFORE INSERT ON lineageguard.retry_attempts
        FOR EACH ROW EXECUTE FUNCTION lineageguard.authorize_retry_attempt();

      CREATE TABLE lineageguard.external_effect_attempts (
        id text PRIMARY KEY CHECK (id ~ '^effect_attempt_[a-f0-9]{24}$'),
        intent_id text NOT NULL REFERENCES lineageguard.external_effect_intents(id) ON DELETE RESTRICT,
        attempt integer NOT NULL CHECK (attempt BETWEEN 1 AND 3),
        worker_id text NOT NULL CHECK (length(worker_id) BETWEEN 1 AND 160),
        fencing_token text NOT NULL UNIQUE CHECK (fencing_token ~ '^effect_fence_[a-f0-9]{24}$'),
        state text NOT NULL CHECK (state IN ('READY_TO_INVOKE','SUCCEEDED','RECONCILIATION_REQUIRED')),
        claimed_at timestamptz NOT NULL,
        claim_expires_at timestamptz NOT NULL CHECK (claim_expires_at > claimed_at),
        updated_at timestamptz NOT NULL,
        UNIQUE (intent_id, attempt)
      );

      CREATE TABLE lineageguard.effect_approvals (
        id text PRIMARY KEY CHECK (id ~ '^approval_[a-f0-9]{24}$'),
        run_id text NOT NULL REFERENCES lineageguard.runs(id) ON DELETE RESTRICT,
        kind text NOT NULL CHECK (kind IN ('GITHUB_REVIEW','DATAHUB_WRITEBACK')),
        target text NOT NULL CHECK (length(target) BETWEEN 1 AND 1024),
        input_fingerprint text NOT NULL CHECK (input_fingerprint ~ '^[0-9a-f]{64}$'),
        approved_by text NOT NULL CHECK (length(approved_by) BETWEEN 1 AND 240),
        approved_at timestamptz NOT NULL CHECK (approved_at <= clock_timestamp()),
        approval_fingerprint text NOT NULL CHECK (approval_fingerprint ~ '^[a-f0-9]{64}$'),
        created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
        UNIQUE (run_id,kind,target,input_fingerprint)
      );
      CREATE TRIGGER effect_approvals_immutable BEFORE UPDATE OR DELETE ON lineageguard.effect_approvals
        FOR EACH ROW EXECUTE FUNCTION lineageguard.reject_immutable_change();

      CREATE TABLE lineageguard.external_effect_reconciliations (
        id text PRIMARY KEY CHECK (id ~ '^reconciliation_[a-f0-9]{24}$'),
        attempt_id text NOT NULL UNIQUE REFERENCES lineageguard.external_effect_attempts(id) ON DELETE RESTRICT,
        proof_outcome text NOT NULL CHECK (proof_outcome IN ('APPLIED','NOT_APPLIED')),
        payload jsonb NOT NULL CHECK (jsonb_typeof(payload) = 'object' AND pg_column_size(payload) <= 65536),
        created_at timestamptz NOT NULL DEFAULT clock_timestamp()
      );
      CREATE TRIGGER external_effect_reconciliations_immutable BEFORE UPDATE OR DELETE ON lineageguard.external_effect_reconciliations
        FOR EACH ROW EXECUTE FUNCTION lineageguard.reject_immutable_change();

      CREATE FUNCTION lineageguard.enforce_effect_attempt_transition() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN
        IF (NEW.id,NEW.intent_id,NEW.attempt,NEW.worker_id,NEW.fencing_token,NEW.claimed_at,NEW.claim_expires_at)
          IS DISTINCT FROM
          (OLD.id,OLD.intent_id,OLD.attempt,OLD.worker_id,OLD.fencing_token,OLD.claimed_at,OLD.claim_expires_at)
          OR NEW.updated_at < OLD.updated_at
        THEN RAISE EXCEPTION 'effect attempt identity is immutable' USING ERRCODE='23514'; END IF;
        IF OLD.state='READY_TO_INVOKE' AND NEW.state='RECONCILIATION_REQUIRED' AND (
          OLD.claim_expires_at <= clock_timestamp() OR EXISTS (
            SELECT 1 FROM lineageguard.external_effect_failures f
            WHERE f.intent_id=OLD.intent_id AND f.created_at >= OLD.claimed_at
          )
        ) THEN RETURN NEW; END IF;
        IF OLD.state IN ('READY_TO_INVOKE','RECONCILIATION_REQUIRED') AND NEW.state='SUCCEEDED' AND EXISTS (
          SELECT 1 FROM lineageguard.external_effect_receipts r WHERE r.intent_id=OLD.intent_id
        ) THEN RETURN NEW; END IF;
        RAISE EXCEPTION 'invalid effect attempt state transition' USING ERRCODE='23514';
      END $$;
      CREATE TRIGGER external_effect_attempts_state_machine BEFORE UPDATE ON lineageguard.external_effect_attempts
        FOR EACH ROW EXECUTE FUNCTION lineageguard.enforce_effect_attempt_transition();

      CREATE FUNCTION lineageguard.transition_run(
        p_run_id text,p_from text,p_to text,p_lease_id text,p_worker_id text,p_generation integer,
        p_occurred_at timestamptz,p_event jsonb
      ) RETURNS SETOF lineageguard.runs LANGUAGE plpgsql SECURITY DEFINER
      SET search_path=pg_catalog,lineageguard AS $$
      DECLARE changed lineageguard.runs%ROWTYPE;
      DECLARE next_sequence bigint;
      BEGIN
        IF NOT (
          (p_from,p_to) IN (
            ('CREATED','CHANGE_PARSED'),('CHANGE_PARSED','BASELINE_ASSESSED'),
            ('BASELINE_ASSESSED','CONTEXT_COLLECTING'),('CONTEXT_COLLECTING','CONTEXT_COLLECTED'),
            ('CONTEXT_COLLECTING','FAILED_CONTEXT'),('CONTEXT_COLLECTED','RISK_DECIDED'),
            ('CONTEXT_COLLECTED','FAILED_CONTEXT'),('RISK_DECIDED','MIGRATION_PLANNED'),
            ('RISK_DECIDED','FAILED_GENERATION'),('MIGRATION_PLANNED','PATCH_GENERATED'),
            ('MIGRATION_PLANNED','FAILED_GENERATION'),('PATCH_GENERATED','VALIDATING'),
            ('PATCH_GENERATED','FAILED_GENERATION'),('VALIDATING','VALIDATED'),
            ('VALIDATING','FAILED_VALIDATION'),('VALIDATED','REVIEW_ARTIFACT_CREATED'),
            ('VALIDATED','FAILED_GITHUB'),('REVIEW_ARTIFACT_CREATED','WRITEBACK_PENDING'),
            ('REVIEW_ARTIFACT_CREATED','FAILED_GITHUB'),('WRITEBACK_PENDING','COMPLETED'),
            ('WRITEBACK_PENDING','FAILED_WRITEBACK')
          ) OR p_to='CANCELLED'
        ) THEN RAISE EXCEPTION 'invalid status transition' USING ERRCODE='23514'; END IF;
        IF p_to IN ('VALIDATED','COMPLETED') AND NOT EXISTS (
          SELECT 1 FROM lineageguard.validation_receipts v WHERE v.run_id=p_run_id
            AND v.id ~ '^val_[a-f0-9]{24}$' AND v.payload#>>'{payload,status}'='PASS'
            AND v.payload#>>'{protectedHeaders,purpose}'='LINEAGEGUARD_VALIDATION_LIVE'
            AND v.payload#>>'{protectedHeaders,algorithm}'='ED25519'
        ) THEN RAISE EXCEPTION 'accepted validation prerequisite missing' USING ERRCODE='23514'; END IF;
        IF p_to='REVIEW_ARTIFACT_CREATED' AND NOT EXISTS (
          SELECT 1 FROM lineageguard.external_effect_intents i
          JOIN lineageguard.external_effect_receipts r ON r.intent_id=i.id
          JOIN lineageguard.validation_receipts v ON v.id=i.validation_receipt_id
          WHERE i.run_id=p_run_id AND i.kind='GITHUB_REVIEW' AND r.validation_receipt_id=v.id
            AND r.candidate_fingerprint=i.candidate_fingerprint
            AND r.artifact_set_fingerprint=i.artifact_set_fingerprint
        ) THEN RAISE EXCEPTION 'GitHub review receipt prerequisite missing' USING ERRCODE='23514'; END IF;
        IF p_to='COMPLETED' AND (
          NOT EXISTS (SELECT 1 FROM lineageguard.external_effect_intents i JOIN lineageguard.external_effect_receipts r ON r.intent_id=i.id JOIN lineageguard.validation_receipts v ON v.id=i.validation_receipt_id WHERE i.run_id=p_run_id AND i.kind='GITHUB_REVIEW' AND r.validation_receipt_id=v.id AND r.candidate_fingerprint=i.candidate_fingerprint AND r.artifact_set_fingerprint=i.artifact_set_fingerprint) OR
          NOT EXISTS (SELECT 1 FROM lineageguard.external_effect_intents i JOIN lineageguard.external_effect_receipts r ON r.intent_id=i.id JOIN lineageguard.validation_receipts v ON v.id=i.validation_receipt_id WHERE i.run_id=p_run_id AND i.kind='DATAHUB_WRITEBACK' AND r.validation_receipt_id=v.id AND r.candidate_fingerprint=i.candidate_fingerprint AND r.artifact_set_fingerprint=i.artifact_set_fingerprint)
        ) THEN RAISE EXCEPTION 'completion prerequisites missing' USING ERRCODE='23514'; END IF;
        SELECT COALESCE(MAX(sequence),-1)+1 INTO next_sequence FROM lineageguard.run_events WHERE run_id=p_run_id;
        IF (p_event->>'sequence')::bigint <> next_sequence THEN
          RAISE EXCEPTION 'event sequence is stale' USING ERRCODE='23514';
        END IF;
        UPDATE lineageguard.runs SET status=p_to,version=version+1,updated_at=p_occurred_at,
          lease_id=CASE WHEN p_to IN ('COMPLETED','FAILED_CONTEXT','FAILED_GENERATION','FAILED_VALIDATION','FAILED_GITHUB','FAILED_WRITEBACK','CANCELLED') THEN NULL ELSE lease_id END,
          worker_id=CASE WHEN p_to IN ('COMPLETED','FAILED_CONTEXT','FAILED_GENERATION','FAILED_VALIDATION','FAILED_GITHUB','FAILED_WRITEBACK','CANCELLED') THEN NULL ELSE worker_id END,
          lease_expires_at=CASE WHEN p_to IN ('COMPLETED','FAILED_CONTEXT','FAILED_GENERATION','FAILED_VALIDATION','FAILED_GITHUB','FAILED_WRITEBACK','CANCELLED') THEN NULL ELSE lease_expires_at END
        WHERE id=p_run_id AND status=p_from AND lease_id=p_lease_id AND worker_id=p_worker_id
          AND lease_generation=p_generation AND lease_expires_at>clock_timestamp() RETURNING * INTO changed;
        IF changed.id IS NULL THEN RAISE EXCEPTION 'transition fence rejected' USING ERRCODE='23514'; END IF;
        INSERT INTO lineageguard.run_events
          (id,run_id,sequence,type,payload,created_at,lease_id,worker_id,generation,from_status,to_status)
        VALUES (p_event->>'eventId',p_run_id,next_sequence,p_event->>'type',p_event,p_occurred_at,
          p_lease_id,p_worker_id,p_generation,p_from,p_to);
        RETURN NEXT changed;
      END $$;
      REVOKE ALL ON FUNCTION lineageguard.transition_run(text,text,text,text,text,integer,timestamptz,jsonb) FROM PUBLIC;
    `,
  },
  {
    id: "0003_typed_impact_collection_results",
    sql: `
      CREATE FUNCTION lineageguard.is_typed_impact_collection_result(candidate jsonb)
      RETURNS boolean
      LANGUAGE plpgsql
      IMMUTABLE
      SET search_path=pg_catalog
      AS $$
      DECLARE
        outcome text;
        origin_mode text;
        evidence_item jsonb;
        provenance_item jsonb;
      BEGIN
        IF jsonb_typeof(candidate) <> 'object' THEN RETURN false; END IF;
        outcome := candidate->>'outcome';
        IF outcome = 'FAILED' THEN
          RETURN candidate->>'mode' IN ('LIVE','VERIFIED_REPLAY')
            AND jsonb_typeof(candidate->'report') = 'object';
        END IF;
        IF outcome NOT IN ('COLLECTED_LIVE','COLLECTED_VERIFIED_REPLAY')
          OR jsonb_typeof(candidate->'context') <> 'object'
          OR jsonb_typeof(candidate#>'{context,resolution,provenance}') <> 'object'
          OR jsonb_typeof(candidate#>'{context,evidence}') <> 'array'
          OR candidate#>>'{context,impactContextFingerprint}' !~ '^[a-f0-9]{64}$'
          OR candidate#>>'{context,collectionFingerprint}' !~ '^[a-f0-9]{64}$'
        THEN RETURN false; END IF;
        origin_mode := candidate#>>'{context,collectionOrigin,mode}';
        IF (outcome = 'COLLECTED_LIVE' AND origin_mode <> 'LIVE')
          OR (outcome = 'COLLECTED_VERIFIED_REPLAY' AND origin_mode <> 'VERIFIED_REPLAY')
        THEN RETURN false; END IF;
        IF origin_mode = 'VERIFIED_REPLAY' AND (
          candidate#>>'{context,collectionOrigin,manifestFingerprint}' !~ '^[a-f0-9]{64}$'
          OR candidate#>>'{context,collectionOrigin,sourceLiveCollectionFingerprint}' !~ '^[a-f0-9]{64}$'
          OR candidate#>>'{context,collectionOrigin,sourceImpactContextFingerprint}' !~ '^[a-f0-9]{64}$'
        ) THEN RETURN false; END IF;
        FOR evidence_item IN SELECT value FROM jsonb_array_elements(candidate#>'{context,evidence}')
        LOOP
          IF jsonb_typeof(evidence_item->'provenance') <> 'array'
            OR jsonb_array_length(evidence_item->'provenance') < 1
          THEN RETURN false; END IF;
          FOR provenance_item IN SELECT value FROM jsonb_array_elements(evidence_item->'provenance')
          LOOP
            IF jsonb_typeof(provenance_item) <> 'object'
              OR provenance_item->>'source' <> 'DATAHUB_MCP'
              OR length(provenance_item->>'invocationId') < 1
              OR provenance_item->>'responseFingerprint' !~ '^[a-f0-9]{64}$'
            THEN RETURN false; END IF;
          END LOOP;
        END LOOP;
        RETURN true;
      END $$;
      REVOKE ALL ON FUNCTION lineageguard.is_typed_impact_collection_result(jsonb) FROM PUBLIC;

      ALTER TABLE lineageguard.run_bundles
        ADD CONSTRAINT run_bundles_typed_context_check
        CHECK (kind <> 'CONTEXT' OR lineageguard.is_typed_impact_collection_result(payload))
        NOT VALID;
    `,
  },
  {
    id: "0004_execution_and_effect_authority",
    sql: `
      DO $$
      BEGIN
        IF EXISTS (
          SELECT 1 FROM lineageguard.run_bundles b
          WHERE b.kind='CONTEXT'
            AND b.payload->>'outcome' IN ('COLLECTED_LIVE','COLLECTED_VERIFIED_REPLAY')
            AND (
              jsonb_typeof(b.payload#>'{context,resolution,provenance}') NOT IN ('object','array')
              OR (jsonb_typeof(b.payload#>'{context,resolution,provenance}')='array'
                AND jsonb_array_length(b.payload#>'{context,resolution,provenance}')<1)
            )
        ) THEN
          RAISE EXCEPTION 'legacy resolution provenance is not safely migratable'
            USING ERRCODE='23514';
        END IF;
      END $$;
      ALTER TABLE lineageguard.run_bundles DROP CONSTRAINT run_bundles_typed_context_check;
      ALTER TABLE lineageguard.run_bundles DISABLE TRIGGER run_bundles_immutable;
      CREATE FUNCTION lineageguard.canonical_json_text(candidate jsonb)
      RETURNS text LANGUAGE plpgsql IMMUTABLE SET search_path=pg_catalog,lineageguard AS $$
      DECLARE result text;
      BEGIN
        CASE jsonb_typeof(candidate)
          WHEN 'object' THEN
            SELECT '{' || COALESCE(string_agg(
              to_jsonb(entry.key)::text || ':' || lineageguard.canonical_json_text(entry.value),
              ',' ORDER BY entry.key COLLATE "C"
            ),'') || '}' INTO result FROM jsonb_each(candidate) AS entry;
          WHEN 'array' THEN
            SELECT '[' || COALESCE(string_agg(
              lineageguard.canonical_json_text(entry.value),',' ORDER BY entry.ordinality
            ),'') || ']' INTO result
            FROM jsonb_array_elements(candidate) WITH ORDINALITY AS entry(value,ordinality);
          ELSE result := candidate::text;
        END CASE;
        RETURN result;
      END $$;
      REVOKE ALL ON FUNCTION lineageguard.canonical_json_text(jsonb) FROM PUBLIC;
      UPDATE lineageguard.run_bundles
        SET payload=jsonb_set(
          payload,
          '{context,resolution,provenance}',
          jsonb_build_array(payload#>'{context,resolution,provenance}'),
          false
        )
        WHERE kind='CONTEXT'
          AND payload->>'outcome' IN ('COLLECTED_LIVE','COLLECTED_VERIFIED_REPLAY')
          AND jsonb_typeof(payload#>'{context,resolution,provenance}')='object';
      UPDATE lineageguard.run_bundles
        SET payload=jsonb_set(
          payload,
          '{context,collectionFingerprint}',
          to_jsonb(encode(sha256(convert_to(lineageguard.canonical_json_text(
            (payload->'context')-'impactContextFingerprint'-'collectionFingerprint'
          ),'UTF8')),'hex')),
          false
        )
        WHERE kind='CONTEXT'
          AND payload->>'outcome' IN ('COLLECTED_LIVE','COLLECTED_VERIFIED_REPLAY');
      ALTER TABLE lineageguard.run_bundles ENABLE TRIGGER run_bundles_immutable;

      CREATE OR REPLACE FUNCTION lineageguard.is_typed_impact_collection_result(candidate jsonb)
      RETURNS boolean
      LANGUAGE plpgsql
      IMMUTABLE
      SET search_path=pg_catalog
      AS $$
      DECLARE
        outcome text;
        origin_mode text;
        evidence_item jsonb;
        provenance_item jsonb;
        resolution_provenance_item jsonb;
      BEGIN
        IF jsonb_typeof(candidate) <> 'object' THEN RETURN false; END IF;
        outcome := candidate->>'outcome';
        IF outcome = 'FAILED' THEN
          RETURN candidate->>'mode' IN ('LIVE','VERIFIED_REPLAY')
            AND jsonb_typeof(candidate->'report') = 'object';
        END IF;
        IF outcome NOT IN ('COLLECTED_LIVE','COLLECTED_VERIFIED_REPLAY')
          OR jsonb_typeof(candidate->'context') <> 'object'
          OR jsonb_typeof(candidate#>'{context,resolution,provenance}') <> 'array'
          OR jsonb_array_length(candidate#>'{context,resolution,provenance}') NOT BETWEEN 1 AND 8
          OR jsonb_typeof(candidate#>'{context,evidence}') <> 'array'
          OR candidate#>>'{context,impactContextFingerprint}' !~ '^[a-f0-9]{64}$'
          OR candidate#>>'{context,collectionFingerprint}' !~ '^[a-f0-9]{64}$'
        THEN RETURN false; END IF;
        FOR resolution_provenance_item IN
          SELECT value FROM jsonb_array_elements(candidate#>'{context,resolution,provenance}')
        LOOP
          IF jsonb_typeof(resolution_provenance_item) <> 'object'
            OR resolution_provenance_item->>'source' <> 'DATAHUB_MCP'
            OR resolution_provenance_item->>'role' <> 'RESOLUTION'
            OR resolution_provenance_item->>'tool' <> 'search'
            OR length(resolution_provenance_item->>'invocationId') < 1
            OR resolution_provenance_item->>'responseFingerprint' !~ '^[a-f0-9]{64}$'
          THEN RETURN false; END IF;
        END LOOP;
        origin_mode := candidate#>>'{context,collectionOrigin,mode}';
        IF (outcome = 'COLLECTED_LIVE' AND origin_mode <> 'LIVE')
          OR (outcome = 'COLLECTED_VERIFIED_REPLAY' AND origin_mode <> 'VERIFIED_REPLAY')
        THEN RETURN false; END IF;
        IF origin_mode = 'VERIFIED_REPLAY' AND (
          candidate#>>'{context,collectionOrigin,manifestFingerprint}' !~ '^[a-f0-9]{64}$'
          OR candidate#>>'{context,collectionOrigin,sourceLiveCollectionFingerprint}' !~ '^[a-f0-9]{64}$'
          OR candidate#>>'{context,collectionOrigin,sourceImpactContextFingerprint}' !~ '^[a-f0-9]{64}$'
        ) THEN RETURN false; END IF;
        FOR evidence_item IN SELECT value FROM jsonb_array_elements(candidate#>'{context,evidence}')
        LOOP
          IF jsonb_typeof(evidence_item->'provenance') <> 'array'
            OR jsonb_array_length(evidence_item->'provenance') < 1
          THEN RETURN false; END IF;
          FOR provenance_item IN SELECT value FROM jsonb_array_elements(evidence_item->'provenance')
          LOOP
            IF jsonb_typeof(provenance_item) <> 'object'
              OR provenance_item->>'source' <> 'DATAHUB_MCP'
              OR length(provenance_item->>'invocationId') < 1
              OR provenance_item->>'responseFingerprint' !~ '^[a-f0-9]{64}$'
            THEN RETURN false; END IF;
          END LOOP;
        END LOOP;
        RETURN true;
      END $$;
      ALTER TABLE lineageguard.run_bundles
        ADD CONSTRAINT run_bundles_typed_context_check
        CHECK (kind <> 'CONTEXT' OR lineageguard.is_typed_impact_collection_result(payload));
      DO $$
      BEGIN
        IF EXISTS (
          SELECT 1 FROM lineageguard.run_bundles b
          WHERE b.kind='CONTEXT'
            AND b.payload->>'outcome' IN ('COLLECTED_LIVE','COLLECTED_VERIFIED_REPLAY')
            AND (jsonb_typeof(b.payload#>'{context,resolution,provenance}')<>'array'
              OR jsonb_array_length(b.payload#>'{context,resolution,provenance}')<1)
        ) THEN
          RAISE EXCEPTION 'resolution provenance array migration postcondition failed'
            USING ERRCODE='23514';
        END IF;
      END $$;

      ALTER TABLE lineageguard.runs ADD COLUMN execution_mode text;
      DO $$
      BEGIN
        IF EXISTS (
          SELECT b.run_id FROM lineageguard.run_bundles b WHERE b.kind='CONTEXT'
          GROUP BY b.run_id
          HAVING count(DISTINCT CASE WHEN b.payload->>'outcome'='FAILED'
            THEN b.payload->>'mode' ELSE b.payload#>>'{context,collectionOrigin,mode}' END) > 1
        ) THEN
          RAISE EXCEPTION 'cannot migrate runs with mixed impact collection modes'
            USING ERRCODE='23514';
        END IF;
      END $$;
      UPDATE lineageguard.runs r SET execution_mode=COALESCE((
        SELECT CASE WHEN b.payload->>'outcome'='FAILED' THEN b.payload->>'mode'
          ELSE b.payload#>>'{context,collectionOrigin,mode}' END
        FROM lineageguard.run_bundles b
        WHERE b.run_id=r.id AND b.kind='CONTEXT'
        ORDER BY b.position DESC,b.id DESC LIMIT 1
      ),'LIVE');
      ALTER TABLE lineageguard.runs ALTER COLUMN execution_mode SET NOT NULL;
      ALTER TABLE lineageguard.runs ADD CONSTRAINT runs_execution_mode_check
        CHECK (execution_mode IN ('LIVE','VERIFIED_REPLAY'));
      DO $$
      BEGIN
        IF EXISTS (
          SELECT 1 FROM lineageguard.run_bundles b JOIN lineageguard.runs r ON r.id=b.run_id
          WHERE b.kind='CONTEXT' AND r.execution_mode IS DISTINCT FROM
            CASE WHEN b.payload->>'outcome'='FAILED' THEN b.payload->>'mode'
              ELSE b.payload#>>'{context,collectionOrigin,mode}' END
        ) THEN
          RAISE EXCEPTION 'impact collection mode backfill postcondition failed'
            USING ERRCODE='23514';
        END IF;
      END $$;

      CREATE FUNCTION lineageguard.enforce_execution_mode_immutable() RETURNS trigger
      LANGUAGE plpgsql SET search_path=pg_catalog AS $$
      BEGIN
        IF NEW.execution_mode IS DISTINCT FROM OLD.execution_mode THEN
          RAISE EXCEPTION 'run execution mode is immutable' USING ERRCODE='23514';
        END IF;
        RETURN NEW;
      END $$;
      CREATE TRIGGER runs_execution_mode_immutable BEFORE UPDATE ON lineageguard.runs
        FOR EACH ROW EXECUTE FUNCTION lineageguard.enforce_execution_mode_immutable();

      CREATE FUNCTION lineageguard.enforce_impact_collection_mode() RETURNS trigger
      LANGUAGE plpgsql SET search_path=pg_catalog,lineageguard AS $$
      DECLARE run_mode text;
      DECLARE result_mode text;
      BEGIN
        IF NEW.kind <> 'CONTEXT' THEN RETURN NEW; END IF;
        SELECT execution_mode INTO run_mode FROM lineageguard.runs WHERE id=NEW.run_id FOR UPDATE;
        result_mode := CASE WHEN NEW.payload->>'outcome'='FAILED'
          THEN NEW.payload->>'mode' ELSE NEW.payload#>>'{context,collectionOrigin,mode}' END;
        IF result_mode IS NULL OR result_mode <> run_mode THEN
          RAISE EXCEPTION 'impact collection mode does not match immutable run mode'
            USING ERRCODE='23514';
        END IF;
        RETURN NEW;
      END $$;
      CREATE TRIGGER run_bundles_execution_mode BEFORE INSERT ON lineageguard.run_bundles
        FOR EACH ROW EXECUTE FUNCTION lineageguard.enforce_impact_collection_mode();

      ALTER TABLE lineageguard.effect_approvals ADD COLUMN expires_at timestamptz;
      ALTER TABLE lineageguard.effect_approvals ADD COLUMN payload jsonb;
      ALTER TABLE lineageguard.effect_approvals ADD COLUMN validation_receipt_id text;
      ALTER TABLE lineageguard.effect_approvals ADD COLUMN validation_receipt_fingerprint text;
      ALTER TABLE lineageguard.effect_approvals ADD COLUMN validation_completed_at timestamptz;
      ALTER TABLE lineageguard.effect_approvals DISABLE TRIGGER effect_approvals_immutable;
      UPDATE lineageguard.effect_approvals SET expires_at=created_at,payload='{}'::jsonb;
      ALTER TABLE lineageguard.effect_approvals ENABLE TRIGGER effect_approvals_immutable;
      ALTER TABLE lineageguard.effect_approvals ALTER COLUMN expires_at SET NOT NULL;
      ALTER TABLE lineageguard.effect_approvals ALTER COLUMN payload SET NOT NULL;
      ALTER TABLE lineageguard.effect_approvals
        DROP CONSTRAINT effect_approvals_run_id_kind_target_input_fingerprint_key;
      ALTER TABLE lineageguard.effect_approvals
        ADD CONSTRAINT effect_approvals_fingerprint_key UNIQUE (approval_fingerprint);
      ALTER TABLE lineageguard.effect_approvals ADD CONSTRAINT effect_approvals_payload_object
        CHECK (jsonb_typeof(payload)='object' AND pg_column_size(payload)<=16384);

      CREATE FUNCTION lineageguard.enforce_effect_approval_binding() RETURNS trigger
      LANGUAGE plpgsql SET search_path=pg_catalog,lineageguard AS $$
      DECLARE run_mode text;
      DECLARE run_status text;
      DECLARE run_lease_expires_at timestamptz;
      DECLARE current_validation record;
      BEGIN
        SELECT execution_mode,status,lease_expires_at
          INTO run_mode,run_status,run_lease_expires_at
          FROM lineageguard.runs WHERE id=NEW.run_id FOR UPDATE;
        SELECT id,payload INTO current_validation FROM lineageguard.validation_receipts
          WHERE run_id=NEW.run_id ORDER BY position DESC,id DESC LIMIT 1;
        IF run_mode <> 'LIVE' THEN
          RAISE EXCEPTION 'verified replay cannot authorize approval' USING ERRCODE='23514';
        END IF;
        IF run_status IS DISTINCT FROM
            (CASE NEW.kind WHEN 'GITHUB_REVIEW' THEN 'VALIDATED' ELSE 'WRITEBACK_PENDING' END)
          OR run_lease_expires_at<=clock_timestamp()
          OR NEW.approved_at > clock_timestamp()
          OR NEW.expires_at <= clock_timestamp()
          OR NEW.expires_at > clock_timestamp() + interval '1 hour'
          OR NEW.expires_at <= NEW.approved_at
          OR current_validation.id IS NULL
          OR NEW.validation_receipt_id IS DISTINCT FROM current_validation.id
          OR NEW.validation_receipt_fingerprint IS DISTINCT FROM encode(
            sha256(convert_to(lineageguard.canonical_json_text(jsonb_build_object(
              'domain','lineageguard.validation.signed-live-receipt.v1',
              'receipt',current_validation.payload
            )),'UTF8')),'hex'
          )
          OR NEW.validation_completed_at IS DISTINCT FROM
            (current_validation.payload#>>'{payload,completedAt}')::timestamptz
          OR NEW.approved_at < NEW.validation_completed_at
          OR NEW.payload->>'domain' IS DISTINCT FROM 'lineageguard.effect-approval.v2'
          OR NEW.payload->>'runId' IS DISTINCT FROM NEW.run_id
          OR NEW.payload->>'effectKind' IS DISTINCT FROM (CASE NEW.kind WHEN 'GITHUB_REVIEW' THEN 'GITHUB_WRITE' ELSE 'DATAHUB_WRITE' END)
          OR NEW.payload->>'target' IS DISTINCT FROM NEW.target
          OR NEW.payload->>'inputFingerprint' IS DISTINCT FROM NEW.input_fingerprint
          OR NEW.payload->>'validationReceiptId' IS DISTINCT FROM NEW.validation_receipt_id
          OR NEW.payload->>'validationReceiptFingerprint' IS DISTINCT FROM NEW.validation_receipt_fingerprint
          OR (NEW.payload->>'validationCompletedAt')::timestamptz IS DISTINCT FROM NEW.validation_completed_at
          OR NEW.payload->>'approvedBy' IS DISTINCT FROM NEW.approved_by
          OR (NEW.payload->>'approvedAt')::timestamptz IS DISTINCT FROM NEW.approved_at
          OR (NEW.payload->>'expiresAt')::timestamptz IS DISTINCT FROM NEW.expires_at
          OR NEW.approval_fingerprint IS DISTINCT FROM encode(sha256(convert_to(
            lineageguard.canonical_json_text(NEW.payload),'UTF8')),'hex')
        THEN RAISE EXCEPTION 'approval payload or expiry is not canonical' USING ERRCODE='23514'; END IF;
        RETURN NEW;
      END $$;
      CREATE TRIGGER effect_approvals_binding BEFORE INSERT ON lineageguard.effect_approvals
        FOR EACH ROW EXECUTE FUNCTION lineageguard.enforce_effect_approval_binding();

      CREATE FUNCTION lineageguard.enforce_effect_intent_authority() RETURNS trigger
      LANGUAGE plpgsql SET search_path=pg_catalog,lineageguard AS $$
      DECLARE run_mode text;
      DECLARE current_validation record;
      BEGIN
        SELECT execution_mode INTO run_mode FROM lineageguard.runs WHERE id=NEW.run_id FOR UPDATE;
        IF run_mode <> 'LIVE' THEN
          RAISE EXCEPTION 'verified replay cannot authorize external effects' USING ERRCODE='23514';
        END IF;
        SELECT id,payload INTO current_validation FROM lineageguard.validation_receipts
          WHERE run_id=NEW.run_id ORDER BY position DESC,id DESC LIMIT 1;
        IF current_validation.id IS NULL
          OR NEW.validation_receipt_id IS DISTINCT FROM current_validation.id
          OR NEW.candidate_fingerprint IS DISTINCT FROM current_validation.payload#>>'{protectedHeaders,candidateFingerprint}'
          OR NEW.artifact_set_fingerprint IS DISTINCT FROM current_validation.payload#>>'{payload,artifactSetFingerprint}'
        THEN RAISE EXCEPTION 'effect intent must bind the current same-run validation'
          USING ERRCODE='23514'; END IF;
        RETURN NEW;
      END $$;
      CREATE TRIGGER external_effect_intents_live BEFORE INSERT ON lineageguard.external_effect_intents
        FOR EACH ROW EXECUTE FUNCTION lineageguard.enforce_effect_intent_authority();

      CREATE FUNCTION lineageguard.enforce_effect_receipt_payload_binding() RETURNS trigger
      LANGUAGE plpgsql SET search_path=pg_catalog,lineageguard AS $$
      DECLARE intent lineageguard.external_effect_intents%ROWTYPE;
      DECLARE current_validation record;
      BEGIN
        SELECT * INTO intent FROM lineageguard.external_effect_intents WHERE id=NEW.intent_id;
        SELECT id,payload INTO current_validation FROM lineageguard.validation_receipts
          WHERE run_id=intent.run_id ORDER BY position DESC,id DESC LIMIT 1;
        IF NEW.payload->>'intentId' IS DISTINCT FROM intent.id
          OR NEW.payload->>'runId' IS DISTINCT FROM intent.run_id
          OR NEW.payload->>'effectKind' IS DISTINCT FROM intent.kind
          OR NEW.payload->>'target' IS DISTINCT FROM intent.target
          OR NEW.payload->>'inputFingerprint' IS DISTINCT FROM intent.input_fingerprint
          OR NEW.payload->>'validationReceiptId' IS DISTINCT FROM intent.validation_receipt_id
          OR NEW.payload->>'candidateFingerprint' IS DISTINCT FROM intent.candidate_fingerprint
          OR NEW.payload->>'artifactSetFingerprint' IS DISTINCT FROM intent.artifact_set_fingerprint
          OR NEW.validation_receipt_id IS DISTINCT FROM intent.validation_receipt_id
          OR NEW.candidate_fingerprint IS DISTINCT FROM intent.candidate_fingerprint
          OR NEW.artifact_set_fingerprint IS DISTINCT FROM intent.artifact_set_fingerprint
          OR current_validation.id IS DISTINCT FROM intent.validation_receipt_id
          OR intent.candidate_fingerprint IS DISTINCT FROM current_validation.payload#>>'{protectedHeaders,candidateFingerprint}'
          OR intent.artifact_set_fingerprint IS DISTINCT FROM current_validation.payload#>>'{payload,artifactSetFingerprint}'
        THEN RAISE EXCEPTION 'effect receipt payload binding mismatch' USING ERRCODE='23514'; END IF;
        RETURN NEW;
      END $$;
      CREATE TRIGGER external_effect_receipts_payload_binding
        BEFORE INSERT ON lineageguard.external_effect_receipts
        FOR EACH ROW EXECUTE FUNCTION lineageguard.enforce_effect_receipt_payload_binding();

      CREATE FUNCTION lineageguard.enforce_effect_attempt_authority() RETURNS trigger
      LANGUAGE plpgsql SET search_path=pg_catalog,lineageguard AS $$
      DECLARE intent lineageguard.external_effect_intents%ROWTYPE;
      DECLARE run lineageguard.runs%ROWTYPE;
      BEGIN
        SELECT * INTO intent FROM lineageguard.external_effect_intents WHERE id=NEW.intent_id;
        SELECT * INTO run FROM lineageguard.runs WHERE id=intent.run_id FOR UPDATE;
        IF NEW.state<>'READY_TO_INVOKE' OR run.id IS NULL OR run.execution_mode<>'LIVE'
          OR run.status<>(CASE intent.kind WHEN 'GITHUB_REVIEW' THEN 'VALIDATED' ELSE 'WRITEBACK_PENDING' END)
          OR run.lease_expires_at<=clock_timestamp() OR NEW.claimed_at>clock_timestamp()
          OR NEW.claim_expires_at<=NEW.claimed_at OR NEW.claim_expires_at>run.lease_expires_at
          OR intent.validation_receipt_id IS DISTINCT FROM (
            SELECT id FROM lineageguard.validation_receipts WHERE run_id=run.id
            ORDER BY position DESC,id DESC LIMIT 1
          )
        THEN RAISE EXCEPTION 'effect attempt authority rejected' USING ERRCODE='23514'; END IF;
        RETURN NEW;
      END $$;
      CREATE TRIGGER external_effect_attempts_authority BEFORE INSERT
        ON lineageguard.external_effect_attempts FOR EACH ROW
        EXECUTE FUNCTION lineageguard.enforce_effect_attempt_authority();

      CREATE FUNCTION lineageguard.enforce_effect_outcome_authority() RETURNS trigger
      LANGUAGE plpgsql SET search_path=pg_catalog,lineageguard AS $$
      DECLARE latest_attempt lineageguard.external_effect_attempts%ROWTYPE;
      DECLARE proof text;
      BEGIN
        SELECT * INTO latest_attempt FROM lineageguard.external_effect_attempts
          WHERE intent_id=NEW.intent_id ORDER BY attempt DESC LIMIT 1;
        IF TG_TABLE_NAME='external_effect_receipts' THEN
          SELECT proof_outcome INTO proof FROM lineageguard.external_effect_reconciliations
            WHERE attempt_id=latest_attempt.id;
          IF latest_attempt.id IS NULL OR NOT (
            (latest_attempt.state='READY_TO_INVOKE' AND latest_attempt.claim_expires_at>clock_timestamp())
            OR (latest_attempt.state='RECONCILIATION_REQUIRED' AND proof='APPLIED')
          ) THEN RAISE EXCEPTION 'effect receipt lacks current invocation authority'
            USING ERRCODE='23514'; END IF;
        ELSE
          IF latest_attempt.id IS NULL OR latest_attempt.state<>'READY_TO_INVOKE'
            OR latest_attempt.claim_expires_at<=clock_timestamp()
          THEN RAISE EXCEPTION 'effect failure lacks current invocation authority'
            USING ERRCODE='23514'; END IF;
        END IF;
        RETURN NEW;
      END $$;
      CREATE TRIGGER external_effect_receipts_authority BEFORE INSERT
        ON lineageguard.external_effect_receipts FOR EACH ROW
        EXECUTE FUNCTION lineageguard.enforce_effect_outcome_authority();
      CREATE TRIGGER external_effect_failures_authority BEFORE INSERT
        ON lineageguard.external_effect_failures FOR EACH ROW
        EXECUTE FUNCTION lineageguard.enforce_effect_outcome_authority();

      CREATE FUNCTION lineageguard.enforce_effect_reconciliation_authority() RETURNS trigger
      LANGUAGE plpgsql SET search_path=pg_catalog,lineageguard AS $$
      DECLARE attempt lineageguard.external_effect_attempts%ROWTYPE;
      BEGIN
        SELECT * INTO attempt FROM lineageguard.external_effect_attempts WHERE id=NEW.attempt_id;
        IF attempt.id IS NULL OR attempt.state<>'RECONCILIATION_REQUIRED'
          OR attempt.attempt IS DISTINCT FROM (
            SELECT max(current_attempt.attempt) FROM lineageguard.external_effect_attempts current_attempt
            WHERE current_attempt.intent_id=attempt.intent_id
          )
        THEN RAISE EXCEPTION 'effect reconciliation authority rejected' USING ERRCODE='23514'; END IF;
        RETURN NEW;
      END $$;
      CREATE TRIGGER external_effect_reconciliations_authority BEFORE INSERT
        ON lineageguard.external_effect_reconciliations FOR EACH ROW
        EXECUTE FUNCTION lineageguard.enforce_effect_reconciliation_authority();

      CREATE FUNCTION lineageguard.enforce_run_effect_completion() RETURNS trigger
      LANGUAGE plpgsql SET search_path=pg_catalog,lineageguard AS $$
      DECLARE github_binding record;
      DECLARE datahub_binding record;
      DECLARE github_count bigint;
      DECLARE datahub_count bigint;
      BEGIN
        IF NEW.status NOT IN ('REVIEW_ARTIFACT_CREATED','COMPLETED') OR NEW.status=OLD.status THEN
          RETURN NEW;
        END IF;
        IF NEW.execution_mode <> 'LIVE' THEN
          RAISE EXCEPTION 'verified replay cannot complete external effects' USING ERRCODE='23514';
        END IF;
        SELECT count(*) INTO github_count
          FROM lineageguard.external_effect_intents i
          JOIN lineageguard.external_effect_receipts r ON r.intent_id=i.id
          JOIN lineageguard.validation_receipts v ON v.id=i.validation_receipt_id
          WHERE i.run_id=NEW.id AND i.kind='GITHUB_REVIEW'
            AND v.id=(SELECT id FROM lineageguard.validation_receipts WHERE run_id=NEW.id
              ORDER BY position DESC,id DESC LIMIT 1)
            AND i.candidate_fingerprint=v.payload#>>'{protectedHeaders,candidateFingerprint}'
            AND i.artifact_set_fingerprint=v.payload#>>'{payload,artifactSetFingerprint}';
        IF github_count <> 1 THEN
          RAISE EXCEPTION 'exactly one GitHub receipt binding is required' USING ERRCODE='23514';
        END IF;
        SELECT r.validation_receipt_id,r.candidate_fingerprint,r.artifact_set_fingerprint
          INTO github_binding
          FROM lineageguard.external_effect_intents i
          JOIN lineageguard.external_effect_receipts r ON r.intent_id=i.id
          JOIN lineageguard.validation_receipts v ON v.id=i.validation_receipt_id
          WHERE i.run_id=NEW.id AND i.kind='GITHUB_REVIEW'
            AND v.id=(SELECT id FROM lineageguard.validation_receipts WHERE run_id=NEW.id
              ORDER BY position DESC,id DESC LIMIT 1)
            AND i.candidate_fingerprint=v.payload#>>'{protectedHeaders,candidateFingerprint}'
            AND i.artifact_set_fingerprint=v.payload#>>'{payload,artifactSetFingerprint}';
        IF github_binding.validation_receipt_id IS NULL THEN
          RAISE EXCEPTION 'GitHub receipt binding missing' USING ERRCODE='23514';
        END IF;
        IF NEW.status='COMPLETED' THEN
          SELECT count(*) INTO datahub_count
            FROM lineageguard.external_effect_intents i
            JOIN lineageguard.external_effect_receipts r ON r.intent_id=i.id
            JOIN lineageguard.validation_receipts v ON v.id=i.validation_receipt_id
            WHERE i.run_id=NEW.id AND i.kind='DATAHUB_WRITEBACK'
              AND v.id=(SELECT id FROM lineageguard.validation_receipts WHERE run_id=NEW.id
                ORDER BY position DESC,id DESC LIMIT 1)
              AND i.candidate_fingerprint=v.payload#>>'{protectedHeaders,candidateFingerprint}'
              AND i.artifact_set_fingerprint=v.payload#>>'{payload,artifactSetFingerprint}';
          IF datahub_count <> 1 THEN
            RAISE EXCEPTION 'exactly one DataHub receipt binding is required' USING ERRCODE='23514';
          END IF;
          SELECT r.validation_receipt_id,r.candidate_fingerprint,r.artifact_set_fingerprint
            INTO datahub_binding
            FROM lineageguard.external_effect_intents i
            JOIN lineageguard.external_effect_receipts r ON r.intent_id=i.id
            JOIN lineageguard.validation_receipts v ON v.id=i.validation_receipt_id
            WHERE i.run_id=NEW.id AND i.kind='DATAHUB_WRITEBACK'
              AND v.id=(SELECT id FROM lineageguard.validation_receipts WHERE run_id=NEW.id
                ORDER BY position DESC,id DESC LIMIT 1)
              AND i.candidate_fingerprint=v.payload#>>'{protectedHeaders,candidateFingerprint}'
              AND i.artifact_set_fingerprint=v.payload#>>'{payload,artifactSetFingerprint}';
          IF datahub_binding.validation_receipt_id IS NULL
            OR (github_binding.validation_receipt_id,github_binding.candidate_fingerprint,
                github_binding.artifact_set_fingerprint) IS DISTINCT FROM
               (datahub_binding.validation_receipt_id,datahub_binding.candidate_fingerprint,
                datahub_binding.artifact_set_fingerprint)
          THEN RAISE EXCEPTION 'completed effects do not share exact binding' USING ERRCODE='23514'; END IF;
        END IF;
        RETURN NEW;
      END $$;
      CREATE TRIGGER runs_effect_completion BEFORE UPDATE OF status ON lineageguard.runs
        FOR EACH ROW EXECUTE FUNCTION lineageguard.enforce_run_effect_completion();

      CREATE TABLE lineageguard.effect_invocation_reservations (
        id text PRIMARY KEY CHECK (id ~ '^effect_reservation_[a-f0-9]{24}$'),
        run_id text NOT NULL REFERENCES lineageguard.runs(id) ON DELETE RESTRICT,
        intent_id text NOT NULL UNIQUE REFERENCES lineageguard.external_effect_intents(id) ON DELETE RESTRICT,
        idempotency_key text NOT NULL,
        kind text NOT NULL CHECK (kind IN ('GITHUB_REVIEW','DATAHUB_WRITEBACK')),
        target text NOT NULL,
        input_fingerprint text NOT NULL CHECK (input_fingerprint ~ '^[a-f0-9]{64}$'),
        validation_receipt_id text NOT NULL REFERENCES lineageguard.validation_receipts(id) ON DELETE RESTRICT,
        validation_receipt_fingerprint text NOT NULL CHECK (validation_receipt_fingerprint ~ '^[a-f0-9]{64}$'),
        approval_fingerprint text NOT NULL CHECK (approval_fingerprint ~ '^[a-f0-9]{64}$'),
        event_prefix_fingerprint text NOT NULL CHECK (event_prefix_fingerprint ~ '^[a-f0-9]{64}$'),
        lease_id text NOT NULL,
        worker_id text NOT NULL,
        generation integer NOT NULL CHECK (generation > 0),
        token_hash text NOT NULL UNIQUE CHECK (token_hash ~ '^[a-f0-9]{64}$'),
        invoke_by timestamptz NOT NULL,
        state text NOT NULL DEFAULT 'RESERVED' CHECK (state IN ('RESERVED','CONSUMED')),
        consumed_at timestamptz,
        created_at timestamptz NOT NULL DEFAULT clock_timestamp()
      );

      CREATE FUNCTION lineageguard.enforce_active_effect_reservation() RETURNS trigger
      LANGUAGE plpgsql SET search_path=pg_catalog,lineageguard AS $$
      BEGIN
        IF EXISTS(
          SELECT 1 FROM lineageguard.effect_invocation_reservations r
          WHERE r.run_id=OLD.id AND r.state='RESERVED' AND r.invoke_by>clock_timestamp()
        ) AND (
          NEW.status IS DISTINCT FROM OLD.status OR NEW.lease_id IS DISTINCT FROM OLD.lease_id
          OR NEW.worker_id IS DISTINCT FROM OLD.worker_id
          OR NEW.lease_generation IS DISTINCT FROM OLD.lease_generation
        ) THEN
          RAISE EXCEPTION 'active effect reservation blocks transition or lease reassignment'
            USING ERRCODE='23514';
        END IF;
        RETURN NEW;
      END $$;
      CREATE TRIGGER runs_active_effect_reservation
        BEFORE UPDATE OF status,lease_id,worker_id,lease_generation ON lineageguard.runs
        FOR EACH ROW EXECUTE FUNCTION lineageguard.enforce_active_effect_reservation();

      CREATE FUNCTION lineageguard.authority_reserve_effect(
        p_id text,p_run_id text,p_intent_id text,p_idempotency_key text,p_kind text,p_target text,
        p_input_fingerprint text,p_validation_receipt_id text,p_validation_receipt_fingerprint text,
        p_approval_fingerprint text,p_event_prefix_fingerprint text,p_lease_id text,p_worker_id text,
        p_generation integer,p_expected_version bigint,p_token_hash text,p_invoke_by timestamptz
      ) RETURNS SETOF lineageguard.effect_invocation_reservations LANGUAGE plpgsql SECURITY DEFINER
      SET search_path=pg_catalog,lineageguard AS $$
      DECLARE current_run lineageguard.runs%ROWTYPE;
      DECLARE current_intent lineageguard.external_effect_intents%ROWTYPE;
      DECLARE current_validation record;
      DECLARE current_approval lineageguard.effect_approvals%ROWTYPE;
      BEGIN
        SELECT * INTO current_run FROM lineageguard.runs WHERE id=p_run_id FOR UPDATE;
        IF current_run.id IS NULL OR current_run.execution_mode<>'LIVE'
          OR current_run.version<>p_expected_version
          OR current_run.status<>(CASE p_kind WHEN 'GITHUB_REVIEW' THEN 'VALIDATED' ELSE 'WRITEBACK_PENDING' END)
          OR current_run.lease_id IS DISTINCT FROM p_lease_id
          OR current_run.worker_id IS DISTINCT FROM p_worker_id
          OR current_run.lease_generation IS DISTINCT FROM p_generation
          OR current_run.lease_expires_at<=clock_timestamp() OR p_invoke_by>current_run.lease_expires_at
        THEN RAISE EXCEPTION 'effect reservation run authority rejected' USING ERRCODE='23514'; END IF;
        SELECT * INTO current_intent FROM lineageguard.external_effect_intents WHERE id=p_intent_id;
        IF current_intent.id IS NULL OR current_intent.run_id<>p_run_id
          OR current_intent.idempotency_key<>p_idempotency_key OR current_intent.kind<>p_kind
          OR current_intent.target<>p_target OR current_intent.input_fingerprint<>p_input_fingerprint
        THEN RAISE EXCEPTION 'effect reservation intent binding rejected' USING ERRCODE='23514'; END IF;
        SELECT id,payload INTO current_validation FROM lineageguard.validation_receipts
          WHERE run_id=p_run_id ORDER BY position DESC,id DESC LIMIT 1;
        IF current_validation.id IS DISTINCT FROM p_validation_receipt_id
          OR p_validation_receipt_fingerprint IS DISTINCT FROM encode(sha256(convert_to(
            lineageguard.canonical_json_text(jsonb_build_object(
              'domain','lineageguard.validation.signed-live-receipt.v1','receipt',current_validation.payload
            )),'UTF8')),'hex')
        THEN RAISE EXCEPTION 'effect reservation validation binding rejected' USING ERRCODE='23514'; END IF;
        SELECT * INTO current_approval FROM lineageguard.effect_approvals
          WHERE run_id=p_run_id AND kind=p_kind AND target=p_target
            AND input_fingerprint=p_input_fingerprint AND expires_at>clock_timestamp()
          ORDER BY created_at DESC,id DESC LIMIT 1;
        IF current_approval.id IS NULL OR current_approval.approval_fingerprint<>p_approval_fingerprint
          OR current_approval.validation_receipt_id<>p_validation_receipt_id
          OR current_approval.validation_receipt_fingerprint<>p_validation_receipt_fingerprint
          OR p_invoke_by>current_approval.expires_at OR p_invoke_by<=clock_timestamp()
        THEN RAISE EXCEPTION 'effect reservation approval binding rejected' USING ERRCODE='23514'; END IF;
        RETURN QUERY INSERT INTO lineageguard.effect_invocation_reservations(
          id,run_id,intent_id,idempotency_key,kind,target,input_fingerprint,validation_receipt_id,
          validation_receipt_fingerprint,approval_fingerprint,event_prefix_fingerprint,lease_id,
          worker_id,generation,token_hash,invoke_by
        ) VALUES(p_id,p_run_id,p_intent_id,p_idempotency_key,p_kind,p_target,p_input_fingerprint,
          p_validation_receipt_id,p_validation_receipt_fingerprint,p_approval_fingerprint,
          p_event_prefix_fingerprint,p_lease_id,p_worker_id,p_generation,p_token_hash,p_invoke_by)
        RETURNING *;
      END $$;

      CREATE FUNCTION lineageguard.authority_consume_effect(
        p_id text,p_token_hash text,p_run_id text,p_intent_id text,p_idempotency_key text,
        p_kind text,p_input_fingerprint text,p_target text
      ) RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,lineageguard AS $$
      DECLARE changed bigint;
      BEGIN
        UPDATE lineageguard.effect_invocation_reservations SET state='CONSUMED',consumed_at=clock_timestamp()
          WHERE id=p_id AND token_hash=p_token_hash AND run_id=p_run_id AND intent_id=p_intent_id
            AND idempotency_key=p_idempotency_key AND kind=p_kind AND input_fingerprint=p_input_fingerprint
            AND target=p_target AND state='RESERVED' AND invoke_by>clock_timestamp();
        GET DIAGNOSTICS changed=ROW_COUNT;
        IF changed<>1 THEN RAISE EXCEPTION 'effect reservation is invalid, expired, or consumed'
          USING ERRCODE='23514'; END IF;
      END $$;

      CREATE FUNCTION lineageguard.transition_run(
        p_run_id text,p_from text,p_to text,p_lease_id text,p_worker_id text,p_generation integer,
        p_occurred_at timestamptz,p_event jsonb,p_expected_version bigint
      ) RETURNS SETOF lineageguard.runs LANGUAGE plpgsql SECURITY DEFINER
      SET search_path=pg_catalog,lineageguard AS $$
      BEGIN
        PERFORM 1 FROM lineageguard.runs
          WHERE id=p_run_id AND version=p_expected_version
          FOR UPDATE;
        IF NOT FOUND THEN
          RAISE EXCEPTION 'transition version fence rejected' USING ERRCODE='23514';
        END IF;
        RETURN QUERY SELECT * FROM lineageguard.transition_run(
          p_run_id,p_from,p_to,p_lease_id,p_worker_id,p_generation,p_occurred_at,p_event
        );
      END $$;
      REVOKE ALL ON FUNCTION lineageguard.transition_run(
        text,text,text,text,text,integer,timestamptz,jsonb,bigint
      ) FROM PUBLIC;
      ALTER FUNCTION lineageguard.transition_run(text,text,text,text,text,integer,timestamptz,jsonb)
        OWNER TO lineageguard_procedure_owner;
      ALTER FUNCTION lineageguard.transition_run(text,text,text,text,text,integer,timestamptz,jsonb,bigint)
        OWNER TO lineageguard_procedure_owner;

      CREATE FUNCTION lineageguard.authority_insert_validation_receipt(
        p_id text,p_run_id text,p_position integer,p_payload jsonb,p_lease_id text,p_worker_id text,
        p_generation integer,p_expected_version bigint,p_require_live boolean
      ) RETURNS SETOF lineageguard.validation_receipts LANGUAGE plpgsql SECURITY DEFINER
      SET search_path=pg_catalog,lineageguard AS $$
      DECLARE current_run lineageguard.runs%ROWTYPE;
      DECLARE current_candidate jsonb;
      DECLARE current_events jsonb;
      BEGIN
        SELECT * INTO current_run FROM lineageguard.runs WHERE id=p_run_id FOR UPDATE;
        SELECT payload INTO current_candidate FROM lineageguard.migration_candidates
          WHERE run_id=p_run_id ORDER BY position DESC,id DESC LIMIT 1;
        SELECT jsonb_agg(payload ORDER BY sequence) INTO current_events
          FROM lineageguard.run_events WHERE run_id=p_run_id;
        IF current_run.id IS NULL OR current_run.status<>'VALIDATING'
          OR current_run.lease_id IS DISTINCT FROM p_lease_id
          OR current_run.worker_id IS DISTINCT FROM p_worker_id
          OR current_run.lease_generation IS DISTINCT FROM p_generation
          OR current_run.version<>p_expected_version OR current_run.lease_expires_at<=clock_timestamp()
          OR (p_require_live AND current_run.execution_mode<>'LIVE')
          OR p_payload#>>'{protectedHeaders,runId}' IS DISTINCT FROM p_run_id
          OR p_payload#>>'{protectedHeaders,candidateFingerprint}' IS DISTINCT FROM encode(sha256(
            convert_to(lineageguard.canonical_json_text(current_candidate),'UTF8')),'hex')
          OR p_payload#>>'{protectedHeaders,authorizedRunEventStreamFingerprint}' IS DISTINCT FROM
            encode(sha256(convert_to(lineageguard.canonical_json_text(jsonb_build_object(
              'domain','lineageguard.validation.authorized-run-stream.v1','events',current_events
            )),'UTF8')),'hex')
        THEN RAISE EXCEPTION 'validation receipt authority rejected' USING ERRCODE='23514'; END IF;
        RETURN QUERY INSERT INTO lineageguard.validation_receipts(id,run_id,position,payload)
          VALUES(p_id,p_run_id,p_position,p_payload) RETURNING *;
        UPDATE lineageguard.runs SET version=version+1,updated_at=clock_timestamp() WHERE id=p_run_id;
      END;
      $$;
      CREATE FUNCTION lineageguard.authority_insert_effect_approval(
        p_id text,p_run_id text,p_kind text,p_target text,p_input_fingerprint text,
        p_validation_receipt_id text,p_validation_receipt_fingerprint text,
        p_validation_completed_at timestamptz,p_approved_by text,
        p_approved_at timestamptz,p_expires_at timestamptz,
        p_payload jsonb,p_approval_fingerprint text
      ) RETURNS SETOF lineageguard.effect_approvals LANGUAGE sql SECURITY DEFINER
      SET search_path=pg_catalog,lineageguard AS $$
        INSERT INTO lineageguard.effect_approvals(
          id,run_id,kind,target,input_fingerprint,validation_receipt_id,
          validation_receipt_fingerprint,validation_completed_at,approved_by,approved_at,expires_at,payload,
          approval_fingerprint
        ) VALUES(
          p_id,p_run_id,p_kind,p_target,p_input_fingerprint,p_validation_receipt_id,
          p_validation_receipt_fingerprint,p_validation_completed_at,p_approved_by,p_approved_at,p_expires_at,
          p_payload,p_approval_fingerprint
        ) ON CONFLICT (approval_fingerprint) DO NOTHING RETURNING *
      $$;
      CREATE FUNCTION lineageguard.authority_insert_effect_intent(
        p_id text,p_run_id text,p_kind text,p_target text,p_idempotency_key text,
        p_input_fingerprint text,p_input jsonb,p_validation_receipt_id text,
        p_candidate_fingerprint text,p_artifact_set_fingerprint text,p_lease_id text,p_worker_id text,
        p_generation integer,p_expected_version bigint
      ) RETURNS SETOF lineageguard.external_effect_intents LANGUAGE plpgsql SECURITY DEFINER
      SET search_path=pg_catalog,lineageguard AS $$
      DECLARE current_run lineageguard.runs%ROWTYPE;
      BEGIN
        SELECT * INTO current_run FROM lineageguard.runs WHERE id=p_run_id FOR UPDATE;
        IF current_run.id IS NULL OR current_run.execution_mode<>'LIVE'
          OR current_run.status<>(CASE p_kind WHEN 'GITHUB_REVIEW' THEN 'VALIDATED' ELSE 'WRITEBACK_PENDING' END)
          OR current_run.lease_id IS DISTINCT FROM p_lease_id
          OR current_run.worker_id IS DISTINCT FROM p_worker_id
          OR current_run.lease_generation IS DISTINCT FROM p_generation
          OR current_run.version<>p_expected_version OR current_run.lease_expires_at<=clock_timestamp()
        THEN RAISE EXCEPTION 'effect intent authority rejected' USING ERRCODE='23514'; END IF;
        RETURN QUERY INSERT INTO lineageguard.external_effect_intents(
          id,run_id,kind,target,idempotency_key,input_fingerprint,input,validation_receipt_id,
          candidate_fingerprint,artifact_set_fingerprint
        ) VALUES(
          p_id,p_run_id,p_kind,p_target,p_idempotency_key,p_input_fingerprint,p_input,
          p_validation_receipt_id,p_candidate_fingerprint,p_artifact_set_fingerprint
        ) RETURNING *;
        UPDATE lineageguard.runs SET version=version+1,updated_at=clock_timestamp() WHERE id=p_run_id;
      END;
      $$;
      CREATE FUNCTION lineageguard.authority_insert_effect_attempt(
        p_id text,p_intent_id text,p_attempt integer,p_worker_id text,p_fencing_token text,
        p_state text,p_claimed_at timestamptz,p_claim_expires_at timestamptz,p_updated_at timestamptz
      ) RETURNS SETOF lineageguard.external_effect_attempts LANGUAGE sql SECURITY DEFINER
      SET search_path=pg_catalog,lineageguard AS $$
        INSERT INTO lineageguard.external_effect_attempts(
          id,intent_id,attempt,worker_id,fencing_token,state,claimed_at,claim_expires_at,updated_at
        ) VALUES(
          p_id,p_intent_id,p_attempt,p_worker_id,p_fencing_token,p_state,p_claimed_at,
          p_claim_expires_at,p_updated_at
        ) RETURNING *
      $$;
      CREATE FUNCTION lineageguard.authority_set_effect_attempt_state(
        p_id text,p_state text,p_updated_at timestamptz
      ) RETURNS SETOF lineageguard.external_effect_attempts LANGUAGE sql SECURITY DEFINER
      SET search_path=pg_catalog,lineageguard AS $$
        UPDATE lineageguard.external_effect_attempts SET state=p_state,updated_at=p_updated_at
        WHERE id=p_id RETURNING *
      $$;
      CREATE FUNCTION lineageguard.authority_insert_effect_receipt(
        p_id text,p_intent_id text,p_payload jsonb,p_validation_receipt_id text,
        p_candidate_fingerprint text,p_artifact_set_fingerprint text
      ) RETURNS SETOF lineageguard.external_effect_receipts LANGUAGE sql SECURITY DEFINER
      SET search_path=pg_catalog,lineageguard AS $$
        INSERT INTO lineageguard.external_effect_receipts(
          id,intent_id,payload,validation_receipt_id,candidate_fingerprint,artifact_set_fingerprint
        ) VALUES(
          p_id,p_intent_id,p_payload,p_validation_receipt_id,p_candidate_fingerprint,
          p_artifact_set_fingerprint
        ) ON CONFLICT (intent_id) DO NOTHING RETURNING *
      $$;
      CREATE FUNCTION lineageguard.authority_insert_effect_failure(
        p_id text,p_intent_id text,p_run_id text,p_position integer,p_outcome text,p_payload jsonb
      ) RETURNS SETOF lineageguard.external_effect_failures LANGUAGE sql SECURITY DEFINER
      SET search_path=pg_catalog,lineageguard AS $$
        INSERT INTO lineageguard.external_effect_failures(
          id,intent_id,run_id,position,outcome,payload
        ) VALUES(p_id,p_intent_id,p_run_id,p_position,p_outcome,p_payload) RETURNING *
      $$;
      CREATE FUNCTION lineageguard.authority_insert_effect_reconciliation(
        p_id text,p_attempt_id text,p_proof_outcome text,p_payload jsonb
      ) RETURNS SETOF lineageguard.external_effect_reconciliations LANGUAGE sql SECURITY DEFINER
      SET search_path=pg_catalog,lineageguard AS $$
        INSERT INTO lineageguard.external_effect_reconciliations(
          id,attempt_id,proof_outcome,payload
        ) VALUES(p_id,p_attempt_id,p_proof_outcome,p_payload)
        ON CONFLICT (attempt_id) DO NOTHING RETURNING *
      $$;

      ALTER FUNCTION lineageguard.authority_insert_validation_receipt(text,text,integer,jsonb,text,text,integer,bigint,boolean)
        OWNER TO lineageguard_procedure_owner;
      ALTER FUNCTION lineageguard.authority_insert_effect_approval(
        text,text,text,text,text,text,text,timestamptz,text,timestamptz,timestamptz,jsonb,text
      ) OWNER TO lineageguard_procedure_owner;
      ALTER FUNCTION lineageguard.authority_insert_effect_intent(
        text,text,text,text,text,text,jsonb,text,text,text,text,text,integer,bigint
      ) OWNER TO lineageguard_procedure_owner;
      ALTER FUNCTION lineageguard.authority_insert_effect_attempt(
        text,text,integer,text,text,text,timestamptz,timestamptz,timestamptz
      ) OWNER TO lineageguard_procedure_owner;
      ALTER FUNCTION lineageguard.authority_set_effect_attempt_state(text,text,timestamptz)
        OWNER TO lineageguard_procedure_owner;
      ALTER FUNCTION lineageguard.authority_insert_effect_receipt(text,text,jsonb,text,text,text)
        OWNER TO lineageguard_procedure_owner;
      ALTER FUNCTION lineageguard.authority_insert_effect_failure(text,text,text,integer,text,jsonb)
        OWNER TO lineageguard_procedure_owner;
      ALTER FUNCTION lineageguard.authority_insert_effect_reconciliation(text,text,text,jsonb)
        OWNER TO lineageguard_procedure_owner;
      ALTER FUNCTION lineageguard.authority_reserve_effect(text,text,text,text,text,text,text,text,text,text,text,text,text,integer,bigint,text,timestamptz)
        OWNER TO lineageguard_procedure_owner;
      ALTER FUNCTION lineageguard.authority_consume_effect(text,text,text,text,text,text,text,text)
        OWNER TO lineageguard_procedure_owner;

      REVOKE ALL ON FUNCTION lineageguard.authority_insert_validation_receipt(text,text,integer,jsonb,text,text,integer,bigint,boolean) FROM PUBLIC;
      REVOKE ALL ON FUNCTION lineageguard.authority_insert_effect_approval(text,text,text,text,text,text,text,timestamptz,text,timestamptz,timestamptz,jsonb,text) FROM PUBLIC;
      REVOKE ALL ON FUNCTION lineageguard.authority_insert_effect_intent(text,text,text,text,text,text,jsonb,text,text,text,text,text,integer,bigint) FROM PUBLIC;
      REVOKE ALL ON FUNCTION lineageguard.authority_insert_effect_attempt(text,text,integer,text,text,text,timestamptz,timestamptz,timestamptz) FROM PUBLIC;
      REVOKE ALL ON FUNCTION lineageguard.authority_set_effect_attempt_state(text,text,timestamptz) FROM PUBLIC;
      REVOKE ALL ON FUNCTION lineageguard.authority_insert_effect_receipt(text,text,jsonb,text,text,text) FROM PUBLIC;
      REVOKE ALL ON FUNCTION lineageguard.authority_insert_effect_failure(text,text,text,integer,text,jsonb) FROM PUBLIC;
      REVOKE ALL ON FUNCTION lineageguard.authority_insert_effect_reconciliation(text,text,text,jsonb) FROM PUBLIC;
      REVOKE ALL ON FUNCTION lineageguard.authority_reserve_effect(text,text,text,text,text,text,text,text,text,text,text,text,text,integer,bigint,text,timestamptz) FROM PUBLIC;
      REVOKE ALL ON FUNCTION lineageguard.authority_consume_effect(text,text,text,text,text,text,text,text) FROM PUBLIC;
    `,
  },
  {
    id: "0005_atomic_mutation_authority",
    sql: `
      ALTER TABLE lineageguard.effect_approvals
        ADD COLUMN approval_assertion jsonb;
      ALTER TABLE lineageguard.effect_approvals DISABLE TRIGGER effect_approvals_immutable;
      UPDATE lineageguard.effect_approvals
        SET expires_at=LEAST(expires_at,created_at)
        WHERE approval_assertion IS NULL
          OR approval_assertion#>>'{protectedHeaders,schemaVersion}' IS DISTINCT FROM '2';
      ALTER TABLE lineageguard.effect_approvals ENABLE TRIGGER effect_approvals_immutable;

      DO $$ BEGIN
        IF EXISTS(SELECT 1 FROM lineageguard.effect_invocation_reservations) THEN
          RAISE EXCEPTION 'legacy effect reservations require explicit reconciliation before upgrade'
            USING ERRCODE='23514';
        END IF;
      END $$;
      DROP TRIGGER runs_active_effect_reservation ON lineageguard.runs;
      DROP FUNCTION lineageguard.enforce_active_effect_reservation();
      DROP TRIGGER external_effect_attempts_authority ON lineageguard.external_effect_attempts;
      DROP FUNCTION lineageguard.enforce_effect_attempt_authority();
      DROP FUNCTION lineageguard.authority_reserve_effect(text,text,text,text,text,text,text,text,text,text,text,text,text,integer,bigint,text,timestamptz);
      DROP FUNCTION lineageguard.authority_consume_effect(text,text,text,text,text,text,text,text);
      DROP FUNCTION lineageguard.authority_insert_validation_receipt(text,text,integer,jsonb,text,text,integer,bigint,boolean);
      DROP FUNCTION lineageguard.authority_insert_effect_approval(text,text,text,text,text,text,text,timestamptz,text,timestamptz,timestamptz,jsonb,text);
      DROP FUNCTION lineageguard.authority_insert_effect_intent(text,text,text,text,text,text,jsonb,text,text,text,text,text,integer,bigint);
      DROP FUNCTION lineageguard.authority_insert_effect_attempt(text,text,integer,text,text,text,timestamptz,timestamptz,timestamptz);
      DROP FUNCTION lineageguard.authority_set_effect_attempt_state(text,text,timestamptz);
      DROP FUNCTION lineageguard.authority_insert_effect_receipt(text,text,jsonb,text,text,text);
      DROP FUNCTION lineageguard.authority_insert_effect_failure(text,text,text,integer,text,jsonb);
      DROP FUNCTION lineageguard.authority_insert_effect_reconciliation(text,text,text,jsonb);
      DROP TABLE lineageguard.effect_invocation_reservations;

      CREATE OR REPLACE FUNCTION lineageguard.enforce_effect_approval_binding() RETURNS trigger
      LANGUAGE plpgsql SET search_path=pg_catalog,lineageguard AS $$
      DECLARE current_run lineageguard.runs%ROWTYPE;
      DECLARE current_validation record;
      BEGIN
        SELECT * INTO current_run FROM lineageguard.runs WHERE id=NEW.run_id FOR UPDATE;
        SELECT id,payload INTO current_validation FROM lineageguard.validation_receipts
          WHERE run_id=NEW.run_id ORDER BY position DESC,id DESC LIMIT 1;
        IF current_run.execution_mode<>'LIVE'
          OR current_run.status<>(CASE NEW.kind WHEN 'GITHUB_REVIEW' THEN 'VALIDATED' ELSE 'WRITEBACK_PENDING' END)
          OR current_run.lease_expires_at<=clock_timestamp()
          OR NEW.approved_at>clock_timestamp() OR NEW.expires_at<=clock_timestamp()
          OR NEW.expires_at>clock_timestamp()+interval '1 hour' OR NEW.expires_at<=NEW.approved_at
          OR current_validation.id IS NULL
          OR NEW.validation_receipt_id IS DISTINCT FROM current_validation.id
          OR NEW.validation_receipt_fingerprint IS DISTINCT FROM encode(sha256(convert_to(
            lineageguard.canonical_json_text(jsonb_build_object(
              'domain','lineageguard.validation.signed-live-receipt.v1','receipt',current_validation.payload
            )),'UTF8')),'hex')
          OR NEW.validation_completed_at IS DISTINCT FROM
            (current_validation.payload#>>'{payload,completedAt}')::timestamptz
          OR NEW.approved_at<NEW.validation_completed_at
          OR NEW.payload->>'domain' IS DISTINCT FROM 'lineageguard.effect-approval.v2'
          OR NEW.payload->>'runId' IS DISTINCT FROM NEW.run_id
          OR NEW.payload->>'effectKind' IS DISTINCT FROM
            (CASE NEW.kind WHEN 'GITHUB_REVIEW' THEN 'GITHUB_WRITE' ELSE 'DATAHUB_WRITE' END)
          OR NEW.payload->>'target' IS DISTINCT FROM NEW.target
          OR NEW.payload->>'inputFingerprint' IS DISTINCT FROM NEW.input_fingerprint
          OR NEW.payload->>'validationReceiptId' IS DISTINCT FROM NEW.validation_receipt_id
          OR NEW.payload->>'validationReceiptFingerprint' IS DISTINCT FROM NEW.validation_receipt_fingerprint
          OR (NEW.payload->>'validationCompletedAt')::timestamptz IS DISTINCT FROM NEW.validation_completed_at
          OR NEW.payload->>'approvedBy' IS DISTINCT FROM NEW.approved_by
          OR (NEW.payload->>'approvedAt')::timestamptz IS DISTINCT FROM NEW.approved_at
          OR (NEW.payload->>'expiresAt')::timestamptz IS DISTINCT FROM NEW.expires_at
          OR NEW.approval_fingerprint IS DISTINCT FROM encode(sha256(convert_to(
            lineageguard.canonical_json_text(NEW.payload),'UTF8')),'hex')
          OR NEW.approval_assertion#>>'{protectedHeaders,purpose}'
            IS DISTINCT FROM 'LINEAGEGUARD_EFFECT_APPROVAL'
          OR NEW.approval_assertion#>>'{protectedHeaders,schemaVersion}' IS DISTINCT FROM '2'
          OR NEW.approval_assertion#>>'{protectedHeaders,algorithm}' IS DISTINCT FROM 'ED25519'
          OR NEW.approval_assertion->'payload' IS DISTINCT FROM NEW.payload
          OR NEW.approval_assertion->>'signedPayloadFingerprint' IS NULL
          OR NEW.approval_assertion->>'signature' IS NULL
        THEN RAISE EXCEPTION 'approval payload or authority is not canonical' USING ERRCODE='23514'; END IF;
        RETURN NEW;
      END $$;

      CREATE FUNCTION lineageguard.effect_intent_fingerprint(
        candidate lineageguard.external_effect_intents
      ) RETURNS text LANGUAGE sql IMMUTABLE SET search_path=pg_catalog,lineageguard AS $$
        SELECT encode(sha256(convert_to(lineageguard.canonical_json_text(jsonb_build_object(
          'domain','lineageguard.external-effect-intent.v1',
          'intentId',candidate.id,'runId',candidate.run_id,
          'effectKind',CASE candidate.kind WHEN 'GITHUB_REVIEW' THEN 'GITHUB_WRITE' ELSE 'DATAHUB_WRITE' END,
          'target',candidate.target,'idempotencyKey',candidate.idempotency_key,
          'inputFingerprint',candidate.input_fingerprint,
          'effectPayloadFingerprint',encode(sha256(convert_to(
            lineageguard.canonical_json_text(candidate.input),'UTF8')),'hex'),
          'validationReceiptId',candidate.validation_receipt_id,
          'candidateFingerprint',candidate.candidate_fingerprint,
          'artifactSetFingerprint',candidate.artifact_set_fingerprint
        )),'UTF8')),'hex')
      $$;
      REVOKE ALL ON FUNCTION lineageguard.effect_intent_fingerprint(
        lineageguard.external_effect_intents
      ) FROM PUBLIC;

      ALTER TABLE lineageguard.external_effect_attempts
        ADD COLUMN reservation_id text;
      UPDATE lineageguard.external_effect_attempts
        SET state='RECONCILIATION_REQUIRED',updated_at=clock_timestamp()
        WHERE state='READY_TO_INVOKE';

      CREATE TABLE lineageguard.effect_invocation_reservations (
        id text PRIMARY KEY CHECK (id ~ '^effect_reservation_[a-f0-9]{24}$'),
        run_id text NOT NULL REFERENCES lineageguard.runs(id) ON DELETE RESTRICT,
        intent_id text NOT NULL REFERENCES lineageguard.external_effect_intents(id) ON DELETE RESTRICT,
        idempotency_key text NOT NULL,
        kind text NOT NULL CHECK (kind IN ('GITHUB_REVIEW','DATAHUB_WRITEBACK')),
        target text NOT NULL,
        input_fingerprint text NOT NULL CHECK (input_fingerprint ~ '^[a-f0-9]{64}$'),
        intent_fingerprint text NOT NULL CHECK (intent_fingerprint ~ '^[a-f0-9]{64}$'),
        validation_receipt_id text NOT NULL REFERENCES lineageguard.validation_receipts(id) ON DELETE RESTRICT,
        validation_receipt_fingerprint text NOT NULL CHECK (validation_receipt_fingerprint ~ '^[a-f0-9]{64}$'),
        approval_id text NOT NULL REFERENCES lineageguard.effect_approvals(id) ON DELETE RESTRICT,
        approval_fingerprint text NOT NULL CHECK (approval_fingerprint ~ '^[a-f0-9]{64}$'),
        event_prefix_fingerprint text NOT NULL CHECK (event_prefix_fingerprint ~ '^[a-f0-9]{64}$'),
        run_version bigint NOT NULL CHECK (run_version>=0),
        run_status text NOT NULL CHECK (run_status IN ('VALIDATED','WRITEBACK_PENDING')),
        lease_id text NOT NULL,
        worker_id text NOT NULL,
        generation integer NOT NULL CHECK (generation>0),
        token_hash text NOT NULL UNIQUE CHECK (token_hash ~ '^[a-f0-9]{64}$'),
        invoke_by timestamptz NOT NULL,
        state text NOT NULL DEFAULT 'RESERVED' CHECK (state IN ('RESERVED','CONSUMED','CANCELLED_PRE_SEND')),
        attempt_id text UNIQUE,
        attempt_fence text UNIQUE,
        consumed_at timestamptz,
        created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
        CHECK (((state='RESERVED' OR state='CANCELLED_PRE_SEND')
            AND attempt_id IS NULL AND attempt_fence IS NULL AND consumed_at IS NULL)
          OR (state='CONSUMED' AND attempt_id IS NOT NULL AND attempt_fence IS NOT NULL AND consumed_at IS NOT NULL))
      );
      CREATE UNIQUE INDEX effect_invocation_reservations_active_intent
        ON lineageguard.effect_invocation_reservations(intent_id)
        WHERE state IN ('RESERVED','CONSUMED');
      ALTER TABLE lineageguard.external_effect_attempts ADD CONSTRAINT effect_attempt_reservation_fk
        FOREIGN KEY (reservation_id) REFERENCES lineageguard.effect_invocation_reservations(id)
        ON DELETE RESTRICT;

      CREATE FUNCTION lineageguard.current_run_event_prefix_fingerprint(p_run_id text)
      RETURNS text LANGUAGE sql STABLE SET search_path=pg_catalog,lineageguard AS $$
        SELECT encode(sha256(convert_to(lineageguard.canonical_json_text(jsonb_build_object(
          'domain','lineageguard.validation.authorized-run-stream.v1',
          'events',COALESCE(jsonb_agg(payload ORDER BY sequence),'[]'::jsonb)
        )),'UTF8')),'hex') FROM lineageguard.run_events WHERE run_id=p_run_id
      $$;
      REVOKE ALL ON FUNCTION lineageguard.current_run_event_prefix_fingerprint(text) FROM PUBLIC;

      CREATE OR REPLACE FUNCTION lineageguard.transition_run(
        p_run_id text,p_from text,p_to text,p_lease_id text,p_worker_id text,p_generation integer,
        p_occurred_at timestamptz,p_event jsonb,p_expected_version bigint
      ) RETURNS SETOF lineageguard.runs LANGUAGE plpgsql SECURITY DEFINER
      SET search_path=pg_catalog,lineageguard AS $$
      BEGIN
        PERFORM 1 FROM lineageguard.runs WHERE id=p_run_id AND version=p_expected_version FOR UPDATE;
        IF NOT FOUND THEN RAISE EXCEPTION 'transition version fence rejected' USING ERRCODE='23514'; END IF;
        RETURN QUERY SELECT * FROM lineageguard.transition_run(
          p_run_id,p_from,p_to,p_lease_id,p_worker_id,p_generation,p_occurred_at,p_event
        );
      END $$;

      CREATE FUNCTION lineageguard.signer_insert_validation_receipt(
        p_id text,p_run_id text,p_position integer,p_payload jsonb,p_lease_id text,p_worker_id text,
        p_generation integer,p_expected_version bigint
      ) RETURNS SETOF lineageguard.validation_receipts LANGUAGE plpgsql SECURITY DEFINER
      SET search_path=pg_catalog,lineageguard AS $$
      DECLARE current_run lineageguard.runs%ROWTYPE;
      DECLARE current_candidate jsonb;
      DECLARE current_events_fingerprint text;
      BEGIN
        SELECT * INTO current_run FROM lineageguard.runs WHERE id=p_run_id FOR UPDATE;
        SELECT payload INTO current_candidate FROM lineageguard.migration_candidates
          WHERE run_id=p_run_id ORDER BY position DESC,id DESC LIMIT 1;
        current_events_fingerprint:=lineageguard.current_run_event_prefix_fingerprint(p_run_id);
        IF current_run.id IS NULL OR current_run.execution_mode<>'LIVE' OR current_run.status<>'VALIDATING'
          OR current_run.lease_id IS DISTINCT FROM p_lease_id
          OR current_run.worker_id IS DISTINCT FROM p_worker_id
          OR current_run.lease_generation IS DISTINCT FROM p_generation
          OR current_run.version<>p_expected_version OR current_run.lease_expires_at<=clock_timestamp()
          OR p_payload#>>'{protectedHeaders,runId}' IS DISTINCT FROM p_run_id
          OR p_payload#>>'{protectedHeaders,candidateFingerprint}' IS DISTINCT FROM encode(sha256(
            convert_to(lineageguard.canonical_json_text(current_candidate),'UTF8')),'hex')
          OR p_payload#>>'{protectedHeaders,authorizedRunEventStreamFingerprint}'
            IS DISTINCT FROM current_events_fingerprint
        THEN RAISE EXCEPTION 'live validation signer authority rejected' USING ERRCODE='23514'; END IF;
        RETURN QUERY INSERT INTO lineageguard.validation_receipts(id,run_id,position,payload)
          VALUES(p_id,p_run_id,p_position,p_payload) RETURNING *;
        UPDATE lineageguard.runs SET version=version+1,updated_at=clock_timestamp() WHERE id=p_run_id;
      END $$;

      CREATE FUNCTION lineageguard.signer_lock_validation_run(p_run_id text)
      RETURNS SETOF lineageguard.runs LANGUAGE sql SECURITY DEFINER
      SET search_path=pg_catalog,lineageguard AS $$
        SELECT * FROM lineageguard.runs WHERE id=p_run_id FOR UPDATE
      $$;

      CREATE FUNCTION lineageguard.approval_insert_effect_approval(
        p_id text,p_run_id text,p_kind text,p_target text,p_input_fingerprint text,
        p_validation_receipt_id text,p_validation_receipt_fingerprint text,
        p_validation_completed_at timestamptz,p_approved_by text,p_approved_at timestamptz,
        p_expires_at timestamptz,p_payload jsonb,p_approval_fingerprint text,
        p_approval_assertion jsonb,
        p_lease_id text,p_worker_id text,p_generation integer,p_expected_version bigint
      ) RETURNS SETOF lineageguard.effect_approvals LANGUAGE plpgsql SECURITY DEFINER
      SET search_path=pg_catalog,lineageguard AS $$
      DECLARE current_run lineageguard.runs%ROWTYPE;
      BEGIN
        SELECT * INTO current_run FROM lineageguard.runs WHERE id=p_run_id FOR UPDATE;
        IF current_run.lease_id IS DISTINCT FROM p_lease_id
          OR current_run.worker_id IS DISTINCT FROM p_worker_id
          OR current_run.lease_generation IS DISTINCT FROM p_generation
          OR current_run.version<>p_expected_version
        THEN RAISE EXCEPTION 'approval authority fence rejected' USING ERRCODE='23514'; END IF;
        RETURN QUERY INSERT INTO lineageguard.effect_approvals(
          id,run_id,kind,target,input_fingerprint,validation_receipt_id,
          validation_receipt_fingerprint,validation_completed_at,approved_by,approved_at,
          expires_at,payload,approval_fingerprint,approval_assertion
        ) VALUES(p_id,p_run_id,p_kind,p_target,p_input_fingerprint,p_validation_receipt_id,
          p_validation_receipt_fingerprint,p_validation_completed_at,p_approved_by,p_approved_at,
          p_expires_at,p_payload,p_approval_fingerprint,p_approval_assertion)
        ON CONFLICT (approval_fingerprint) DO NOTHING RETURNING *;
      END;
      $$;

      CREATE FUNCTION lineageguard.effect_insert_intent(
        p_id text,p_run_id text,p_kind text,p_target text,p_idempotency_key text,
        p_input_fingerprint text,p_input jsonb,p_validation_receipt_id text,
        p_candidate_fingerprint text,p_artifact_set_fingerprint text,p_lease_id text,p_worker_id text,
        p_generation integer,p_expected_version bigint
      ) RETURNS SETOF lineageguard.external_effect_intents LANGUAGE plpgsql SECURITY DEFINER
      SET search_path=pg_catalog,lineageguard AS $$
      DECLARE current_run lineageguard.runs%ROWTYPE;
      BEGIN
        SELECT * INTO current_run FROM lineageguard.runs WHERE id=p_run_id FOR UPDATE;
        IF current_run.id IS NULL OR current_run.execution_mode<>'LIVE'
          OR current_run.status<>(CASE p_kind WHEN 'GITHUB_REVIEW' THEN 'VALIDATED' ELSE 'WRITEBACK_PENDING' END)
          OR current_run.lease_id IS DISTINCT FROM p_lease_id
          OR current_run.worker_id IS DISTINCT FROM p_worker_id
          OR current_run.lease_generation IS DISTINCT FROM p_generation
          OR current_run.version<>p_expected_version OR current_run.lease_expires_at<=clock_timestamp()
        THEN RAISE EXCEPTION 'effect intent authority rejected' USING ERRCODE='23514'; END IF;
        RETURN QUERY INSERT INTO lineageguard.external_effect_intents(
          id,run_id,kind,target,idempotency_key,input_fingerprint,input,validation_receipt_id,
          candidate_fingerprint,artifact_set_fingerprint
        ) VALUES(p_id,p_run_id,p_kind,p_target,p_idempotency_key,p_input_fingerprint,p_input,
          p_validation_receipt_id,p_candidate_fingerprint,p_artifact_set_fingerprint) RETURNING *;
        UPDATE lineageguard.runs SET version=version+1,updated_at=clock_timestamp() WHERE id=p_run_id;
      END $$;

      CREATE FUNCTION lineageguard.effect_reserve_current(
        p_id text,p_run_id text,p_intent_id text,p_idempotency_key text,p_kind text,p_target text,
        p_input_fingerprint text,p_validation_receipt_id text,p_validation_receipt_fingerprint text,
        p_approval_id text,p_approval_fingerprint text,p_event_prefix_fingerprint text,
        p_lease_id text,p_worker_id text,p_generation integer,p_expected_version bigint,
        p_token_hash text,p_invoke_by timestamptz
      ) RETURNS SETOF lineageguard.effect_invocation_reservations LANGUAGE plpgsql SECURITY DEFINER
      SET search_path=pg_catalog,lineageguard AS $$
      DECLARE current_run lineageguard.runs%ROWTYPE;
      DECLARE current_intent lineageguard.external_effect_intents%ROWTYPE;
      DECLARE current_validation record;
      DECLARE current_approval lineageguard.effect_approvals%ROWTYPE;
      DECLARE computed_intent_fingerprint text;
      BEGIN
        SELECT * INTO current_run FROM lineageguard.runs WHERE id=p_run_id FOR UPDATE;
        SELECT * INTO current_intent FROM lineageguard.external_effect_intents WHERE id=p_intent_id;
        SELECT id,payload INTO current_validation FROM lineageguard.validation_receipts
          WHERE run_id=p_run_id ORDER BY position DESC,id DESC LIMIT 1;
        SELECT * INTO current_approval FROM lineageguard.effect_approvals
          WHERE id=p_approval_id AND run_id=p_run_id AND kind=p_kind AND target=p_target
            AND input_fingerprint=p_input_fingerprint;
        computed_intent_fingerprint:=lineageguard.effect_intent_fingerprint(current_intent);
        IF current_run.id IS NULL OR current_run.execution_mode<>'LIVE'
          OR current_run.version<>p_expected_version
          OR current_run.status<>(CASE p_kind WHEN 'GITHUB_REVIEW' THEN 'VALIDATED' ELSE 'WRITEBACK_PENDING' END)
          OR current_run.lease_id IS DISTINCT FROM p_lease_id
          OR current_run.worker_id IS DISTINCT FROM p_worker_id
          OR current_run.lease_generation IS DISTINCT FROM p_generation
          OR current_run.lease_expires_at<=clock_timestamp() OR p_invoke_by>current_run.lease_expires_at
          OR lineageguard.current_run_event_prefix_fingerprint(p_run_id)<>p_event_prefix_fingerprint
          OR current_intent.id IS NULL OR current_intent.run_id<>p_run_id
          OR current_intent.idempotency_key<>p_idempotency_key OR current_intent.kind<>p_kind
          OR current_intent.target<>p_target OR current_intent.input_fingerprint<>p_input_fingerprint
          OR current_validation.id IS DISTINCT FROM p_validation_receipt_id
          OR p_validation_receipt_fingerprint IS DISTINCT FROM encode(sha256(convert_to(
            lineageguard.canonical_json_text(jsonb_build_object(
              'domain','lineageguard.validation.signed-live-receipt.v1','receipt',current_validation.payload
            )),'UTF8')),'hex')
          OR current_approval.id IS NULL OR current_approval.approval_fingerprint<>p_approval_fingerprint
          OR current_approval.validation_receipt_id<>p_validation_receipt_id
          OR current_approval.validation_receipt_fingerprint<>p_validation_receipt_fingerprint
          OR current_approval.approval_assertion#>>'{protectedHeaders,schemaVersion}'<>'2'
          OR current_approval.approval_assertion->'payload' IS DISTINCT FROM current_approval.payload
          OR current_approval.expires_at<=clock_timestamp() OR p_invoke_by>current_approval.expires_at
          OR p_invoke_by<=clock_timestamp()
        THEN RAISE EXCEPTION 'effect reservation authority rejected' USING ERRCODE='23514'; END IF;
        RETURN QUERY INSERT INTO lineageguard.effect_invocation_reservations(
          id,run_id,intent_id,idempotency_key,kind,target,input_fingerprint,intent_fingerprint,
          validation_receipt_id,validation_receipt_fingerprint,approval_id,approval_fingerprint,
          event_prefix_fingerprint,run_version,run_status,lease_id,worker_id,generation,token_hash,invoke_by
        ) VALUES(p_id,p_run_id,p_intent_id,p_idempotency_key,p_kind,p_target,p_input_fingerprint,
          computed_intent_fingerprint,p_validation_receipt_id,p_validation_receipt_fingerprint,
          p_approval_id,p_approval_fingerprint,p_event_prefix_fingerprint,p_expected_version,
          current_run.status,p_lease_id,p_worker_id,p_generation,p_token_hash,p_invoke_by) RETURNING *;
      END $$;

      CREATE FUNCTION lineageguard.effect_verify_current(
        p_id text,p_token_hash text,p_run_id text,p_intent_id text,p_idempotency_key text,
        p_kind text,p_target text,p_canonical_effect_fingerprint text,p_validation_receipt_id text,
        p_validation_receipt_fingerprint text,p_approval_id text,p_approval_fingerprint text,
        p_intent_fingerprint text
      ) RETURNS SETOF lineageguard.effect_invocation_reservations LANGUAGE plpgsql SECURITY DEFINER
      SET search_path=pg_catalog,lineageguard AS $$
      DECLARE reservation lineageguard.effect_invocation_reservations%ROWTYPE;
      DECLARE current_run lineageguard.runs%ROWTYPE;
      DECLARE current_intent lineageguard.external_effect_intents%ROWTYPE;
      DECLARE current_validation record;
      DECLARE current_approval lineageguard.effect_approvals%ROWTYPE;
      BEGIN
        SELECT * INTO reservation FROM lineageguard.effect_invocation_reservations WHERE id=p_id;
        SELECT * INTO current_run FROM lineageguard.runs WHERE id=p_run_id;
        SELECT * INTO current_intent FROM lineageguard.external_effect_intents WHERE id=p_intent_id;
        SELECT id,payload INTO current_validation FROM lineageguard.validation_receipts
          WHERE run_id=p_run_id ORDER BY position DESC,id DESC LIMIT 1;
        SELECT * INTO current_approval FROM lineageguard.effect_approvals WHERE id=p_approval_id;
        IF reservation.id IS NULL OR reservation.token_hash<>p_token_hash
          OR reservation.run_id<>p_run_id OR reservation.intent_id<>p_intent_id
          OR reservation.idempotency_key<>p_idempotency_key OR reservation.kind<>p_kind
          OR reservation.target<>p_target
          OR reservation.input_fingerprint<>p_canonical_effect_fingerprint
          OR reservation.validation_receipt_id<>p_validation_receipt_id
          OR reservation.validation_receipt_fingerprint<>p_validation_receipt_fingerprint
          OR reservation.approval_id<>p_approval_id
          OR reservation.approval_fingerprint<>p_approval_fingerprint
          OR reservation.intent_fingerprint<>p_intent_fingerprint
          OR lineageguard.effect_intent_fingerprint(current_intent)<>p_intent_fingerprint
        THEN RAISE EXCEPTION 'effect reservation claim binding rejected' USING ERRCODE='23514'; END IF;
        IF reservation.state='RESERVED' AND (
          current_run.execution_mode<>'LIVE' OR current_run.version<>reservation.run_version
          OR current_run.status<>reservation.run_status
          OR current_run.lease_id IS DISTINCT FROM reservation.lease_id
          OR current_run.worker_id IS DISTINCT FROM reservation.worker_id
          OR current_run.lease_generation IS DISTINCT FROM reservation.generation
          OR current_run.lease_expires_at<=clock_timestamp() OR reservation.invoke_by<=clock_timestamp()
          OR lineageguard.current_run_event_prefix_fingerprint(p_run_id)<>reservation.event_prefix_fingerprint
          OR current_validation.id IS DISTINCT FROM reservation.validation_receipt_id
          OR reservation.validation_receipt_fingerprint IS DISTINCT FROM encode(sha256(convert_to(
            lineageguard.canonical_json_text(jsonb_build_object(
              'domain','lineageguard.validation.signed-live-receipt.v1','receipt',current_validation.payload
            )),'UTF8')),'hex')
          OR current_approval.id IS NULL OR current_approval.approval_fingerprint<>reservation.approval_fingerprint
          OR current_approval.validation_receipt_id<>reservation.validation_receipt_id
          OR current_approval.validation_receipt_fingerprint<>reservation.validation_receipt_fingerprint
          OR current_approval.approval_assertion#>>'{protectedHeaders,schemaVersion}'<>'2'
          OR current_approval.approval_assertion->'payload' IS DISTINCT FROM current_approval.payload
          OR current_approval.expires_at<=clock_timestamp()
        ) THEN RAISE EXCEPTION 'effect reservation is stale or expired' USING ERRCODE='23514'; END IF;
        RETURN NEXT reservation;
      END $$;

      CREATE FUNCTION lineageguard.effect_consume_current(
        p_id text,p_token_hash text,p_run_id text,p_intent_id text,p_idempotency_key text,
        p_kind text,p_target text,p_canonical_effect_fingerprint text,p_validation_receipt_id text,
        p_validation_receipt_fingerprint text,p_approval_id text,p_approval_fingerprint text,
        p_intent_fingerprint text
      ) RETURNS TABLE(
        reservation_id text,canonical_effect_fingerprint text,invoke_by timestamptz,
        attempt_id text,attempt_fence text
      ) LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,lineageguard AS $$
      DECLARE reservation lineageguard.effect_invocation_reservations%ROWTYPE;
      DECLARE current_run lineageguard.runs%ROWTYPE;
      DECLARE current_intent lineageguard.external_effect_intents%ROWTYPE;
      DECLARE current_validation record;
      DECLARE current_approval lineageguard.effect_approvals%ROWTYPE;
      DECLARE next_attempt integer;
      DECLARE created_attempt_id text;
      DECLARE created_attempt_fence text;
      BEGIN
        SELECT * INTO reservation FROM lineageguard.effect_invocation_reservations WHERE id=p_id FOR UPDATE;
        SELECT * INTO current_run FROM lineageguard.runs WHERE id=p_run_id FOR UPDATE;
        SELECT * INTO current_intent FROM lineageguard.external_effect_intents WHERE id=p_intent_id;
        SELECT id,payload INTO current_validation FROM lineageguard.validation_receipts
          WHERE run_id=p_run_id ORDER BY position DESC,id DESC LIMIT 1;
        SELECT * INTO current_approval FROM lineageguard.effect_approvals WHERE id=p_approval_id;
        IF reservation.id IS NULL OR reservation.state<>'RESERVED' OR reservation.token_hash<>p_token_hash
          OR reservation.run_id<>p_run_id OR reservation.intent_id<>p_intent_id
          OR reservation.idempotency_key<>p_idempotency_key OR reservation.kind<>p_kind
          OR reservation.target<>p_target OR reservation.input_fingerprint<>p_canonical_effect_fingerprint
          OR reservation.validation_receipt_id<>p_validation_receipt_id
          OR reservation.validation_receipt_fingerprint<>p_validation_receipt_fingerprint
          OR reservation.approval_id<>p_approval_id OR reservation.approval_fingerprint<>p_approval_fingerprint
          OR reservation.intent_fingerprint<>p_intent_fingerprint
          OR lineageguard.effect_intent_fingerprint(current_intent)<>p_intent_fingerprint
          OR current_run.execution_mode<>'LIVE' OR current_run.version<>reservation.run_version
          OR current_run.status<>reservation.run_status
          OR current_run.lease_id IS DISTINCT FROM reservation.lease_id
          OR current_run.worker_id IS DISTINCT FROM reservation.worker_id
          OR current_run.lease_generation IS DISTINCT FROM reservation.generation
          OR current_run.lease_expires_at<=clock_timestamp() OR reservation.invoke_by<=clock_timestamp()
          OR lineageguard.current_run_event_prefix_fingerprint(p_run_id)<>reservation.event_prefix_fingerprint
          OR current_validation.id IS DISTINCT FROM reservation.validation_receipt_id
          OR reservation.validation_receipt_fingerprint IS DISTINCT FROM encode(sha256(convert_to(
            lineageguard.canonical_json_text(jsonb_build_object(
              'domain','lineageguard.validation.signed-live-receipt.v1','receipt',current_validation.payload
            )),'UTF8')),'hex')
          OR current_approval.id IS NULL OR current_approval.approval_fingerprint<>reservation.approval_fingerprint
          OR current_approval.validation_receipt_id<>reservation.validation_receipt_id
          OR current_approval.validation_receipt_fingerprint<>reservation.validation_receipt_fingerprint
          OR current_approval.approval_assertion#>>'{protectedHeaders,schemaVersion}'<>'2'
          OR current_approval.approval_assertion->'payload' IS DISTINCT FROM current_approval.payload
          OR current_approval.expires_at<=clock_timestamp()
        THEN RAISE EXCEPTION 'effect reservation consume rejected' USING ERRCODE='23514'; END IF;
        SELECT COALESCE(max(a.attempt),0)+1 INTO next_attempt
          FROM lineageguard.external_effect_attempts a WHERE a.intent_id=p_intent_id;
        IF next_attempt>3 THEN RAISE EXCEPTION 'effect attempt limit reached' USING ERRCODE='23514'; END IF;
        created_attempt_id:='effect_attempt_'||substr(replace(gen_random_uuid()::text,'-',''),1,24);
        created_attempt_fence:='effect_fence_'||substr(replace(gen_random_uuid()::text,'-',''),1,24);
        UPDATE lineageguard.effect_invocation_reservations SET state='CONSUMED',
          attempt_id=created_attempt_id,attempt_fence=created_attempt_fence,consumed_at=clock_timestamp()
          WHERE id=p_id;
        INSERT INTO lineageguard.external_effect_attempts(
          id,intent_id,attempt,worker_id,fencing_token,state,claimed_at,claim_expires_at,
          updated_at,reservation_id
        ) VALUES(created_attempt_id,p_intent_id,next_attempt,reservation.worker_id,
          created_attempt_fence,'READY_TO_INVOKE',clock_timestamp(),reservation.invoke_by,
          clock_timestamp(),p_id);
        RETURN QUERY SELECT p_id,p_canonical_effect_fingerprint,reservation.invoke_by,
          created_attempt_id,created_attempt_fence;
      END $$;

      CREATE FUNCTION lineageguard.effect_cancel_reservation_before_send(
        p_id text,p_token_hash text,p_run_id text,p_intent_id text,p_idempotency_key text,
        p_kind text,p_target text,p_canonical_effect_fingerprint text,p_validation_receipt_id text,
        p_validation_receipt_fingerprint text,p_approval_id text,p_approval_fingerprint text,
        p_intent_fingerprint text
      ) RETURNS void LANGUAGE plpgsql SECURITY DEFINER
      SET search_path=pg_catalog,lineageguard AS $$
      DECLARE reservation lineageguard.effect_invocation_reservations%ROWTYPE;
      BEGIN
        SELECT * INTO reservation FROM lineageguard.effect_invocation_reservations
          WHERE id=p_id FOR UPDATE;
        IF reservation.id IS NULL OR reservation.state<>'RESERVED'
          OR reservation.token_hash<>p_token_hash OR reservation.run_id<>p_run_id
          OR reservation.intent_id<>p_intent_id OR reservation.idempotency_key<>p_idempotency_key
          OR reservation.kind<>p_kind OR reservation.target<>p_target
          OR reservation.input_fingerprint<>p_canonical_effect_fingerprint
          OR reservation.validation_receipt_id<>p_validation_receipt_id
          OR reservation.validation_receipt_fingerprint<>p_validation_receipt_fingerprint
          OR reservation.approval_id<>p_approval_id
          OR reservation.approval_fingerprint<>p_approval_fingerprint
          OR reservation.intent_fingerprint<>p_intent_fingerprint
        THEN RAISE EXCEPTION 'pre-send reservation cancellation rejected' USING ERRCODE='23514'; END IF;
        UPDATE lineageguard.effect_invocation_reservations
          SET state='CANCELLED_PRE_SEND' WHERE id=p_id;
      END $$;

      CREATE FUNCTION lineageguard.enforce_effect_attempt_authority() RETURNS trigger
      LANGUAGE plpgsql SET search_path=pg_catalog,lineageguard AS $$
      DECLARE reservation lineageguard.effect_invocation_reservations%ROWTYPE;
      BEGIN
        SELECT * INTO reservation FROM lineageguard.effect_invocation_reservations
          WHERE id=NEW.reservation_id;
        IF NEW.state<>'READY_TO_INVOKE' OR reservation.id IS NULL OR reservation.state<>'CONSUMED'
          OR reservation.intent_id<>NEW.intent_id OR reservation.attempt_id<>NEW.id
          OR reservation.attempt_fence<>NEW.fencing_token
        THEN RAISE EXCEPTION 'effect attempt requires a consumed reservation' USING ERRCODE='23514'; END IF;
        RETURN NEW;
      END $$;
      CREATE TRIGGER external_effect_attempts_authority BEFORE INSERT
        ON lineageguard.external_effect_attempts FOR EACH ROW
        EXECUTE FUNCTION lineageguard.enforce_effect_attempt_authority();

      CREATE FUNCTION lineageguard.enforce_active_effect_invocation() RETURNS trigger
      LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,lineageguard AS $$
      BEGIN
        IF EXISTS(
          SELECT 1 FROM lineageguard.effect_invocation_reservations reservation
          WHERE reservation.run_id=OLD.id AND (
            (reservation.state='RESERVED' AND reservation.invoke_by>clock_timestamp())
            OR (reservation.state='CONSUMED' AND NOT EXISTS(
              SELECT 1 FROM lineageguard.external_effect_receipts receipt
                WHERE receipt.intent_id=reservation.intent_id
            ) AND NOT EXISTS(
              SELECT 1 FROM lineageguard.external_effect_reconciliations reconciliation
                WHERE reconciliation.attempt_id=reservation.attempt_id
                  AND reconciliation.proof_outcome='NOT_APPLIED'
            ))
          )
        ) AND (NEW.status IS DISTINCT FROM OLD.status OR NEW.lease_id IS DISTINCT FROM OLD.lease_id
          OR NEW.worker_id IS DISTINCT FROM OLD.worker_id
          OR NEW.lease_generation IS DISTINCT FROM OLD.lease_generation)
        THEN RAISE EXCEPTION 'active effect invocation blocks transition or lease reassignment'
          USING ERRCODE='23514'; END IF;
        RETURN NEW;
      END $$;
      CREATE TRIGGER runs_active_effect_invocation
        BEFORE UPDATE OF status,lease_id,worker_id,lease_generation ON lineageguard.runs
        FOR EACH ROW EXECUTE FUNCTION lineageguard.enforce_active_effect_invocation();

      CREATE OR REPLACE FUNCTION lineageguard.enforce_effect_outcome_authority() RETURNS trigger
      LANGUAGE plpgsql SET search_path=pg_catalog,lineageguard AS $$
      DECLARE attempt lineageguard.external_effect_attempts%ROWTYPE;
      DECLARE reservation lineageguard.effect_invocation_reservations%ROWTYPE;
      DECLARE proof text;
      BEGIN
        SELECT * INTO attempt FROM lineageguard.external_effect_attempts
          WHERE intent_id=NEW.intent_id ORDER BY attempt DESC LIMIT 1;
        SELECT * INTO reservation FROM lineageguard.effect_invocation_reservations
          WHERE id=attempt.reservation_id;
        SELECT proof_outcome INTO proof FROM lineageguard.external_effect_reconciliations
          WHERE attempt_id=attempt.id;
        IF attempt.id IS NULL OR reservation.id IS NULL OR reservation.state<>'CONSUMED'
          OR reservation.attempt_id<>attempt.id OR reservation.attempt_fence<>attempt.fencing_token
          OR NOT (attempt.state='READY_TO_INVOKE'
            OR (TG_TABLE_NAME='external_effect_receipts'
              AND attempt.state='RECONCILIATION_REQUIRED' AND proof='APPLIED'))
        THEN RAISE EXCEPTION 'effect outcome lacks consumed invocation authority'
          USING ERRCODE='23514'; END IF;
        RETURN NEW;
      END $$;
      CREATE OR REPLACE FUNCTION lineageguard.enforce_effect_reconciliation_authority() RETURNS trigger
      LANGUAGE plpgsql SET search_path=pg_catalog,lineageguard AS $$
      DECLARE attempt lineageguard.external_effect_attempts%ROWTYPE;
      DECLARE reservation lineageguard.effect_invocation_reservations%ROWTYPE;
      BEGIN
        SELECT * INTO attempt FROM lineageguard.external_effect_attempts WHERE id=NEW.attempt_id;
        SELECT * INTO reservation FROM lineageguard.effect_invocation_reservations
          WHERE id=attempt.reservation_id;
        IF attempt.id IS NULL OR attempt.state<>'RECONCILIATION_REQUIRED'
          OR reservation.id IS NULL OR reservation.state<>'CONSUMED'
          OR reservation.attempt_id<>attempt.id
        THEN RAISE EXCEPTION 'effect reconciliation authority rejected' USING ERRCODE='23514'; END IF;
        RETURN NEW;
      END $$;
      CREATE FUNCTION lineageguard.effect_set_attempt_state(
        p_id text,p_state text,p_updated_at timestamptz
      ) RETURNS SETOF lineageguard.external_effect_attempts LANGUAGE sql SECURITY DEFINER
      SET search_path=pg_catalog,lineageguard AS $$
        UPDATE lineageguard.external_effect_attempts SET state=p_state,updated_at=p_updated_at
        WHERE id=p_id RETURNING *
      $$;
      CREATE FUNCTION lineageguard.effect_insert_receipt(
        p_id text,p_intent_id text,p_payload jsonb,p_validation_receipt_id text,
        p_candidate_fingerprint text,p_artifact_set_fingerprint text
      ) RETURNS SETOF lineageguard.external_effect_receipts LANGUAGE sql SECURITY DEFINER
      SET search_path=pg_catalog,lineageguard AS $$
        INSERT INTO lineageguard.external_effect_receipts(
          id,intent_id,payload,validation_receipt_id,candidate_fingerprint,artifact_set_fingerprint
        ) VALUES(p_id,p_intent_id,p_payload,p_validation_receipt_id,p_candidate_fingerprint,
          p_artifact_set_fingerprint) ON CONFLICT (intent_id) DO NOTHING RETURNING *
      $$;
      CREATE FUNCTION lineageguard.effect_insert_failure(
        p_id text,p_intent_id text,p_run_id text,p_position integer,p_outcome text,p_payload jsonb
      ) RETURNS SETOF lineageguard.external_effect_failures LANGUAGE sql SECURITY DEFINER
      SET search_path=pg_catalog,lineageguard AS $$
        INSERT INTO lineageguard.external_effect_failures(id,intent_id,run_id,position,outcome,payload)
        VALUES(p_id,p_intent_id,p_run_id,p_position,p_outcome,p_payload) RETURNING *
      $$;
      CREATE FUNCTION lineageguard.effect_insert_reconciliation(
        p_id text,p_attempt_id text,p_proof_outcome text,p_payload jsonb
      ) RETURNS SETOF lineageguard.external_effect_reconciliations LANGUAGE sql SECURITY DEFINER
      SET search_path=pg_catalog,lineageguard AS $$
        INSERT INTO lineageguard.external_effect_reconciliations(id,attempt_id,proof_outcome,payload)
        VALUES(p_id,p_attempt_id,p_proof_outcome,p_payload)
        ON CONFLICT (attempt_id) DO NOTHING RETURNING *
      $$;

      ALTER FUNCTION lineageguard.transition_run(text,text,text,text,text,integer,timestamptz,jsonb)
        OWNER TO lineageguard_procedure_owner;
      ALTER FUNCTION lineageguard.transition_run(text,text,text,text,text,integer,timestamptz,jsonb,bigint)
        OWNER TO lineageguard_procedure_owner;
      ALTER FUNCTION lineageguard.signer_insert_validation_receipt(text,text,integer,jsonb,text,text,integer,bigint)
        OWNER TO lineageguard_procedure_owner;
      ALTER FUNCTION lineageguard.signer_lock_validation_run(text)
        OWNER TO lineageguard_procedure_owner;
      ALTER FUNCTION lineageguard.approval_insert_effect_approval(text,text,text,text,text,text,text,timestamptz,text,timestamptz,timestamptz,jsonb,text,jsonb,text,text,integer,bigint)
        OWNER TO lineageguard_procedure_owner;
      ALTER FUNCTION lineageguard.effect_insert_intent(text,text,text,text,text,text,jsonb,text,text,text,text,text,integer,bigint)
        OWNER TO lineageguard_procedure_owner;
      ALTER FUNCTION lineageguard.effect_reserve_current(text,text,text,text,text,text,text,text,text,text,text,text,text,text,integer,bigint,text,timestamptz)
        OWNER TO lineageguard_procedure_owner;
      ALTER FUNCTION lineageguard.effect_verify_current(text,text,text,text,text,text,text,text,text,text,text,text,text)
        OWNER TO lineageguard_procedure_owner;
      ALTER FUNCTION lineageguard.effect_consume_current(text,text,text,text,text,text,text,text,text,text,text,text,text)
        OWNER TO lineageguard_procedure_owner;
      ALTER FUNCTION lineageguard.effect_cancel_reservation_before_send(text,text,text,text,text,text,text,text,text,text,text,text,text)
        OWNER TO lineageguard_procedure_owner;
      ALTER FUNCTION lineageguard.effect_set_attempt_state(text,text,timestamptz)
        OWNER TO lineageguard_procedure_owner;
      ALTER FUNCTION lineageguard.effect_insert_receipt(text,text,jsonb,text,text,text)
        OWNER TO lineageguard_procedure_owner;
      ALTER FUNCTION lineageguard.effect_insert_failure(text,text,text,integer,text,jsonb)
        OWNER TO lineageguard_procedure_owner;
      ALTER FUNCTION lineageguard.effect_insert_reconciliation(text,text,text,jsonb)
        OWNER TO lineageguard_procedure_owner;
      ALTER FUNCTION lineageguard.enforce_active_effect_invocation()
        OWNER TO lineageguard_procedure_owner;

      REVOKE ALL ON FUNCTION lineageguard.transition_run(text,text,text,text,text,integer,timestamptz,jsonb,bigint) FROM PUBLIC;
      REVOKE ALL ON FUNCTION lineageguard.signer_insert_validation_receipt(text,text,integer,jsonb,text,text,integer,bigint) FROM PUBLIC;
      REVOKE ALL ON FUNCTION lineageguard.signer_lock_validation_run(text) FROM PUBLIC;
      REVOKE ALL ON FUNCTION lineageguard.approval_insert_effect_approval(text,text,text,text,text,text,text,timestamptz,text,timestamptz,timestamptz,jsonb,text,jsonb,text,text,integer,bigint) FROM PUBLIC;
      REVOKE ALL ON FUNCTION lineageguard.effect_insert_intent(text,text,text,text,text,text,jsonb,text,text,text,text,text,integer,bigint) FROM PUBLIC;
      REVOKE ALL ON FUNCTION lineageguard.effect_reserve_current(text,text,text,text,text,text,text,text,text,text,text,text,text,text,integer,bigint,text,timestamptz) FROM PUBLIC;
      REVOKE ALL ON FUNCTION lineageguard.effect_verify_current(text,text,text,text,text,text,text,text,text,text,text,text,text) FROM PUBLIC;
      REVOKE ALL ON FUNCTION lineageguard.effect_consume_current(text,text,text,text,text,text,text,text,text,text,text,text,text) FROM PUBLIC;
      REVOKE ALL ON FUNCTION lineageguard.effect_cancel_reservation_before_send(text,text,text,text,text,text,text,text,text,text,text,text,text) FROM PUBLIC;
      REVOKE ALL ON FUNCTION lineageguard.effect_set_attempt_state(text,text,timestamptz) FROM PUBLIC;
      REVOKE ALL ON FUNCTION lineageguard.effect_insert_receipt(text,text,jsonb,text,text,text) FROM PUBLIC;
      REVOKE ALL ON FUNCTION lineageguard.effect_insert_failure(text,text,text,integer,text,jsonb) FROM PUBLIC;
      REVOKE ALL ON FUNCTION lineageguard.effect_insert_reconciliation(text,text,text,jsonb) FROM PUBLIC;
      REVOKE ALL ON FUNCTION lineageguard.enforce_active_effect_invocation() FROM PUBLIC;

      DO $$ BEGIN
        IF EXISTS(SELECT 1 FROM lineageguard.effect_approvals
          WHERE expires_at>clock_timestamp() AND (
            validation_receipt_id IS NULL OR approval_assertion IS NULL
            OR approval_assertion#>>'{protectedHeaders,schemaVersion}' IS DISTINCT FROM '2'
          ))
        THEN RAISE EXCEPTION 'active legacy approvals require explicit invalidation before upgrade'; END IF;
        IF NOT EXISTS(SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
          WHERE n.nspname='lineageguard' AND p.proname='effect_consume_current' AND p.prosecdef)
        THEN RAISE EXCEPTION 'atomic effect authority migration postcondition failed'; END IF;
      END $$;

      CREATE VIEW lineageguard.effect_approval_summaries WITH (security_barrier=true) AS
        SELECT id,run_id,kind,target,input_fingerprint,validation_receipt_id,
          validation_receipt_fingerprint,validation_completed_at,'[redacted]'::text AS approved_by,
          approved_at,expires_at,approval_fingerprint,created_at
        FROM lineageguard.effect_approvals
        WHERE validation_receipt_id IS NOT NULL
          AND approval_assertion#>>'{protectedHeaders,schemaVersion}'='2';

      DO $$ BEGIN
        IF EXISTS(SELECT 1 FROM pg_roles WHERE rolname='lineageguard_authority') THEN
          EXECUTE 'REVOKE ALL ON ALL TABLES IN SCHEMA lineageguard FROM lineageguard_authority';
          EXECUTE 'REVOKE ALL ON ALL FUNCTIONS IN SCHEMA lineageguard FROM lineageguard_authority';
        END IF;
      END $$;
    `,
  },
];

function checksum(sql: string): string {
  return createHash("sha256").update(sql).digest("hex");
}

export async function migrate(pool: pg.Pool): Promise<void> {
  await inTransaction(pool, async (client) => {
    await client.query("SELECT pg_advisory_xact_lock(hashtext('lineageguard:migrations'))");
    await client.query(`
      CREATE SCHEMA IF NOT EXISTS lineageguard;
      CREATE TABLE IF NOT EXISTS lineageguard.schema_migrations (
        id text PRIMARY KEY,
        checksum text NOT NULL CHECK (checksum ~ '^[0-9a-f]{64}$'),
        applied_at timestamptz NOT NULL DEFAULT clock_timestamp()
      )
    `);

    for (const migration of MIGRATIONS) {
      const digest = checksum(migration.sql);
      const existing = await client.query<{ checksum: string }>(
        "SELECT checksum FROM lineageguard.schema_migrations WHERE id = $1",
        [migration.id],
      );
      if (existing.rowCount === 1) {
        if (existing.rows[0]?.checksum !== digest) {
          throw new Error(`applied migration ${migration.id} checksum does not match source`);
        }
        continue;
      }
      await client.query(migration.sql);
      await client.query(
        "INSERT INTO lineageguard.schema_migrations (id, checksum) VALUES ($1, $2)",
        [migration.id, digest],
      );
    }
  });
}

export async function grantRuntimePrivileges(pool: pg.Pool, role: string): Promise<void> {
  if (!/^[a-z][a-z0-9_]{0,62}$/.test(role)) {
    throw new TypeError("runtime role must be a simple PostgreSQL identifier");
  }
  const quotedRole = `"${role}"`;
  await inTransaction(pool, async (client) => {
    await client.query("REVOKE ALL ON ALL TABLES IN SCHEMA lineageguard FROM PUBLIC");
    await client.query("REVOKE ALL ON ALL FUNCTIONS IN SCHEMA lineageguard FROM PUBLIC");
    await client.query(`REVOKE ALL ON ALL TABLES IN SCHEMA lineageguard FROM ${quotedRole}`);
    await client.query(`REVOKE ALL ON ALL FUNCTIONS IN SCHEMA lineageguard FROM ${quotedRole}`);
    await client.query(`GRANT USAGE ON SCHEMA lineageguard TO ${quotedRole}`);
    await client.query(
      `GRANT SELECT ON lineageguard.runs,lineageguard.run_events,lineageguard.run_leases,
        lineageguard.retry_attempts,lineageguard.run_bundles,lineageguard.run_decisions,
        lineageguard.migration_candidates,lineageguard.validation_receipts,
        lineageguard.external_effect_intents,lineageguard.external_effect_attempts,
        lineageguard.external_effect_receipts,lineageguard.external_effect_failures,
        lineageguard.external_effect_reconciliations,lineageguard.effect_approval_summaries
       TO ${quotedRole}`,
    );
    await client.query(`REVOKE INSERT,UPDATE ON lineageguard.runs FROM ${quotedRole}`);
    await client.query(
      `GRANT INSERT (id,request_key,input_fingerprint,execution_mode,payload,next_attempt_at),
        UPDATE (lease_id,worker_id,lease_generation,lease_expires_at,version,updated_at,next_attempt_at)
       ON lineageguard.runs TO ${quotedRole}`,
    );
    await client.query(
      `GRANT INSERT ON lineageguard.run_events,lineageguard.run_leases,
        lineageguard.retry_attempts,lineageguard.run_bundles,lineageguard.run_decisions,
        lineageguard.migration_candidates
       TO ${quotedRole}`,
    );
    await client.query(
      `GRANT EXECUTE ON FUNCTION lineageguard.transition_run(text,text,text,text,text,integer,timestamptz,jsonb,bigint) TO ${quotedRole}`,
    );
    await client.query(
      `GRANT EXECUTE ON FUNCTION lineageguard.is_typed_impact_collection_result(jsonb) TO ${quotedRole}`,
    );
    await client.query(
      `GRANT EXECUTE ON FUNCTION lineageguard.enforce_impact_collection_mode() TO ${quotedRole}`,
    );
  });
}

async function grantProcedureOwnerPrivileges(pool: pg.Pool): Promise<void> {
  await inTransaction(pool, async (client) => {
    await client.query("REVOKE CREATE ON SCHEMA lineageguard FROM lineageguard_procedure_owner");
    await client.query("GRANT USAGE ON SCHEMA lineageguard TO lineageguard_procedure_owner");
    await client.query(
      `GRANT SELECT ON lineageguard.runs,lineageguard.run_events,lineageguard.run_bundles,
        lineageguard.migration_candidates,lineageguard.validation_receipts,
        lineageguard.effect_approvals,lineageguard.external_effect_intents,
        lineageguard.external_effect_attempts,lineageguard.external_effect_receipts,
        lineageguard.external_effect_failures,lineageguard.external_effect_reconciliations,
        lineageguard.effect_invocation_reservations TO lineageguard_procedure_owner`,
    );
    await client.query(
      `GRANT UPDATE (status,version,updated_at,next_attempt_at,lease_id,worker_id,lease_expires_at)
       ON lineageguard.runs TO lineageguard_procedure_owner`,
    );
    await client.query(
      `GRANT INSERT ON lineageguard.run_events,lineageguard.validation_receipts,
        lineageguard.effect_approvals,lineageguard.external_effect_intents,
        lineageguard.external_effect_attempts,lineageguard.external_effect_receipts,
        lineageguard.external_effect_failures,lineageguard.external_effect_reconciliations,
        lineageguard.effect_invocation_reservations TO lineageguard_procedure_owner`,
    );
    await client.query(
      `GRANT UPDATE ON lineageguard.external_effect_attempts,
        lineageguard.effect_invocation_reservations TO lineageguard_procedure_owner`,
    );
    await client.query(
      `GRANT EXECUTE ON FUNCTION lineageguard.canonical_json_text(jsonb),
        lineageguard.effect_intent_fingerprint(lineageguard.external_effect_intents),
        lineageguard.current_run_event_prefix_fingerprint(text)
       TO lineageguard_procedure_owner`,
    );
  });
}

async function grantNarrowAuthority(
  pool: pg.Pool,
  role: string,
  tables: string,
  functions: readonly string[],
): Promise<void> {
  if (!/^[a-z][a-z0-9_]{0,62}$/.test(role)) {
    throw new TypeError("authority role must be a simple PostgreSQL identifier");
  }
  const quotedRole = `"${role}"`;
  await grantProcedureOwnerPrivileges(pool);
  await inTransaction(pool, async (client) => {
    await client.query(`REVOKE ALL ON ALL TABLES IN SCHEMA lineageguard FROM ${quotedRole}`);
    await client.query(`REVOKE ALL ON ALL FUNCTIONS IN SCHEMA lineageguard FROM ${quotedRole}`);
    await client.query(`GRANT USAGE ON SCHEMA lineageguard TO ${quotedRole}`);
    if (tables) await client.query(`GRANT SELECT ON ${tables} TO ${quotedRole}`);
    for (const signature of functions) {
      await client.query(`GRANT EXECUTE ON FUNCTION lineageguard.${signature} TO ${quotedRole}`);
    }
  });
}

export function grantValidationSignerPrivileges(pool: pg.Pool, role: string): Promise<void> {
  return grantNarrowAuthority(
    pool,
    role,
    `lineageguard.runs,lineageguard.run_events,lineageguard.run_bundles,
     lineageguard.migration_candidates,lineageguard.validation_receipts`,
    [
      "signer_lock_validation_run(text)",
      "signer_insert_validation_receipt(text,text,integer,jsonb,text,text,integer,bigint)",
    ],
  );
}

export function grantApprovalAuthorityPrivileges(pool: pg.Pool, role: string): Promise<void> {
  return grantNarrowAuthority(
    pool,
    role,
    `lineageguard.runs,lineageguard.run_events,lineageguard.run_bundles,
     lineageguard.migration_candidates,lineageguard.validation_receipts,
     lineageguard.effect_approvals`,
    [
      "approval_insert_effect_approval(text,text,text,text,text,text,text,timestamptz,text,timestamptz,timestamptz,jsonb,text,jsonb,text,text,integer,bigint)",
    ],
  );
}

export function grantEffectAuthorityPrivileges(pool: pg.Pool, role: string): Promise<void> {
  return grantNarrowAuthority(
    pool,
    role,
    `lineageguard.runs,lineageguard.run_events,lineageguard.run_bundles,
     lineageguard.migration_candidates,lineageguard.validation_receipts,
     lineageguard.effect_approvals,lineageguard.external_effect_intents,
     lineageguard.external_effect_attempts,lineageguard.external_effect_receipts,
     lineageguard.external_effect_failures,lineageguard.external_effect_reconciliations,
     lineageguard.effect_invocation_reservations`,
    [
      "effect_insert_intent(text,text,text,text,text,text,jsonb,text,text,text,text,text,integer,bigint)",
      "effect_reserve_current(text,text,text,text,text,text,text,text,text,text,text,text,text,text,integer,bigint,text,timestamptz)",
      "effect_verify_current(text,text,text,text,text,text,text,text,text,text,text,text,text)",
      "effect_consume_current(text,text,text,text,text,text,text,text,text,text,text,text,text)",
      "effect_cancel_reservation_before_send(text,text,text,text,text,text,text,text,text,text,text,text,text)",
      "effect_set_attempt_state(text,text,timestamptz)",
      "effect_insert_receipt(text,text,jsonb,text,text,text)",
      "effect_insert_failure(text,text,text,integer,text,jsonb)",
      "effect_insert_reconciliation(text,text,text,jsonb)",
    ],
  );
}
