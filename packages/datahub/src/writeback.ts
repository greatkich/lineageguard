import { canonicalDatasetUrn, sha256, stableId, stableJson } from "@lineageguard/domain";
import { z } from "zod";
import { DataHubAdapterError } from "./errors.js";
import {
  createOfficialMutationSession,
  type OfficialMutationCredentials,
} from "./mutation-stdio.js";
import {
  createMutationToolClient,
  type MutationInvocation,
  type MutationToolClient,
} from "./mutation-tool-client.js";
import { createOfficialStdioSession, type OfficialStdioCredentials } from "./official-stdio.js";
import { createReadOnlyToolClient } from "./tool-client.js";

const fingerprint = z.string().regex(/^[a-f0-9]{64}$/u);
const CANONICAL_SCENARIO_MARKER = "lineageguard-canonical-v1";
const identifier = z
  .string()
  .min(1)
  .max(128)
  .regex(/^[A-Za-z0-9][A-Za-z0-9_.:-]*$/u);
const urn = z.string().startsWith("urn:li:").max(4_096);
const httpsUrl = z
  .string()
  .url()
  .max(2_048)
  .refine((value) => new URL(value).protocol === "https:");

const requestObjectSchema = z
  .object({
    artifactFingerprint: fingerprint,
    approvalFingerprint: fingerprint,
    candidateFingerprint: fingerprint,
    decision: z.enum(["ALLOW", "REVIEW", "BLOCK"]),
    documentPayloadHash: fingerprint,
    expectedMetadataFingerprint: fingerprint,
    expectedMetadataVersion: z.string().min(1).max(256),
    githubPrUrl: httpsUrl,
    githubReceiptFingerprint: fingerprint,
    idempotencyKey: identifier,
    intentId: identifier,
    reasonEvidenceIds: z.array(identifier).min(1).max(64),
    rollbackRef: z.string().min(1).max(512),
    runId: identifier,
    scenarioMarker: z.string().min(1).max(256),
    sourceCollectionFingerprint: fingerprint,
    sourceUrn: urn,
    tagPayloadHash: fingerprint,
    validationReceiptFingerprint: fingerprint,
  })
  .strict();

const requestSchema = requestObjectSchema.refine(
  (request) => new Set(request.reasonEvidenceIds).size === request.reasonEvidenceIds.length,
);

export type DataHubWritebackRequest = z.infer<typeof requestSchema>;

export type DataHubDecisionDocument = Readonly<{
  content: string;
  id: string;
  marker: string;
  title: string;
}>;

export type DataHubWritebackPayloads = Readonly<{
  document: DataHubDecisionDocument;
  documentPayloadHash: string;
  reviewStatusTagUrn: string;
  tagPayloadHash: string;
  writePayloadFingerprint: string;
}>;

type InternalDataHubWritebackPayloads = DataHubWritebackPayloads &
  Readonly<{
    documentArguments: Readonly<Record<string, unknown>>;
    tagArguments: Readonly<Record<string, unknown>>;
  }>;

export type DataHubDocumentProof = Readonly<{
  contentHash: string;
  id: string;
  marker: string;
  title: string;
}>;

export type ExactDataHubEntitySnapshot = Readonly<{
  documentProofs: readonly DataHubDocumentProof[];
  knownTagUrns: readonly string[];
  observedAt: string;
  relevantMetadataFingerprint: string;
  scenarioMarker: string;
  tagUrns: readonly string[];
  urn: string;
  version: string;
}>;

export interface ExactDataHubEntityReader {
  readExact(urn: string, documentId: string, tagUrn: string): Promise<ExactDataHubEntitySnapshot>;
  close?(): Promise<void>;
}

export type DataHubEffectAuthorityBinding = Readonly<{
  artifactFingerprint: string;
  approvalFingerprint: string;
  candidateFingerprint: string;
  decision: DataHubWritebackRequest["decision"];
  documentPayloadHash: string;
  effectKind: "DATAHUB_WRITEBACK";
  expectedMetadataFingerprint: string;
  expectedMetadataVersion: string;
  githubPrUrl: string;
  githubReceiptFingerprint: string;
  idempotencyKey: string;
  inputFingerprint: string;
  intentId: string;
  reasonEvidenceIds: readonly string[];
  rollbackRef: string;
  runId: string;
  scenarioMarker: string;
  sourceCollectionFingerprint: string;
  sourceUrn: string;
  tagPayloadHash: string;
  target: string;
  validationReceiptFingerprint: string;
  writePayloadFingerprint: string;
}>;

export interface TrustedDataHubEffectAuthority {
  /** The injected worker closure captures opaque VerifiedCurrentEffect bearer material. */
  verifyCurrentEffectReservation(
    exactBinding: DataHubEffectAuthorityBinding,
    options: Readonly<{ signal: AbortSignal; timeoutMs: number }>,
  ): Promise<
    | Readonly<{ state: "RESERVED" }>
    | Readonly<{
        consumedAt: string;
        fencing: number;
        invokeBy: string;
        reservationId: string;
        state: "CONSUMED";
      }>
  >;
  /** The trusted run store atomically consumes that same current effect and persists only token hash. */
  consumeCurrentEffect(
    exactBinding: DataHubEffectAuthorityBinding,
    options: Readonly<{ signal: AbortSignal; timeoutMs: number }>,
  ): Promise<
    Readonly<{
      consumedAt: string;
      fencing: number;
      invokeBy: string;
      reservationId: string;
    }>
  >;
}

export type DataHubWritebackReceipt = Readonly<{
  artifactFingerprint: string;
  approvalFingerprint: string;
  authorityConsumedAt?: string;
  candidateFingerprint: string;
  completedAt: string;
  decision: DataHubWritebackRequest["decision"];
  document: Readonly<{ contentHash: string; id: string; marker: string; title: string }>;
  documentPayloadHash: string;
  expectedMetadataFingerprint: string;
  expectedMetadataVersion: string;
  githubPrUrl: string;
  githubReceiptFingerprint: string;
  fencing?: number;
  idempotencyKey: string;
  inputFingerprint: string;
  intentId: string;
  invokeBy?: string;
  mutationInvocationFingerprints: readonly string[];
  observedAt: string;
  preservedMetadataFingerprint: string;
  preservedTagUrns: readonly string[];
  reasonEvidenceIds: readonly string[];
  receiptFingerprint: string;
  reservationId?: string;
  rollbackRef: string;
  runId: string;
  scenarioMarker: string;
  sourceCollectionFingerprint: string;
  sourceUrn: string;
  status: "SUCCEEDED" | "AMBIGUOUS";
  tagUrn: string;
  tagPayloadHash: string;
  validationReceiptFingerprint: string;
  workerFailureState: "NONE" | "FAILED_WRITEBACK";
  writePayloadFingerprint: string;
  writeProof: Readonly<{ document: boolean; tag: boolean }>;
}>;

export interface DataHubWritebackPort {
  write(request: DataHubWritebackRequest): Promise<DataHubWritebackReceipt>;
}

type LiveDependencies = Readonly<{
  authority: TrustedDataHubEffectAuthority;
  clock?: () => Date;
  enabled: boolean;
  mutationClientFactory: () => Promise<MutationToolClient>;
  readerFactory: () => Promise<ExactDataHubEntityReader>;
}>;

const AUTHORITY_TIMEOUT_MS = 2_000;

async function withAuthorityDeadline<T>(
  operation: (options: Readonly<{ signal: AbortSignal; timeoutMs: number }>) => Promise<T>,
): Promise<T> {
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      controller.abort();
      reject(
        new DataHubAdapterError("AMBIGUOUS", "DataHub effect authority outcome is ambiguous.", {
          retryable: true,
        }),
      );
    }, AUTHORITY_TIMEOUT_MS);
  });
  try {
    return await Promise.race([
      operation({ signal: controller.signal, timeoutMs: AUTHORITY_TIMEOUT_MS }),
      deadline,
    ]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

function reviewStatusTag(decision: DataHubWritebackRequest["decision"]): string {
  const status = decision === "BLOCK" ? "blocked" : decision === "REVIEW" ? "review" : "allowed";
  return `urn:li:tag:lineageguard.review-status.${status}`;
}

function safeDocumentLine(value: string): string {
  return [...value]
    .map((character) => {
      const codePoint = character.codePointAt(0) ?? 0;
      return codePoint < 32 || codePoint === 127 ? " " : character;
    })
    .join("")
    .trim();
}

function deriveInternalDataHubWritebackPayloads(
  unsafeRequest:
    | DataHubWritebackRequest
    | Omit<DataHubWritebackRequest, "documentPayloadHash" | "tagPayloadHash">,
): InternalDataHubWritebackPayloads {
  const candidate = { ...unsafeRequest } as Partial<DataHubWritebackRequest>;
  delete candidate.documentPayloadHash;
  delete candidate.tagPayloadHash;
  const request = requestObjectSchema
    .omit({ documentPayloadHash: true, tagPayloadHash: true })
    .parse(candidate);
  const id = stableId("lineageguard-migration-decision", {
    runId: request.runId,
    sourceUrn: request.sourceUrn,
  });
  const marker = `lineageguard:decision:v1:${request.idempotencyKey}`;
  const title = `LineageGuard migration decision · ${request.runId}`;
  const content = [
    `Marker: ${marker}`,
    `Decision: ${request.decision}`,
    `Run: ${request.runId}`,
    `Reasons: ${request.reasonEvidenceIds.join(", ")}`,
    `Candidate: ${request.candidateFingerprint}`,
    `Artifact: ${request.artifactFingerprint}`,
    `Validation: ${request.validationReceiptFingerprint}`,
    `GitHub review: ${request.githubPrUrl}`,
    `Rollback: ${safeDocumentLine(request.rollbackRef)}`,
  ].join("\n");
  const documentArguments = Object.freeze({
    content,
    document_type: "Decision",
    related_assets: [request.sourceUrn],
    title,
    urn: `urn:li:document:${id}`,
  });
  const reviewStatusTagUrn = reviewStatusTag(request.decision);
  const tagArguments = Object.freeze({
    entity_urns: [request.sourceUrn],
    tag_urns: [reviewStatusTagUrn],
  });
  return Object.freeze({
    document: Object.freeze({ content, id, marker, title }),
    documentArguments,
    documentPayloadHash: sha256(documentArguments),
    reviewStatusTagUrn,
    tagArguments,
    tagPayloadHash: sha256(tagArguments),
    writePayloadFingerprint: sha256({ documentArguments, tagArguments }),
  });
}

export function deriveDataHubWritebackPayloads(
  unsafeRequest:
    | DataHubWritebackRequest
    | Omit<DataHubWritebackRequest, "documentPayloadHash" | "tagPayloadHash">,
): DataHubWritebackPayloads {
  const payloads = deriveInternalDataHubWritebackPayloads(unsafeRequest);
  return Object.freeze({
    document: payloads.document,
    documentPayloadHash: payloads.documentPayloadHash,
    reviewStatusTagUrn: payloads.reviewStatusTagUrn,
    tagPayloadHash: payloads.tagPayloadHash,
    writePayloadFingerprint: payloads.writePayloadFingerprint,
  });
}

function authorityBinding(request: DataHubWritebackRequest): DataHubEffectAuthorityBinding {
  const payloads = deriveInternalDataHubWritebackPayloads(request);
  return Object.freeze({
    ...request,
    effectKind: "DATAHUB_WRITEBACK",
    inputFingerprint: sha256(request),
    reasonEvidenceIds: Object.freeze([...request.reasonEvidenceIds]),
    target: request.sourceUrn,
    writePayloadFingerprint: payloads.writePayloadFingerprint,
  });
}

function validateRequest(input: DataHubWritebackRequest): DataHubWritebackRequest {
  const parsed = requestSchema.safeParse(input);
  if (
    !parsed.success ||
    parsed.data.sourceUrn !== canonicalDatasetUrn ||
    parsed.data.scenarioMarker !== CANONICAL_SCENARIO_MARKER
  ) {
    throw new DataHubAdapterError(
      "CONFIGURATION",
      "DataHub write-back request is invalid or targets a non-canonical entity.",
    );
  }
  const payloads = deriveInternalDataHubWritebackPayloads(parsed.data);
  if (
    payloads.documentPayloadHash !== parsed.data.documentPayloadHash ||
    payloads.tagPayloadHash !== parsed.data.tagPayloadHash
  ) {
    throw new DataHubAdapterError("CONFLICT", "DataHub write-back payload binding conflicts.");
  }
  return parsed.data;
}

function validateSnapshot(
  snapshot: ExactDataHubEntitySnapshot,
  request: DataHubWritebackRequest,
  phase: "before" | "after",
): void {
  if (snapshot.urn !== request.sourceUrn) {
    throw new DataHubAdapterError("CONFLICT", "DataHub write-back read returned the wrong URN.");
  }
  if (snapshot.scenarioMarker !== request.scenarioMarker) {
    throw new DataHubAdapterError("CONFLICT", "DataHub scenario marker changed.");
  }
  if (snapshot.relevantMetadataFingerprint !== request.expectedMetadataFingerprint) {
    throw new DataHubAdapterError("CONFLICT", "DataHub relevant metadata changed.");
  }
  if (phase === "before" && snapshot.version !== request.expectedMetadataVersion) {
    throw new DataHubAdapterError("CONFLICT", "DataHub metadata version changed.");
  }
}

function requireKnownReviewTag(
  snapshot: ExactDataHubEntitySnapshot,
  payloads: DataHubWritebackPayloads,
): void {
  if (!snapshot.knownTagUrns.includes(payloads.reviewStatusTagUrn)) {
    throw new DataHubAdapterError(
      "CONFLICT",
      "The allowlisted DataHub review-status tag is not provisioned.",
    );
  }
}

function proofState(snapshot: ExactDataHubEntitySnapshot, payloads: DataHubWritebackPayloads) {
  const matchingId = snapshot.documentProofs.filter((proof) => proof.id === payloads.document.id);
  const document = matchingId.some(
    (proof) =>
      proof.marker === payloads.document.marker &&
      proof.title === payloads.document.title &&
      proof.contentHash === sha256(payloads.document.content),
  );
  if (matchingId.length > 0 && !document) {
    throw new DataHubAdapterError(
      "CONFLICT",
      "The deterministic DataHub decision document already has different content.",
    );
  }
  return Object.freeze({ document, tag: snapshot.tagUrns.includes(payloads.reviewStatusTagUrn) });
}

function receipt(
  request: DataHubWritebackRequest,
  payloads: DataHubWritebackPayloads,
  before: ExactDataHubEntitySnapshot,
  after: ExactDataHubEntitySnapshot,
  proof: Readonly<{ document: boolean; tag: boolean }>,
  completedAt: string,
  invocations: readonly MutationInvocation[],
  authority?: Readonly<{
    consumedAt: string;
    fencing: number;
    invokeBy: string;
    reservationId: string;
  }>,
): DataHubWritebackReceipt {
  const priorTagsPreserved = before.tagUrns.every((tag) => after.tagUrns.includes(tag));
  const succeeded = proof.document && proof.tag && priorTagsPreserved;
  const body = {
    artifactFingerprint: request.artifactFingerprint,
    approvalFingerprint: request.approvalFingerprint,
    ...(authority === undefined ? {} : { authorityConsumedAt: authority.consumedAt }),
    candidateFingerprint: request.candidateFingerprint,
    completedAt,
    decision: request.decision,
    document: {
      contentHash: sha256(payloads.document.content),
      id: payloads.document.id,
      marker: payloads.document.marker,
      title: payloads.document.title,
    },
    documentPayloadHash: request.documentPayloadHash,
    expectedMetadataFingerprint: request.expectedMetadataFingerprint,
    expectedMetadataVersion: request.expectedMetadataVersion,
    githubPrUrl: request.githubPrUrl,
    githubReceiptFingerprint: request.githubReceiptFingerprint,
    ...(authority === undefined
      ? {}
      : { fencing: authority.fencing, invokeBy: authority.invokeBy }),
    idempotencyKey: request.idempotencyKey,
    inputFingerprint: sha256(request),
    intentId: request.intentId,
    mutationInvocationFingerprints: invocations.map((item) => item.responseFingerprint),
    observedAt: after.observedAt,
    preservedMetadataFingerprint: after.relevantMetadataFingerprint,
    preservedTagUrns: [...before.tagUrns].sort(),
    reasonEvidenceIds: [...request.reasonEvidenceIds],
    ...(authority === undefined ? {} : { reservationId: authority.reservationId }),
    rollbackRef: request.rollbackRef,
    runId: request.runId,
    scenarioMarker: request.scenarioMarker,
    sourceCollectionFingerprint: request.sourceCollectionFingerprint,
    sourceUrn: request.sourceUrn,
    status: succeeded ? ("SUCCEEDED" as const) : ("AMBIGUOUS" as const),
    tagUrn: payloads.reviewStatusTagUrn,
    tagPayloadHash: request.tagPayloadHash,
    validationReceiptFingerprint: request.validationReceiptFingerprint,
    workerFailureState: succeeded ? ("NONE" as const) : ("FAILED_WRITEBACK" as const),
    writePayloadFingerprint: payloads.writePayloadFingerprint,
    writeProof: proof,
  };
  return Object.freeze({ ...body, receiptFingerprint: sha256(body) });
}

type ConsumedAuthority = Readonly<{
  consumedAt: string;
  fencing: number;
  invokeBy: string;
  reservationId: string;
}>;

function validateConsumedAuthority(
  consumed: ConsumedAuthority,
  clock: () => Date,
  requireCurrentDeadline: boolean,
): void {
  if (
    !Number.isSafeInteger(consumed.fencing) ||
    consumed.fencing < 1 ||
    !Number.isFinite(Date.parse(consumed.consumedAt)) ||
    !Number.isFinite(Date.parse(consumed.invokeBy)) ||
    (requireCurrentDeadline && clock().getTime() > Date.parse(consumed.invokeBy))
  ) {
    throw new DataHubAdapterError(
      "AUTHORITY_INVALID",
      "DataHub effect authority returned an invalid or expired consumption fence.",
    );
  }
}

class LiveDataHubWritebackPort implements DataHubWritebackPort {
  readonly #dependencies: LiveDependencies;

  constructor(dependencies: LiveDependencies) {
    this.#dependencies = dependencies;
  }

  async write(unsafeRequest: DataHubWritebackRequest): Promise<DataHubWritebackReceipt> {
    if (!this.#dependencies.enabled) {
      throw new DataHubAdapterError("CONFIGURATION", "DataHub mutation is disabled.");
    }
    const request = validateRequest(unsafeRequest);
    const payloads = deriveInternalDataHubWritebackPayloads(request);
    const binding = authorityBinding(request);
    let verified:
      | Readonly<{ state: "RESERVED" }>
      | Readonly<{
          consumedAt: string;
          fencing: number;
          invokeBy: string;
          reservationId: string;
          state: "CONSUMED";
        }>;
    try {
      verified = await withAuthorityDeadline((options) =>
        this.#dependencies.authority.verifyCurrentEffectReservation(binding, options),
      );
    } catch (error) {
      if (error instanceof DataHubAdapterError) throw error;
      throw new DataHubAdapterError(
        "AUTHORITY_INVALID",
        "DataHub effect authority was missing, invalid, expired, or not current.",
      );
    }
    if (verified.state !== "RESERVED" && verified.state !== "CONSUMED") {
      throw new DataHubAdapterError("AUTHORITY_INVALID", "DataHub effect authority is invalid.");
    }
    if (verified.state === "CONSUMED") {
      validateConsumedAuthority(verified, this.#dependencies.clock ?? (() => new Date()), false);
    }
    const reader = await this.#dependencies.readerFactory();
    let mutationClient: MutationToolClient | undefined;
    const invocations: MutationInvocation[] = [];
    try {
      const before = await reader.readExact(
        request.sourceUrn,
        payloads.document.id,
        payloads.reviewStatusTagUrn,
      );
      validateSnapshot(before, request, "before");
      requireKnownReviewTag(before, payloads);
      const existing = proofState(before, payloads);
      if (existing.document && existing.tag) {
        if (verified.state !== "CONSUMED") {
          throw new DataHubAdapterError(
            "CONFLICT",
            "DataHub already contains the write-back without a consumed local effect.",
          );
        }
        return receipt(
          request,
          payloads,
          before,
          before,
          existing,
          (this.#dependencies.clock ?? (() => new Date()))().toISOString(),
          invocations,
          verified,
        );
      }
      let consumed: ConsumedAuthority;
      if (verified.state === "CONSUMED") {
        if (
          (this.#dependencies.clock ?? (() => new Date()))().getTime() >
          Date.parse(verified.invokeBy)
        ) {
          return receipt(
            request,
            payloads,
            before,
            before,
            existing,
            (this.#dependencies.clock ?? (() => new Date()))().toISOString(),
            invocations,
            verified,
          );
        }
        consumed = verified;
        mutationClient = await this.#dependencies.mutationClientFactory();
      } else {
        mutationClient = await this.#dependencies.mutationClientFactory();
        try {
          consumed = await withAuthorityDeadline((options) =>
            this.#dependencies.authority.consumeCurrentEffect(binding, options),
          );
        } catch (error) {
          if (error instanceof DataHubAdapterError) throw error;
          throw new DataHubAdapterError(
            "AMBIGUOUS",
            "DataHub effect consumption outcome is ambiguous and requires reconciliation.",
            { retryable: true },
          );
        }
        validateConsumedAuthority(consumed, this.#dependencies.clock ?? (() => new Date()), true);
      }
      if (mutationClient === undefined) {
        throw new DataHubAdapterError("UNAVAILABLE", "DataHub mutation client is unavailable.");
      }

      if (!existing.document) {
        try {
          invocations.push(
            await mutationClient.invoke("save_document", payloads.documentArguments),
          );
        } catch (error) {
          if (!(error instanceof DataHubAdapterError) || !error.retryable) throw error;
          const reconciled = await reader.readExact(
            request.sourceUrn,
            payloads.document.id,
            payloads.reviewStatusTagUrn,
          );
          validateSnapshot(reconciled, request, "after");
          const proof = proofState(reconciled, payloads);
          if (!proof.document) {
            return receipt(
              request,
              payloads,
              before,
              reconciled,
              proof,
              (this.#dependencies.clock ?? (() => new Date()))().toISOString(),
              invocations,
              consumed,
            );
          }
        }
      }

      const afterDocument = await reader.readExact(
        request.sourceUrn,
        payloads.document.id,
        payloads.reviewStatusTagUrn,
      );
      validateSnapshot(afterDocument, request, "after");
      const documentProof = proofState(afterDocument, payloads);
      if (!documentProof.document) {
        return receipt(
          request,
          payloads,
          before,
          afterDocument,
          documentProof,
          (this.#dependencies.clock ?? (() => new Date()))().toISOString(),
          invocations,
          consumed,
        );
      }

      if (!documentProof.tag) {
        try {
          invocations.push(await mutationClient.invoke("add_tags", payloads.tagArguments));
        } catch (error) {
          if (!(error instanceof DataHubAdapterError) || !error.retryable) {
            const partial = await reader.readExact(
              request.sourceUrn,
              payloads.document.id,
              payloads.reviewStatusTagUrn,
            );
            validateSnapshot(partial, request, "after");
            return receipt(
              request,
              payloads,
              before,
              partial,
              proofState(partial, payloads),
              (this.#dependencies.clock ?? (() => new Date()))().toISOString(),
              invocations,
              consumed,
            );
          }
        }
      }

      const after = await reader.readExact(
        request.sourceUrn,
        payloads.document.id,
        payloads.reviewStatusTagUrn,
      );
      validateSnapshot(after, request, "after");
      return receipt(
        request,
        payloads,
        before,
        after,
        proofState(after, payloads),
        (this.#dependencies.clock ?? (() => new Date()))().toISOString(),
        invocations,
        consumed,
      );
    } finally {
      await Promise.allSettled([reader.close?.(), mutationClient?.close()]);
    }
  }
}

export function createLiveDataHubWritebackPort(
  dependencies: LiveDependencies,
): DataHubWritebackPort {
  return new LiveDataHubWritebackPort(dependencies);
}

function record(value: unknown): Readonly<Record<string, unknown>> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Readonly<Record<string, unknown>>)
    : undefined;
}

function isDefinedRecord(
  value: Readonly<Record<string, unknown>> | undefined,
): value is Readonly<Record<string, unknown>> {
  return value !== undefined;
}

function customProperty(
  properties: Readonly<Record<string, unknown>>,
  key: string,
): string | undefined {
  const custom = properties.customProperties;
  if (Array.isArray(custom)) {
    for (const item of custom) {
      const entry = record(item);
      if (entry?.key === key && typeof entry.value === "string") return entry.value;
    }
  }
  const customRecord = record(custom);
  const value = customRecord?.[key];
  return typeof value === "string" ? value : undefined;
}

function parseExactEntity(
  payload: unknown,
  expectedUrn: string,
  documentId: string,
  tagUrn: string,
  observedAt: string,
): ExactDataHubEntitySnapshot {
  const entities = (Array.isArray(payload) ? payload : [payload])
    .map(record)
    .filter(isDefinedRecord);
  const entity = entities.find((item) => item.urn === expectedUrn);
  if (entity === undefined) {
    throw new DataHubAdapterError(
      "SCHEMA_DRIFT",
      "Official DataHub entity write-back projection changed or is malformed.",
    );
  }
  const properties = record(entity.properties) ?? {};
  const scenarioMarker =
    expectedUrn === canonicalDatasetUrn ? CANONICAL_SCENARIO_MARKER : undefined;
  const systemMetadata = record(entity.systemMetadata);
  const versionValue =
    customProperty(properties, "lineageguard.metadata-version") ?? systemMetadata?.lastObserved;
  if (
    scenarioMarker === undefined ||
    (typeof versionValue !== "string" && typeof versionValue !== "number")
  ) {
    throw new DataHubAdapterError(
      "SCHEMA_DRIFT",
      "Official DataHub entity omitted the controlled scenario marker or metadata version.",
    );
  }
  const tags = record(entity.tags)?.tags;
  const tagUrns = Array.isArray(tags)
    ? tags.flatMap((entry) => {
        const tagUrn = record(record(entry)?.tag)?.urn;
        return typeof tagUrn === "string" && tagUrn.startsWith("urn:li:tag:") ? [tagUrn] : [];
      })
    : [];
  const documentUrn = `urn:li:document:${documentId}`;
  const document = entities.find((item) => item.urn === documentUrn);
  const documentInfo = document === undefined ? undefined : record(document.info);
  const documentContent = record(documentInfo?.contents)?.text;
  const documentTitle = documentInfo?.title;
  const related = documentInfo?.relatedAssets;
  const relatedUrns = Array.isArray(related)
    ? related.flatMap((item) => {
        const value = record(record(item)?.asset)?.urn;
        return typeof value === "string" ? [value] : [];
      })
    : [];
  const marker =
    documentInfo === undefined
      ? undefined
      : typeof documentContent === "string"
        ? documentContent
            .split("\n")
            .find((line) => line.startsWith("Marker: "))
            ?.slice("Marker: ".length)
        : undefined;
  const documentProofs =
    typeof documentContent === "string" &&
    typeof documentTitle === "string" &&
    marker !== undefined &&
    relatedUrns.includes(expectedUrn)
      ? [{ contentHash: sha256(documentContent), id: documentId, marker, title: documentTitle }]
      : [];
  const relevantMetadata = {
    domain: entity.domain,
    glossaryTerms: entity.glossaryTerms,
    ownership: entity.ownership,
    properties: {
      description: properties.description,
      name: properties.name,
    },
    schemaMetadata: entity.schemaMetadata,
  };
  return Object.freeze({
    documentProofs: Object.freeze(documentProofs.map((proof) => Object.freeze(proof))),
    knownTagUrns: Object.freeze(
      entities.some((item) => item.urn === tagUrn && !("error" in item)) ? [tagUrn] : [],
    ),
    observedAt,
    relevantMetadataFingerprint: sha256(relevantMetadata),
    scenarioMarker,
    tagUrns: Object.freeze([...new Set(tagUrns)].sort()),
    urn: expectedUrn,
    version: String(versionValue),
  });
}

async function officialReader(
  credentials: OfficialStdioCredentials,
): Promise<ExactDataHubEntityReader> {
  const session = await createOfficialStdioSession(credentials);
  const client = await createReadOnlyToolClient(session);
  return {
    async close() {
      await client.close();
    },
    async readExact(expectedUrn, documentId, tagUrn) {
      const result = await client.invoke("get_entities", {
        urns: [expectedUrn, `urn:li:document:${documentId}`, tagUrn],
      });
      return parseExactEntity(result.payload, expectedUrn, documentId, tagUrn, result.retrievedAt);
    },
  };
}

export type OfficialLiveDataHubWritebackConfiguration = Readonly<{
  authority: TrustedDataHubEffectAuthority;
  enabled?: boolean;
  mutationCredentials: OfficialMutationCredentials;
  readCredentials: OfficialStdioCredentials;
}>;

export function createOfficialLiveDataHubWritebackPort(
  configuration: OfficialLiveDataHubWritebackConfiguration,
): DataHubWritebackPort {
  return createLiveDataHubWritebackPort({
    authority: configuration.authority,
    enabled: configuration.enabled === true,
    mutationClientFactory: async () =>
      createMutationToolClient(
        await createOfficialMutationSession(configuration.mutationCredentials),
      ),
    readerFactory: () => officialReader(configuration.readCredentials),
  });
}

export function dataHubWritebackBindingFingerprint(request: DataHubWritebackRequest): string {
  return sha256(stableJson(authorityBinding(validateRequest(request))));
}
