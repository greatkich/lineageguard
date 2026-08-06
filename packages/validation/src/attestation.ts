import {
  createPrivateKey,
  createPublicKey,
  type KeyObject,
  sign as signBytes,
  verify as verifyBytes,
} from "node:crypto";
import {
  authorizeRunEvent,
  bindGroundedRiskAssessment,
  bindMigrationCandidate,
  type ExpectedValidationExecution,
  expectedValidationExecutionSchema,
  type ImpactContext,
  impactContextSchema,
  liveValidationSignedPayloadFingerprint,
  type MigrationCandidate,
  migrationArtifactFingerprint,
  migrationCandidateFingerprint,
  migrationCandidateSchema,
  type ProposedChange,
  proposedChangeSchema,
  type RiskAssessment,
  type RunEventStream,
  riskAssessmentSchema,
  type SignedLiveValidationReceipt,
  sha256,
  signedLiveValidationReceiptFingerprint,
  signedLiveValidationReceiptSchema,
  type ValidationReplayPresentation,
  validationArtifactSetFingerprint,
  validationReplayPresentationSchema,
} from "@lineageguard/domain";
import { ValidationError } from "./errors.js";
import type { MaterializedCandidateHandle } from "./materializer.js";
import {
  executeValidationInOwnedDatabase,
  type ValidationExecutionEvidence,
  type ValidationRuntimePolicy,
} from "./validator.js";

export interface TrustedValidationPublicKey {
  algorithm: "ED25519";
  issuer: string;
  keyId: string;
  publicKeySpkiPem: string;
}

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

export interface CurrentEffectReservationSnapshot {
  originalValidationBinding: ValidationAuthorityBinding;
  originalValidationEventPrefix: RunEventStream;
  currentRunEventStream: RunEventStream;
  currentStatus: "VALIDATED" | "WRITEBACK_PENDING";
  currentLease: {
    leaseId: string;
    workerId: string;
    generation: number;
    expiresAt: string;
  };
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
    validationReceiptId: string;
    validationReceiptFingerprint: string;
    validationCompletedAt: string;
    approvalFingerprint: string;
    approvalId: string;
  };
  validationReceiptId: string;
  validationReceiptFingerprint: string;
  approvalId: string;
  approvalFingerprint: string;
  storedLiveReceipt: SignedLiveValidationReceipt;
  storedLiveReceiptFingerprint: string;
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

export interface ConsumedCurrentEffectAuthorization {
  reservationId: string;
  canonicalEffectFingerprint: string;
  invokeBy: string;
  attemptId: string;
  attemptFence: string;
}

export interface VerifiedCurrentEffectReservation {
  reservationId: string;
  canonicalEffectFingerprint: string;
  state: "RESERVED" | "CONSUMED";
  invokeBy: string;
  attemptId?: string;
  attemptFence?: string;
}

/**
 * Server-side atomic port. Production implementations must lock the run and persist the returned
 * receipt/reservation state in the same database transaction before resolving these methods.
 */
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
    request: ValidationEffectConsumptionRequest,
    canonicalEffectFingerprint: string,
  ): Promise<VerifiedCurrentEffectReservation>;
  consumeCurrentEffect(
    request: ValidationEffectConsumptionRequest,
    canonicalEffectFingerprint: string,
  ): Promise<ConsumedCurrentEffectAuthorization>;
  cancelCurrentEffectBeforeSend(
    request: ValidationEffectConsumptionRequest,
    canonicalEffectFingerprint: string,
  ): Promise<void>;
}

const verifiedLiveValidationBrand: unique symbol = Symbol("verified-live-validation");
export interface VerifiedLiveValidation {
  readonly receipt: SignedLiveValidationReceipt;
  readonly [verifiedLiveValidationBrand]: true;
}

const verifiedReplayBrand: unique symbol = Symbol("verified-validation-replay");
export interface VerifiedValidationReplay {
  readonly presentation: ValidationReplayPresentation;
  readonly [verifiedReplayBrand]: true;
}

const verifiedCurrentEffectBrand: unique symbol = Symbol("verified-current-effect");
export interface VerifiedCurrentEffect {
  readonly [verifiedCurrentEffectBrand]: true;
}

export interface ValidationReceiptIssuer {
  validateAndIssue(
    runId: string,
    materialized: MaterializedCandidateHandle,
  ): Promise<VerifiedLiveValidation>;
}

export interface LiveValidationReceiptVerifier {
  verifyHistoricalLive(
    receipt: unknown,
    originalValidationBinding: ValidationAuthorityBinding,
  ): VerifiedLiveValidation;
  verifyReplay(
    presentation: ValidationReplayPresentation,
    originalBinding: ValidationAuthorityBinding,
  ): VerifiedValidationReplay;
}

export interface EffectAuthorizationAuthority {
  reserveCurrentEffect(
    receipt: unknown,
    request: ValidationEffectRequest,
  ): Promise<VerifiedCurrentEffect>;
  verifyCurrentEffectReservation(
    capability: VerifiedCurrentEffect,
    canonicalEffectFingerprint: string,
  ): Promise<VerifiedCurrentEffectReservation>;
  consumeCurrentEffect(
    capability: VerifiedCurrentEffect,
    canonicalEffectFingerprint: string,
  ): Promise<ConsumedCurrentEffectAuthorization>;
  cancelCurrentEffectBeforeSend(
    capability: VerifiedCurrentEffect,
    canonicalEffectFingerprint: string,
  ): Promise<void>;
}

interface ActiveLease {
  acquiredAt: string;
  expiresAt: string;
  leaseId: string;
  workerId: string;
  generation: number;
  runId: string;
  status: string;
}

const capabilities = new WeakSet<object>();
const replayCapabilities = new WeakSet<object>();
type PendingEffectConsumption = ValidationEffectConsumptionRequest & { invokeBy: string };
const effectCapabilities = new WeakMap<object, PendingEffectConsumption>();

class RuntimeVerifiedLiveValidation implements VerifiedLiveValidation {
  readonly [verifiedLiveValidationBrand] = true as const;
  readonly receipt: SignedLiveValidationReceipt;

  constructor(receipt: SignedLiveValidationReceipt) {
    this.receipt = deepFreeze(receipt);
    capabilities.add(this);
    Object.freeze(this);
  }
}

class RuntimeVerifiedValidationReplay implements VerifiedValidationReplay {
  readonly [verifiedReplayBrand] = true as const;
  readonly presentation: ValidationReplayPresentation;

  constructor(presentation: ValidationReplayPresentation) {
    this.presentation = deepFreeze(presentation);
    replayCapabilities.add(this);
    Object.freeze(this);
  }
}

class RuntimeVerifiedCurrentEffect implements VerifiedCurrentEffect {
  readonly [verifiedCurrentEffectBrand] = true as const;

  constructor(binding: PendingEffectConsumption) {
    effectCapabilities.set(this, deepFreeze({ ...binding }));
    Object.freeze(this);
  }
}

function currentEffectRequest(
  capability: VerifiedCurrentEffect,
  canonicalEffectFingerprint: string,
): { binding: PendingEffectConsumption; request: ValidationEffectConsumptionRequest } {
  if (!capability || typeof capability !== "object") {
    throw new ValidationError("ATTESTATION_INVALID", "effect capability is not runtime-issued");
  }
  const binding = effectCapabilities.get(capability);
  if (!binding) {
    throw new ValidationError("ATTESTATION_INVALID", "effect capability is not runtime-issued");
  }
  if (
    !/^[a-f0-9]{64}$/.test(canonicalEffectFingerprint) ||
    binding.inputFingerprint !== canonicalEffectFingerprint
  ) {
    throw new ValidationError("ATTESTATION_INVALID", "canonical effect fingerprint is invalid");
  }
  const { invokeBy: _invokeBy, ...request } = binding;
  return { binding, request };
}

export function readRuntimeVerifiedLiveReceipt(value: unknown): SignedLiveValidationReceipt {
  if (!value || typeof value !== "object" || !capabilities.has(value)) {
    throw new ValidationError("ATTESTATION_INVALID", "validation capability is not runtime-issued");
  }
  return (value as VerifiedLiveValidation).receipt;
}

export function readRuntimeVerifiedReplayPresentation(
  value: unknown,
): ValidationReplayPresentation {
  if (!value || typeof value !== "object" || !replayCapabilities.has(value)) {
    throw new ValidationError("ATTESTATION_INVALID", "replay capability is not runtime-issued");
  }
  return (value as VerifiedValidationReplay).presentation;
}

function deepFreeze<T extends object>(value: T): T {
  for (const nested of Object.values(value)) {
    if (nested && typeof nested === "object" && !Object.isFrozen(nested)) deepFreeze(nested);
  }
  return Object.freeze(value);
}

function parsePrivateKey(pem: string): KeyObject {
  if (!pem.startsWith("-----BEGIN PRIVATE KEY-----")) {
    throw new ValidationError("ATTESTATION_INVALID", "private key must be PKCS8 PEM");
  }
  try {
    const key = createPrivateKey(pem);
    if (key.asymmetricKeyType !== "ed25519") throw new Error("wrong key type");
    return key;
  } catch {
    throw new ValidationError("ATTESTATION_INVALID", "invalid Ed25519 private key");
  }
}

function parsePublicKey(pem: string): KeyObject {
  if (!pem.startsWith("-----BEGIN PUBLIC KEY-----")) {
    throw new ValidationError("ATTESTATION_INVALID", "public key must be SPKI PEM");
  }
  try {
    const key = createPublicKey(pem);
    if (key.asymmetricKeyType !== "ed25519") throw new Error("wrong key type");
    return key;
  } catch {
    throw new ValidationError("ATTESTATION_INVALID", "invalid Ed25519 public key");
  }
}

function keyIdentity(issuer: string, keyId: string, algorithm = "ED25519"): string {
  return `${algorithm}\u0000${issuer}\u0000${keyId}`;
}

function validateRunStream(
  eventsInput: RunEventStream,
  requiredStatus?: string,
): {
  events: RunEventStream;
  activeLease: ActiveLease;
  fingerprint: string;
} {
  let events: RunEventStream = [] as unknown as RunEventStream;
  let active: Omit<ActiveLease, "status"> | undefined;
  let status = "CREATED";
  for (const event of eventsInput) {
    events = authorizeRunEvent(events, event, event.occurredAt);
    if (event.type === "RUN_LEASE_ACQUIRED") {
      active = {
        acquiredAt: event.occurredAt,
        expiresAt: event.expiresAt,
        leaseId: event.leaseId,
        workerId: event.workerId,
        generation: event.generation,
        runId: event.runId,
      };
    } else if (event.type === "RUN_LEASE_RENEWED" && active) {
      active = { ...active, expiresAt: event.expiresAt };
    } else if (event.type === "RUN_LEASE_RELEASED" || event.type === "RUN_LEASE_EXPIRED") {
      active = undefined;
    } else if (event.type === "RUN_STATUS_CHANGED") {
      status = event.to;
    }
  }
  if (!active || (requiredStatus !== undefined && status !== requiredStatus)) {
    throw new ValidationError(
      "ATTESTATION_INVALID",
      "run stream lacks the required live lease/state",
    );
  }
  return {
    events,
    activeLease: { ...active, status },
    fingerprint: sha256({
      domain: "lineageguard.validation.authorized-run-stream.v1",
      events,
    }),
  };
}

function canonicalBinding(binding: ValidationAuthorityBinding) {
  const change = proposedChangeSchema.parse(binding.change);
  const context = impactContextSchema.parse(binding.context);
  const assessment = bindGroundedRiskAssessment(
    change,
    context,
    riskAssessmentSchema.parse(binding.authoritativeAssessment),
  );
  const candidate = bindMigrationCandidate(
    migrationCandidateSchema.parse(binding.candidate),
    change,
    context,
    assessment,
  );
  const expected = expectedValidationExecutionSchema.parse(binding.expectedExecution);
  const run = validateRunStream(binding.authorizedRunEventStream, "VALIDATING");
  const lease = run.activeLease;
  if (
    expected.runId !== lease.runId ||
    expected.leaseId !== lease.leaseId ||
    expected.workerId !== lease.workerId ||
    expected.generation !== lease.generation
  ) {
    throw new ValidationError("ATTESTATION_INVALID", "expected execution is outside active lease");
  }
  return { change, context, assessment, candidate, expected, run };
}

function assertValidationSnapshotContinuity(
  before: ReturnType<typeof canonicalBinding>,
  after: ReturnType<typeof canonicalBinding>,
): void {
  const originalEvents = before.run.events;
  const currentPrefix = after.run.events.slice(0, originalEvents.length);
  if (
    JSON.stringify(currentPrefix) !== JSON.stringify(originalEvents) ||
    before.run.activeLease.leaseId !== after.run.activeLease.leaseId ||
    before.run.activeLease.workerId !== after.run.activeLease.workerId ||
    before.run.activeLease.generation !== after.run.activeLease.generation ||
    JSON.stringify(before.change) !== JSON.stringify(after.change) ||
    JSON.stringify(before.context) !== JSON.stringify(after.context) ||
    JSON.stringify(before.assessment) !== JSON.stringify(after.assessment) ||
    JSON.stringify(before.candidate) !== JSON.stringify(after.candidate) ||
    JSON.stringify(before.expected) !== JSON.stringify(after.expected)
  ) {
    throw new ValidationError(
      "ATTESTATION_INVALID",
      "authoritative validation snapshot changed during execution",
    );
  }
}

function validationBindingFingerprint(binding: ReturnType<typeof canonicalBinding>): string {
  return sha256({
    domain: "lineageguard.validation-authority-binding.v1",
    change: binding.change,
    context: binding.context,
    assessment: binding.assessment,
    candidate: binding.candidate,
    expectedExecution: binding.expected,
  });
}

function receiptIssueRequest(
  binding: ReturnType<typeof canonicalBinding>,
): ValidationReceiptIssueRequest {
  return {
    runId: binding.expected.runId,
    claimedBindingFingerprint: validationBindingFingerprint(binding),
    claimedRunEventStreamFingerprint: binding.run.fingerprint,
    candidateFingerprint: migrationCandidateFingerprint(binding.candidate),
    expectedExecutionFingerprint: sha256(binding.expected),
    leaseId: binding.expected.leaseId,
    workerId: binding.expected.workerId,
    generation: binding.expected.generation,
  };
}

function exactKeys(value: object, expected: readonly string[], label: string): void {
  const prototype = Object.getPrototypeOf(value);
  const descriptors = Object.getOwnPropertyDescriptors(value);
  if (
    (prototype !== Object.prototype && prototype !== null) ||
    Reflect.ownKeys(value).length !== expected.length ||
    Object.values(descriptors).some(
      (descriptor) => !("value" in descriptor) || !descriptor.enumerable,
    ) ||
    JSON.stringify(Object.keys(value).sort()) !== JSON.stringify([...expected].sort())
  ) {
    throw new ValidationError("ATTESTATION_INVALID", `${label} fields are not canonical`);
  }
}

function containsControlCharacters(value: string): boolean {
  return [...value].some((character) => {
    const code = character.codePointAt(0) ?? 0;
    return code <= 31 || code === 127;
  });
}

function assertEffectRequest(request: ValidationEffectRequest): void {
  if (!request || typeof request !== "object") {
    throw new ValidationError("ATTESTATION_INVALID", "effect request is malformed");
  }
  exactKeys(
    request,
    ["runId", "effectKind", "inputFingerprint", "target", "intentId", "idempotencyKey"],
    "effect request",
  );
  if (
    !/^run_[a-f0-9]{24}$/.test(request.runId) ||
    (request.effectKind !== "GITHUB_WRITE" && request.effectKind !== "DATAHUB_WRITE") ||
    !/^[a-f0-9]{64}$/.test(request.inputFingerprint) ||
    !/^[a-z][a-z0-9_]{1,30}_[a-f0-9]{24}$/.test(request.intentId) ||
    request.idempotencyKey.length < 1 ||
    request.idempotencyKey.length > 200 ||
    containsControlCharacters(request.idempotencyKey) ||
    request.target.length < 1 ||
    request.target.length > 500 ||
    containsControlCharacters(request.target)
  ) {
    throw new ValidationError("ATTESTATION_INVALID", "effect request is malformed");
  }
}

function canonicalApprovalFingerprint(
  request: ValidationEffectRequest,
  current: CurrentEffectReservationSnapshot,
): string {
  return sha256({
    domain: "lineageguard.effect-approval.v2",
    runId: request.runId,
    effectKind: request.effectKind,
    target: request.target,
    inputFingerprint: request.inputFingerprint,
    approvedBy: current.approval.approvedBy,
    approvedAt: current.approval.approvedAt,
    expiresAt: current.approval.expiresAt,
    validationReceiptId: current.approval.validationReceiptId,
    validationReceiptFingerprint: current.approval.validationReceiptFingerprint,
    validationCompletedAt: current.approval.validationCompletedAt,
  });
}

function assertEffectReservationSnapshot(current: CurrentEffectReservationSnapshot): void {
  exactKeys(
    current,
    [
      "originalValidationBinding",
      "originalValidationEventPrefix",
      "currentRunEventStream",
      "currentStatus",
      "currentLease",
      "effectKind",
      "inputFingerprint",
      "target",
      "intentId",
      "idempotencyKey",
      "approval",
      "validationReceiptId",
      "validationReceiptFingerprint",
      "approvalId",
      "approvalFingerprint",
      "storedLiveReceipt",
      "storedLiveReceiptFingerprint",
      "reservationId",
      "reservationToken",
      "intentFingerprint",
      "invokeBy",
      "trustedDatabaseTime",
    ],
    "effect reservation",
  );
  exactKeys(
    current.currentLease,
    ["leaseId", "workerId", "generation", "expiresAt"],
    "effect lease",
  );
  exactKeys(
    current.approval,
    [
      "status",
      "approvedBy",
      "approvedAt",
      "expiresAt",
      "validationReceiptId",
      "validationReceiptFingerprint",
      "validationCompletedAt",
      "approvalFingerprint",
      "approvalId",
    ],
    "effect approval",
  );
  try {
    if (Buffer.byteLength(JSON.stringify(current), "utf8") > 2_000_000) throw new Error("oversize");
  } catch {
    throw new ValidationError("ATTESTATION_INVALID", "effect reservation snapshot is malformed");
  }
  if (
    current.approval.approvedBy.length < 1 ||
    current.approval.approvedBy.length > 200 ||
    containsControlCharacters(current.approval.approvedBy) ||
    !/^val_[a-f0-9]{24}$/.test(current.validationReceiptId) ||
    !/^[a-z][a-z0-9_]{1,30}_[a-f0-9]{24}$/.test(current.approvalId) ||
    current.approvalId !== current.approval.approvalId ||
    !/^[a-f0-9]{64}$/.test(current.validationReceiptFingerprint) ||
    !/^[a-f0-9]{64}$/.test(current.approvalFingerprint) ||
    !/^[a-f0-9]{64}$/.test(current.intentFingerprint)
  ) {
    throw new ValidationError("ATTESTATION_INVALID", "effect reservation identity is malformed");
  }
}

function assertCurrentLease(
  activeLease: ActiveLease,
  trustedCurrentTime: string,
  completedAt?: string,
): void {
  const now = new Date(trustedCurrentTime).getTime();
  if (
    !Number.isFinite(now) ||
    now >= new Date(activeLease.expiresAt).getTime() ||
    (completedAt !== undefined && now < new Date(completedAt).getTime())
  ) {
    throw new ValidationError("ATTESTATION_INVALID", "validation lease is not active now");
  }
}

function assertHistoricalCompletion(activeLease: ActiveLease, completedAt: string): void {
  const completed = new Date(completedAt).getTime();
  if (
    !Number.isFinite(completed) ||
    completed < new Date(activeLease.acquiredAt).getTime() ||
    completed >= new Date(activeLease.expiresAt).getTime()
  ) {
    throw new ValidationError(
      "ATTESTATION_INVALID",
      "receipt completion is outside its historical validation lease",
    );
  }
}

function buildUnsigned(
  binding: ReturnType<typeof canonicalBinding>,
  execution: ValidationExecutionEvidence,
  trustedCurrentTime: string,
  issuer: string,
  keyId: string,
) {
  assertCurrentLease(binding.run.activeLease, trustedCurrentTime);
  if (
    execution.candidateFingerprint !== migrationCandidateFingerprint(binding.candidate) ||
    execution.baseSha !== binding.change.baseSha ||
    execution.checks.length !== 8 ||
    execution.checks.some((check) => check.status !== "PASS" || check.exitCode !== 0)
  ) {
    const failedChecks = execution.checks
      .filter((check) => check.status !== "PASS" || check.exitCode !== 0)
      .map((check) => check.check)
      .join(",");
    throw new ValidationError(
      "ATTESTATION_INVALID",
      `only the exact passing execution is signable; failed_checks=${failedChecks || "STRUCTURAL"}`,
    );
  }
  for (const [index, check] of execution.checks.entries()) {
    const configured = binding.expected.validators[index];
    if (
      !configured ||
      configured.check !== check.check ||
      configured.commandId !== check.commandId ||
      configured.implementationId !== check.validatorImplementationId ||
      configured.version !== check.validatorVersion ||
      configured.digest !== check.validatorDigest ||
      check.runId !== binding.expected.runId ||
      check.sandboxId !== binding.expected.sandboxId ||
      check.worktreeId !== binding.expected.worktreeId ||
      check.leaseId !== binding.expected.leaseId ||
      check.workerId !== binding.expected.workerId ||
      check.generation !== binding.expected.generation
    ) {
      throw new ValidationError("ATTESTATION_INVALID", "check execution binding mismatch");
    }
  }
  const completedAt = trustedCurrentTime;
  return {
    protectedHeaders: {
      schemaVersion: 1 as const,
      purpose: "LINEAGEGUARD_VALIDATION_LIVE" as const,
      algorithm: "ED25519" as const,
      issuer,
      keyId,
      candidateFingerprint: migrationCandidateFingerprint(binding.candidate),
      changeFingerprint: binding.change.fingerprint,
      impactContextFingerprint: binding.context.impactContextFingerprint,
      authoritativeGroundedAssessmentFingerprint: sha256(binding.assessment),
      authoritativeGroundedDecision: "BLOCK" as const,
      authorizedRunEventStreamFingerprint: binding.run.fingerprint,
      leaseAcquiredAt: binding.run.activeLease.acquiredAt,
      leaseExpiresAt: binding.run.activeLease.expiresAt,
      runId: binding.expected.runId,
      sandboxId: binding.expected.sandboxId,
      worktreeId: binding.expected.worktreeId,
      leaseId: binding.expected.leaseId,
      workerId: binding.expected.workerId,
      generation: binding.expected.generation,
    },
    payload: {
      status: "PASS" as const,
      artifactPaths: execution.artifactObservations.map((observation) => observation.path),
      artifactObservations: execution.artifactObservations,
      artifactSetFingerprint: validationArtifactSetFingerprint(execution.artifactObservations),
      checks: execution.checks.map(({ status: _status, summary: _summary, ...check }) => ({
        ...check,
        status: "PASS" as const,
        exitCode: 0 as const,
      })),
      completedAt,
    },
  };
}

class InternalValidationSecurityBoundary {
  readonly #privateKey: KeyObject | undefined;
  readonly #issuer: string | undefined;
  readonly #keyId: string | undefined;
  readonly #keyring: ReadonlyMap<string, KeyObject>;
  readonly #validationStore: ValidationReceiptAuthorityStore | undefined;
  readonly #effectStore: EffectReservationAuthorityStore | undefined;
  readonly #runtimePolicy: ValidationRuntimePolicy | undefined;

  constructor(
    privateKey: KeyObject | undefined,
    issuer: string | undefined,
    keyId: string | undefined,
    keyring: ReadonlyMap<string, KeyObject>,
    validationStore: ValidationReceiptAuthorityStore | undefined,
    effectStore: EffectReservationAuthorityStore | undefined,
    runtimePolicy: ValidationRuntimePolicy | undefined,
  ) {
    this.#privateKey = privateKey;
    this.#issuer = issuer;
    this.#keyId = keyId;
    this.#keyring = keyring;
    this.#validationStore = validationStore;
    this.#effectStore = effectStore;
    this.#runtimePolicy = runtimePolicy ? Object.freeze({ ...runtimePolicy }) : undefined;
  }

  async validateAndIssue(
    runId: string,
    materialized: MaterializedCandidateHandle,
  ): Promise<VerifiedLiveValidation> {
    if (
      !this.#validationStore ||
      !this.#runtimePolicy ||
      !this.#privateKey ||
      !this.#issuer ||
      !this.#keyId
    ) {
      throw new ValidationError("ATTESTATION_INVALID", "receipt issuer capability is unavailable");
    }
    const validationStore = this.#validationStore;
    const runtimePolicy = this.#runtimePolicy;
    const privateKey = this.#privateKey;
    const issuer = this.#issuer;
    const keyId = this.#keyId;
    const bindingInput = await validationStore.loadValidationExecutionClaim(runId);
    const binding = canonicalBinding(bindingInput);
    if (binding.expected.runId !== runId) {
      throw new ValidationError("ATTESTATION_INVALID", "run-store snapshot belongs to another run");
    }
    // The production signer is deliberately adjacent to, and receives evidence only from,
    // the sealed real runner. No caller-controlled runner or evidence crosses this boundary.
    const execution = await executeValidationInOwnedDatabase(
      binding.candidate,
      materialized,
      binding.expected,
      runtimePolicy,
    );
    let issuedBinding: ReturnType<typeof canonicalBinding> | undefined;
    let issuedReceipt: SignedLiveValidationReceipt | undefined;
    const persisted = await validationStore.issueAndStoreValidationReceipt(
      receiptIssueRequest(binding),
      (authoritativeBinding, trustedDatabaseTime) => {
        const currentBinding = canonicalBinding(authoritativeBinding);
        if (currentBinding.expected.runId !== runId) {
          throw new ValidationError(
            "ATTESTATION_INVALID",
            "run-store snapshot belongs to another run",
          );
        }
        assertValidationSnapshotContinuity(binding, currentBinding);
        const unsigned = buildUnsigned(
          currentBinding,
          execution,
          trustedDatabaseTime,
          issuer,
          keyId,
        );
        const fingerprint = liveValidationSignedPayloadFingerprint(unsigned);
        const receipt = signedLiveValidationReceiptSchema.parse({
          ...unsigned,
          signedPayloadFingerprint: fingerprint,
          signature: signBytes(null, Buffer.from(fingerprint, "utf8"), privateKey).toString(
            "base64url",
          ),
        });
        issuedBinding = currentBinding;
        issuedReceipt = receipt;
        return receipt;
      },
    );
    if (
      !issuedBinding ||
      !issuedReceipt ||
      JSON.stringify(persisted) !== JSON.stringify(issuedReceipt)
    ) {
      throw new ValidationError(
        "ATTESTATION_INVALID",
        "atomic store did not persist the synchronously issued receipt",
      );
    }
    return this.#verifyReceipt(signedLiveValidationReceiptSchema.parse(persisted), issuedBinding);
  }

  verifyHistoricalLive(
    receiptInput: unknown,
    bindingInput: ValidationAuthorityBinding,
  ): VerifiedLiveValidation {
    return this.#verifyReceipt(
      signedLiveValidationReceiptSchema.parse(receiptInput),
      canonicalBinding(bindingInput),
    );
  }

  async reserveCurrentEffect(
    receiptInput: unknown,
    request: ValidationEffectRequest,
  ): Promise<VerifiedCurrentEffect> {
    if (!this.#effectStore) {
      throw new ValidationError(
        "ATTESTATION_INVALID",
        "effect authority capability is unavailable",
      );
    }
    const runtimeReceipt = signedLiveValidationReceiptSchema.parse(receiptInput);
    assertEffectRequest(request);
    const current = await this.#effectStore.reserveCurrentEffect({
      ...request,
      validationReceiptFingerprint: signedLiveValidationReceiptFingerprint(runtimeReceipt),
    });
    assertEffectReservationSnapshot(current);
    const verified = this.verifyHistoricalLive(runtimeReceipt, current.originalValidationBinding);
    const storedReceipt = signedLiveValidationReceiptSchema.parse(current.storedLiveReceipt);
    const expectedStatus =
      request.effectKind === "GITHUB_WRITE" ? "VALIDATED" : "WRITEBACK_PENDING";
    const currentRun = validateRunStream(current.currentRunEventStream, expectedStatus);
    const originalPrefix = current.originalValidationEventPrefix;
    const originalEvents = current.originalValidationBinding.authorizedRunEventStream;
    const persistedFingerprint = signedLiveValidationReceiptFingerprint(storedReceipt);
    const prefixMatches =
      JSON.stringify(originalPrefix) === JSON.stringify(originalEvents) &&
      JSON.stringify(current.currentRunEventStream.slice(0, originalPrefix.length)) ===
        JSON.stringify(originalPrefix);
    const approvalFingerprint = canonicalApprovalFingerprint(request, current);
    const receiptFingerprint = signedLiveValidationReceiptFingerprint(runtimeReceipt);
    if (
      current.effectKind !== request.effectKind ||
      current.inputFingerprint !== request.inputFingerprint ||
      current.target !== request.target ||
      current.intentId !== request.intentId ||
      current.idempotencyKey !== request.idempotencyKey ||
      current.currentStatus !== expectedStatus ||
      currentRun.activeLease.leaseId !== current.currentLease.leaseId ||
      currentRun.activeLease.workerId !== current.currentLease.workerId ||
      currentRun.activeLease.generation !== current.currentLease.generation ||
      currentRun.activeLease.expiresAt !== current.currentLease.expiresAt ||
      !prefixMatches ||
      current.storedLiveReceiptFingerprint !== persistedFingerprint ||
      persistedFingerprint !== receiptFingerprint ||
      JSON.stringify(storedReceipt) !== JSON.stringify(runtimeReceipt) ||
      current.approval.status !== "APPROVED" ||
      current.validationReceiptId !== current.approval.validationReceiptId ||
      current.validationReceiptFingerprint !== receiptFingerprint ||
      current.approvalId !== current.approval.approvalId ||
      current.approvalFingerprint !== approvalFingerprint ||
      current.approval.validationReceiptFingerprint !== receiptFingerprint ||
      current.approval.validationCompletedAt !== runtimeReceipt.payload.completedAt ||
      current.approval.approvalFingerprint !== approvalFingerprint ||
      verified.receipt.protectedHeaders.runId !== request.runId ||
      !/^[a-z][a-z0-9_]{1,30}_[a-f0-9]{24}$/.test(current.reservationId) ||
      !/^[A-Za-z0-9_-]{32,512}$/.test(current.reservationToken)
    ) {
      throw new ValidationError("ATTESTATION_INVALID", "current effect authority binding mismatch");
    }
    const effectTime = new Date(current.trustedDatabaseTime).getTime();
    const approvedAt = new Date(current.approval.approvedAt).getTime();
    const approvalExpiresAt = new Date(current.approval.expiresAt).getTime();
    const completedAt = new Date(verified.receipt.payload.completedAt).getTime();
    const invokeBy = new Date(current.invokeBy).getTime();
    const leaseExpiresAt = new Date(current.currentLease.expiresAt).getTime();
    const lastEvent = current.currentRunEventStream.at(-1);
    if (
      !Number.isFinite(effectTime) ||
      !Number.isFinite(approvedAt) ||
      !Number.isFinite(approvalExpiresAt) ||
      !Number.isFinite(completedAt) ||
      !Number.isFinite(invokeBy) ||
      approvedAt < completedAt ||
      approvedAt > effectTime ||
      approvalExpiresAt <= approvedAt ||
      approvalExpiresAt - approvedAt > 60 * 60 * 1_000 ||
      effectTime >= approvalExpiresAt ||
      invokeBy <= effectTime ||
      invokeBy > approvalExpiresAt ||
      invokeBy > leaseExpiresAt ||
      (lastEvent !== undefined && effectTime < new Date(lastEvent.occurredAt).getTime()) ||
      effectTime >= leaseExpiresAt
    ) {
      throw new ValidationError("ATTESTATION_INVALID", "run store returned an invalid effect time");
    }
    return new RuntimeVerifiedCurrentEffect({
      reservationId: current.reservationId,
      reservationToken: current.reservationToken,
      runId: request.runId,
      intentId: request.intentId,
      idempotencyKey: request.idempotencyKey,
      effectKind: request.effectKind,
      inputFingerprint: request.inputFingerprint,
      target: request.target,
      validationReceiptFingerprint: receiptFingerprint,
      validationReceiptId: current.validationReceiptId,
      approvalId: current.approvalId,
      approvalFingerprint,
      intentFingerprint: current.intentFingerprint,
      invokeBy: current.invokeBy,
    });
  }

  async consumeCurrentEffect(
    capability: VerifiedCurrentEffect,
    canonicalEffectFingerprint: string,
  ): Promise<ConsumedCurrentEffectAuthorization> {
    if (!this.#effectStore) {
      throw new ValidationError(
        "ATTESTATION_INVALID",
        "effect authority capability is unavailable",
      );
    }
    const { binding, request } = currentEffectRequest(capability, canonicalEffectFingerprint);
    effectCapabilities.delete(capability);
    const consumed = await this.#effectStore.consumeCurrentEffect(
      request,
      canonicalEffectFingerprint,
    );
    if (
      consumed.reservationId !== request.reservationId ||
      consumed.canonicalEffectFingerprint !== canonicalEffectFingerprint ||
      consumed.invokeBy !== binding.invokeBy ||
      !/^[a-z][a-z0-9_]{1,30}_[a-f0-9]{24}$/.test(consumed.attemptId) ||
      !/^[A-Za-z0-9_-]{32,512}$/.test(consumed.attemptFence)
    ) {
      throw new ValidationError("ATTESTATION_INVALID", "consumed effect fence is invalid");
    }
    return deepFreeze({ ...consumed });
  }

  async verifyCurrentEffectReservation(
    capability: VerifiedCurrentEffect,
    canonicalEffectFingerprint: string,
  ): Promise<VerifiedCurrentEffectReservation> {
    if (!this.#effectStore) {
      throw new ValidationError(
        "ATTESTATION_INVALID",
        "effect authority capability is unavailable",
      );
    }
    const { binding, request } = currentEffectRequest(capability, canonicalEffectFingerprint);
    const verified = await this.#effectStore.verifyCurrentEffectReservation(
      request,
      canonicalEffectFingerprint,
    );
    if (
      verified.reservationId !== request.reservationId ||
      verified.canonicalEffectFingerprint !== canonicalEffectFingerprint ||
      verified.invokeBy !== binding.invokeBy ||
      verified.state !== "RESERVED" ||
      verified.attemptId !== undefined ||
      verified.attemptFence !== undefined
    ) {
      throw new ValidationError("ATTESTATION_INVALID", "effect reservation is no longer current");
    }
    return deepFreeze({ ...verified });
  }

  async cancelCurrentEffectBeforeSend(
    capability: VerifiedCurrentEffect,
    canonicalEffectFingerprint: string,
  ): Promise<void> {
    if (!this.#effectStore) {
      throw new ValidationError(
        "ATTESTATION_INVALID",
        "effect authority capability is unavailable",
      );
    }
    const { request } = currentEffectRequest(capability, canonicalEffectFingerprint);
    effectCapabilities.delete(capability);
    await this.#effectStore.cancelCurrentEffectBeforeSend(request, canonicalEffectFingerprint);
  }

  verifyReplay(
    presentationInput: ValidationReplayPresentation,
    originalBinding: ValidationAuthorityBinding,
  ): VerifiedValidationReplay {
    const presentation = validationReplayPresentationSchema.parse(presentationInput);
    this.#verifyReceipt(presentation.originalLiveReceipt, canonicalBinding(originalBinding));
    return new RuntimeVerifiedValidationReplay(presentation);
  }

  #verifyReceipt(
    receipt: SignedLiveValidationReceipt,
    binding: ReturnType<typeof canonicalBinding>,
  ): VerifiedLiveValidation {
    assertHistoricalCompletion(binding.run.activeLease, receipt.payload.completedAt);
    const headers = receipt.protectedHeaders;
    const expectedHeaders = {
      candidateFingerprint: migrationCandidateFingerprint(binding.candidate),
      changeFingerprint: binding.change.fingerprint,
      impactContextFingerprint: binding.context.impactContextFingerprint,
      authoritativeGroundedAssessmentFingerprint: sha256(binding.assessment),
      authoritativeGroundedDecision: "BLOCK",
      authorizedRunEventStreamFingerprint: binding.run.fingerprint,
      leaseAcquiredAt: binding.run.activeLease.acquiredAt,
      leaseExpiresAt: binding.run.activeLease.expiresAt,
      runId: binding.expected.runId,
      sandboxId: binding.expected.sandboxId,
      worktreeId: binding.expected.worktreeId,
      leaseId: binding.expected.leaseId,
      workerId: binding.expected.workerId,
      generation: binding.expected.generation,
    } as const;
    for (const [field, value] of Object.entries(expectedHeaders)) {
      if (headers[field as keyof typeof headers] !== value) {
        throw new ValidationError("ATTESTATION_INVALID", `receipt binding mismatch=${field}`);
      }
    }
    for (const [index, check] of receipt.payload.checks.entries()) {
      const validator = binding.expected.validators[index];
      if (
        !validator ||
        check.check !== validator.check ||
        check.commandId !== validator.commandId ||
        check.validatorImplementationId !== validator.implementationId ||
        check.validatorVersion !== validator.version ||
        check.validatorDigest !== validator.digest
      ) {
        throw new ValidationError("ATTESTATION_INVALID", "receipt validator mismatch");
      }
    }
    const candidatePaths = binding.candidate.artifacts.map((artifact) => artifact.path).sort();
    if (JSON.stringify(receipt.payload.artifactPaths) !== JSON.stringify(candidatePaths)) {
      throw new ValidationError("ATTESTATION_INVALID", "receipt artifact coverage mismatch");
    }
    for (const observation of receipt.payload.artifactObservations) {
      const artifact = binding.candidate.artifacts.find((item) => item.path === observation.path);
      if (
        !artifact ||
        observation.candidateArtifactFingerprint !== migrationArtifactFingerprint(artifact) ||
        observation.materializedSha256 !== sha256(artifact.content)
      ) {
        throw new ValidationError("ATTESTATION_INVALID", "receipt artifact bytes mismatch");
      }
    }
    const publicKey = this.#keyring.get(
      keyIdentity(headers.issuer, headers.keyId, headers.algorithm),
    );
    if (
      headers.algorithm !== "ED25519" ||
      !publicKey ||
      !verifyBytes(
        null,
        Buffer.from(receipt.signedPayloadFingerprint, "utf8"),
        publicKey,
        Buffer.from(receipt.signature, "base64url"),
      )
    ) {
      throw new ValidationError("ATTESTATION_INVALID", "receipt signature is not trusted");
    }
    return new RuntimeVerifiedLiveValidation(receipt);
  }
}

function trustedKeyring(
  trustedPublicKeys: readonly TrustedValidationPublicKey[],
): ReadonlyMap<string, KeyObject> {
  const keyring = new Map<string, KeyObject>();
  for (const entry of trustedPublicKeys) {
    if (entry.algorithm !== "ED25519") {
      throw new ValidationError("ATTESTATION_INVALID", "only Ed25519 is allowed");
    }
    const identity = keyIdentity(entry.issuer, entry.keyId, entry.algorithm);
    if (keyring.has(identity)) {
      throw new ValidationError("ATTESTATION_INVALID", "duplicate immutable keyring identity");
    }
    keyring.set(identity, parsePublicKey(entry.publicKeySpkiPem));
  }
  return keyring;
}

export function createLiveValidationReceiptVerifier(
  trustedPublicKeys: readonly TrustedValidationPublicKey[],
): LiveValidationReceiptVerifier {
  const boundary = new InternalValidationSecurityBoundary(
    undefined,
    undefined,
    undefined,
    trustedKeyring(trustedPublicKeys),
    undefined,
    undefined,
    undefined,
  );
  return Object.freeze({
    verifyHistoricalLive: boundary.verifyHistoricalLive.bind(boundary),
    verifyReplay: boundary.verifyReplay.bind(boundary),
  });
}

export interface ValidationSignerCredentials {
  privateKeyPkcs8Pem: string;
  issuer: string;
  keyId: string;
}

/** @internal Server entrypoint construction; not exported from the general package surface. */
export function createValidationReceiptIssuerServer(
  credentials: ValidationSignerCredentials,
  trustedPublicKeys: readonly TrustedValidationPublicKey[],
  validationStore: ValidationReceiptAuthorityStore,
  runtimePolicy: ValidationRuntimePolicy,
): ValidationReceiptIssuer {
  const privateKey = parsePrivateKey(credentials.privateKeyPkcs8Pem);
  const issuer = credentials.issuer;
  const keyId = credentials.keyId;
  const keyring = trustedKeyring(trustedPublicKeys);
  const selected = keyring.get(keyIdentity(issuer, keyId));
  const derivedPublic = createPublicKey(privateKey).export({ format: "der", type: "spki" });
  if (
    !selected ||
    !Buffer.from(derivedPublic).equals(
      Buffer.from(selected.export({ format: "der", type: "spki" })),
    )
  ) {
    throw new ValidationError(
      "ATTESTATION_INVALID",
      "private signer is absent from trusted keyring",
    );
  }
  const boundary = new InternalValidationSecurityBoundary(
    privateKey,
    issuer,
    keyId,
    keyring,
    validationStore,
    undefined,
    runtimePolicy,
  );
  return Object.freeze({ validateAndIssue: boundary.validateAndIssue.bind(boundary) });
}

/** @internal Server entrypoint construction; not exported from the general package surface. */
export function createEffectAuthorizationServer(
  trustedPublicKeys: readonly TrustedValidationPublicKey[],
  effectStore: EffectReservationAuthorityStore,
): EffectAuthorizationAuthority {
  const boundary = new InternalValidationSecurityBoundary(
    undefined,
    undefined,
    undefined,
    trustedKeyring(trustedPublicKeys),
    undefined,
    effectStore,
    undefined,
  );
  return Object.freeze({
    reserveCurrentEffect: boundary.reserveCurrentEffect.bind(boundary),
    verifyCurrentEffectReservation: boundary.verifyCurrentEffectReservation.bind(boundary),
    consumeCurrentEffect: boundary.consumeCurrentEffect.bind(boundary),
    cancelCurrentEffectBeforeSend: boundary.cancelCurrentEffectBeforeSend.bind(boundary),
  });
}
