import { randomBytes } from "node:crypto";
import {
  authorizeRunEvent,
  type ExpectedValidationExecution,
  type ImpactCollectionResult,
  type ImpactContext,
  impactCollectionResultSchema,
  impactContextSchema,
  type MigrationCandidate,
  migrationCandidateFingerprint,
  migrationCandidateSchema,
  type ProposedChange,
  type RiskAssessment,
  type RunEvent,
  type RunEventStream,
  retryOperationSchema,
  runStatusSchema,
  type SignedLiveValidationReceipt,
  sha256,
  signedLiveValidationReceiptFingerprint,
  signedLiveValidationReceiptSchema,
  stableId,
} from "@lineageguard/domain";
import type pg from "pg";
import { inTransaction } from "./client.js";
import { parsePersisted } from "./codec.js";
import {
  CorruptDataError,
  IdempotencyConflictError,
  LeaseConflictError,
  mapPostgresError,
  NotFoundError,
  StateConflictError,
} from "./errors.js";
import {
  newEventId,
  newInternalId,
  newLeaseId,
  newRunId,
  requireFingerprint,
  requireRunId,
} from "./ids.js";
import type {
  AssociatedRecord,
  DecisionRecord,
  EffectApprovalRecord,
  EffectAttemptRecord,
  EffectAttemptState,
  EffectFailureRecord,
  EffectIntentRecord,
  EffectKind,
  EffectReceiptRecord,
  EventRecord,
  ExecutionMode,
  LeaseGuard,
  LeaseHistoryRecord,
  RetryAttemptRecord,
  RunRecord,
  RunSnapshot,
  RunStoreCodecs,
  StrictCodec,
} from "./types.js";

const TERMINAL_SQL =
  "('COMPLETED','FAILED_CONTEXT','FAILED_GENERATION','FAILED_VALIDATION','FAILED_GITHUB','FAILED_WRITEBACK','CANCELLED')";

export interface ValidationAuthorityBinding {
  change: ProposedChange;
  context: ImpactContext;
  authoritativeAssessment: RiskAssessment;
  candidate: MigrationCandidate;
  authorizedRunEventStream: RunEventStream;
  expectedExecution: ExpectedValidationExecution;
}

export type ValidationEffectKind = "GITHUB_WRITE" | "DATAHUB_WRITE";
export interface ValidationEffectRequest {
  runId: string;
  effectKind: ValidationEffectKind;
  inputFingerprint: string;
  target: string;
  intentId: string;
  idempotencyKey: string;
}

export interface VerifiedLiveValidation {
  readonly receipt: SignedLiveValidationReceipt;
}

export interface ValidationExecutionClaim {
  runId: string;
  executionMode: "LIVE";
  status: "VALIDATING";
  guard: LeaseGuard;
  eventPrefixFingerprint: string;
  candidateFingerprint: string;
  impactContextFingerprint: string;
  trustedDatabaseTime: string;
  binding: ValidationAuthorityBinding;
}

export interface ValidationReceiptIssueRequest {
  runId: string;
  claimedBindingFingerprint: string;
  claimedRunEventStreamFingerprint: string;
  candidateFingerprint: string;
  expectedExecutionFingerprint: string;
  leaseId: string;
  workerId: string;
  generation: number;
}

export interface ValidationAuthorityPort {
  verifyHistoricalLive(
    receipt: unknown,
    originalValidationBinding: ValidationAuthorityBinding,
  ): VerifiedLiveValidation;
}

export interface EffectApprovalAssertion {
  protectedHeaders: {
    schemaVersion: 2;
    purpose: "LINEAGEGUARD_EFFECT_APPROVAL";
    algorithm: "ED25519";
    issuer: string;
    keyId: string;
    nonce: string;
  };
  payload: ReturnType<typeof canonicalApprovalPayload>;
  signedPayloadFingerprint: string;
  signature: string;
}

export interface ApprovalAuthorityPort {
  verify(
    assertion: unknown,
    expectedPayload: ReturnType<typeof canonicalApprovalPayload>,
  ): EffectApprovalAssertion;
}

export interface CurrentEffectReservationSnapshot {
  originalValidationBinding: ValidationAuthorityBinding;
  originalValidationEventPrefix: RunEventStream;
  currentRunEventStream: RunEventStream;
  currentStatus: "VALIDATED" | "WRITEBACK_PENDING";
  currentLease: { leaseId: string; workerId: string; generation: number; expiresAt: string };
  effectKind: ValidationEffectKind;
  inputFingerprint: string;
  target: string;
  intentId: string;
  idempotencyKey: string;
  approval: {
    status: "APPROVED";
    approvedBy: string;
    approvedAt: string;
    expiresAt: string;
    approvalFingerprint: string;
    validationReceiptId: string;
    validationReceiptFingerprint: string;
    validationCompletedAt: string;
    approvalId: string;
  };
  storedLiveReceipt: SignedLiveValidationReceipt;
  storedLiveReceiptFingerprint: string;
  validationReceiptId: string;
  validationReceiptFingerprint: string;
  approvalId: string;
  approvalFingerprint: string;
  reservationId: string;
  reservationToken: string;
  intentFingerprint: string;
  invokeBy: string;
  trustedDatabaseTime: string;
}

export interface ValidationEffectConsumptionRequest {
  reservationId: string;
  reservationToken: string;
  runId: string;
  intentId: string;
  idempotencyKey: string;
  effectKind: ValidationEffectKind;
  inputFingerprint: string;
  target: string;
  validationReceiptId: string;
  validationReceiptFingerprint: string;
  approvalId: string;
  approvalFingerprint: string;
  intentFingerprint: string;
}

export interface VerifiedEffectReservationSnapshot {
  reservationId: string;
  canonicalEffectFingerprint: string;
  state: "RESERVED" | "CONSUMED";
  invokeBy: string;
  attemptId?: string;
  attemptFence?: string;
}

export interface ConsumedEffectInvocation {
  reservationId: string;
  canonicalEffectFingerprint: string;
  invokeBy: string;
  attemptId: string;
  attemptFence: string;
}

export interface ValidationReceiptAuthorityStore {
  loadValidationExecutionClaim(runId: string): Promise<ValidationAuthorityBinding>;
  issueAndStoreValidationReceipt(
    request: ValidationReceiptIssueRequest,
    issue: (
      authoritativeBinding: ValidationAuthorityBinding,
      trustedDatabaseTime: string,
    ) => SignedLiveValidationReceipt,
  ): Promise<SignedLiveValidationReceipt>;
}

export interface EffectReservationAuthorityStore {
  reserveCurrentEffect(
    request: ValidationEffectRequest & { validationReceiptFingerprint: string },
  ): Promise<CurrentEffectReservationSnapshot>;
  verifyCurrentEffectReservation(
    claim: ValidationEffectConsumptionRequest,
    canonicalEffectFingerprint: string,
  ): Promise<VerifiedEffectReservationSnapshot>;
  consumeCurrentEffect(
    claim: ValidationEffectConsumptionRequest,
    canonicalEffectFingerprint: string,
  ): Promise<ConsumedEffectInvocation>;
  cancelCurrentEffectBeforeSend(
    claim: ValidationEffectConsumptionRequest,
    canonicalEffectFingerprint: string,
  ): Promise<void>;
}

export type StoredValidationBinding = Omit<
  ValidationAuthorityBinding,
  "candidate" | "authorizedRunEventStream"
>;

export interface RunStoreOptions {
  mutationMode?: "PRODUCTION" | "WALKTHROUGH";
  validationAuthority?: ValidationAuthorityPort;
  approvalAuthority?: ApprovalAuthorityPort;
  validationBindingForRun?: (
    runId: string,
  ) => StoredValidationBinding | Promise<StoredValidationBinding>;
}

interface RunRow {
  id: string;
  request_key: string;
  input_fingerprint: string;
  execution_mode: ExecutionMode;
  status: string;
  payload: unknown;
  version: string;
  lease_generation: number;
  next_attempt_at: Date;
  lease_id: string | null;
  worker_id: string | null;
  lease_expires_at: Date | null;
  created_at: Date;
  updated_at: Date;
  lease_active?: boolean;
}

interface EventRow {
  id: string;
  run_id: string;
  sequence: string;
  type: string;
  payload: unknown;
  created_at: Date;
}

interface PositionedRow {
  id: string;
  run_id: string;
  position: number;
  payload: unknown;
  created_at: Date;
}

interface IntentRow {
  id: string;
  run_id: string;
  kind: EffectKind;
  target: string;
  idempotency_key: string;
  input_fingerprint: string;
  input: unknown;
  validation_receipt_id: string;
  candidate_fingerprint: string;
  artifact_set_fingerprint: string;
  created_at: Date;
}

interface ReceiptRow {
  id: string;
  intent_id: string;
  payload: unknown;
  validation_receipt_id: string;
  candidate_fingerprint: string;
  artifact_set_fingerprint: string;
  created_at: Date;
}

interface AttemptRow {
  id: string;
  intent_id: string;
  attempt: number;
  worker_id: string;
  fencing_token: string;
  state: EffectAttemptState;
  claimed_at: Date;
  claim_expires_at: Date;
  updated_at: Date;
  reservation_id: string | null;
}

interface ApprovalRow {
  id: string;
  run_id: string;
  kind: EffectKind;
  target: string;
  input_fingerprint: string;
  validation_receipt_id: string;
  validation_receipt_fingerprint: string;
  validation_completed_at: Date;
  approved_by: string;
  approved_at: Date;
  expires_at: Date;
  payload: unknown;
  approval_fingerprint: string;
  approval_assertion: unknown;
}

interface ReservationRow {
  id: string;
  run_id: string;
  intent_id: string;
  idempotency_key: string;
  kind: EffectKind;
  target: string;
  input_fingerprint: string;
  intent_fingerprint: string;
  validation_receipt_id: string;
  validation_receipt_fingerprint: string;
  approval_id: string;
  approval_fingerprint: string;
  event_prefix_fingerprint: string;
  run_version: string;
  run_status: "VALIDATED" | "WRITEBACK_PENDING";
  lease_id: string;
  worker_id: string;
  generation: number;
  invoke_by: Date;
  state: "RESERVED" | "CONSUMED";
  attempt_id: string | null;
  attempt_fence: string | null;
}

const MAX_APPROVAL_DURATION_MS = 60 * 60 * 1_000;

function canonicalApprovalPayload(input: {
  runId: string;
  kind: EffectKind;
  target: string;
  inputFingerprint: string;
  validationReceiptId: string;
  validationReceiptFingerprint: string;
  validationCompletedAt: Date;
  approvedBy: string;
  approvedAt: Date;
  expiresAt: Date;
}) {
  return {
    domain: "lineageguard.effect-approval.v2" as const,
    runId: input.runId,
    effectKind: validationEffectKind(input.kind),
    target: input.target,
    inputFingerprint: input.inputFingerprint,
    validationReceiptId: input.validationReceiptId,
    validationReceiptFingerprint: input.validationReceiptFingerprint,
    validationCompletedAt: input.validationCompletedAt.toISOString(),
    approvedBy: input.approvedBy,
    approvedAt: input.approvedAt.toISOString(),
    expiresAt: input.expiresAt.toISOString(),
  };
}

export function effectApprovalSignedPayloadFingerprint(
  assertion: Pick<EffectApprovalAssertion, "protectedHeaders" | "payload">,
): string {
  return sha256({
    domain: "lineageguard.effect-approval-assertion.v2",
    protectedHeaders: assertion.protectedHeaders,
    payload: assertion.payload,
  });
}

function integer(value: string | number, label: string): number {
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed)) throw new StateConflictError(`${label} is not a safe integer`);
  return parsed;
}

function stringField(value: unknown, field: string): string {
  if (typeof value !== "object" || value === null || !(field in value)) {
    throw new TypeError(`event requires ${field}`);
  }
  const result = (value as Record<string, unknown>)[field];
  if (typeof result !== "string") throw new TypeError(`event ${field} must be a string`);
  return result;
}

function requireEffectKind(value: string): EffectKind {
  if (value !== "GITHUB_REVIEW" && value !== "DATAHUB_WRITEBACK") {
    throw new TypeError("effect kind is not allowlisted");
  }
  return value;
}

function requireExecutionMode(value: string): ExecutionMode {
  if (value !== "LIVE" && value !== "VERIFIED_REPLAY") {
    throw new TypeError("execution mode is not allowlisted");
  }
  return value;
}

export function effectInputFingerprint(payload: unknown): string {
  return sha256({ domain: "lineageguard.effect-input.v1", payload });
}

function collectionMode(result: ImpactCollectionResult): ExecutionMode {
  if (result.outcome === "FAILED") return result.mode;
  return result.context.collectionOrigin.mode;
}

interface ReceiptBindingPayload {
  intentId: string;
  runId: string;
  effectKind: EffectKind;
  target: string;
  inputFingerprint: string;
  validationReceiptId: string;
  candidateFingerprint: string;
  artifactSetFingerprint: string;
}

function receiptBinding(value: unknown): ReceiptBindingPayload {
  if (typeof value !== "object" || value === null) {
    throw new TypeError("effect receipt must carry an authenticated binding");
  }
  const item = value as Record<string, unknown>;
  if (
    typeof item.runId !== "string" ||
    typeof item.intentId !== "string" ||
    typeof item.target !== "string" ||
    typeof item.inputFingerprint !== "string" ||
    typeof item.candidateFingerprint !== "string" ||
    typeof item.artifactSetFingerprint !== "string"
  ) {
    throw new TypeError("effect receipt binding fields are invalid");
  }
  const validationReceiptId = item.validationReceiptId;
  if (typeof validationReceiptId !== "string" || !/^val_[a-f0-9]{24}$/.test(validationReceiptId)) {
    throw new TypeError("effect receipt validation receipt ID is invalid");
  }
  return {
    intentId: String(item.intentId),
    runId: requireRunId(item.runId),
    effectKind: requireEffectKind(String(item.effectKind)),
    target: requireEffectTarget(item.target),
    inputFingerprint: requireFingerprint(item.inputFingerprint),
    validationReceiptId,
    candidateFingerprint: requireFingerprint(item.candidateFingerprint),
    artifactSetFingerprint: requireFingerprint(item.artifactSetFingerprint),
  };
}

function effectState(kind: EffectKind): "VALIDATED" | "WRITEBACK_PENDING" {
  return kind === "GITHUB_REVIEW" ? "VALIDATED" : "WRITEBACK_PENDING";
}

function validationEffectKind(kind: EffectKind): "GITHUB_WRITE" | "DATAHUB_WRITE" {
  return kind === "GITHUB_REVIEW" ? "GITHUB_WRITE" : "DATAHUB_WRITE";
}

function requireEffectTarget(value: string): string {
  if (!value || value.length > 500) throw new TypeError("effect target must be 1-500 characters");
  return value;
}

function requireLiveEffectContext(context: ImpactContext): void {
  if (context.collectionOrigin.mode !== "LIVE") {
    throw new StateConflictError("external effects require a LIVE impact collection");
  }
}

function canonical<T>(codec: StrictCodec<T>, value: unknown, maxBytes: number, label: string): T {
  const parsed = codec.parse(value);
  const bytes = Buffer.byteLength(JSON.stringify(parsed), "utf8");
  if (bytes > maxBytes) throw new TypeError(`${label} exceeds ${maxBytes} bytes`);
  return parsed;
}

function runFromRow<T>(row: RunRow, codec: StrictCodec<T>): RunRecord<T> {
  return {
    id: requireRunId(row.id),
    requestKey: row.request_key,
    inputFingerprint: row.input_fingerprint,
    executionMode: requireExecutionMode(row.execution_mode),
    status: runStatusSchema.parse(row.status),
    payload: parsePersisted(codec, row.payload, "run payload"),
    version: integer(row.version, "run version"),
    leaseGeneration: row.lease_generation,
    nextAttemptAt: row.next_attempt_at,
    leaseId: row.lease_id,
    workerId: row.worker_id,
    leaseExpiresAt: row.lease_expires_at,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function attemptFromRow(row: AttemptRow): EffectAttemptRecord {
  return {
    id: row.id,
    intentId: row.intent_id,
    attempt: row.attempt,
    workerId: row.worker_id,
    fencingToken: row.fencing_token,
    state: row.state,
    claimedAt: row.claimed_at,
    claimExpiresAt: row.claim_expires_at,
    updatedAt: row.updated_at,
  };
}

export class RunStore<
  TRun,
  TBundle,
  TDecision,
  TMigration,
  TValidation,
  TEffectInput,
  TEffectReceipt,
  TEffectFailure,
> {
  constructor(
    private readonly pool: pg.Pool,
    private readonly codecs: RunStoreCodecs<
      TRun,
      TBundle,
      TDecision,
      TMigration,
      TValidation,
      TEffectInput,
      TEffectReceipt,
      TEffectFailure
    >,
    private readonly options: RunStoreOptions = {},
  ) {}

  protected validationSignerDatabasePool(): pg.Pool {
    throw new StateConflictError("validation signer database boundary is required");
  }

  protected approvalAuthorityDatabasePool(): pg.Pool {
    throw new StateConflictError("approval authority database boundary is required");
  }

  protected effectAuthorityDatabasePool(): pg.Pool {
    throw new StateConflictError("effect invocation authority database boundary is required");
  }

  private async requireCurrentApproval(
    client: pg.PoolClient,
    request: { runId: string; kind: EffectKind; target: string; inputFingerprint: string },
    now?: Date,
  ): Promise<ApprovalRow> {
    const clockNow =
      now ?? (await client.query<{ now: Date }>("SELECT clock_timestamp() AS now")).rows[0]?.now;
    if (!clockNow) throw new StateConflictError("database clock unavailable");
    const result = await client.query<ApprovalRow>(
      `SELECT * FROM lineageguard.effect_approvals
       WHERE run_id=$1 AND kind=$2 AND target=$3 AND input_fingerprint=$4 AND expires_at>$5
       ORDER BY created_at DESC,id DESC LIMIT 1`,
      [request.runId, request.kind, request.target, request.inputFingerprint, clockNow],
    );
    const row = result.rows[0];
    if (!row || row.expires_at <= clockNow) {
      throw new StateConflictError("effect requires an exact unexpired approval");
    }
    const payload = canonicalApprovalPayload({
      runId: row.run_id,
      kind: row.kind,
      target: row.target,
      inputFingerprint: row.input_fingerprint,
      validationReceiptId: row.validation_receipt_id,
      validationReceiptFingerprint: row.validation_receipt_fingerprint,
      validationCompletedAt: row.validation_completed_at,
      approvedBy: row.approved_by,
      approvedAt: row.approved_at,
      expiresAt: row.expires_at,
    });
    if (sha256(row.payload) !== sha256(payload)) {
      throw new CorruptDataError("stored effect approval payload is invalid");
    }
    if (row.approval_fingerprint !== sha256(payload)) {
      throw new CorruptDataError("stored effect approval fingerprint is invalid");
    }
    const approvalAuthority = this.options.approvalAuthority;
    if (!approvalAuthority) {
      throw new StateConflictError("approval signature authority is not configured");
    }
    const assertion = approvalAuthority.verify(row.approval_assertion, payload);
    if (
      assertion.protectedHeaders.schemaVersion !== 2 ||
      assertion.protectedHeaders.purpose !== "LINEAGEGUARD_EFFECT_APPROVAL" ||
      assertion.protectedHeaders.algorithm !== "ED25519" ||
      !assertion.protectedHeaders.issuer ||
      !assertion.protectedHeaders.keyId ||
      !assertion.protectedHeaders.nonce ||
      assertion.signedPayloadFingerprint !== effectApprovalSignedPayloadFingerprint(assertion) ||
      sha256(assertion.payload) !== sha256(payload) ||
      !/^[A-Za-z0-9_-]{32,512}$/.test(assertion.signature)
    ) {
      throw new CorruptDataError("stored effect approval assertion is invalid");
    }
    return row;
  }

  async loadValidationBinding(runId: string): Promise<ValidationAuthorityBinding> {
    requireRunId(runId);
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY");
      const binding = await this.validationBinding(client, runId);
      await client.query("COMMIT");
      return binding;
    } catch (error) {
      await client.query("ROLLBACK").catch(() => undefined);
      throw error;
    } finally {
      client.release();
    }
  }

  async reserveCurrentEffect(
    request: ValidationEffectRequest & { validationReceiptFingerprint: string },
  ): Promise<CurrentEffectReservationSnapshot> {
    requireRunId(request.runId);
    requireFingerprint(request.inputFingerprint);
    requireFingerprint(request.validationReceiptFingerprint);
    requireEffectTarget(request.target);
    const kind: EffectKind =
      request.effectKind === "GITHUB_WRITE" ? "GITHUB_REVIEW" : "DATAHUB_WRITEBACK";
    if (validationEffectKind(kind) !== request.effectKind) {
      throw new TypeError("effect kind is not allowlisted");
    }
    const client = await this.effectAuthorityDatabasePool().connect();
    try {
      await client.query("BEGIN ISOLATION LEVEL SERIALIZABLE");
      const clock = await client.query<{ now: Date }>("SELECT clock_timestamp() AS now");
      const now = clock.rows[0]?.now;
      if (!now) throw new StateConflictError("database clock unavailable");
      const runResult = await client.query<RunRow>(
        `SELECT *,lease_expires_at > $2 AS lease_active
         FROM lineageguard.runs WHERE id=$1`,
        [request.runId, now],
      );
      const run = runResult.rows[0];
      if (!run) throw new NotFoundError("run not found");
      runFromRow(run, this.codecs.run);
      if (
        run.status !== effectState(kind) ||
        run.lease_active !== true ||
        !run.lease_id ||
        !run.worker_id ||
        !run.lease_expires_at
      ) {
        throw new LeaseConflictError("effect snapshot requires the exact current state and lease");
      }
      const validation = await client.query<{ id: string; payload: unknown }>(
        `SELECT id,payload FROM lineageguard.validation_receipts
         WHERE run_id=$1 ORDER BY position DESC,id DESC LIMIT 1`,
        [request.runId],
      );
      const validationRow = validation.rows[0];
      if (!validationRow) throw new StateConflictError("effect snapshot requires validation");
      const receipt = signedLiveValidationReceiptSchema.parse(validationRow.payload);
      if (stableId("val", receipt) !== validationRow.id) {
        throw new CorruptDataError("stored validation receipt ID does not match its content");
      }
      const storedReceiptFingerprint = signedLiveValidationReceiptFingerprint(receipt);
      if (storedReceiptFingerprint !== request.validationReceiptFingerprint) {
        throw new StateConflictError("effect reservation validation receipt is stale");
      }
      const intentResult = await client.query<IntentRow>(
        `SELECT * FROM lineageguard.external_effect_intents
         WHERE id=$1 AND run_id=$2 AND kind=$3 AND target=$4 AND input_fingerprint=$5
           AND idempotency_key=$6`,
        [
          request.intentId,
          request.runId,
          kind,
          request.target,
          request.inputFingerprint,
          request.idempotencyKey,
        ],
      );
      const intent = intentResult.rows[0];
      if (!intent || intent.validation_receipt_id !== validationRow.id) {
        throw new StateConflictError("effect reservation requires the exact persisted intent");
      }
      const originalBinding = await this.validationBinding(
        client,
        request.runId,
        receipt.protectedHeaders.authorizedRunEventStreamFingerprint,
      );
      requireLiveEffectContext(originalBinding.context);
      const currentEvents = (await this.authorizedEvents(client, request.runId)).map(
        (event) => event.payload,
      ) as RunEventStream;
      const approval = await this.requireCurrentApproval(
        client,
        {
          runId: request.runId,
          kind,
          target: request.target,
          inputFingerprint: request.inputFingerprint,
        },
        now,
      );
      const reservationToken = randomBytes(32).toString("base64url");
      const reservationId = newInternalId("effect_reservation");
      const invokeBy = new Date(
        Math.min(
          now.getTime() + 30_000,
          run.lease_expires_at.getTime(),
          approval.expires_at.getTime(),
        ),
      );
      if (invokeBy <= now) throw new LeaseConflictError("effect reservation authority expired");
      const eventPrefixFingerprint = sha256({
        domain: "lineageguard.validation.authorized-run-stream.v1",
        events: currentEvents,
      });
      const reserved = await client.query<ReservationRow>(
        `SELECT * FROM lineageguard.effect_reserve_current(
          $1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18
        )`,
        [
          reservationId,
          request.runId,
          request.intentId,
          request.idempotencyKey,
          kind,
          request.target,
          request.inputFingerprint,
          validationRow.id,
          storedReceiptFingerprint,
          approval.id,
          approval.approval_fingerprint,
          eventPrefixFingerprint,
          run.lease_id,
          run.worker_id,
          run.lease_generation,
          integer(run.version, "run version"),
          sha256({ domain: "lineageguard.effect-reservation-token.v1", token: reservationToken }),
          invokeBy,
        ],
      );
      const reservedRow = reserved.rows[0];
      if (reservedRow?.id !== reservationId) {
        throw new StateConflictError("effect reservation was not stored");
      }
      await client.query("COMMIT");
      return {
        originalValidationBinding: originalBinding,
        originalValidationEventPrefix: originalBinding.authorizedRunEventStream,
        currentRunEventStream: currentEvents,
        currentStatus: run.status as "VALIDATED" | "WRITEBACK_PENDING",
        currentLease: {
          leaseId: run.lease_id,
          workerId: run.worker_id,
          generation: run.lease_generation,
          expiresAt: run.lease_expires_at.toISOString(),
        },
        effectKind: request.effectKind,
        inputFingerprint: request.inputFingerprint,
        target: request.target,
        intentId: request.intentId,
        idempotencyKey: request.idempotencyKey,
        approval: {
          status: "APPROVED",
          approvedBy: approval.approved_by,
          approvedAt: approval.approved_at.toISOString(),
          expiresAt: approval.expires_at.toISOString(),
          approvalFingerprint: approval.approval_fingerprint,
          approvalId: approval.id,
          validationReceiptId: approval.validation_receipt_id,
          validationReceiptFingerprint: approval.validation_receipt_fingerprint,
          validationCompletedAt: approval.validation_completed_at.toISOString(),
        },
        storedLiveReceipt: receipt,
        validationReceiptId: validationRow.id,
        validationReceiptFingerprint: storedReceiptFingerprint,
        approvalId: approval.id,
        approvalFingerprint: approval.approval_fingerprint,
        storedLiveReceiptFingerprint: storedReceiptFingerprint,
        reservationId,
        reservationToken,
        intentFingerprint: reservedRow.intent_fingerprint,
        invokeBy: invokeBy.toISOString(),
        trustedDatabaseTime: now.toISOString(),
      };
    } catch (error) {
      await client.query("ROLLBACK").catch(() => undefined);
      throw error;
    } finally {
      client.release();
    }
  }

  private effectReservationArguments(
    request: ValidationEffectConsumptionRequest,
    canonicalEffectFingerprint: string,
  ): unknown[] {
    requireRunId(request.runId);
    requireFingerprint(request.inputFingerprint);
    requireFingerprint(canonicalEffectFingerprint);
    requireFingerprint(request.validationReceiptFingerprint);
    requireFingerprint(request.approvalFingerprint);
    requireFingerprint(request.intentFingerprint);
    requireEffectTarget(request.target);
    if (request.inputFingerprint !== canonicalEffectFingerprint) {
      throw new StateConflictError("canonical effect fingerprint does not match approved input");
    }
    if (!/^[a-z][a-z0-9_]{1,30}_[a-f0-9]{24}$/.test(request.reservationId)) {
      throw new TypeError("invalid effect reservation ID");
    }
    if (!/^[A-Za-z0-9_-]{32,512}$/.test(request.reservationToken)) {
      throw new TypeError("invalid effect reservation token");
    }
    const kind: EffectKind =
      request.effectKind === "GITHUB_WRITE" ? "GITHUB_REVIEW" : "DATAHUB_WRITEBACK";
    return [
      request.reservationId,
      sha256({
        domain: "lineageguard.effect-reservation-token.v1",
        token: request.reservationToken,
      }),
      request.runId,
      request.intentId,
      request.idempotencyKey,
      kind,
      request.target,
      canonicalEffectFingerprint,
      request.validationReceiptId,
      request.validationReceiptFingerprint,
      request.approvalId,
      request.approvalFingerprint,
      request.intentFingerprint,
    ];
  }

  async verifyCurrentEffectReservation(
    request: ValidationEffectConsumptionRequest,
    canonicalEffectFingerprint: string,
  ): Promise<VerifiedEffectReservationSnapshot> {
    const result = await this.effectAuthorityDatabasePool().query<ReservationRow>(
      `SELECT * FROM lineageguard.effect_verify_current(
        $1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13
      )`,
      this.effectReservationArguments(request, canonicalEffectFingerprint),
    );
    const row = result.rows[0];
    if (!row) throw new StateConflictError("effect reservation verification returned no row");
    return {
      reservationId: row.id,
      canonicalEffectFingerprint: row.input_fingerprint,
      state: row.state,
      invokeBy: row.invoke_by.toISOString(),
      ...(row.attempt_id ? { attemptId: row.attempt_id } : {}),
      ...(row.attempt_fence ? { attemptFence: row.attempt_fence } : {}),
    };
  }

  async consumeCurrentEffect(
    request: ValidationEffectConsumptionRequest,
    canonicalEffectFingerprint: string,
  ): Promise<ConsumedEffectInvocation> {
    const result = await this.effectAuthorityDatabasePool().query<{
      reservation_id: string;
      canonical_effect_fingerprint: string;
      invoke_by: Date;
      attempt_id: string;
      attempt_fence: string;
    }>(
      `SELECT * FROM lineageguard.effect_consume_current(
        $1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13
      )`,
      this.effectReservationArguments(request, canonicalEffectFingerprint),
    );
    const row = result.rows[0];
    if (!row) throw new StateConflictError("effect reservation consumption returned no authority");
    return {
      reservationId: row.reservation_id,
      canonicalEffectFingerprint: row.canonical_effect_fingerprint,
      invokeBy: row.invoke_by.toISOString(),
      attemptId: row.attempt_id,
      attemptFence: row.attempt_fence,
    };
  }

  async cancelCurrentEffectBeforeSend(
    request: ValidationEffectConsumptionRequest,
    canonicalEffectFingerprint: string,
  ): Promise<void> {
    await this.effectAuthorityDatabasePool().query(
      `SELECT lineageguard.effect_cancel_reservation_before_send(
        $1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13
      )`,
      this.effectReservationArguments(request, canonicalEffectFingerprint),
    );
  }

  async createRun(input: {
    requestKey: string;
    inputFingerprint: string;
    executionMode: ExecutionMode;
    payload: unknown;
    nextAttemptAt?: Date;
    id?: string;
  }): Promise<RunRecord<TRun>> {
    requireFingerprint(input.inputFingerprint);
    const executionMode = requireExecutionMode(input.executionMode);
    const id = requireRunId(input.id ?? newRunId());
    const payload = canonical(this.codecs.run, input.payload, 1_048_576, "run payload");
    try {
      return await inTransaction(this.pool, async (client) => {
        const inserted = await client.query<RunRow>(
          `INSERT INTO lineageguard.runs
             (id, request_key, input_fingerprint, execution_mode, payload, next_attempt_at)
           VALUES ($1,$2,$3,$4,$5,$6)
           ON CONFLICT (request_key) DO NOTHING RETURNING *`,
          [
            id,
            input.requestKey,
            input.inputFingerprint,
            executionMode,
            payload,
            input.nextAttemptAt ?? new Date(),
          ],
        );
        const fresh = inserted.rows[0];
        if (fresh) return runFromRow(fresh, this.codecs.run);
        const existing = await client.query<RunRow>(
          "SELECT * FROM lineageguard.runs WHERE request_key=$1",
          [input.requestKey],
        );
        const row = existing.rows[0];
        if (!row) throw new StateConflictError("conflicting run disappeared");
        if (
          row.input_fingerprint !== input.inputFingerprint ||
          row.execution_mode !== executionMode
        ) {
          throw new IdempotencyConflictError("request key was reused with different input");
        }
        return runFromRow(row, this.codecs.run);
      });
    } catch (error) {
      throw mapPostgresError(error);
    }
  }

  private async nextSequence(client: pg.PoolClient, runId: string): Promise<number> {
    const result = await client.query<{ sequence: string }>(
      "SELECT COALESCE(MAX(sequence), -1) + 1 AS sequence FROM lineageguard.run_events WHERE run_id=$1",
      [runId],
    );
    return integer(result.rows[0]?.sequence ?? -1, "event sequence");
  }

  private async appendEvent(client: pg.PoolClient, event: RunEvent): Promise<EventRecord> {
    if (Buffer.byteLength(JSON.stringify(event), "utf8") > 131_072) {
      throw new TypeError("run event exceeds 131072 bytes");
    }
    const result = await client.query<EventRow>(
      `INSERT INTO lineageguard.run_events
         (id,run_id,sequence,type,payload,created_at,lease_id,worker_id,generation,from_status,to_status)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) RETURNING *`,
      [
        event.eventId,
        event.runId,
        event.sequence,
        event.type,
        event,
        event.occurredAt,
        event.leaseId,
        event.workerId,
        event.generation,
        event.type === "RUN_STATUS_CHANGED" ? event.from : null,
        event.type === "RUN_STATUS_CHANGED" ? event.to : null,
      ],
    );
    return this.eventFromRow(result.rows[0] as EventRow, event);
  }

  private eventFromRow(row: EventRow, payload: RunEvent): EventRecord {
    if (
      payload.eventId !== row.id ||
      payload.runId !== row.run_id ||
      payload.sequence !== integer(row.sequence, "event sequence") ||
      payload.type !== row.type ||
      new Date(payload.occurredAt).getTime() !== row.created_at.getTime()
    ) {
      throw new CorruptDataError("persisted run event columns do not match its domain payload");
    }
    return {
      id: row.id,
      runId: row.run_id,
      sequence: payload.sequence,
      type: payload.type,
      payload,
      createdAt: row.created_at,
    };
  }

  private async authorizedEvents(client: pg.PoolClient, runId: string): Promise<EventRecord[]> {
    const rows = await client.query<EventRow>(
      "SELECT * FROM lineageguard.run_events WHERE run_id=$1 ORDER BY sequence,id",
      [runId],
    );
    const stream: RunEvent[] = [];
    const result: EventRecord[] = [];
    for (const row of rows.rows) {
      let authorized: RunEvent[];
      try {
        authorized = authorizeRunEvent(stream, row.payload, row.created_at.toISOString());
      } catch (error) {
        const reason = error instanceof Error ? error.message : "domain authorization failed";
        throw new CorruptDataError(`persisted run event stream is corrupt: ${reason}`);
      }
      const payload = authorized.at(-1);
      if (!payload) throw new CorruptDataError("persisted run event stream is empty");
      stream.push(payload);
      result.push(this.eventFromRow(row, payload));
    }
    return result;
  }

  private async authorizeEvent(
    client: pg.PoolClient,
    runId: string,
    proposed: unknown,
    trustedTime: Date,
  ): Promise<RunEvent> {
    const current = (await this.authorizedEvents(client, runId)).map((event) => event.payload);
    const stream = authorizeRunEvent(current, proposed, trustedTime.toISOString());
    const event = stream.at(-1);
    if (!event) throw new StateConflictError("domain did not authorize an event");
    return event;
  }

  private async lockRunForLease(
    client: pg.PoolClient,
    runId: string,
    guard: LeaseGuard,
    lock = true,
  ): Promise<RunRow> {
    const result = await client.query<RunRow>(
      `SELECT *, lease_expires_at > clock_timestamp() AS lease_active
       FROM lineageguard.runs WHERE id=$1${lock ? " FOR UPDATE" : ""}`,
      [runId],
    );
    const row = result.rows[0];
    if (!row) throw new NotFoundError("run not found");
    runFromRow(row, this.codecs.run);
    if (
      row.lease_id !== guard.leaseId ||
      row.worker_id !== guard.workerId ||
      row.lease_generation !== guard.generation ||
      integer(row.version, "run version") !== guard.fencingVersion ||
      row.lease_active !== true
    ) {
      throw new LeaseConflictError("lease identity, worker, generation, or fence is stale");
    }
    return row;
  }

  async claimDue(workerId: string, leaseMillis: number): Promise<RunRecord<TRun> | null> {
    if (!workerId || workerId.length > 160)
      throw new TypeError("worker ID must be 1-160 characters");
    if (!Number.isSafeInteger(leaseMillis) || leaseMillis <= 0) {
      throw new TypeError("lease duration must be positive");
    }
    return inTransaction(this.pool, async (client) => {
      const candidates = await client.query<RunRow>(
        `SELECT * FROM lineageguard.runs
         WHERE next_attempt_at <= clock_timestamp() AND status NOT IN ${TERMINAL_SQL}
           AND (lease_id IS NULL OR lease_expires_at <= clock_timestamp())
         ORDER BY next_attempt_at,created_at,id FOR UPDATE SKIP LOCKED LIMIT 1`,
      );
      const row = candidates.rows[0];
      if (!row) return null;
      runFromRow(row, this.codecs.run);
      const clock = await client.query<{ now: Date }>("SELECT clock_timestamp() AS now");
      const now = clock.rows[0]?.now;
      if (!now) throw new StateConflictError("database clock unavailable");
      let sequence = await this.nextSequence(client, row.id);
      if (row.lease_id && row.worker_id && row.lease_expires_at) {
        const expired = await this.authorizeEvent(
          client,
          row.id,
          {
            eventId: newEventId(),
            runId: row.id,
            sequence,
            occurredAt: now.toISOString(),
            type: "RUN_LEASE_EXPIRED",
            leaseId: row.lease_id,
            workerId: row.worker_id,
            generation: row.lease_generation,
            expiredAt: now.toISOString(),
          },
          now,
        );
        await this.appendEvent(client, expired);
        sequence += 1;
      }
      const leaseId = newLeaseId();
      const generation = row.lease_generation + 1;
      const expiresAt = new Date(now.getTime() + leaseMillis);
      const acquired = await this.authorizeEvent(
        client,
        row.id,
        {
          eventId: newEventId(),
          runId: row.id,
          sequence,
          occurredAt: now.toISOString(),
          type: "RUN_LEASE_ACQUIRED",
          leaseId,
          workerId,
          generation,
          expiresAt: expiresAt.toISOString(),
        },
        now,
      );
      await client.query(
        `INSERT INTO lineageguard.run_leases
           (lease_id,run_id,worker_id,generation,acquired_at,expires_at)
         VALUES ($1,$2,$3,$4,$5,$6)`,
        [leaseId, row.id, workerId, generation, now, expiresAt],
      );
      const updated = await client.query<RunRow>(
        `UPDATE lineageguard.runs SET lease_id=$2,worker_id=$3,lease_generation=$4,
           lease_expires_at=$5,version=version+1,updated_at=$6 WHERE id=$1 RETURNING *`,
        [row.id, leaseId, workerId, generation, expiresAt, now],
      );
      await this.appendEvent(client, acquired);
      return runFromRow(updated.rows[0] as RunRow, this.codecs.run);
    });
  }

  async renewLease(
    runId: string,
    guard: LeaseGuard,
    leaseMillis: number,
  ): Promise<RunRecord<TRun>> {
    if (!Number.isSafeInteger(leaseMillis) || leaseMillis <= 0) {
      throw new TypeError("lease duration must be positive");
    }
    return inTransaction(this.pool, async (client) => {
      const row = await this.lockRunForLease(client, runId, guard);
      if (!row.lease_expires_at) throw new LeaseConflictError("lease is missing expiry");
      const clock = await client.query<{ now: Date }>("SELECT clock_timestamp() AS now");
      const now = clock.rows[0]?.now as Date;
      const expiresAt = new Date(
        Math.max(now.getTime(), row.lease_expires_at.getTime()) + leaseMillis,
      );
      const event = await this.authorizeEvent(
        client,
        runId,
        {
          eventId: newEventId(),
          runId,
          sequence: await this.nextSequence(client, runId),
          occurredAt: now.toISOString(),
          type: "RUN_LEASE_RENEWED",
          leaseId: guard.leaseId,
          workerId: guard.workerId,
          generation: guard.generation,
          previousExpiresAt: row.lease_expires_at.toISOString(),
          expiresAt: expiresAt.toISOString(),
        },
        now,
      );
      const updated = await client.query<RunRow>(
        "UPDATE lineageguard.runs SET lease_expires_at=$2,version=version+1,updated_at=$3 WHERE id=$1 RETURNING *",
        [runId, expiresAt, now],
      );
      await this.appendEvent(client, event);
      return runFromRow(updated.rows[0] as RunRow, this.codecs.run);
    });
  }

  async releaseLease(runId: string, guard: LeaseGuard): Promise<RunRecord<TRun>> {
    return inTransaction(this.pool, async (client) => {
      await this.lockRunForLease(client, runId, guard);
      const clock = await client.query<{ now: Date }>("SELECT clock_timestamp() AS now");
      const now = clock.rows[0]?.now as Date;
      const event = await this.authorizeEvent(
        client,
        runId,
        {
          eventId: newEventId(),
          runId,
          sequence: await this.nextSequence(client, runId),
          occurredAt: now.toISOString(),
          type: "RUN_LEASE_RELEASED",
          leaseId: guard.leaseId,
          workerId: guard.workerId,
          generation: guard.generation,
        },
        now,
      );
      const updated = await client.query<RunRow>(
        `UPDATE lineageguard.runs SET lease_id=NULL,worker_id=NULL,lease_expires_at=NULL,
           version=version+1,updated_at=$2 WHERE id=$1 RETURNING *`,
        [runId, now],
      );
      await this.appendEvent(client, event);
      return runFromRow(updated.rows[0] as RunRow, this.codecs.run);
    });
  }

  async transition(
    untrustedEvent: unknown,
    expectedVersion: number,
  ): Promise<{
    run: RunRecord<TRun>;
    event: EventRecord;
  }> {
    const runId = requireRunId(stringField(untrustedEvent, "runId"));
    if (!Number.isSafeInteger(expectedVersion) || expectedVersion < 0) {
      throw new TypeError("expected run version must be a non-negative safe integer");
    }
    return inTransaction(this.pool, async (client) => {
      const clock = await client.query<{ now: Date }>("SELECT clock_timestamp() AS now");
      const now = clock.rows[0]?.now as Date;
      const event = await this.authorizeEvent(
        client,
        runId,
        { ...(untrustedEvent as Record<string, unknown>), occurredAt: now.toISOString() },
        now,
      );
      if (event.type !== "RUN_STATUS_CHANGED") {
        throw new StateConflictError("transition requires RUN_STATUS_CHANGED");
      }
      const guard: LeaseGuard = {
        leaseId: event.leaseId,
        workerId: event.workerId,
        generation: event.generation,
        fencingVersion: expectedVersion,
      };
      const row = await this.lockRunForLease(client, event.runId, guard);
      if (row.status !== event.from) throw new StateConflictError("event from-state is stale");
      if (event.sequence !== (await this.nextSequence(client, event.runId))) {
        throw new StateConflictError("event sequence is stale");
      }
      if (event.to === "VALIDATED") await this.assertAcceptedValidation(client, event.runId);
      if (event.to === "COMPLETED") {
        await this.assertAcceptedValidation(client, event.runId, {
          requireOriginalLease: false,
        });
      }
      if (event.to === "REVIEW_ARTIFACT_CREATED") {
        await this.assertBoundEffectReceipt(client, event.runId, "GITHUB_REVIEW");
      }
      if (event.to === "COMPLETED") await this.assertCompletionPrerequisites(client, event.runId);
      const updated = await client.query<RunRow>(
        `SELECT * FROM lineageguard.transition_run($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
        [
          event.runId,
          event.from,
          event.to,
          event.leaseId,
          event.workerId,
          event.generation,
          now,
          event,
          expectedVersion,
        ],
      );
      const changed = updated.rows[0];
      if (!changed) throw new StateConflictError("transition fence was not satisfied");
      const inserted = await client.query<EventRow>(
        "SELECT * FROM lineageguard.run_events WHERE id=$1",
        [event.eventId],
      );
      const persistedEvent = this.eventFromRow(inserted.rows[0] as EventRow, event);
      return { run: runFromRow(changed, this.codecs.run), event: persistedEvent };
    });
  }

  private async currentVersion(client: pg.PoolClient, runId: string): Promise<number> {
    const result = await client.query<{ version: string }>(
      "SELECT version FROM lineageguard.runs WHERE id=$1",
      [runId],
    );
    if (!result.rows[0]) throw new NotFoundError("run not found");
    return integer(result.rows[0].version, "run version");
  }

  private async latestCandidate(client: pg.PoolClient, runId: string) {
    const result = await client.query<{ payload: unknown }>(
      `SELECT payload FROM lineageguard.migration_candidates
       WHERE run_id=$1 ORDER BY position DESC,id DESC LIMIT 1`,
      [runId],
    );
    const row = result.rows[0];
    if (!row) throw new StateConflictError("validation requires a migration candidate");
    return migrationCandidateSchema.parse(row.payload);
  }

  private async validationBinding(
    client: pg.PoolClient,
    runId: string,
    signedStreamFingerprint?: string,
  ): Promise<ValidationAuthorityBinding> {
    const resolve = this.options.validationBindingForRun;
    if (!resolve) throw new StateConflictError("validation binding resolver is not configured");
    const base = await resolve(runId);
    const boundContext = impactContextSchema.parse(base.context);
    const persistedCollection = await client.query<{ payload: unknown }>(
      `SELECT payload FROM lineageguard.run_bundles
       WHERE run_id=$1 AND kind='CONTEXT' ORDER BY position DESC,id DESC LIMIT 1`,
      [runId],
    );
    const persisted = persistedCollection.rows[0];
    if (!persisted) throw new StateConflictError("validation requires persisted impact context");
    const collection = parsePersisted(
      impactCollectionResultSchema,
      persisted.payload,
      "impact collection result",
    );
    if (collection.outcome === "FAILED") {
      throw new StateConflictError("failed impact collection cannot authorize validation");
    }
    const runMode = await client.query<{ execution_mode: ExecutionMode }>(
      "SELECT execution_mode FROM lineageguard.runs WHERE id=$1",
      [runId],
    );
    if (runMode.rows[0]?.execution_mode !== collectionMode(collection)) {
      throw new CorruptDataError("persisted impact collection does not match run execution mode");
    }
    if (JSON.stringify(collection.context) !== JSON.stringify(boundContext)) {
      throw new StateConflictError("validation context does not match persisted collection");
    }
    const candidate = await this.latestCandidate(client, runId);
    if (candidate.sourceImpactContextFingerprint !== collection.context.impactContextFingerprint) {
      throw new StateConflictError("migration candidate does not match persisted impact context");
    }
    const allEvents = (await this.authorizedEvents(client, runId)).map((event) => event.payload);
    let events = allEvents;
    if (signedStreamFingerprint) {
      const match = allEvents.findIndex((_event, index) => {
        const prefix = allEvents.slice(0, index + 1);
        return (
          sha256({
            domain: "lineageguard.validation.authorized-run-stream.v1",
            events: prefix,
          }) === signedStreamFingerprint
        );
      });
      if (match < 0) {
        throw new CorruptDataError("signed validation stream is not a prefix of persisted events");
      }
      events = allEvents.slice(0, match + 1);
    }
    return {
      ...base,
      context: boundContext,
      candidate,
      authorizedRunEventStream: events as RunEventStream,
    };
  }

  private async verifyValidation(
    client: pg.PoolClient,
    runId: string,
    input: unknown,
    requireLiveCollection = false,
  ): Promise<VerifiedLiveValidation> {
    const authority = this.options.validationAuthority;
    if (!authority) {
      throw new StateConflictError("validation authority is not configured");
    }
    const receipt = signedLiveValidationReceiptSchema.parse(input);
    if (receipt.protectedHeaders.runId !== runId) {
      throw new StateConflictError("validation receipt belongs to a different run");
    }
    const binding = await this.validationBinding(
      client,
      runId,
      receipt.protectedHeaders.authorizedRunEventStreamFingerprint,
    );
    if (requireLiveCollection) requireLiveEffectContext(binding.context);
    try {
      return authority.verifyHistoricalLive(receipt, binding);
    } catch (error) {
      const reason = error instanceof Error ? error.message : "validation acceptance failed";
      throw new StateConflictError(`validation receipt was rejected: ${reason}`);
    }
  }

  private async validationExecutionClaim(
    client: pg.PoolClient,
    runId: string,
    lock = false,
  ): Promise<ValidationExecutionClaim> {
    const clock = await client.query<{ now: Date }>("SELECT clock_timestamp() AS now");
    const now = clock.rows[0]?.now;
    if (!now) throw new StateConflictError("database clock unavailable");
    const result = await client.query<RunRow>(
      lock
        ? "SELECT * FROM lineageguard.signer_lock_validation_run($1)"
        : "SELECT * FROM lineageguard.runs WHERE id=$1",
      [runId],
    );
    const run = result.rows[0];
    if (!run) throw new NotFoundError("run not found");
    if (
      run.execution_mode !== "LIVE" ||
      run.status !== "VALIDATING" ||
      !run.lease_id ||
      !run.worker_id ||
      !run.lease_expires_at ||
      run.lease_expires_at <= now
    ) {
      throw new LeaseConflictError("validation issuance requires a live VALIDATING lease");
    }
    const currentGuard: LeaseGuard = {
      leaseId: run.lease_id,
      workerId: run.worker_id,
      generation: run.lease_generation,
      fencingVersion: integer(run.version, "run version"),
    };
    const binding = await this.validationBinding(client, runId);
    const eventPrefixFingerprint = sha256({
      domain: "lineageguard.validation.authorized-run-stream.v1",
      events: binding.authorizedRunEventStream,
    });
    return {
      runId,
      executionMode: "LIVE",
      status: "VALIDATING",
      guard: currentGuard,
      eventPrefixFingerprint,
      candidateFingerprint: migrationCandidateFingerprint(binding.candidate),
      impactContextFingerprint: binding.context.impactContextFingerprint,
      trustedDatabaseTime: now.toISOString(),
      binding,
    };
  }

  async loadValidationExecutionClaim(runId: string): Promise<ValidationAuthorityBinding> {
    requireRunId(runId);
    return inTransaction(this.validationSignerDatabasePool(), async (client) => {
      const claim = await this.validationExecutionClaim(client, runId);
      return claim.binding;
    });
  }

  private async assertAcceptedValidation(
    client: pg.PoolClient,
    runId: string,
    options: {
      effect?: Omit<ValidationEffectRequest, "runId">;
      requireOriginalLease?: boolean;
      requireLiveCollection?: boolean;
    } = {},
  ): Promise<VerifiedLiveValidation> {
    const validations = await client.query<{ id: string; payload: unknown }>(
      `SELECT id,payload FROM lineageguard.validation_receipts
       WHERE run_id=$1 ORDER BY position DESC,id DESC LIMIT 1`,
      [runId],
    );
    const row = validations.rows[0];
    if (!row) throw new StateConflictError("status transition requires accepted validation");
    const clock = await client.query<{ now: Date }>("SELECT clock_timestamp() AS now");
    const now = clock.rows[0]?.now;
    if (!now) throw new StateConflictError("database clock unavailable");
    const verified = await this.verifyValidation(
      client,
      runId,
      row.payload,
      options.requireLiveCollection ?? options.effect !== undefined,
    );
    if (stableId("val", verified.receipt) !== row.id) {
      throw new CorruptDataError("persisted validation receipt ID does not match its content");
    }
    const lease = await client.query<{
      lease_id: string | null;
      worker_id: string | null;
      lease_generation: number;
      lease_active: boolean;
    }>(
      `SELECT lease_id,worker_id,lease_generation,
        lease_expires_at > clock_timestamp() AS lease_active
       FROM lineageguard.runs WHERE id=$1`,
      [runId],
    );
    const current = lease.rows[0];
    const headers = verified.receipt.protectedHeaders;
    if (
      !current?.lease_active ||
      ((options.requireOriginalLease ?? options.effect === undefined) &&
        (current.lease_id !== headers.leaseId ||
          current.worker_id !== headers.workerId ||
          current.lease_generation !== headers.generation))
    ) {
      throw new LeaseConflictError(
        options.effect
          ? "effect requires a current active run lease"
          : "signed validation is outside the current active lease",
      );
    }
    return verified;
  }

  private async assertCompletionPrerequisites(client: pg.PoolClient, runId: string): Promise<void> {
    const github = await this.assertBoundEffectReceipt(client, runId, "GITHUB_REVIEW");
    const datahub = await this.assertBoundEffectReceipt(client, runId, "DATAHUB_WRITEBACK");
    if (
      github.validationReceiptId !== datahub.validationReceiptId ||
      github.candidateFingerprint !== datahub.candidateFingerprint ||
      github.artifactSetFingerprint !== datahub.artifactSetFingerprint
    ) {
      throw new StateConflictError("completed effects do not share one authenticated binding");
    }
  }

  private async assertBoundEffectReceipt(
    client: pg.PoolClient,
    runId: string,
    kind: EffectKind,
  ): Promise<ReceiptBindingPayload> {
    const effects = await client.query<IntentRow & { receipt_payload: unknown }>(
      `SELECT i.*,r.payload AS receipt_payload FROM lineageguard.external_effect_intents i
       JOIN lineageguard.external_effect_receipts r ON r.intent_id=i.id
       JOIN lineageguard.validation_receipts v ON v.id=i.validation_receipt_id
       WHERE i.run_id=$1 AND r.validation_receipt_id=v.id
         AND i.candidate_fingerprint=v.payload#>>'{protectedHeaders,candidateFingerprint}'
         AND r.candidate_fingerprint=i.candidate_fingerprint
         AND i.artifact_set_fingerprint=v.payload#>>'{payload,artifactSetFingerprint}'
         AND r.artifact_set_fingerprint=i.artifact_set_fingerprint
         AND i.kind=$2`,
      [runId, kind],
    );
    if (effects.rows.length !== 1) {
      throw new StateConflictError(`${kind} requires a successful validation-bound receipt`);
    }
    const effect = effects.rows[0] as IntentRow & { receipt_payload: unknown };
    return this.assertEffectReceiptPayload(client, effect, effect.receipt_payload);
  }

  async scheduleRetry(untrustedEvent: unknown): Promise<{
    run: RunRecord<TRun>;
    retry: RetryAttemptRecord;
  }> {
    const runId = requireRunId(stringField(untrustedEvent, "runId"));
    return inTransaction(this.pool, async (client) => {
      const clock = await client.query<{ now: Date }>("SELECT clock_timestamp() AS now");
      const now = clock.rows[0]?.now as Date;
      const attemptInput = (untrustedEvent as Record<string, unknown>).attempt;
      if (!Number.isInteger(attemptInput) || Number(attemptInput) < 1 || Number(attemptInput) > 3) {
        throw new TypeError("retry attempt must be 1-3");
      }
      const delays = [1_000, 5_000, 30_000] as const;
      const event = await this.authorizeEvent(
        client,
        runId,
        {
          ...(untrustedEvent as Record<string, unknown>),
          occurredAt: now.toISOString(),
          retryAt: new Date(now.getTime() + (delays[Number(attemptInput) - 1] ?? 0)).toISOString(),
        },
        now,
      );
      if (event.type !== "RUN_RETRY_SCHEDULED") {
        throw new StateConflictError("scheduleRetry requires RUN_RETRY_SCHEDULED");
      }
      retryOperationSchema.parse(event.operation);
      const guard: LeaseGuard = {
        leaseId: event.leaseId,
        workerId: event.workerId,
        generation: event.generation,
        fencingVersion: await this.currentVersion(client, event.runId),
      };
      await this.lockRunForLease(client, event.runId, guard);
      const retry = await client.query<{
        id: string;
        run_id: string;
        operation: RetryAttemptRecord["operation"];
        attempt: number;
        retry_at: Date;
        created_at: Date;
      }>(
        `INSERT INTO lineageguard.retry_attempts (id,run_id,operation,attempt,retry_at,created_at)
         VALUES ($1,$2,$3,$4,$5,$6) RETURNING *`,
        [
          newInternalId("retry"),
          event.runId,
          event.operation,
          event.attempt,
          event.retryAt,
          event.occurredAt,
        ],
      );
      await this.appendEvent(client, event);
      const released = await this.authorizeEvent(
        client,
        event.runId,
        {
          eventId: newEventId(),
          runId: event.runId,
          sequence: event.sequence + 1,
          occurredAt: event.occurredAt,
          type: "RUN_LEASE_RELEASED",
          leaseId: event.leaseId,
          workerId: event.workerId,
          generation: event.generation,
        },
        now,
      );
      await this.appendEvent(client, released);
      const updated = await client.query<RunRow>(
        `UPDATE lineageguard.runs SET next_attempt_at=$2,lease_id=NULL,worker_id=NULL,
           lease_expires_at=NULL,version=version+1,updated_at=$3 WHERE id=$1 RETURNING *`,
        [event.runId, event.retryAt, event.occurredAt],
      );
      const retryRow = retry.rows[0];
      if (!retryRow) throw new StateConflictError("retry was not stored");
      return {
        run: runFromRow(updated.rows[0] as RunRow, this.codecs.run),
        retry: {
          id: retryRow.id,
          runId: retryRow.run_id,
          operation: retryRow.operation,
          attempt: retryRow.attempt,
          retryAt: retryRow.retry_at,
          createdAt: retryRow.created_at,
        },
      };
    });
  }

  private async appendPositioned<T>(
    table: "run_bundles" | "migration_candidates" | "validation_receipts",
    prefix: string,
    runId: string,
    guard: LeaseGuard,
    input: unknown,
    codec: StrictCodec<T>,
    maxBytes: number,
    kind?: "EVIDENCE" | "CONTEXT",
  ): Promise<{ id: string; position: number; version: number }> {
    const payload = canonical(codec, input, maxBytes, `${table} payload`);
    return inTransaction(this.pool, async (client) => {
      await this.lockRunForLease(client, runId, guard);
      const id = newInternalId(prefix);
      const result = kind
        ? await client.query<{ id: string; position: number }>(
            `INSERT INTO lineageguard.run_bundles (id,run_id,kind,position,payload)
             SELECT $1,$2,$3,COALESCE(MAX(position),0)+1,$4 FROM lineageguard.run_bundles
             WHERE run_id=$2 AND kind=$3 RETURNING id,position`,
            [id, runId, kind, payload],
          )
        : await client.query<{ id: string; position: number }>(
            `INSERT INTO lineageguard.${table} (id,run_id,position,payload)
             SELECT $1,$2,COALESCE(MAX(position),0)+1,$3 FROM lineageguard.${table}
             WHERE run_id=$2 RETURNING id,position`,
            [id, runId, payload],
          );
      await client.query(
        "UPDATE lineageguard.runs SET version=version+1,updated_at=clock_timestamp() WHERE id=$1",
        [runId],
      );
      const row = result.rows[0];
      if (!row) throw new StateConflictError("record was not appended");
      return { ...row, version: guard.fencingVersion + 1 };
    });
  }

  appendBundle(
    runId: string,
    guard: LeaseGuard,
    kind: "EVIDENCE",
    payload: unknown,
  ): Promise<{
    id: string;
    position: number;
    version: number;
  }>;
  appendBundle(
    runId: string,
    guard: LeaseGuard,
    kind: "CONTEXT",
    payload: unknown,
  ): Promise<{
    id: string;
    position: number;
    version: number;
  }>;
  appendBundle(runId: string, guard: LeaseGuard, kind: "EVIDENCE" | "CONTEXT", payload: unknown) {
    return kind === "CONTEXT"
      ? this.appendImpactCollectionResult(runId, guard, payload)
      : this.appendPositioned(
          "run_bundles",
          "bundle",
          runId,
          guard,
          payload,
          this.codecs.bundle,
          1_048_576,
          "EVIDENCE",
        );
  }

  async appendImpactCollectionResult(runId: string, guard: LeaseGuard, payload: unknown) {
    const result = canonical(
      impactCollectionResultSchema,
      payload,
      1_048_576,
      "impact collection result",
    );
    return inTransaction(this.pool, async (client) => {
      const run = await this.lockRunForLease(client, runId, guard);
      if (run.execution_mode !== collectionMode(result)) {
        throw new StateConflictError("impact collection mode does not match immutable run mode");
      }
      const inserted = await client.query<{ id: string; position: number }>(
        `INSERT INTO lineageguard.run_bundles (id,run_id,kind,position,payload)
         SELECT $1,$2,'CONTEXT',COALESCE(MAX(position),0)+1,$3
         FROM lineageguard.run_bundles WHERE run_id=$2 AND kind='CONTEXT'
         RETURNING id,position`,
        [newInternalId("bundle"), runId, result],
      );
      await client.query(
        "UPDATE lineageguard.runs SET version=version+1,updated_at=clock_timestamp() WHERE id=$1",
        [runId],
      );
      const row = inserted.rows[0];
      if (!row) throw new StateConflictError("impact collection result was not appended");
      return { ...row, version: guard.fencingVersion + 1 };
    });
  }

  appendMigrationCandidate(runId: string, guard: LeaseGuard, payload: unknown) {
    return this.appendPositioned(
      "migration_candidates",
      "migration",
      runId,
      guard,
      payload,
      this.codecs.migration,
      2_097_152,
    );
  }

  async appendValidationReceipt(runId: string, guard: LeaseGuard, input: unknown) {
    const parsedInput = signedLiveValidationReceiptSchema.parse(input);
    const persistedRun = (await this.snapshot(runId)).run;
    if (persistedRun.executionMode === "VERIFIED_REPLAY") {
      throw new StateConflictError("verified replay validation import is migrator-only");
    }
    const binding = await this.loadValidationExecutionClaim(runId);
    return this.issueAndStoreValidationReceipt(
      {
        runId,
        claimedBindingFingerprint: sha256({
          domain: "lineageguard.validation-authority-binding.v1",
          change: binding.change,
          context: binding.context,
          assessment: binding.authoritativeAssessment,
          candidate: binding.candidate,
          expectedExecution: binding.expectedExecution,
        }),
        claimedRunEventStreamFingerprint: sha256({
          domain: "lineageguard.validation.authorized-run-stream.v1",
          events: binding.authorizedRunEventStream,
        }),
        candidateFingerprint: migrationCandidateFingerprint(binding.candidate),
        expectedExecutionFingerprint: sha256(binding.expectedExecution),
        leaseId: guard.leaseId,
        workerId: guard.workerId,
        generation: guard.generation,
      },
      () => parsedInput,
    );
  }

  async issueAndStoreValidationReceipt(
    request: ValidationReceiptIssueRequest,
    issue: (
      binding: ValidationAuthorityBinding,
      trustedDatabaseTime: string,
    ) => SignedLiveValidationReceipt,
  ): Promise<SignedLiveValidationReceipt> {
    requireRunId(request.runId);
    if (typeof issue !== "function") throw new TypeError("validation issuer callback is required");
    return inTransaction(this.validationSignerDatabasePool(), async (client) => {
      const claim = await this.validationExecutionClaim(client, request.runId, true);
      const bindingFingerprint = sha256({
        domain: "lineageguard.validation-authority-binding.v1",
        change: claim.binding.change,
        context: claim.binding.context,
        assessment: claim.binding.authoritativeAssessment,
        candidate: claim.binding.candidate,
        expectedExecution: claim.binding.expectedExecution,
      });
      if (
        request.claimedBindingFingerprint !== bindingFingerprint ||
        request.claimedRunEventStreamFingerprint !== claim.eventPrefixFingerprint ||
        request.candidateFingerprint !== claim.candidateFingerprint ||
        request.expectedExecutionFingerprint !== sha256(claim.binding.expectedExecution) ||
        request.leaseId !== claim.guard.leaseId ||
        request.workerId !== claim.guard.workerId ||
        request.generation !== claim.guard.generation
      ) {
        throw new LeaseConflictError("validation issuance claim changed during execution");
      }
      const issued = issue(claim.binding, claim.trustedDatabaseTime);
      if (
        typeof issued === "object" &&
        issued !== null &&
        "then" in issued &&
        typeof (issued as { then?: unknown }).then === "function"
      ) {
        throw new TypeError("validation issuer callback must be synchronous");
      }
      const accepted = await this.verifyValidation(client, request.runId, issued);
      const payload = signedLiveValidationReceiptSchema.parse(accepted.receipt);
      if (
        payload.protectedHeaders.authorizedRunEventStreamFingerprint !==
          claim.eventPrefixFingerprint ||
        payload.protectedHeaders.candidateFingerprint !== claim.candidateFingerprint
      ) {
        throw new StateConflictError("issued validation does not match the locked execution claim");
      }
      if (Buffer.byteLength(JSON.stringify(payload), "utf8") > 1_048_576) {
        throw new TypeError("validation receipt exceeds 1048576 bytes");
      }
      const result = await client.query<{ id: string; position: number }>(
        `SELECT id,position FROM lineageguard.signer_insert_validation_receipt(
           $1,$2,(SELECT COALESCE(MAX(position),0)+1 FROM lineageguard.validation_receipts WHERE run_id=$2),
           $3,$4,$5,$6,$7
         )`,
        [
          stableId("val", payload),
          request.runId,
          payload,
          claim.guard.leaseId,
          claim.guard.workerId,
          claim.guard.generation,
          claim.guard.fencingVersion,
        ],
      );
      const row = result.rows[0];
      if (!row) throw new StateConflictError("validation receipt was not appended");
      return payload;
    });
  }

  async saveDecision(
    runId: string,
    guard: LeaseGuard,
    scope: "BASELINE" | "GROUNDED",
    input: unknown,
  ) {
    const payload = canonical(this.codecs.decision, input, 1_048_576, "decision payload");
    return inTransaction(this.pool, async (client) => {
      await this.lockRunForLease(client, runId, guard);
      const id = newInternalId("decision");
      await client.query(
        "INSERT INTO lineageguard.run_decisions (id,run_id,scope,payload) VALUES ($1,$2,$3,$4)",
        [id, runId, scope, payload],
      );
      await client.query("UPDATE lineageguard.runs SET version=version+1 WHERE id=$1", [runId]);
      return { id, version: guard.fencingVersion + 1 };
    });
  }

  async recordEffectApproval(input: {
    runId: string;
    guard: LeaseGuard;
    kind: EffectKind;
    target: string;
    inputFingerprint: string;
    approvedBy: string;
    approvedAt: Date;
    expiresAt: Date;
    assertion: unknown;
  }): Promise<EffectApprovalRecord> {
    const kind = requireEffectKind(input.kind);
    requireFingerprint(input.inputFingerprint);
    requireEffectTarget(input.target);
    if (!input.approvedBy || input.approvedBy.length > 240) {
      throw new TypeError("invalid approval identity");
    }
    if (Number.isNaN(input.approvedAt.getTime()) || Number.isNaN(input.expiresAt.getTime())) {
      throw new TypeError("approval times must be valid instants");
    }
    return inTransaction(this.approvalAuthorityDatabasePool(), async (client) => {
      const run = await this.lockRunForLease(client, input.runId, input.guard, false);
      if (run.status !== effectState(kind)) {
        throw new StateConflictError(`${kind} approval is not allowed from ${run.status}`);
      }
      if (run.execution_mode !== "LIVE") {
        throw new StateConflictError("verified replay cannot authorize approval or effects");
      }
      const clock = await client.query<{ now: Date }>("SELECT clock_timestamp() AS now");
      const now = clock.rows[0]?.now;
      if (
        !now ||
        input.approvedAt > now ||
        input.expiresAt <= now ||
        input.expiresAt.getTime() - now.getTime() > MAX_APPROVAL_DURATION_MS ||
        input.expiresAt <= input.approvedAt
      ) {
        throw new StateConflictError("approval must be current and expire within one hour");
      }
      const validation = await this.assertAcceptedValidation(client, input.runId, {
        requireOriginalLease: false,
        requireLiveCollection: true,
      });
      const validationReceiptId = stableId("val", validation.receipt);
      const validationReceiptFingerprint = signedLiveValidationReceiptFingerprint(
        validation.receipt,
      );
      const validationCompletedAt = new Date(validation.receipt.payload.completedAt);
      if (input.approvedAt < validationCompletedAt) {
        throw new StateConflictError("approval cannot predate the bound validation");
      }
      const approvalPayload = canonicalApprovalPayload({
        ...input,
        kind,
        validationReceiptId,
        validationReceiptFingerprint,
        validationCompletedAt,
      });
      const approvalFingerprint = sha256(approvalPayload);
      const approvalAuthority = this.options.approvalAuthority;
      if (!approvalAuthority) {
        throw new StateConflictError("approval signature authority is not configured");
      }
      const assertion = approvalAuthority.verify(input.assertion, approvalPayload);
      if (
        assertion.protectedHeaders.schemaVersion !== 2 ||
        assertion.protectedHeaders.purpose !== "LINEAGEGUARD_EFFECT_APPROVAL" ||
        assertion.protectedHeaders.algorithm !== "ED25519" ||
        !assertion.protectedHeaders.issuer ||
        !assertion.protectedHeaders.keyId ||
        !assertion.protectedHeaders.nonce ||
        sha256(assertion.payload) !== sha256(approvalPayload) ||
        assertion.signedPayloadFingerprint !== effectApprovalSignedPayloadFingerprint(assertion) ||
        !/^[A-Za-z0-9_-]{32,512}$/.test(assertion.signature)
      ) {
        throw new StateConflictError("approval assertion is not canonical or authenticated");
      }
      const inserted = await client.query<ApprovalRow>(
        `SELECT * FROM lineageguard.approval_insert_effect_approval(
           $1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18
         )`,
        [
          newInternalId("approval"),
          input.runId,
          kind,
          input.target,
          input.inputFingerprint,
          validationReceiptId,
          validationReceiptFingerprint,
          validationCompletedAt,
          input.approvedBy,
          input.approvedAt,
          input.expiresAt,
          approvalPayload,
          approvalFingerprint,
          assertion,
          input.guard.leaseId,
          input.guard.workerId,
          input.guard.generation,
          input.guard.fencingVersion,
        ],
      );
      const row =
        inserted.rows[0] ??
        (
          await client.query<ApprovalRow>(
            `SELECT * FROM lineageguard.effect_approvals
             WHERE approval_fingerprint=$1`,
            [approvalFingerprint],
          )
        ).rows[0];
      if (!row) throw new StateConflictError("effect approval was not stored");
      const current = await this.requireCurrentApproval(
        client,
        {
          runId: input.runId,
          kind,
          target: input.target,
          inputFingerprint: input.inputFingerprint,
        },
        now,
      );
      if (current.id !== row.id || current.approval_fingerprint !== approvalFingerprint) {
        throw new IdempotencyConflictError("approval binding conflicts with persisted approval");
      }
      return {
        id: row.id,
        runId: row.run_id,
        kind: row.kind,
        target: row.target,
        inputFingerprint: row.input_fingerprint,
        validationReceiptId: row.validation_receipt_id,
        validationReceiptFingerprint: row.validation_receipt_fingerprint,
        validationCompletedAt: row.validation_completed_at,
        approvedBy: row.approved_by,
        approvedAt: row.approved_at,
        expiresAt: row.expires_at,
        approvalFingerprint: row.approval_fingerprint,
      };
    });
  }

  async beginEffect(input: {
    runId: string;
    guard: LeaseGuard;
    kind: EffectKind;
    target: string;
    idempotencyKey: string;
    inputFingerprint: string;
    payload: unknown;
  }): Promise<{
    intent: EffectIntentRecord<TEffectInput>;
    receipt: EffectReceiptRecord<TEffectReceipt> | null;
    created: boolean;
    version: number;
  }> {
    const kind = requireEffectKind(input.kind);
    requireFingerprint(input.inputFingerprint);
    requireEffectTarget(input.target);
    const payload = canonical(this.codecs.effectInput, input.payload, 1_048_576, "effect input");
    const computedInputFingerprint = effectInputFingerprint(payload);
    if (input.inputFingerprint !== computedInputFingerprint) {
      throw new StateConflictError("effect input fingerprint does not match canonical payload");
    }
    return inTransaction(this.effectAuthorityDatabasePool(), async (client) => {
      const run = await this.lockRunForLease(client, input.runId, input.guard, false);
      if (run.status !== effectState(kind)) {
        throw new StateConflictError(`${kind} is not allowed from ${run.status}`);
      }
      if (run.execution_mode !== "LIVE") {
        throw new StateConflictError("verified replay cannot authorize approval or effects");
      }
      const validation = await this.assertAcceptedValidation(client, input.runId);
      const validationReceiptId = stableId("val", validation.receipt);
      if ((this.options.mutationMode ?? "PRODUCTION") === "PRODUCTION") {
        await this.requireCurrentApproval(client, {
          runId: input.runId,
          kind,
          target: input.target,
          inputFingerprint: input.inputFingerprint,
        });
      }
      await client.query("SELECT pg_advisory_xact_lock(hashtext($1),hashtext($2 || ':' || $3))", [
        kind,
        input.target,
        input.idempotencyKey,
      ]);
      const existing = await client.query<IntentRow>(
        "SELECT * FROM lineageguard.external_effect_intents WHERE kind=$1 AND target=$2 AND idempotency_key=$3",
        [kind, input.target, input.idempotencyKey],
      );
      let row = existing.rows[0];
      let created = false;
      let version = input.guard.fencingVersion;
      if (row) {
        if (
          row.run_id !== input.runId ||
          row.input_fingerprint !== input.inputFingerprint ||
          row.validation_receipt_id !== validationReceiptId ||
          row.candidate_fingerprint !== validation.receipt.protectedHeaders.candidateFingerprint ||
          row.artifact_set_fingerprint !== validation.receipt.payload.artifactSetFingerprint ||
          sha256(parsePersisted(this.codecs.effectInput, row.input, "effect input")) !==
            sha256(payload)
        ) {
          throw new IdempotencyConflictError("effect key was reused with different input or run");
        }
      } else {
        const inserted = await client.query<IntentRow>(
          `SELECT * FROM lineageguard.effect_insert_intent(
             $1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14
           )`,
          [
            newInternalId("effect"),
            input.runId,
            kind,
            input.target,
            input.idempotencyKey,
            input.inputFingerprint,
            payload,
            validationReceiptId,
            validation.receipt.protectedHeaders.candidateFingerprint,
            validation.receipt.payload.artifactSetFingerprint,
            input.guard.leaseId,
            input.guard.workerId,
            input.guard.generation,
            input.guard.fencingVersion,
          ],
        );
        row = inserted.rows[0];
        if (!row) throw new StateConflictError("effect intent was not stored");
        created = true;
        version += 1;
      }
      const receipt = await client.query<ReceiptRow>(
        "SELECT * FROM lineageguard.external_effect_receipts WHERE intent_id=$1",
        [row.id],
      );
      return {
        intent: this.intentFromRow(row),
        receipt: receipt.rows[0] ? this.receiptFromRow(receipt.rows[0]) : null,
        created,
        version,
      };
    });
  }

  private async assertEffectReceiptPayload(
    client: pg.PoolClient,
    intent: IntentRow,
    payload: unknown,
  ): Promise<ReceiptBindingPayload> {
    const binding = receiptBinding(payload);
    const validationResult = await client.query<{ id: string; payload: unknown }>(
      "SELECT id,payload FROM lineageguard.validation_receipts WHERE id=$1 AND run_id=$2",
      [intent.validation_receipt_id, intent.run_id],
    );
    const validationRow = validationResult.rows[0];
    if (!validationRow) throw new CorruptDataError("effect intent validation is missing");
    const validation = await this.verifyValidation(client, intent.run_id, validationRow.payload);
    const expected = {
      intentId: intent.id,
      runId: intent.run_id,
      effectKind: intent.kind,
      target: intent.target,
      inputFingerprint: intent.input_fingerprint,
      validationReceiptId: validationRow.id,
      candidateFingerprint: validation.receipt.protectedHeaders.candidateFingerprint,
      artifactSetFingerprint: validation.receipt.payload.artifactSetFingerprint,
    };
    if (sha256(binding) !== sha256(expected)) {
      throw new StateConflictError(
        "effect receipt payload does not match current authenticated binding",
      );
    }
    if (
      intent.validation_receipt_id !== expected.validationReceiptId ||
      intent.candidate_fingerprint !== expected.candidateFingerprint ||
      intent.artifact_set_fingerprint !== expected.artifactSetFingerprint
    ) {
      throw new StateConflictError(
        "effect intent is stale against current authenticated validation",
      );
    }
    return binding;
  }

  async recordEffectSuccess(input: {
    attemptId: string;
    workerId: string;
    fencingToken: string;
    payload: unknown;
  }): Promise<EffectReceiptRecord<TEffectReceipt>> {
    const payload = canonical(
      this.codecs.effectReceipt,
      input.payload,
      1_048_576,
      "effect receipt",
    );
    return inTransaction(this.effectAuthorityDatabasePool(), async (client) => {
      await client.query("SELECT pg_advisory_xact_lock(hashtext($1))", [input.attemptId]);
      const attempt = await client.query<AttemptRow>(
        "SELECT * FROM lineageguard.external_effect_attempts WHERE id=$1",
        [input.attemptId],
      );
      const row = attempt.rows[0];
      if (!row) throw new NotFoundError("effect attempt not found");
      const intent = await client.query<IntentRow>(
        "SELECT * FROM lineageguard.external_effect_intents WHERE id=$1",
        [row.intent_id],
      );
      const intentRow = intent.rows[0];
      if (!intentRow) throw new CorruptDataError("effect attempt references a missing intent");
      const reservation = await client.query<ReservationRow>(
        "SELECT * FROM lineageguard.effect_invocation_reservations WHERE id=$1",
        [row.reservation_id],
      );
      const reservationRow = reservation.rows[0];
      if (
        reservationRow?.state !== "CONSUMED" ||
        reservationRow.attempt_id !== row.id ||
        reservationRow.intent_id !== intentRow.id
      ) {
        throw new StateConflictError("effect success lacks consumed reservation authority");
      }
      if (row.worker_id !== input.workerId || row.fencing_token !== input.fencingToken) {
        throw new LeaseConflictError("effect attempt fence is stale");
      }
      if (row.state !== "SUCCEEDED" && row.state !== "READY_TO_INVOKE") {
        throw new LeaseConflictError("effect attempt is not eligible for success");
      }
      const binding = await this.assertEffectReceiptPayload(client, intentRow, payload);
      let receipt = await client.query<ReceiptRow>(
        "SELECT * FROM lineageguard.external_effect_receipts WHERE intent_id=$1",
        [row.intent_id],
      );
      let persisted = receipt.rows[0];
      if (!persisted) {
        await client.query(`SELECT * FROM lineageguard.effect_insert_receipt($1,$2,$3,$4,$5,$6)`, [
          newInternalId("receipt"),
          row.intent_id,
          payload,
          binding.validationReceiptId,
          binding.candidateFingerprint,
          binding.artifactSetFingerprint,
        ]);
        receipt = await client.query<ReceiptRow>(
          "SELECT * FROM lineageguard.external_effect_receipts WHERE intent_id=$1",
          [row.intent_id],
        );
        persisted = receipt.rows[0];
      }
      if (!persisted) throw new StateConflictError("effect receipt was not persisted");
      const equal = await client.query<{ equal: boolean }>(
        "SELECT $1::jsonb = $2::jsonb AS equal",
        [persisted.payload, payload],
      );
      if (equal.rows[0]?.equal !== true)
        throw new IdempotencyConflictError("success receipt conflicts with persisted receipt");
      if (row.state !== "SUCCEEDED") {
        await client.query(
          "SELECT * FROM lineageguard.effect_set_attempt_state($1,'SUCCEEDED',clock_timestamp())",
          [row.id],
        );
      }
      return this.receiptFromRow(persisted);
    });
  }

  async recordEffectAmbiguous(input: {
    attemptId: string;
    workerId: string;
    fencingToken: string;
    payload: unknown;
  }): Promise<EffectAttemptRecord> {
    const payload = canonical(this.codecs.effectFailure, input.payload, 65_536, "effect failure");
    return inTransaction(this.effectAuthorityDatabasePool(), async (client) => {
      await client.query("SELECT pg_advisory_xact_lock(hashtext($1))", [input.attemptId]);
      const attempt = await client.query<AttemptRow>(
        "SELECT * FROM lineageguard.external_effect_attempts WHERE id=$1",
        [input.attemptId],
      );
      const row = attempt.rows[0];
      if (!row) throw new NotFoundError("effect attempt not found");
      if (
        row.worker_id !== input.workerId ||
        row.fencing_token !== input.fencingToken ||
        row.state !== "READY_TO_INVOKE"
      ) {
        throw new LeaseConflictError("effect attempt is not the live invocation fence");
      }
      const failure = await client.query<{ position: number }>(
        "SELECT COALESCE(MAX(position),0)+1 AS position FROM lineageguard.external_effect_failures WHERE intent_id=$1",
        [row.intent_id],
      );
      await client.query(
        `SELECT * FROM lineageguard.effect_insert_failure(
           $1,$2,(SELECT run_id FROM lineageguard.external_effect_intents WHERE id=$2),
           $3,'RECONCILIATION_REQUIRED',$4
         )`,
        [newInternalId("failure"), row.intent_id, failure.rows[0]?.position, payload],
      );
      const changed = await client.query<AttemptRow>(
        "SELECT * FROM lineageguard.effect_set_attempt_state($1,'RECONCILIATION_REQUIRED',clock_timestamp())",
        [row.id],
      );
      return attemptFromRow(changed.rows[0] as AttemptRow);
    });
  }

  async reconcileEffectAttempt(input: {
    runId: string;
    guard: LeaseGuard;
    attemptId: string;
    workerId: string;
    fencingToken: string;
    proofOutcome: "APPLIED" | "NOT_APPLIED";
    proof: unknown;
    receipt?: unknown;
  }): Promise<EffectAttemptRecord> {
    const proof = canonical(this.codecs.effectFailure, input.proof, 65_536, "reconciliation proof");
    return inTransaction(this.effectAuthorityDatabasePool(), async (client) => {
      await client.query("SELECT pg_advisory_xact_lock(hashtext($1))", [input.attemptId]);
      const attempt = await client.query<AttemptRow>(
        "SELECT * FROM lineageguard.external_effect_attempts WHERE id=$1",
        [input.attemptId],
      );
      const row = attempt.rows[0];
      if (row?.state !== "RECONCILIATION_REQUIRED") {
        throw new StateConflictError("attempt does not require reconciliation");
      }
      const intent = await client.query<IntentRow>(
        "SELECT * FROM lineageguard.external_effect_intents WHERE id=$1",
        [row.intent_id],
      );
      const intentRow = intent.rows[0];
      if (!intentRow || intentRow.run_id !== input.runId) {
        throw new StateConflictError("reconciliation attempt does not belong to run");
      }
      await this.lockRunForLease(client, input.runId, input.guard, false);
      if (row.worker_id !== input.workerId || row.fencing_token !== input.fencingToken) {
        throw new LeaseConflictError("reconciliation attempt fence is stale");
      }
      const latest = await client.query<{ id: string }>(
        `SELECT id FROM lineageguard.external_effect_attempts
         WHERE intent_id=$1 ORDER BY attempt DESC LIMIT 1`,
        [row.intent_id],
      );
      if (latest.rows[0]?.id !== row.id) {
        throw new LeaseConflictError("reconciliation attempt is no longer current");
      }
      await client.query(`SELECT * FROM lineageguard.effect_insert_reconciliation($1,$2,$3,$4)`, [
        newInternalId("reconciliation"),
        row.id,
        input.proofOutcome,
        proof,
      ]);
      const persistedProof = await client.query<{
        proof_outcome: "APPLIED" | "NOT_APPLIED";
        payload: unknown;
      }>(
        "SELECT proof_outcome,payload FROM lineageguard.external_effect_reconciliations WHERE attempt_id=$1",
        [row.id],
      );
      const savedProof = persistedProof.rows[0];
      if (!savedProof) throw new StateConflictError("reconciliation proof was not persisted");
      const sameProof = await client.query<{ equal: boolean }>(
        "SELECT $1::jsonb=$2::jsonb AS equal",
        [savedProof.payload, proof],
      );
      if (savedProof.proof_outcome !== input.proofOutcome || sameProof.rows[0]?.equal !== true) {
        throw new IdempotencyConflictError("reconciliation proof conflicts with persisted proof");
      }
      if (input.proofOutcome === "APPLIED") {
        if (input.receipt === undefined)
          throw new StateConflictError("APPLIED proof requires a receipt");
        const receipt = canonical(
          this.codecs.effectReceipt,
          input.receipt,
          1_048_576,
          "effect receipt",
        );
        const binding = await this.assertEffectReceiptPayload(client, intentRow, receipt);
        await client.query(`SELECT * FROM lineageguard.effect_insert_receipt($1,$2,$3,$4,$5,$6)`, [
          newInternalId("receipt"),
          row.intent_id,
          receipt,
          binding.validationReceiptId,
          binding.candidateFingerprint,
          binding.artifactSetFingerprint,
        ]);
        const changed = await client.query<AttemptRow>(
          "SELECT * FROM lineageguard.effect_set_attempt_state($1,'SUCCEEDED',clock_timestamp())",
          [row.id],
        );
        return attemptFromRow(changed.rows[0] as AttemptRow);
      }
      return attemptFromRow(row);
    });
  }

  private intentFromRow(row: IntentRow): EffectIntentRecord<TEffectInput> {
    return {
      id: row.id,
      runId: row.run_id,
      kind: row.kind,
      target: row.target,
      idempotencyKey: row.idempotency_key,
      inputFingerprint: row.input_fingerprint,
      input: parsePersisted(this.codecs.effectInput, row.input, "effect input"),
      createdAt: row.created_at,
    };
  }

  private receiptFromRow(row: ReceiptRow): EffectReceiptRecord<TEffectReceipt> {
    return {
      id: row.id,
      intentId: row.intent_id,
      payload: parsePersisted(this.codecs.effectReceipt, row.payload, "effect receipt"),
      createdAt: row.created_at,
    };
  }

  async snapshot(
    runId: string,
  ): Promise<
    RunSnapshot<
      TRun,
      TBundle,
      TDecision,
      TMigration,
      TValidation,
      TEffectInput,
      TEffectReceipt,
      TEffectFailure
    >
  > {
    requireRunId(runId);
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY");
      const runs = await client.query<RunRow>("SELECT * FROM lineageguard.runs WHERE id=$1", [
        runId,
      ]);
      const parsedEvents = await this.authorizedEvents(client, runId);
      const leases = await client.query<{
        lease_id: string;
        run_id: string;
        worker_id: string;
        generation: number;
        acquired_at: Date;
        expires_at: Date;
      }>("SELECT * FROM lineageguard.run_leases WHERE run_id=$1 ORDER BY generation,lease_id", [
        runId,
      ]);
      const bundles = await client.query<PositionedRow & { kind: "EVIDENCE" | "CONTEXT" }>(
        "SELECT * FROM lineageguard.run_bundles WHERE run_id=$1 ORDER BY kind,position,id",
        [runId],
      );
      const decisions = await client.query<PositionedRow & { scope: "BASELINE" | "GROUNDED" }>(
        "SELECT * FROM lineageguard.run_decisions WHERE run_id=$1 ORDER BY scope,position,id",
        [runId],
      );
      const migrations = await client.query<PositionedRow>(
        "SELECT * FROM lineageguard.migration_candidates WHERE run_id=$1 ORDER BY position,id",
        [runId],
      );
      const validations = await client.query<PositionedRow>(
        "SELECT * FROM lineageguard.validation_receipts WHERE run_id=$1 ORDER BY position,id",
        [runId],
      );
      const retries = await client.query<{
        id: string;
        run_id: string;
        operation: RetryAttemptRecord["operation"];
        attempt: number;
        retry_at: Date;
        created_at: Date;
      }>(
        "SELECT * FROM lineageguard.retry_attempts WHERE run_id=$1 ORDER BY operation,attempt,id",
        [runId],
      );
      const approvals = await client.query<ApprovalRow>(
        `SELECT * FROM lineageguard.effect_approval_summaries
         WHERE run_id=$1 ORDER BY kind,target,input_fingerprint,id`,
        [runId],
      );
      const intents = await client.query<IntentRow>(
        "SELECT * FROM lineageguard.external_effect_intents WHERE run_id=$1 ORDER BY created_at,id",
        [runId],
      );
      const attempts = await client.query<AttemptRow>(
        "SELECT a.* FROM lineageguard.external_effect_attempts a JOIN lineageguard.external_effect_intents i ON i.id=a.intent_id WHERE i.run_id=$1 ORDER BY a.intent_id,a.attempt,a.id",
        [runId],
      );
      const reconciliations = await client.query<{
        id: string;
        attempt_id: string;
        proof_outcome: "APPLIED" | "NOT_APPLIED";
        payload: unknown;
        created_at: Date;
      }>(
        "SELECT r.* FROM lineageguard.external_effect_reconciliations r JOIN lineageguard.external_effect_attempts a ON a.id=r.attempt_id JOIN lineageguard.external_effect_intents i ON i.id=a.intent_id WHERE i.run_id=$1 ORDER BY a.intent_id,a.attempt,r.id",
        [runId],
      );
      const receipts = await client.query<ReceiptRow>(
        "SELECT r.* FROM lineageguard.external_effect_receipts r JOIN lineageguard.external_effect_intents i ON i.id=r.intent_id WHERE i.run_id=$1 ORDER BY r.created_at,r.id",
        [runId],
      );
      const failures = await client.query<
        PositionedRow & { intent_id: string; outcome: "FAILED" | "RECONCILIATION_REQUIRED" }
      >(
        "SELECT * FROM lineageguard.external_effect_failures WHERE run_id=$1 ORDER BY intent_id,position,id",
        [runId],
      );
      await client.query("COMMIT");
      const run = runs.rows[0];
      if (!run) throw new NotFoundError("run not found");
      const mapPositioned = <T>(
        row: PositionedRow,
        codec: StrictCodec<T>,
        label: string,
      ): AssociatedRecord<T> => ({
        id: row.id,
        runId: row.run_id,
        position: row.position,
        payload: parsePersisted(codec, row.payload, label),
        createdAt: row.created_at,
      });
      return {
        run: runFromRow(run, this.codecs.run),
        events: parsedEvents,
        leases: leases.rows.map(
          (lease): LeaseHistoryRecord => ({
            leaseId: lease.lease_id,
            runId: lease.run_id,
            workerId: lease.worker_id,
            generation: lease.generation,
            acquiredAt: lease.acquired_at,
            initialExpiresAt: lease.expires_at,
          }),
        ),
        bundles: bundles.rows.map((row) =>
          row.kind === "CONTEXT"
            ? {
                ...mapPositioned(row, impactCollectionResultSchema, "impact collection result"),
                kind: "CONTEXT" as const,
              }
            : {
                ...mapPositioned(row, this.codecs.bundle, "evidence bundle"),
                kind: "EVIDENCE" as const,
              },
        ),
        decisions: decisions.rows.map(
          (row): DecisionRecord<TDecision> => ({
            ...mapPositioned(row, this.codecs.decision, "decision"),
            scope: row.scope,
          }),
        ),
        migrationCandidates: migrations.rows.map((row) =>
          mapPositioned(row, this.codecs.migration, "migration"),
        ),
        validationReceipts: validations.rows.map((row) =>
          mapPositioned(row, this.codecs.validation, "validation"),
        ),
        retryAttempts: retries.rows.map((retry) => ({
          id: retry.id,
          runId: retry.run_id,
          operation: retry.operation,
          attempt: retry.attempt,
          retryAt: retry.retry_at,
          createdAt: retry.created_at,
        })),
        effectApprovals: approvals.rows.map((approval) => ({
          id: approval.id,
          runId: approval.run_id,
          kind: approval.kind,
          target: approval.target,
          inputFingerprint: approval.input_fingerprint,
          validationReceiptId: approval.validation_receipt_id,
          validationReceiptFingerprint: approval.validation_receipt_fingerprint,
          validationCompletedAt: approval.validation_completed_at,
          approvedBy: approval.approved_by,
          approvedAt: approval.approved_at,
          expiresAt: approval.expires_at,
          approvalFingerprint: approval.approval_fingerprint,
        })),
        effects: intents.rows.map((intent) => ({
          intent: this.intentFromRow(intent),
          attempts: attempts.rows
            .filter((attempt) => attempt.intent_id === intent.id)
            .map(attemptFromRow),
          reconciliations: reconciliations.rows
            .filter((reconciliation) =>
              attempts.rows.some(
                (attempt) =>
                  attempt.intent_id === intent.id && attempt.id === reconciliation.attempt_id,
              ),
            )
            .map((reconciliation) => ({
              id: reconciliation.id,
              attemptId: reconciliation.attempt_id,
              proofOutcome: reconciliation.proof_outcome,
              payload: parsePersisted(
                this.codecs.effectFailure,
                reconciliation.payload,
                "effect reconciliation",
              ),
              createdAt: reconciliation.created_at,
            })),
          receipt: (() => {
            const receipt = receipts.rows.find((candidate) => candidate.intent_id === intent.id);
            return receipt ? this.receiptFromRow(receipt) : null;
          })(),
          failures: failures.rows
            .filter((failure) => failure.intent_id === intent.id)
            .map(
              (failure): EffectFailureRecord<TEffectFailure> => ({
                ...mapPositioned(failure, this.codecs.effectFailure, "effect failure"),
                intentId: failure.intent_id,
                outcome: failure.outcome,
              }),
            ),
        })),
      };
    } catch (error) {
      await client.query("ROLLBACK").catch(() => undefined);
      throw error;
    } finally {
      client.release();
    }
  }
}

abstract class SingleAuthorityRunStore<
  TRun,
  TBundle,
  TDecision,
  TMigration,
  TValidation,
  TEffectInput,
  TEffectReceipt,
  TEffectFailure,
> extends RunStore<
  TRun,
  TBundle,
  TDecision,
  TMigration,
  TValidation,
  TEffectInput,
  TEffectReceipt,
  TEffectFailure
> {
  constructor(
    runtimePool: pg.Pool,
    protected readonly narrowAuthorityPool: pg.Pool,
    codecs: RunStoreCodecs<
      TRun,
      TBundle,
      TDecision,
      TMigration,
      TValidation,
      TEffectInput,
      TEffectReceipt,
      TEffectFailure
    >,
    options: RunStoreOptions = {},
  ) {
    super(runtimePool, codecs, options);
  }
}

class InternalValidationSignerStore<
    TRun,
    TBundle,
    TDecision,
    TMigration,
    TValidation,
    TEffectInput,
    TEffectReceipt,
    TEffectFailure,
  >
  extends SingleAuthorityRunStore<
    TRun,
    TBundle,
    TDecision,
    TMigration,
    TValidation,
    TEffectInput,
    TEffectReceipt,
    TEffectFailure
  >
  implements ValidationReceiptAuthorityStore
{
  protected override validationSignerDatabasePool(): pg.Pool {
    return this.narrowAuthorityPool;
  }
}

class InternalApprovalAuthorityStore<
  TRun,
  TBundle,
  TDecision,
  TMigration,
  TValidation,
  TEffectInput,
  TEffectReceipt,
  TEffectFailure,
> extends SingleAuthorityRunStore<
  TRun,
  TBundle,
  TDecision,
  TMigration,
  TValidation,
  TEffectInput,
  TEffectReceipt,
  TEffectFailure
> {
  protected override approvalAuthorityDatabasePool(): pg.Pool {
    return this.narrowAuthorityPool;
  }
}

class InternalEffectInvocationAuthority<
    TRun,
    TBundle,
    TDecision,
    TMigration,
    TValidation,
    TEffectInput,
    TEffectReceipt,
    TEffectFailure,
  >
  extends SingleAuthorityRunStore<
    TRun,
    TBundle,
    TDecision,
    TMigration,
    TValidation,
    TEffectInput,
    TEffectReceipt,
    TEffectFailure
  >
  implements EffectReservationAuthorityStore
{
  protected override effectAuthorityDatabasePool(): pg.Pool {
    return this.narrowAuthorityPool;
  }
}

type StoreCodecs<
  TRun,
  TBundle,
  TDecision,
  TMigration,
  TValidation,
  TEffectInput,
  TEffectReceipt,
  TEffectFailure,
> = RunStoreCodecs<
  TRun,
  TBundle,
  TDecision,
  TMigration,
  TValidation,
  TEffectInput,
  TEffectReceipt,
  TEffectFailure
>;

export class ValidationSignerStore<
  TRun,
  TBundle,
  TDecision,
  TMigration,
  TValidation,
  TEffectInput,
  TEffectReceipt,
  TEffectFailure,
> implements ValidationReceiptAuthorityStore
{
  readonly loadValidationExecutionClaim: ValidationReceiptAuthorityStore["loadValidationExecutionClaim"];
  readonly issueAndStoreValidationReceipt: ValidationReceiptAuthorityStore["issueAndStoreValidationReceipt"];

  constructor(
    signerPool: pg.Pool,
    codecs: StoreCodecs<
      TRun,
      TBundle,
      TDecision,
      TMigration,
      TValidation,
      TEffectInput,
      TEffectReceipt,
      TEffectFailure
    >,
    options: RunStoreOptions = {},
  ) {
    const delegate = new InternalValidationSignerStore(signerPool, signerPool, codecs, options);
    this.loadValidationExecutionClaim = delegate.loadValidationExecutionClaim.bind(delegate);
    this.issueAndStoreValidationReceipt = delegate.issueAndStoreValidationReceipt.bind(delegate);
  }
}

export class ApprovalAuthorityStore<
  TRun,
  TBundle,
  TDecision,
  TMigration,
  TValidation,
  TEffectInput,
  TEffectReceipt,
  TEffectFailure,
> {
  readonly recordEffectApproval: RunStore<
    TRun,
    TBundle,
    TDecision,
    TMigration,
    TValidation,
    TEffectInput,
    TEffectReceipt,
    TEffectFailure
  >["recordEffectApproval"];

  constructor(
    approvalPool: pg.Pool,
    codecs: StoreCodecs<
      TRun,
      TBundle,
      TDecision,
      TMigration,
      TValidation,
      TEffectInput,
      TEffectReceipt,
      TEffectFailure
    >,
    options: RunStoreOptions = {},
  ) {
    const delegate = new InternalApprovalAuthorityStore(
      approvalPool,
      approvalPool,
      codecs,
      options,
    );
    this.recordEffectApproval = delegate.recordEffectApproval.bind(delegate);
  }
}

export class EffectInvocationAuthority<
  TRun,
  TBundle,
  TDecision,
  TMigration,
  TValidation,
  TEffectInput,
  TEffectReceipt,
  TEffectFailure,
> implements EffectReservationAuthorityStore
{
  readonly beginEffect: RunStore<
    TRun,
    TBundle,
    TDecision,
    TMigration,
    TValidation,
    TEffectInput,
    TEffectReceipt,
    TEffectFailure
  >["beginEffect"];
  readonly reserveCurrentEffect: EffectReservationAuthorityStore["reserveCurrentEffect"];
  readonly verifyCurrentEffectReservation: EffectReservationAuthorityStore["verifyCurrentEffectReservation"];
  readonly consumeCurrentEffect: EffectReservationAuthorityStore["consumeCurrentEffect"];
  readonly cancelCurrentEffectBeforeSend: EffectReservationAuthorityStore["cancelCurrentEffectBeforeSend"];
  readonly recordEffectSuccess: RunStore<
    TRun,
    TBundle,
    TDecision,
    TMigration,
    TValidation,
    TEffectInput,
    TEffectReceipt,
    TEffectFailure
  >["recordEffectSuccess"];
  readonly recordEffectAmbiguous: RunStore<
    TRun,
    TBundle,
    TDecision,
    TMigration,
    TValidation,
    TEffectInput,
    TEffectReceipt,
    TEffectFailure
  >["recordEffectAmbiguous"];
  readonly reconcileEffectAttempt: RunStore<
    TRun,
    TBundle,
    TDecision,
    TMigration,
    TValidation,
    TEffectInput,
    TEffectReceipt,
    TEffectFailure
  >["reconcileEffectAttempt"];

  constructor(
    effectPool: pg.Pool,
    codecs: StoreCodecs<
      TRun,
      TBundle,
      TDecision,
      TMigration,
      TValidation,
      TEffectInput,
      TEffectReceipt,
      TEffectFailure
    >,
    options: RunStoreOptions = {},
  ) {
    const delegate = new InternalEffectInvocationAuthority(effectPool, effectPool, codecs, options);
    this.beginEffect = delegate.beginEffect.bind(delegate);
    this.reserveCurrentEffect = delegate.reserveCurrentEffect.bind(delegate);
    this.verifyCurrentEffectReservation = delegate.verifyCurrentEffectReservation.bind(delegate);
    this.consumeCurrentEffect = delegate.consumeCurrentEffect.bind(delegate);
    this.cancelCurrentEffectBeforeSend = delegate.cancelCurrentEffectBeforeSend.bind(delegate);
    this.recordEffectSuccess = delegate.recordEffectSuccess.bind(delegate);
    this.recordEffectAmbiguous = delegate.recordEffectAmbiguous.bind(delegate);
    this.reconcileEffectAttempt = delegate.reconcileEffectAttempt.bind(delegate);
  }
}
