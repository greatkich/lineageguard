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
const CANONICAL_SCENARIO_MARKER = "canonical-customer-id-rename";
const CANONICAL_REVIEWED_TAG_URN = "urn:li:tag:lineageguard-canonical.Reviewed";
const CANONICAL_REVIEWED_TAG_DESCRIPTION_PATTERN =
  /^LineageGuard review status: a validated migration decision was written back through the approved effect gate\. \[lineageguard\.scenario=canonical-customer-id-rename;lineageguard\.ownershipNonce=[a-f0-9]{64}\]$/u;
const identifier = z
  .string()
  .min(1)
  .max(128)
  .regex(/^[A-Za-z0-9][A-Za-z0-9_.:-]*$/u);
const repositoryArtifactPath = z
  .string()
  .min(1)
  .max(512)
  .regex(/^[A-Za-z0-9][A-Za-z0-9._/-]*$/u)
  .refine(
    (value) =>
      !value.endsWith("/") &&
      !value.includes("//") &&
      value.split("/").every((segment) => segment !== "." && segment !== ".."),
  );
const urn = z.string().startsWith("urn:li:").max(4_096);
const httpsUrl = z
  .string()
  .url()
  .max(2_048)
  .refine((value) => {
    const url = new URL(value);
    return (
      url.protocol === "https:" &&
      url.hostname === "github.com" &&
      url.port === "" &&
      url.username === "" &&
      url.password === "" &&
      url.search === "" &&
      url.hash === "" &&
      /^\/[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+\/pull\/[1-9][0-9]*$/u.test(url.pathname)
    );
  });

const requestObjectSchema = z
  .object({
    artifactFingerprint: fingerprint,
    approvalFingerprint: fingerprint,
    candidateFingerprint: fingerprint,
    decision: z.enum(["ALLOW", "REVIEW", "BLOCK"]),
    documentPayloadHash: fingerprint,
    expectedMetadataFingerprint: fingerprint,
    expectedMetadataVersion: z.string().min(1).max(256),
    expectedReviewTagDefinitionFingerprint: fingerprint,
    githubPrUrl: httpsUrl,
    githubReceiptFingerprint: fingerprint,
    idempotencyKey: identifier,
    intentId: identifier,
    reasonEvidenceIds: z.array(identifier).min(1).max(64),
    rollbackRef: repositoryArtifactPath,
    runId: identifier,
    scenarioMarker: z.string().min(1).max(256),
    sourceCollectionFingerprint: fingerprint,
    sourceUrn: urn,
    tagPayloadHash: fingerprint,
    targetInstanceFingerprint: fingerprint,
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
  reviewTagDefinitionFingerprint?: string;
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
  expectedReviewTagDefinitionFingerprint: string;
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
  targetInstanceFingerprint: string;
  validationReceiptFingerprint: string;
  writePayloadFingerprint: string;
}>;

export interface TrustedDataHubEffectAuthority {
  /** Opaque run-store claim; never copied into requests, receipts, diagnostics, or logs. */
  currentEffectClaim: unknown;
  verifyCurrentEffectReservation(
    claim: unknown,
    canonicalEffectFingerprint: string,
  ): Promise<
    Readonly<{
      attemptFence?: string;
      attemptId?: string;
      canonicalEffectFingerprint: string;
      invokeBy: string;
      reservationId: string;
      state: "RESERVED" | "CONSUMED";
    }>
  >;
  /** Matches EffectInvocationAuthority.consumeCurrentEffect(claim, canonicalEffectFingerprint). */
  consumeCurrentEffect(
    claim: unknown,
    canonicalEffectFingerprint: string,
  ): Promise<
    Readonly<{
      attemptFence: string;
      attemptId: string;
      canonicalEffectFingerprint: string;
      invokeBy: string;
      reservationId: string;
    }>
  >;
}

export type DataHubWritebackReceipt = Readonly<{
  attemptFence?: string;
  attemptId?: string;
  artifactFingerprint: string;
  approvalFingerprint: string;
  canonicalEffectFingerprint?: string;
  candidateFingerprint: string;
  completedAt: string;
  decision: DataHubWritebackRequest["decision"];
  document: Readonly<{ contentHash: string; id: string; marker: string; title: string }>;
  documentPayloadHash: string;
  expectedMetadataFingerprint: string;
  expectedMetadataVersion: string;
  expectedReviewTagDefinitionFingerprint: string;
  githubPrUrl: string;
  githubReceiptFingerprint: string;
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
  targetInstanceFingerprint: string;
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
  expectedTargetInstanceFingerprint?: string;
  mutationClientFactory: () => Promise<MutationToolClient>;
  readerFactory: () => Promise<ExactDataHubEntityReader>;
}>;

const AUTHORITY_TIMEOUT_MS = 2_000;

async function withAuthorityDeadline<T>(operation: () => Promise<T>): Promise<T> {
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
    return await Promise.race([operation(), deadline]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
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
  // Institutional memory is keyed on the semantic decision, not on the run that produced it.
  // A run-scoped key created a new decision record per rehearsal, so repeated identical runs
  // accumulated duplicate metadata instead of converging on one remembered decision.
  const id = stableId("lineageguard-migration-decision", {
    candidateFingerprint: request.candidateFingerprint,
    sourceUrn: request.sourceUrn,
  });
  const marker = `lineageguard:decision:v1:${request.idempotencyKey}`;
  const title = `LineageGuard migration decision · ${request.candidateFingerprint.slice(0, 12)}`;
  const content = [
    `Marker: ${marker}`,
    `Decision: ${request.decision}`,
    `Latest verified run: ${request.runId}`,
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
  const reviewStatusTagUrn = CANONICAL_REVIEWED_TAG_URN;
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
  if (
    !snapshot.knownTagUrns.includes(CANONICAL_REVIEWED_TAG_URN) ||
    snapshot.reviewTagDefinitionFingerprint !== request.expectedReviewTagDefinitionFingerprint
  ) {
    throw new DataHubAdapterError(
      "CONFLICT",
      "The allowlisted DataHub Reviewed tag definition changed.",
    );
  }
  if (phase === "before" && snapshot.version !== request.expectedMetadataVersion) {
    throw new DataHubAdapterError("CONFLICT", "DataHub metadata version changed.");
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
    attemptFence: string;
    attemptId: string;
    canonicalEffectFingerprint: string;
    invokeBy: string;
    reservationId: string;
  }>,
): DataHubWritebackReceipt {
  const expectedFinalTags = [...new Set([...before.tagUrns, payloads.reviewStatusTagUrn])].sort();
  const exactFinalTags = [...after.tagUrns].sort();
  const tagsPreservedExactly = stableJson(expectedFinalTags) === stableJson(exactFinalTags);
  const succeeded = proof.document && proof.tag && tagsPreservedExactly;
  const body = {
    artifactFingerprint: request.artifactFingerprint,
    approvalFingerprint: request.approvalFingerprint,
    ...(authority === undefined
      ? {}
      : {
          attemptFence: authority.attemptFence,
          attemptId: authority.attemptId,
          canonicalEffectFingerprint: authority.canonicalEffectFingerprint,
        }),
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
    expectedReviewTagDefinitionFingerprint: request.expectedReviewTagDefinitionFingerprint,
    githubPrUrl: request.githubPrUrl,
    githubReceiptFingerprint: request.githubReceiptFingerprint,
    ...(authority === undefined ? {} : { invokeBy: authority.invokeBy }),
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
    targetInstanceFingerprint: request.targetInstanceFingerprint,
    validationReceiptFingerprint: request.validationReceiptFingerprint,
    workerFailureState: succeeded ? ("NONE" as const) : ("FAILED_WRITEBACK" as const),
    writePayloadFingerprint: payloads.writePayloadFingerprint,
    writeProof: proof,
  };
  return Object.freeze({ ...body, receiptFingerprint: sha256(body) });
}

type ConsumedAuthority = Readonly<{
  attemptFence: string;
  attemptId: string;
  canonicalEffectFingerprint: string;
  invokeBy: string;
  reservationId: string;
}>;

function validateConsumedAuthority(
  consumed: ConsumedAuthority,
  clock: () => Date,
  requireCurrentDeadline: boolean,
): void {
  if (
    consumed.attemptFence.length < 1 ||
    consumed.attemptId.length < 1 ||
    !/^[a-f0-9]{64}$/u.test(consumed.canonicalEffectFingerprint) ||
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
    if (
      this.#dependencies.expectedTargetInstanceFingerprint !== undefined &&
      request.targetInstanceFingerprint !== this.#dependencies.expectedTargetInstanceFingerprint
    ) {
      throw new DataHubAdapterError(
        "CONFLICT",
        "DataHub write-back target instance attestation changed.",
      );
    }
    const payloads = deriveInternalDataHubWritebackPayloads(request);
    const binding = authorityBinding(request);
    const canonicalEffectFingerprint = sha256(stableJson(binding));
    let verified: Awaited<
      ReturnType<TrustedDataHubEffectAuthority["verifyCurrentEffectReservation"]>
    >;
    try {
      verified = await withAuthorityDeadline(() =>
        this.#dependencies.authority.verifyCurrentEffectReservation(
          this.#dependencies.authority.currentEffectClaim,
          canonicalEffectFingerprint,
        ),
      );
    } catch (error) {
      if (error instanceof DataHubAdapterError) throw error;
      throw new DataHubAdapterError(
        "AUTHORITY_INVALID",
        "DataHub effect authority was missing, invalid, expired, or not current.",
      );
    }
    if (
      (verified.state !== "RESERVED" && verified.state !== "CONSUMED") ||
      verified.canonicalEffectFingerprint !== canonicalEffectFingerprint ||
      verified.reservationId.length < 1 ||
      !Number.isFinite(Date.parse(verified.invokeBy))
    ) {
      throw new DataHubAdapterError("AUTHORITY_INVALID", "DataHub effect authority is invalid.");
    }
    let verifiedConsumed: ConsumedAuthority | undefined;
    if (verified.state === "CONSUMED") {
      verifiedConsumed = {
        attemptFence: verified.attemptFence ?? "",
        attemptId: verified.attemptId ?? "",
        canonicalEffectFingerprint: verified.canonicalEffectFingerprint,
        invokeBy: verified.invokeBy,
        reservationId: verified.reservationId,
      };
      validateConsumedAuthority(
        verifiedConsumed,
        this.#dependencies.clock ?? (() => new Date()),
        false,
      );
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
      const existing = proofState(before, payloads);
      if (existing.tag && !existing.document) {
        throw new DataHubAdapterError(
          "CONFLICT",
          "DataHub contains an impossible tag-only write-back state.",
        );
      }
      if (verified.state === "RESERVED" && (existing.document || existing.tag)) {
        throw new DataHubAdapterError(
          "CONFLICT",
          "DataHub contains write-back state without a consumed local effect.",
        );
      }
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
          verifiedConsumed,
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
            verifiedConsumed,
          );
        }
        if (verifiedConsumed === undefined) {
          throw new DataHubAdapterError("AUTHORITY_INVALID", "DataHub consumed effect is invalid.");
        }
        consumed = verifiedConsumed;
        mutationClient = await this.#dependencies.mutationClientFactory();
      } else {
        mutationClient = await this.#dependencies.mutationClientFactory();
        try {
          consumed = await withAuthorityDeadline(() =>
            this.#dependencies.authority.consumeCurrentEffect(
              this.#dependencies.authority.currentEffectClaim,
              canonicalEffectFingerprint,
            ),
          );
        } catch (error) {
          if (error instanceof DataHubAdapterError) throw error;
          throw new DataHubAdapterError(
            "AMBIGUOUS",
            "DataHub effect consumption outcome is ambiguous and requires reconciliation.",
            { retryable: true },
          );
        }
        if (consumed.canonicalEffectFingerprint !== canonicalEffectFingerprint) {
          throw new DataHubAdapterError(
            "AUTHORITY_INVALID",
            "DataHub consumed effect fingerprint changed.",
          );
        }
        validateConsumedAuthority(consumed, this.#dependencies.clock ?? (() => new Date()), true);
      }
      if (mutationClient === undefined) {
        throw new DataHubAdapterError("UNAVAILABLE", "DataHub mutation client is unavailable.");
      }
      validateConsumedAuthority(consumed, this.#dependencies.clock ?? (() => new Date()), true);

      if (!existing.document) {
        try {
          validateConsumedAuthority(consumed, this.#dependencies.clock ?? (() => new Date()), true);
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
          validateConsumedAuthority(consumed, this.#dependencies.clock ?? (() => new Date()), true);
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

function strictCustomProperty(
  properties: Readonly<Record<string, unknown>>,
  key: string,
): string | undefined {
  const custom = properties.customProperties;
  if (Array.isArray(custom)) {
    if (custom.length > 100) {
      throw new DataHubAdapterError("SCHEMA_DRIFT", "DataHub custom properties are unbounded.");
    }
    const matches: string[] = [];
    for (const item of custom) {
      const entry = record(item);
      if (entry === undefined || typeof entry.key !== "string" || typeof entry.value !== "string") {
        throw new DataHubAdapterError("SCHEMA_DRIFT", "DataHub custom properties are malformed.");
      }
      if (entry.key === key) matches.push(entry.value);
    }
    if (matches.length > 1) {
      throw new DataHubAdapterError("SCHEMA_DRIFT", "DataHub scenario marker was duplicated.");
    }
    return matches[0];
  }
  const customRecord = record(custom);
  if (custom !== undefined && customRecord === undefined) {
    throw new DataHubAdapterError("SCHEMA_DRIFT", "DataHub custom properties are malformed.");
  }
  const value = customRecord?.[key];
  if (value !== undefined && typeof value !== "string") {
    throw new DataHubAdapterError("SCHEMA_DRIFT", "DataHub scenario marker is malformed.");
  }
  return value;
}

export function parseOfficialWritebackEntities(
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
  const scenarioMarker = strictCustomProperty(properties, "lineageguard.scenario");
  const systemMetadata = record(entity.systemMetadata);
  const versionValue =
    strictCustomProperty(properties, "lineageguard.metadata-version") ??
    systemMetadata?.lastObserved;
  if (
    scenarioMarker !== CANONICAL_SCENARIO_MARKER ||
    (typeof versionValue !== "string" && typeof versionValue !== "number")
  ) {
    throw new DataHubAdapterError(
      "SCHEMA_DRIFT",
      "Official DataHub entity omitted the controlled scenario marker or metadata version.",
    );
  }
  const tags = record(entity.tags)?.tags;
  if (!Array.isArray(tags) || tags.length > 200) {
    throw new DataHubAdapterError("SCHEMA_DRIFT", "DataHub entity tags are absent or unbounded.");
  }
  const tagUrns = tags.map((entry) => {
    const tagUrn = record(record(entry)?.tag)?.urn;
    if (typeof tagUrn !== "string" || !tagUrn.startsWith("urn:li:tag:")) {
      throw new DataHubAdapterError("SCHEMA_DRIFT", "DataHub entity tags are malformed.");
    }
    return tagUrn;
  });
  if (new Set(tagUrns).size !== tagUrns.length) {
    throw new DataHubAdapterError("SCHEMA_DRIFT", "DataHub entity tags are duplicated.");
  }
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
    tagUrns: tagUrns.filter((item) => item !== tagUrn).sort(),
  };
  const matchingTags = entities.filter((item) => item.urn === tagUrn && !("error" in item));
  const tagProperties = matchingTags.length === 1 ? record(matchingTags[0]?.properties) : undefined;
  const knownTagUrns =
    tagProperties?.name === "Reviewed" &&
    typeof tagProperties.description === "string" &&
    CANONICAL_REVIEWED_TAG_DESCRIPTION_PATTERN.test(tagProperties.description)
      ? [tagUrn]
      : [];
  const reviewTagDefinitionFingerprint =
    knownTagUrns.length === 1
      ? sha256({
          description: tagProperties?.description,
          name: tagProperties?.name,
          urn: tagUrn,
        })
      : undefined;
  return Object.freeze({
    documentProofs: Object.freeze(documentProofs.map((proof) => Object.freeze(proof))),
    knownTagUrns: Object.freeze(knownTagUrns),
    observedAt,
    relevantMetadataFingerprint: sha256(relevantMetadata),
    ...(reviewTagDefinitionFingerprint === undefined ? {} : { reviewTagDefinitionFingerprint }),
    scenarioMarker,
    tagUrns: Object.freeze([...new Set(tagUrns)].sort()),
    urn: expectedUrn,
    version: String(versionValue),
  });
}

export async function createExactReaderFromSession(
  session: Awaited<ReturnType<typeof createOfficialStdioSession>>,
): Promise<ExactDataHubEntityReader> {
  let client: Awaited<ReturnType<typeof createReadOnlyToolClient>>;
  try {
    client = await createReadOnlyToolClient(session);
  } catch (error) {
    await Promise.allSettled([session.close()]);
    throw error;
  }
  return {
    async close() {
      await client.close();
    },
    async readExact(expectedUrn, documentId, tagUrn) {
      const result = await client.invoke("get_entities", {
        urns: [expectedUrn, `urn:li:document:${documentId}`, tagUrn],
      });
      return parseOfficialWritebackEntities(
        result.payload,
        expectedUrn,
        documentId,
        tagUrn,
        result.retrievedAt,
      );
    },
  };
}

async function officialReader(
  credentials: OfficialStdioCredentials,
): Promise<ExactDataHubEntityReader> {
  return createExactReaderFromSession(await createOfficialStdioSession(credentials));
}

export async function createMutationClientFromSession(
  session: Awaited<ReturnType<typeof createOfficialMutationSession>>,
): Promise<MutationToolClient> {
  try {
    return await createMutationToolClient(session);
  } catch (error) {
    await Promise.allSettled([session.close()]);
    throw error;
  }
}

async function officialMutationClient(
  credentials: OfficialMutationCredentials,
): Promise<MutationToolClient> {
  return createMutationClientFromSession(await createOfficialMutationSession(credentials));
}

export type OfficialLiveDataHubWritebackConfiguration = Readonly<{
  authority: TrustedDataHubEffectAuthority;
  enabled?: boolean;
  mutationCredentials: OfficialMutationCredentials;
  readCredentials: OfficialStdioCredentials;
  targetInstanceFingerprint: string;
}>;

function normalizedGmsUrl(value: string): string {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new DataHubAdapterError("CONFIGURATION", "DataHub GMS target URL is invalid.");
  }
  if (url.username || url.password || url.search || url.hash) {
    throw new DataHubAdapterError("CONFIGURATION", "DataHub GMS target URL is unsafe.");
  }
  const loopback = url.hostname === "127.0.0.1" || url.hostname === "localhost";
  if (url.protocol !== "https:" && !(url.protocol === "http:" && loopback)) {
    throw new DataHubAdapterError("CONFIGURATION", "DataHub GMS target URL is unsafe.");
  }
  return url.href;
}

export function createOfficialLiveDataHubWritebackPort(
  configuration: OfficialLiveDataHubWritebackConfiguration,
): DataHubWritebackPort {
  if (configuration.readCredentials.readToken === configuration.mutationCredentials.mutationToken) {
    throw new DataHubAdapterError(
      "CONFIGURATION",
      "DataHub read and mutation credentials must be separate.",
    );
  }
  if (
    normalizedGmsUrl(configuration.readCredentials.dataHubGmsUrl) !==
    normalizedGmsUrl(configuration.mutationCredentials.dataHubGmsUrl)
  ) {
    throw new DataHubAdapterError(
      "CONFIGURATION",
      "DataHub read and mutation credentials target different instances.",
    );
  }
  const targetFingerprint = fingerprint.safeParse(configuration.targetInstanceFingerprint);
  if (!targetFingerprint.success) {
    throw new DataHubAdapterError(
      "CONFIGURATION",
      "DataHub target instance attestation is invalid.",
    );
  }
  return createLiveDataHubWritebackPort({
    authority: configuration.authority,
    enabled: configuration.enabled === true,
    expectedTargetInstanceFingerprint: targetFingerprint.data,
    mutationClientFactory: () => officialMutationClient(configuration.mutationCredentials),
    readerFactory: () => officialReader(configuration.readCredentials),
  });
}

export function dataHubWritebackBindingFingerprint(request: DataHubWritebackRequest): string {
  return sha256(stableJson(authorityBinding(validateRequest(request))));
}
