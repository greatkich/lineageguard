import type { ImpactCollectionResult, RunEvent, RunStatus } from "@lineageguard/domain";

export type { RunEvent, RunStatus } from "@lineageguard/domain";

export interface StrictCodec<T> {
  parse(value: unknown): T;
}

export interface RunStoreCodecs<
  TRun,
  TBundle,
  TDecision,
  TMigration,
  TValidation,
  TEffectInput,
  TEffectReceipt,
  TEffectFailure,
> {
  run: StrictCodec<TRun>;
  bundle: StrictCodec<TBundle>;
  decision: StrictCodec<TDecision>;
  migration: StrictCodec<TMigration>;
  validation: StrictCodec<TValidation>;
  effectInput: StrictCodec<TEffectInput>;
  effectReceipt: StrictCodec<TEffectReceipt>;
  effectFailure: StrictCodec<TEffectFailure>;
}

export interface LeaseGuard {
  leaseId: string;
  workerId: string;
  generation: number;
  fencingVersion: number;
}

export type ExecutionMode = "LIVE" | "VERIFIED_REPLAY";

export interface RunRecord<T> {
  id: string;
  requestKey: string;
  inputFingerprint: string;
  executionMode: ExecutionMode;
  status: RunStatus;
  payload: T;
  version: number;
  leaseGeneration: number;
  nextAttemptAt: Date;
  leaseId: string | null;
  workerId: string | null;
  leaseExpiresAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
}

export interface RetryAttemptRecord {
  id: string;
  runId: string;
  operation: "DATAHUB_READ" | "GENERATION" | "GITHUB_WRITE" | "DATAHUB_WRITE";
  attempt: number;
  retryAt: Date;
  createdAt: Date;
}

export interface LeaseHistoryRecord {
  leaseId: string;
  runId: string;
  workerId: string;
  generation: number;
  acquiredAt: Date;
  initialExpiresAt: Date;
}

export interface EventRecord {
  id: string;
  runId: string;
  sequence: number;
  type: RunEvent["type"];
  payload: RunEvent;
  createdAt: Date;
}

export interface AssociatedRecord<T> {
  id: string;
  runId: string;
  position: number;
  payload: T;
  createdAt: Date;
}

export interface DecisionRecord<T> extends AssociatedRecord<T> {
  scope: "BASELINE" | "GROUNDED";
}

export type RunBundleRecord<T> =
  | (AssociatedRecord<T> & { kind: "EVIDENCE" })
  | (AssociatedRecord<ImpactCollectionResult> & { kind: "CONTEXT" });

export type EffectKind = "GITHUB_REVIEW" | "DATAHUB_WRITEBACK";

export interface EffectIntentRecord<T> {
  id: string;
  runId: string;
  kind: EffectKind;
  target: string;
  idempotencyKey: string;
  inputFingerprint: string;
  input: T;
  createdAt: Date;
}

export interface EffectApprovalRecord {
  id: string;
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
  approvalFingerprint: string;
}

export interface EffectReceiptBinding {
  intentId: string;
  runId: string;
  effectKind: EffectKind;
  target: string;
  inputFingerprint: string;
  validationReceiptId: string;
  candidateFingerprint: string;
  artifactSetFingerprint: string;
}

export interface EffectReceiptRecord<T> {
  id: string;
  intentId: string;
  payload: T;
  createdAt: Date;
}

export interface EffectFailureRecord<T> extends AssociatedRecord<T> {
  intentId: string;
  outcome: "FAILED" | "RECONCILIATION_REQUIRED";
}

export type EffectAttemptState = "READY_TO_INVOKE" | "SUCCEEDED" | "RECONCILIATION_REQUIRED";

export interface EffectAttemptRecord {
  id: string;
  intentId: string;
  attempt: number;
  workerId: string;
  fencingToken: string;
  state: EffectAttemptState;
  claimedAt: Date;
  claimExpiresAt: Date;
  updatedAt: Date;
}

export interface EffectReconciliationRecord<T> {
  id: string;
  attemptId: string;
  proofOutcome: "APPLIED" | "NOT_APPLIED";
  payload: T;
  createdAt: Date;
}

export interface RunSnapshot<
  TRun,
  TBundle,
  TDecision,
  TMigration,
  TValidation,
  TEffectInput,
  TEffectReceipt,
  TEffectFailure,
> {
  run: RunRecord<TRun>;
  events: EventRecord[];
  leases: LeaseHistoryRecord[];
  bundles: RunBundleRecord<TBundle>[];
  decisions: DecisionRecord<TDecision>[];
  migrationCandidates: AssociatedRecord<TMigration>[];
  validationReceipts: AssociatedRecord<TValidation>[];
  retryAttempts: RetryAttemptRecord[];
  effectApprovals: EffectApprovalRecord[];
  effects: Array<{
    intent: EffectIntentRecord<TEffectInput>;
    attempts: EffectAttemptRecord[];
    reconciliations: EffectReconciliationRecord<TEffectFailure>[];
    receipt: EffectReceiptRecord<TEffectReceipt> | null;
    failures: EffectFailureRecord<TEffectFailure>[];
  }>;
}
