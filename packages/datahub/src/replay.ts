import {
  canonicalImpactRequestSchema,
  computeImpactCollectionFingerprint,
  computeImpactContextFingerprint,
  type ImpactCollectionResult,
  type ImpactContextData,
  impactCollectionResultSchema,
  impactContextSchema,
  sha256,
} from "@lineageguard/domain";
import { z } from "zod";
import type { DataHubContextCollectionInput, DataHubContextPort } from "./context-port.js";
import { DataHubAdapterError } from "./errors.js";

const fingerprintSchema = z.string().regex(/^[a-f0-9]{64}$/u);
const isoDateTimeSchema = z.iso.datetime({ offset: true });

export const verifiedReplayScenarioMarker = "lineageguard-canonical-customer-id-rename-v1" as const;
export const verifiedReplayRedactionMethod = "normalized-domain-evidence-only-v1" as const;

// Staged internal implementation only. Do not export replay constructors from the package root
// until a real live bundle passes verification and an authenticated fixture trust policy exists.

const manifestIdentitySchema = z
  .object({
    schemaVersion: z.literal(1),
    sourceScenarioMarker: z.literal(verifiedReplayScenarioMarker),
    redactionMethod: z.literal(verifiedReplayRedactionMethod),
    protocolClient: z
      .object({
        package: z.literal("@modelcontextprotocol/client"),
        version: z.literal("2.0.0"),
      })
      .strict(),
    officialServer: z
      .object({
        package: z.literal("mcp-server-datahub"),
        sourceCommit: z.literal("9a6946daa7d30eb481c82dd8ee5e15ae6526a3c9"),
        transport: z.literal("stdio"),
        version: z.literal("0.6.0"),
      })
      .strict(),
    approvedReadTools: z.tuple([
      z.literal("search"),
      z.literal("list_schema_fields"),
      z.literal("get_entities"),
      z.literal("get_lineage"),
      z.literal("get_lineage_paths_between"),
      z.literal("get_dataset_queries"),
    ]),
    sourceCollectedAt: isoDateTimeSchema,
    sourceLiveCollectionFingerprint: fingerprintSchema,
    sourceImpactContextFingerprint: fingerprintSchema,
  })
  .strict();

const verifiedReplayManifestSchema = manifestIdentitySchema
  .extend({ manifestFingerprint: fingerprintSchema })
  .strict();

const verifiedReplayBundleSchema = z
  .object({
    manifest: verifiedReplayManifestSchema,
    sourceLiveContext: impactContextSchema,
  })
  .strict()
  .superRefine((bundle, refinement) => {
    const { manifestFingerprint, ...identity } = bundle.manifest;
    if (manifestFingerprint !== sha256(identity)) {
      refinement.addIssue({
        code: "custom",
        message: "Replay manifest fingerprint is invalid",
        path: ["manifest", "manifestFingerprint"],
      });
    }
    if (bundle.sourceLiveContext.collectionOrigin.mode !== "LIVE") {
      refinement.addIssue({
        code: "custom",
        message: "Replay source must be a live context",
        path: ["sourceLiveContext", "collectionOrigin"],
      });
    }
    if (bundle.sourceLiveContext.collectionStatus !== "COMPLETE") {
      refinement.addIssue({
        code: "custom",
        message: "Replay source must be complete",
        path: ["sourceLiveContext", "collectionStatus"],
      });
    }
    if (
      bundle.manifest.sourceLiveCollectionFingerprint !==
      bundle.sourceLiveContext.collectionFingerprint
    ) {
      refinement.addIssue({
        code: "custom",
        message: "Replay manifest is not bound to the live collection",
        path: ["manifest", "sourceLiveCollectionFingerprint"],
      });
    }
    if (
      bundle.manifest.sourceImpactContextFingerprint !==
      bundle.sourceLiveContext.impactContextFingerprint
    ) {
      refinement.addIssue({
        code: "custom",
        message: "Replay manifest is not bound to the semantic context",
        path: ["manifest", "sourceImpactContextFingerprint"],
      });
    }
    if (bundle.manifest.sourceCollectedAt !== bundle.sourceLiveContext.collectedAt) {
      refinement.addIssue({
        code: "custom",
        message: "Replay manifest collection time is not bound to its source",
        path: ["manifest", "sourceCollectedAt"],
      });
    }
  });

export type VerifiedReplayManifest = z.infer<typeof verifiedReplayManifestSchema>;
export type VerifiedReplayBundle = z.infer<typeof verifiedReplayBundleSchema>;

function replayInvalid(): DataHubAdapterError {
  return new DataHubAdapterError(
    "REPLAY_INVALID",
    "Verified DataHub replay bundle is invalid or does not match the request.",
  );
}

function parseBundle(input: unknown): VerifiedReplayBundle {
  const parsed = verifiedReplayBundleSchema.safeParse(input);
  if (!parsed.success) throw replayInvalid();
  return parsed.data;
}

export function createVerifiedReplayBundle(liveResult: unknown): VerifiedReplayBundle {
  const parsed = impactCollectionResultSchema.safeParse(liveResult);
  if (
    !parsed.success ||
    parsed.data.outcome !== "COLLECTED_LIVE" ||
    parsed.data.context.collectionStatus !== "COMPLETE"
  ) {
    throw replayInvalid();
  }
  const sourceLiveContext = parsed.data.context;
  const identity = manifestIdentitySchema.parse({
    schemaVersion: 1,
    sourceScenarioMarker: verifiedReplayScenarioMarker,
    redactionMethod: verifiedReplayRedactionMethod,
    protocolClient: {
      package: "@modelcontextprotocol/client",
      version: "2.0.0",
    },
    officialServer: {
      package: "mcp-server-datahub",
      sourceCommit: "9a6946daa7d30eb481c82dd8ee5e15ae6526a3c9",
      transport: "stdio",
      version: "0.6.0",
    },
    approvedReadTools: [
      "search",
      "list_schema_fields",
      "get_entities",
      "get_lineage",
      "get_lineage_paths_between",
      "get_dataset_queries",
    ],
    sourceCollectedAt: sourceLiveContext.collectedAt,
    sourceLiveCollectionFingerprint: sourceLiveContext.collectionFingerprint,
    sourceImpactContextFingerprint: sourceLiveContext.impactContextFingerprint,
  });
  return parseBundle({
    manifest: { ...identity, manifestFingerprint: sha256(identity) },
    sourceLiveContext,
  });
}

function replayInputMatches(
  input: DataHubContextCollectionInput,
  bundle: VerifiedReplayBundle,
): boolean {
  return (
    canonicalImpactRequestSchema.safeParse(input.request).success &&
    input.changeId === bundle.sourceLiveContext.changeId
  );
}

function replayResult(bundle: VerifiedReplayBundle): ImpactCollectionResult {
  const {
    collectionFingerprint: sourceLiveCollectionFingerprint,
    collectionOrigin: _sourceLiveOrigin,
    impactContextFingerprint: sourceImpactContextFingerprint,
    ...commonContext
  } = bundle.sourceLiveContext;
  const contextData = {
    ...commonContext,
    collectionOrigin: {
      manifestFingerprint: bundle.manifest.manifestFingerprint,
      mode: "VERIFIED_REPLAY" as const,
      sourceImpactContextFingerprint,
      sourceLiveCollectionFingerprint,
    },
  } satisfies ImpactContextData;
  const impactContextFingerprint = computeImpactContextFingerprint(contextData);
  if (impactContextFingerprint !== sourceImpactContextFingerprint) throw replayInvalid();
  const context = impactContextSchema.parse({
    ...contextData,
    collectionFingerprint: computeImpactCollectionFingerprint(contextData),
    impactContextFingerprint,
  });
  return impactCollectionResultSchema.parse({
    context,
    outcome: "COLLECTED_VERIFIED_REPLAY",
  });
}

class VerifiedReplayDataHubContextPort implements DataHubContextPort {
  readonly #bundle: VerifiedReplayBundle;

  constructor(bundle: VerifiedReplayBundle) {
    this.#bundle = bundle;
  }

  async collect(input: DataHubContextCollectionInput): Promise<ImpactCollectionResult> {
    if (!replayInputMatches(input, this.#bundle)) throw replayInvalid();
    return replayResult(this.#bundle);
  }
}

export function createVerifiedReplayDataHubContextPort(bundle: unknown): DataHubContextPort {
  return new VerifiedReplayDataHubContextPort(parseBundle(bundle));
}
