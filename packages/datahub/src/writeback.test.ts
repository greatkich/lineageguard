import { canonicalDatasetUrn, sha256 } from "@lineageguard/domain";
import { describe, expect, it, vi } from "vitest";
import { DataHubAdapterError } from "./errors.js";
import { createMutationToolClient, officialMutationInputSchemas } from "./mutation-tool-client.js";
import type { ToolSession } from "./tool-client.js";
import {
  createExactReaderFromSession,
  createLiveDataHubWritebackPort,
  createOfficialLiveDataHubWritebackPort,
  type DataHubDocumentProof,
  type DataHubWritebackRequest,
  dataHubWritebackBindingFingerprint,
  deriveDataHubWritebackPayloads,
  type ExactDataHubEntitySnapshot,
  type TrustedDataHubEffectAuthority,
} from "./writeback.js";

const hash = (value: string) => sha256(value);
const NOW = "2026-08-05T10:00:00.000Z";

function request(): DataHubWritebackRequest {
  const base = {
    artifactFingerprint: hash("artifact"),
    approvalFingerprint: hash("approval"),
    candidateFingerprint: hash("candidate"),
    decision: "BLOCK" as const,
    expectedMetadataFingerprint: hash("metadata"),
    expectedMetadataVersion: "version-7",
    githubPrUrl: "https://github.com/example/lineageguard/pull/42",
    githubReceiptFingerprint: hash("github"),
    idempotencyKey: "effect.datahub.run-42",
    intentId: "intent-42",
    reasonEvidenceIds: ["evidence_01", "evidence_02"],
    rollbackRef: "migration/rollback.sql",
    runId: "run-42",
    scenarioMarker: "canonical-customer-id-rename",
    sourceCollectionFingerprint: hash("collection"),
    sourceUrn: canonicalDatasetUrn,
    targetInstanceFingerprint: hash("datahub-instance"),
    validationReceiptFingerprint: hash("validation"),
  };
  const payloads = deriveDataHubWritebackPayloads(base);
  return {
    ...base,
    documentPayloadHash: payloads.documentPayloadHash,
    tagPayloadHash: payloads.tagPayloadHash,
  };
}

function snapshot(input: Partial<ExactDataHubEntitySnapshot> = {}): ExactDataHubEntitySnapshot {
  return {
    documentProofs: [],
    knownTagUrns: ["urn:li:tag:lineageguard-canonical.Reviewed"],
    observedAt: NOW,
    relevantMetadataFingerprint: hash("metadata"),
    scenarioMarker: "canonical-customer-id-rename",
    tagUrns: ["urn:li:tag:existing"],
    urn: canonicalDatasetUrn,
    version: "version-7",
    ...input,
  };
}

function proofFor(writeRequest: DataHubWritebackRequest): DataHubDocumentProof {
  const payloads = deriveDataHubWritebackPayloads(writeRequest);
  return {
    contentHash: sha256(payloads.document.content),
    id: payloads.document.id,
    marker: payloads.document.marker,
    title: payloads.document.title,
  };
}

function authority() {
  const consumeCurrentEffect = vi.fn<TrustedDataHubEffectAuthority["consumeCurrentEffect"]>(
    async (_claim, canonicalEffectFingerprint) => ({
      attemptFence: "attempt-fence-7",
      attemptId: "attempt-7",
      canonicalEffectFingerprint,
      invokeBy: "2026-08-05T10:01:00.000Z",
      reservationId: "reservation-42",
    }),
  );
  const verifyCurrentEffectReservation = vi.fn<
    TrustedDataHubEffectAuthority["verifyCurrentEffectReservation"]
  >(async (_claim, canonicalEffectFingerprint) => ({
    canonicalEffectFingerprint,
    invokeBy: "2026-08-05T10:01:00.000Z",
    reservationId: "reservation-42",
    state: "RESERVED" as const,
  }));
  return {
    consumeCurrentEffect,
    currentEffectClaim: Object.freeze({ opaque: "trusted-test-claim" }),
    verifyCurrentEffectReservation,
  };
}

async function portFor(options: {
  authority?: TrustedDataHubEffectAuthority;
  enabled?: boolean;
  expectedTargetInstanceFingerprint?: string;
  mutationClientFactory?: () => Promise<Awaited<ReturnType<typeof createMutationToolClient>>>;
  onCall?: (name: string, arguments_: Readonly<Record<string, unknown>>) => void | Promise<void>;
  onReaderClose?: () => void;
  read: () => ExactDataHubEntitySnapshot;
}) {
  const calls: string[] = [];
  const session: ToolSession = {
    async callTool(name, arguments_) {
      calls.push(name);
      await options.onCall?.(name, arguments_);
      return name === "save_document"
        ? {
            structuredContent: {
              author: null,
              message: "Successfully created document: test",
              success: true,
              urn: arguments_.urn,
            },
          }
        : {
            structuredContent: {
              message: "Successfully added 1 tag(s) to 1 entit(ies)",
              success: true,
            },
          };
    },
    async close() {},
    async listTools() {
      return {
        tools: [
          {
            inputSchema: officialMutationInputSchemas.save_document,
            name: "save_document",
          },
          { inputSchema: officialMutationInputSchemas.add_tags, name: "add_tags" },
          { name: "remove_tags" },
        ],
      };
    },
  };
  const port = createLiveDataHubWritebackPort({
    authority: options.authority ?? authority(),
    clock: () => new Date(NOW),
    enabled: options.enabled ?? true,
    ...(options.expectedTargetInstanceFingerprint === undefined
      ? {}
      : { expectedTargetInstanceFingerprint: options.expectedTargetInstanceFingerprint }),
    mutationClientFactory:
      options.mutationClientFactory ??
      (() =>
        createMutationToolClient(session, {
          invocationId: () => `invocation-${calls.length + 1}`,
        })),
    readerFactory: async () => ({
      async close() {
        options.onReaderClose?.();
      },
      readExact: async () => options.read(),
    }),
  });
  return { calls, port };
}

describe("controlled DataHub write-back", () => {
  it.each(["ALLOW", "REVIEW", "BLOCK"] as const)(
    "uses the one provisioned Reviewed tag for %s decisions",
    (decision) => {
      const candidate = request();
      const payloads = deriveDataHubWritebackPayloads({ ...candidate, decision });
      expect(payloads.reviewStatusTagUrn).toBe("urn:li:tag:lineageguard-canonical.Reviewed");
    },
  );

  it("rejects different normalized read and mutation GMS targets before any process starts", () => {
    expect(() =>
      createOfficialLiveDataHubWritebackPort({
        authority: authority(),
        mutationCredentials: {
          dataHubGmsUrl: "https://mutation.example.test",
          mutationToken: "mutation-token",
          uvCacheDir: "/tmp/mutation-cache",
          uvxPath: "/usr/local/bin/uvx",
        },
        readCredentials: {
          dataHubGmsUrl: "https://read.example.test",
          readToken: "read-token",
          uvCacheDir: "/tmp/read-cache",
          uvxPath: "/usr/local/bin/uvx",
        },
        targetInstanceFingerprint: hash("datahub-instance"),
      }),
    ).toThrow("target different instances");
  });

  it("rejects a mismatched trusted target-instance attestation before authority or read", async () => {
    const trusted = authority();
    const read = vi.fn(() => snapshot());
    const { port } = await portFor({
      authority: trusted,
      expectedTargetInstanceFingerprint: hash("other-instance"),
      read,
    });
    await expect(port.write(request())).rejects.toMatchObject({ code: "CONFLICT" });
    expect(trusted.verifyCurrentEffectReservation).not.toHaveBeenCalled();
    expect(read).not.toHaveBeenCalled();
  });

  it("closes a constructed read session when read-tool discovery fails", async () => {
    const close = vi.fn(async () => {});
    const session: ToolSession = {
      async callTool() {
        return {};
      },
      close,
      async listTools() {
        return { tools: [] };
      },
    };
    await expect(createExactReaderFromSession(session)).rejects.toMatchObject({
      code: "TOOL_MISSING",
    });
    expect(close).toHaveBeenCalledTimes(1);
  });

  it("consumes exact trusted authority immediately before the first mutation and proves both writes", async () => {
    const writeRequest = request();
    const payloads = deriveDataHubWritebackPayloads(writeRequest);
    const trusted = authority();
    let document = false;
    let tag = false;
    const argumentsByTool = new Map<string, Readonly<Record<string, unknown>>>();
    const { calls, port } = await portFor({
      authority: trusted,
      onCall(name, arguments_) {
        expect(trusted.consumeCurrentEffect).toHaveBeenCalledTimes(1);
        argumentsByTool.set(name, arguments_);
        if (name === "save_document") document = true;
        if (name === "add_tags") tag = true;
      },
      read: () => {
        expect(trusted.verifyCurrentEffectReservation).toHaveBeenCalledTimes(1);
        return snapshot({
          documentProofs: document ? [proofFor(writeRequest)] : [],
          tagUrns: tag
            ? ["urn:li:tag:existing", payloads.reviewStatusTagUrn]
            : ["urn:li:tag:existing"],
        });
      },
    });

    const result = await port.write(writeRequest);

    expect(calls).toEqual(["save_document", "add_tags"]);
    expect(argumentsByTool.get("save_document")).toEqual({
      content: payloads.document.content,
      document_type: "Decision",
      related_assets: [canonicalDatasetUrn],
      title: payloads.document.title,
      urn: `urn:li:document:${payloads.document.id}`,
    });
    expect(argumentsByTool.get("add_tags")).toEqual({
      entity_urns: [canonicalDatasetUrn],
      tag_urns: [payloads.reviewStatusTagUrn],
    });
    expect(trusted.consumeCurrentEffect).toHaveBeenCalledWith(
      trusted.currentEffectClaim,
      dataHubWritebackBindingFingerprint(writeRequest),
    );
    expect(trusted.consumeCurrentEffect.mock.calls[0]?.[0]).toEqual(
      trusted.verifyCurrentEffectReservation.mock.calls[0]?.[0],
    );
    expect(result).toMatchObject({
      preservedTagUrns: ["urn:li:tag:existing"],
      reservationId: "reservation-42",
      status: "SUCCEEDED",
      workerFailureState: "NONE",
      writeProof: { document: true, tag: true },
    });
    expect(JSON.stringify(result)).not.toContain(payloads.document.content);
    expect(result).not.toHaveProperty("reservationToken");
  });

  it.each([
    ["wrong URN", { sourceUrn: "urn:li:dataset:(urn:li:dataPlatform:postgres,other,PROD)" }, {}],
    ["wrong marker", {}, { scenarioMarker: "other-scenario" }],
    ["wrong version", {}, { version: "version-8" }],
    ["wrong metadata", {}, { relevantMetadataFingerprint: hash("changed") }],
  ])("fails before mutation for %s", async (_name, requestPatch, snapshotPatch) => {
    const trusted = authority();
    const { calls, port } = await portFor({
      authority: trusted,
      read: () => snapshot(snapshotPatch),
    });
    await expect(port.write({ ...request(), ...requestPatch })).rejects.toBeInstanceOf(
      DataHubAdapterError,
    );
    expect(calls).toEqual([]);
    expect(trusted.consumeCurrentEffect).not.toHaveBeenCalled();
  });

  it("is disabled by default at the official policy boundary", async () => {
    const read = vi.fn(() => snapshot());
    const { port } = await portFor({ enabled: false, read });
    await expect(port.write(request())).rejects.toThrow("DataHub mutation is disabled");
    expect(read).not.toHaveBeenCalled();
  });

  it("fails before authority consumption when the namespaced review tag is not provisioned", async () => {
    const trusted = authority();
    const { calls, port } = await portFor({
      authority: trusted,
      read: () => snapshot({ knownTagUrns: [] }),
    });
    await expect(port.write(request())).rejects.toMatchObject({ code: "CONFLICT" });
    expect(trusted.consumeCurrentEffect).not.toHaveBeenCalled();
    expect(calls).toEqual([]);
  });

  it("rejects missing, forged, expired, or consumed authority before invoking mutation tools", async () => {
    const trusted: TrustedDataHubEffectAuthority = {
      async consumeCurrentEffect() {
        throw new Error("must not consume");
      },
      async verifyCurrentEffectReservation() {
        throw new Error("secret token and internal reason");
      },
      currentEffectClaim: Object.freeze({ opaque: "invalid" }),
    };
    const { calls, port } = await portFor({ authority: trusted, read: () => snapshot() });
    await expect(port.write(request())).rejects.toMatchObject({
      code: "AUTHORITY_INVALID",
      message: "DataHub effect authority was missing, invalid, expired, or not current.",
    });
    expect(calls).toEqual([]);
  });

  it("rejects an expired invoke fence returned by authority before mutation", async () => {
    const trusted: TrustedDataHubEffectAuthority = {
      async consumeCurrentEffect(_claim, canonicalEffectFingerprint) {
        return {
          attemptFence: "attempt-fence-8",
          attemptId: "attempt-8",
          canonicalEffectFingerprint,
          invokeBy: "2026-08-05T09:59:59.000Z",
          reservationId: "reservation-42",
        };
      },
      currentEffectClaim: Object.freeze({ opaque: "expired" }),
      async verifyCurrentEffectReservation(_claim, canonicalEffectFingerprint) {
        return {
          canonicalEffectFingerprint,
          invokeBy: "2026-08-05T10:01:00.000Z",
          reservationId: "reservation-42",
          state: "RESERVED",
        };
      },
    };
    const { calls, port } = await portFor({ authority: trusted, read: () => snapshot() });
    await expect(port.write(request())).rejects.toMatchObject({
      code: "AUTHORITY_INVALID",
    });
    expect(calls).toEqual([]);
  });

  it("reconciles timeout-after-success without duplicating the document", async () => {
    const writeRequest = request();
    const payloads = deriveDataHubWritebackPayloads(writeRequest);
    let document = false;
    let tag = false;
    const { calls, port } = await portFor({
      async onCall(name) {
        if (name === "save_document") {
          document = true;
          throw new DataHubAdapterError("TIMEOUT", "secret remote timeout", { retryable: true });
        }
        tag = true;
      },
      read: () =>
        snapshot({
          documentProofs: document ? [proofFor(writeRequest)] : [],
          tagUrns: tag
            ? ["urn:li:tag:existing", payloads.reviewStatusTagUrn]
            : ["urn:li:tag:existing"],
        }),
    });
    const result = await port.write(writeRequest);
    expect(calls).toEqual(["save_document", "add_tags"]);
    expect(result.status).toBe("SUCCEEDED");
  });

  it("returns durable AMBIGUOUS partial state when the tag cannot be proven", async () => {
    const writeRequest = request();
    let document = false;
    const { port } = await portFor({
      onCall(name) {
        if (name === "save_document") document = true;
        else throw new DataHubAdapterError("TOOL_FAILURE", "failed");
      },
      read: () => snapshot({ documentProofs: document ? [proofFor(writeRequest)] : [] }),
    });
    await expect(port.write(writeRequest)).resolves.toMatchObject({
      status: "AMBIGUOUS",
      workerFailureState: "FAILED_WRITEBACK",
      writeProof: { document: true, tag: false },
    });
  });

  it("detects deterministic idempotency conflicts without mutation", async () => {
    const writeRequest = request();
    const expected = proofFor(writeRequest);
    const { calls, port } = await portFor({
      read: () => snapshot({ documentProofs: [{ ...expected, contentHash: hash("different") }] }),
    });
    await expect(port.write(writeRequest)).rejects.toMatchObject({ code: "CONFLICT" });
    expect(calls).toEqual([]);
  });

  it("reconciles an exact duplicate only with trusted authority and without another mutation", async () => {
    const writeRequest = request();
    const payloads = deriveDataHubWritebackPayloads(writeRequest);
    const trusted = authority();
    trusted.verifyCurrentEffectReservation.mockResolvedValue({
      attemptFence: "attempt-fence-7",
      attemptId: "attempt-7",
      canonicalEffectFingerprint: dataHubWritebackBindingFingerprint(writeRequest),
      invokeBy: "2026-08-05T10:01:00.000Z",
      reservationId: "reservation-42",
      state: "CONSUMED",
    });
    const { calls, port } = await portFor({
      authority: trusted,
      read: () =>
        snapshot({
          documentProofs: [proofFor(writeRequest)],
          tagUrns: ["urn:li:tag:existing", payloads.reviewStatusTagUrn],
        }),
    });
    await expect(port.write(writeRequest)).resolves.toMatchObject({
      status: "SUCCEEDED",
    });
    expect(calls).toEqual([]);
    expect(trusted.consumeCurrentEffect).not.toHaveBeenCalled();
    expect(trusted.verifyCurrentEffectReservation).toHaveBeenCalledTimes(1);
  });

  it("reconciles then completes missing writes under a still-current persisted CONSUMED fence", async () => {
    const writeRequest = request();
    const payloads = deriveDataHubWritebackPayloads(writeRequest);
    const trusted = authority();
    trusted.verifyCurrentEffectReservation.mockResolvedValue({
      attemptFence: "attempt-fence-7",
      attemptId: "attempt-7",
      canonicalEffectFingerprint: dataHubWritebackBindingFingerprint(writeRequest),
      invokeBy: "2026-08-05T10:01:00.000Z",
      reservationId: "reservation-42",
      state: "CONSUMED",
    });
    let document = false;
    let tag = false;
    const { calls, port } = await portFor({
      authority: trusted,
      onCall(name) {
        if (name === "save_document") document = true;
        if (name === "add_tags") tag = true;
      },
      read: () =>
        snapshot({
          documentProofs: document ? [proofFor(writeRequest)] : [],
          tagUrns: tag
            ? ["urn:li:tag:existing", payloads.reviewStatusTagUrn]
            : ["urn:li:tag:existing"],
        }),
    });
    await expect(port.write(writeRequest)).resolves.toMatchObject({
      status: "SUCCEEDED",
      workerFailureState: "NONE",
    });
    expect(calls).toEqual(["save_document", "add_tags"]);
    expect(trusted.consumeCurrentEffect).not.toHaveBeenCalled();
  });

  it("does not mutate a partial CONSUMED effect after its invoke fence expires", async () => {
    const writeRequest = request();
    const trusted = authority();
    trusted.verifyCurrentEffectReservation.mockResolvedValue({
      attemptFence: "attempt-fence-7",
      attemptId: "attempt-7",
      canonicalEffectFingerprint: dataHubWritebackBindingFingerprint(writeRequest),
      invokeBy: "2026-08-05T09:59:59.000Z",
      reservationId: "reservation-42",
      state: "CONSUMED",
    });
    const { calls, port } = await portFor({ authority: trusted, read: () => snapshot() });
    await expect(port.write(writeRequest)).resolves.toMatchObject({ status: "AMBIGUOUS" });
    expect(calls).toEqual([]);
  });

  it("fails closed when readback drops a prior tag", async () => {
    const writeRequest = request();
    const payloads = deriveDataHubWritebackPayloads(writeRequest);
    let document = false;
    let tag = false;
    let reads = 0;
    const { port } = await portFor({
      onCall(name) {
        if (name === "save_document") document = true;
        if (name === "add_tags") tag = true;
      },
      read: () => {
        reads += 1;
        return snapshot({
          documentProofs: document ? [proofFor(writeRequest)] : [],
          tagUrns: reads > 2 && tag ? [payloads.reviewStatusTagUrn] : ["urn:li:tag:existing"],
        });
      },
    });
    await expect(port.write(writeRequest)).resolves.toMatchObject({
      status: "AMBIGUOUS",
      workerFailureState: "FAILED_WRITEBACK",
    });
  });

  it("returns AMBIGUOUS when readback contains an unexpected extra tag", async () => {
    const writeRequest = request();
    const payloads = deriveDataHubWritebackPayloads(writeRequest);
    let document = false;
    let tag = false;
    const { port } = await portFor({
      onCall(name) {
        if (name === "save_document") document = true;
        if (name === "add_tags") tag = true;
      },
      read: () =>
        snapshot({
          documentProofs: document ? [proofFor(writeRequest)] : [],
          tagUrns: tag
            ? ["urn:li:tag:existing", payloads.reviewStatusTagUrn, "urn:li:tag:unexpected"]
            : ["urn:li:tag:existing"],
        }),
    });
    await expect(port.write(writeRequest)).resolves.toMatchObject({
      status: "AMBIGUOUS",
      workerFailureState: "FAILED_WRITEBACK",
    });
  });

  it("closes the read session if mutation-client construction fails after preflight", async () => {
    const closed = vi.fn();
    const { port } = await portFor({
      mutationClientFactory: async () => {
        throw new DataHubAdapterError("TOOL_POLICY_VIOLATION", "schema drift");
      },
      onReaderClose: closed,
      read: () => snapshot(),
    });
    await expect(port.write(request())).rejects.toMatchObject({
      code: "TOOL_POLICY_VIOLATION",
    });
    expect(closed).toHaveBeenCalledTimes(1);
  });

  it("fails closed when read-after-write relevant metadata no longer matches", async () => {
    const writeRequest = request();
    let document = false;
    let reads = 0;
    const { calls, port } = await portFor({
      onCall(name) {
        if (name === "save_document") document = true;
      },
      read: () => {
        reads += 1;
        return snapshot({
          documentProofs: document ? [proofFor(writeRequest)] : [],
          relevantMetadataFingerprint: reads > 1 ? hash("drifted") : hash("metadata"),
        });
      },
    });
    await expect(port.write(writeRequest)).rejects.toMatchObject({ code: "CONFLICT" });
    expect(calls).toEqual(["save_document"]);
  });

  it("rejects caller payload hash substitution before authority or mutation", async () => {
    const trusted = authority();
    const read = vi.fn(() => snapshot());
    const { calls, port } = await portFor({ authority: trusted, read });
    await expect(
      port.write({ ...request(), documentPayloadHash: hash("forged") }),
    ).rejects.toMatchObject({ code: "CONFLICT" });
    expect(trusted.consumeCurrentEffect).not.toHaveBeenCalled();
    expect(trusted.verifyCurrentEffectReservation).not.toHaveBeenCalled();
    expect(read).not.toHaveBeenCalled();
    expect(calls).toEqual([]);
  });

  it("rejects a forged caller authority field before any read or mutation", async () => {
    const trusted = authority();
    const read = vi.fn(() => snapshot());
    const { calls, port } = await portFor({ authority: trusted, read });
    await expect(
      port.write({
        ...request(),
        reservationToken: "caller-self-attestation",
      } as DataHubWritebackRequest),
    ).rejects.toMatchObject({ code: "CONFIGURATION" });
    expect(trusted.verifyCurrentEffectReservation).not.toHaveBeenCalled();
    expect(read).not.toHaveBeenCalled();
    expect(calls).toEqual([]);
  });
});
