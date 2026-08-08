import {
  type CanonicalImpactRequest,
  canonicalAnalyticsRevenueUrn,
  canonicalDashboardUrn,
  canonicalDatasetUrn,
  canonicalFraudFeaturesUrn,
  canonicalFraudModelUrn,
  canonicalGlossaryTermUrn,
  canonicalImpactRequest,
  canonicalImpactRequestSchema,
  canonicalQueryUrn,
  createImpactCollectionFailureReport,
  type ImpactCollectionFailureReport,
  type ImpactCollectionResult,
  impactCollectionResultSchema,
} from "@lineageguard/domain";
import { z } from "zod";
import { normalizeCanonicalLiveCollection } from "./canonical-normalizer.js";
import {
  type CanonicalCollectionTargets,
  collectCanonicalObservations,
} from "./canonical-reader.js";
import { DataHubAdapterError } from "./errors.js";
import { createOfficialStdioSession, type OfficialStdioCredentials } from "./official-stdio.js";
import {
  createReadOnlyToolClient,
  type ReadToolName,
  requiredReadToolNames,
  type ToolSession,
} from "./tool-client.js";

const changeIdSchema = z.string().regex(/^chg_[a-f0-9]{24}$/u);
const requiredReadToolSet: ReadonlySet<string> = new Set(requiredReadToolNames);

const canonicalTargets = Object.freeze({
  dashboardUrn: canonicalDashboardUrn,
  database: "lineageguard",
  dataset: "orders",
  environment: "PROD",
  field: "customer_id",
  fraudFeaturesUrn: canonicalFraudFeaturesUrn,
  glossaryTermUrn: canonicalGlossaryTermUrn,
  modelUrn: canonicalFraudModelUrn,
  platform: "postgres",
  platformInstance: "lineageguard-canonical",
  queryUrn: canonicalQueryUrn,
  revenueUrn: canonicalAnalyticsRevenueUrn,
  schema: "commerce",
  sourceUrn: canonicalDatasetUrn,
} satisfies Omit<CanonicalCollectionTargets, "gmsBaseUrl" | "readToken">);

export type DataHubContextCollectionInput = Readonly<{
  changeId: string;
  request: CanonicalImpactRequest;
}>;

export interface DataHubContextPort {
  collect(input: DataHubContextCollectionInput): Promise<ImpactCollectionResult>;
}

export type LiveDataHubContextPortDependencies = Readonly<{
  clock?: () => Date;
  /** Injected fetch implementation for the GMS aspect read. Uses global `fetch` when omitted. */
  fetchImpl?: typeof fetch;
  gmsBaseUrl: string;
  invocationId?: () => string;
  readToken: string;
  sessionFactory: () => Promise<ToolSession>;
}>;

function safeInput(input: DataHubContextCollectionInput): DataHubContextCollectionInput {
  const request = canonicalImpactRequestSchema.safeParse(input.request);
  const changeId = changeIdSchema.safeParse(input.changeId);
  if (!request.success || !changeId.success) {
    throw new DataHubAdapterError("CONFIGURATION", "Canonical DataHub context request is invalid.");
  }
  return Object.freeze({ changeId: changeId.data, request: request.data });
}

function isReadToolName(value: string | undefined): value is ReadToolName {
  return value !== undefined && requiredReadToolSet.has(value);
}

function domainFailureCode(
  code: DataHubAdapterError["code"],
): ImpactCollectionFailureReport["failures"][number]["code"] | undefined {
  if (code === "TOOL_FAILURE") return "UNAVAILABLE";
  if (code === "TOOL_POLICY_VIOLATION") return "POLICY_VIOLATION";
  if (
    code === "AUTHORITY_INVALID" ||
    code === "CONFIGURATION" ||
    code === "CONFLICT" ||
    code === "REPLAY_INVALID" ||
    code === "TRAINING_DATA_READ_FAILED" ||
    code === "TRAINING_DATA_RESPONSE_TOO_LARGE"
  )
    return undefined;
  return code;
}

function failedLiveResult(
  error: DataHubAdapterError,
  failedAt: string,
): ImpactCollectionResult | undefined {
  const code = domainFailureCode(error.code);
  if (code === undefined || error.invocationId === undefined || !isReadToolName(error.tool)) {
    return undefined;
  }
  const report = createImpactCollectionFailureReport({
    requested: canonicalImpactRequest,
    failedAt,
    failures: [
      {
        code,
        invocationId: error.invocationId,
        message: error.message,
        tool: error.tool,
      },
    ],
  });
  return impactCollectionResultSchema.parse({ mode: "LIVE", outcome: "FAILED", report });
}

function secretSafeError(error: unknown, operation: string): DataHubAdapterError {
  if (error instanceof DataHubAdapterError) return error;
  return new DataHubAdapterError("UNAVAILABLE", `DataHub MCP ${operation} failed.`, {
    retryable: true,
  });
}

class LiveDataHubContextPort implements DataHubContextPort {
  readonly #clock: () => Date;
  readonly #fetchImpl: typeof fetch | undefined;
  readonly #gmsBaseUrl: string;
  readonly #invocationId: (() => string) | undefined;
  readonly #readToken: string;
  readonly #sessionFactory: () => Promise<ToolSession>;

  constructor(dependencies: LiveDataHubContextPortDependencies) {
    this.#clock = dependencies.clock ?? (() => new Date());
    this.#fetchImpl = dependencies.fetchImpl;
    this.#gmsBaseUrl = dependencies.gmsBaseUrl;
    this.#invocationId = dependencies.invocationId;
    this.#readToken = dependencies.readToken;
    this.#sessionFactory = dependencies.sessionFactory;
  }

  async collect(input: DataHubContextCollectionInput): Promise<ImpactCollectionResult> {
    const request = safeInput(input);
    let session: ToolSession;
    try {
      session = await this.#sessionFactory();
    } catch (error) {
      throw secretSafeError(error, "connection");
    }

    let result: ImpactCollectionResult | undefined;
    let failure: DataHubAdapterError | undefined;
    try {
      const client = await createReadOnlyToolClient(session, {
        clock: this.#clock,
        ...(this.#invocationId === undefined ? {} : { invocationId: this.#invocationId }),
      });
      const observations = await collectCanonicalObservations(client, {
        ...canonicalTargets,
        gmsBaseUrl: this.#gmsBaseUrl,
        readToken: this.#readToken,
        ...(this.#fetchImpl === undefined ? {} : { fetchImpl: this.#fetchImpl }),
      });
      try {
        result = normalizeCanonicalLiveCollection({
          changeId: request.changeId,
          collectedAt: this.#clock().toISOString(),
          observations,
        });
      } catch (error) {
        if (error instanceof DataHubAdapterError) throw error;
        throw new DataHubAdapterError(
          "SCHEMA_DRIFT",
          "Canonical DataHub context normalization failed.",
          {
            invocationId: observations.glossaryDetails.invocation.invocationId,
            tool: observations.glossaryDetails.invocation.tool,
          },
        );
      }
    } catch (error) {
      failure = secretSafeError(error, "collection");
    }

    try {
      await session.close();
    } catch (error) {
      failure ??= secretSafeError(error, "session close");
    }

    if (failure !== undefined) {
      const failed = failedLiveResult(failure, this.#clock().toISOString());
      if (failed !== undefined) return failed;
      throw failure;
    }
    if (result === undefined) {
      throw new DataHubAdapterError("UNAVAILABLE", "DataHub MCP collection produced no result.");
    }
    return result;
  }
}

export function createLiveDataHubContextPort(
  dependencies: LiveDataHubContextPortDependencies,
): DataHubContextPort {
  return new LiveDataHubContextPort(dependencies);
}

export function createOfficialLiveDataHubContextPort(
  credentials: OfficialStdioCredentials,
): DataHubContextPort {
  return createLiveDataHubContextPort({
    gmsBaseUrl: credentials.dataHubGmsUrl,
    readToken: credentials.readToken,
    sessionFactory: () => createOfficialStdioSession(credentials),
  });
}
