import {
  canonicalImpactRequest,
  createImpactCollectionFailureReport,
  impactCollectionResultSchema,
  sha256,
} from "@lineageguard/domain";
import { describe, expect, it } from "vitest";
import { canonicalLiveTestResult } from "./canonical-test-support.js";
import { createVerifiedReplayBundle, createVerifiedReplayDataHubContextPort } from "./replay.js";

function withRecomputedManifestFingerprint(bundle: ReturnType<typeof createVerifiedReplayBundle>) {
  const { manifestFingerprint: _oldFingerprint, ...identity } = bundle.manifest;
  return {
    ...bundle,
    manifest: { ...identity, manifestFingerprint: sha256(identity) },
  };
}

describe("verified DataHub context replay", () => {
  it("preserves live semantics, changes collection provenance, and has no transport dependency", async () => {
    const live = await canonicalLiveTestResult();
    if (live.outcome !== "COLLECTED_LIVE") throw new Error("expected live result");
    const bundle = createVerifiedReplayBundle(live);
    const port = createVerifiedReplayDataHubContextPort(bundle);

    const result = await port.collect({
      changeId: live.context.changeId,
      request: canonicalImpactRequest,
    });

    expect(result.outcome).toBe("COLLECTED_VERIFIED_REPLAY");
    if (result.outcome !== "COLLECTED_VERIFIED_REPLAY") {
      throw new Error("expected replay result");
    }
    expect(result.context.impactContextFingerprint).toBe(live.context.impactContextFingerprint);
    expect(result.context.collectionFingerprint).not.toBe(live.context.collectionFingerprint);
    expect(result.context.evidence).toEqual(live.context.evidence);
    expect(result.context.collectionOrigin).toMatchObject({
      manifestFingerprint: bundle.manifest.manifestFingerprint,
      mode: "VERIFIED_REPLAY",
      sourceImpactContextFingerprint: live.context.impactContextFingerprint,
      sourceLiveCollectionFingerprint: live.context.collectionFingerprint,
    });
    expect(bundle.manifest).toMatchObject({
      approvedReadTools: [
        "search",
        "list_schema_fields",
        "get_entities",
        "get_lineage",
        "get_lineage_paths_between",
        "get_dataset_queries",
      ],
      officialServer: {
        package: "mcp-server-datahub",
        sourceCommit: "9a6946daa7d30eb481c82dd8ee5e15ae6526a3c9",
        transport: "stdio",
        version: "0.6.0",
      },
      protocolClient: { package: "@modelcontextprotocol/client", version: "2.0.0" },
    });
    expect(JSON.stringify(bundle)).not.toContain("SELECT");
    expect(JSON.stringify(bundle)).not.toContain("IGNORE PRIOR INSTRUCTIONS");
  });

  it("rejects a manifest fingerprint that was not produced from its full identity", async () => {
    const bundle = createVerifiedReplayBundle(await canonicalLiveTestResult());

    expect(() =>
      createVerifiedReplayDataHubContextPort({
        ...bundle,
        manifest: { ...bundle.manifest, manifestFingerprint: "f".repeat(64) },
      }),
    ).toThrowError(expect.objectContaining({ code: "REPLAY_INVALID" }));
  });

  it("rejects a recomputed manifest that substitutes either source fingerprint", async () => {
    const bundle = createVerifiedReplayBundle(await canonicalLiveTestResult());
    const changedSemantic = withRecomputedManifestFingerprint({
      ...bundle,
      manifest: {
        ...bundle.manifest,
        sourceImpactContextFingerprint: "a".repeat(64),
      },
    });
    const changedCollection = withRecomputedManifestFingerprint({
      ...bundle,
      manifest: {
        ...bundle.manifest,
        sourceLiveCollectionFingerprint: "b".repeat(64),
      },
    });

    expect(() => createVerifiedReplayDataHubContextPort(changedSemantic)).toThrowError(
      expect.objectContaining({ code: "REPLAY_INVALID" }),
    );
    expect(() => createVerifiedReplayDataHubContextPort(changedCollection)).toThrowError(
      expect.objectContaining({ code: "REPLAY_INVALID" }),
    );
  });

  it("rejects source context tampering and non-live source substitution", async () => {
    const bundle = createVerifiedReplayBundle(await canonicalLiveTestResult());
    const firstEvidence = bundle.sourceLiveContext.evidence[0];
    if (firstEvidence === undefined) throw new Error("expected evidence");
    const tamperedContext = {
      ...bundle.sourceLiveContext,
      evidence: [
        { ...firstEvidence, summary: "substituted metadata" },
        ...bundle.sourceLiveContext.evidence.slice(1),
      ],
    };
    const replaySource = {
      ...bundle.sourceLiveContext,
      collectionOrigin: {
        manifestFingerprint: "c".repeat(64),
        mode: "VERIFIED_REPLAY",
        sourceImpactContextFingerprint: bundle.sourceLiveContext.impactContextFingerprint,
        sourceLiveCollectionFingerprint: bundle.sourceLiveContext.collectionFingerprint,
      },
    };

    expect(() =>
      createVerifiedReplayDataHubContextPort({
        ...bundle,
        sourceLiveContext: tamperedContext,
      }),
    ).toThrowError(expect.objectContaining({ code: "REPLAY_INVALID" }));
    expect(() =>
      createVerifiedReplayDataHubContextPort({ ...bundle, sourceLiveContext: replaySource }),
    ).toThrowError(expect.objectContaining({ code: "REPLAY_INVALID" }));
  });

  it("rejects a different change or canonical request at replay time", async () => {
    const bundle = createVerifiedReplayBundle(await canonicalLiveTestResult());
    const port = createVerifiedReplayDataHubContextPort(bundle);

    await expect(
      port.collect({
        changeId: "chg_aaaaaaaaaaaaaaaaaaaaaaaa",
        request: canonicalImpactRequest,
      }),
    ).rejects.toMatchObject({ code: "REPLAY_INVALID" });
    await expect(
      port.collect({
        changeId: bundle.sourceLiveContext.changeId,
        request: {
          ...canonicalImpactRequest,
          field: "account_id",
        } as unknown as typeof canonicalImpactRequest,
      }),
    ).rejects.toMatchObject({ code: "REPLAY_INVALID" });
  });

  it("refuses to create a verified bundle from a failed collection", () => {
    const report = createImpactCollectionFailureReport({
      failedAt: "2026-08-04T08:00:00.000Z",
      failures: [
        {
          code: "NOT_FOUND",
          invocationId: "inv_missing",
          message: "Canonical DataHub dataset was not found.",
          tool: "search",
        },
      ],
      requested: canonicalImpactRequest,
    });
    const failed = impactCollectionResultSchema.parse({
      mode: "LIVE",
      outcome: "FAILED",
      report,
    });

    expect(() => createVerifiedReplayBundle(failed)).toThrowError(
      expect.objectContaining({ code: "REPLAY_INVALID" }),
    );
  });
});
