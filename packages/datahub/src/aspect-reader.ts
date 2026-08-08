import { createHash } from "node:crypto";
import { z } from "zod";
import { DataHubAdapterError } from "./errors.js";

const DEFAULT_TIMEOUT_MS = 10_000;
const DEFAULT_MAX_RESPONSE_BYTES = 256 * 1024;

const trainingDataResponseSchema = z
  .object({
    value: z
      .object({
        trainingData: z
          .array(z.object({ dataset: z.string().startsWith("urn:li:dataset:") }).passthrough())
          .max(100),
      })
      .passthrough(),
  })
  .passthrough();

export type TrainingDataProof = Readonly<{
  aspectName: "mlModelTrainingData";
  credentialClass: "READ";
  endpoint: string;
  modelUrn: string;
  provenDatasetUrn: string;
  responseSha256: string;
  retrievedAt: string;
}>;

export type TrainingDataResult =
  | Readonly<{ proven: true; proof: TrainingDataProof }>
  | Readonly<{ proven: false }>;

export type AspectReaderOptions = Readonly<{
  clock?: () => Date;
  expectedDatasetUrn: string;
  fetchImpl?: typeof fetch;
  gmsBaseUrl: string;
  maxResponseBytes?: number;
  modelUrn: string;
  readToken: string;
  timeoutMs?: number;
}>;

function readFailed(message: string, retryable = false): DataHubAdapterError {
  return new DataHubAdapterError("TRAINING_DATA_READ_FAILED", message, { retryable });
}

function tooLarge(maxBytes: number): DataHubAdapterError {
  return new DataHubAdapterError(
    "TRAINING_DATA_RESPONSE_TOO_LARGE",
    `DataHub GMS TrainingData response exceeds ${String(maxBytes)} bytes.`,
  );
}

/** Rejects credentialed, query-bearing, and non-loopback plaintext GMS targets. */
function normalizedGmsBaseUrl(value: string): string {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new DataHubAdapterError("CONFIGURATION", "DataHub GMS base URL is invalid.");
  }
  if (url.username || url.password || url.search || url.hash) {
    throw new DataHubAdapterError("CONFIGURATION", "DataHub GMS base URL is unsafe.");
  }
  const loopback = url.hostname === "127.0.0.1" || url.hostname === "localhost";
  if (url.protocol !== "https:" && !(url.protocol === "http:" && loopback)) {
    throw new DataHubAdapterError("CONFIGURATION", "DataHub GMS base URL is unsafe.");
  }
  return url.href.replace(/\/+$/u, "");
}

function aspectEndpoint(gmsBaseUrl: string, modelUrn: string): string {
  const base = normalizedGmsBaseUrl(gmsBaseUrl);
  return `${base}/openapi/v3/entity/mlModel/${encodeURIComponent(modelUrn)}/mlModelTrainingData`;
}

/** Issues the bounded read-only GET. Never surfaces the token or raw transport error. */
async function fetchAspect(
  endpoint: string,
  readToken: string,
  timeoutMs: number,
  fetchImpl: typeof fetch,
): Promise<Response> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetchImpl(endpoint, {
      method: "GET",
      headers: { Accept: "application/json", Authorization: `Bearer ${readToken}` },
      signal: controller.signal,
    });
  } catch (error) {
    if (error instanceof DOMException && error.name === "AbortError") {
      throw readFailed(
        `DataHub GMS TrainingData aspect read timed out after ${String(timeoutMs)}ms.`,
        true,
      );
    }
    throw readFailed("DataHub GMS TrainingData aspect read failed due to a network error.", true);
  } finally {
    clearTimeout(timeout);
  }
}

/** Reads the body under an advertised-and-actual size bound, returning text plus its digest. */
async function boundedBody(
  response: Response,
  maxBytes: number,
): Promise<Readonly<{ responseSha256: string; text: string }>> {
  if (!response.ok) {
    throw readFailed(
      `DataHub GMS returned HTTP ${String(response.status)} for TrainingData aspect.`,
      response.status >= 500,
    );
  }
  const advertised = response.headers.get("content-length");
  if (advertised !== null && Number.parseInt(advertised, 10) > maxBytes) throw tooLarge(maxBytes);

  let text: string;
  try {
    text = await response.text();
  } catch {
    throw readFailed("Failed to read DataHub GMS TrainingData response body.", true);
  }
  if (new TextEncoder().encode(text).length > maxBytes) throw tooLarge(maxBytes);

  return Object.freeze({
    responseSha256: createHash("sha256").update(text).digest("hex"),
    text,
  });
}

function parsedTrainingData(text: string): readonly Readonly<{ dataset: string }>[] {
  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch {
    throw readFailed("DataHub GMS TrainingData response is not valid JSON.");
  }
  const validated = trainingDataResponseSchema.safeParse(json);
  if (!validated.success) {
    throw readFailed("DataHub GMS TrainingData response did not match the expected schema.");
  }
  return validated.data.value.trainingData;
}

/**
 * Proves that `modelUrn` declares `expectedDatasetUrn` in its `trainingData` aspect.
 *
 * mlModel entities carry no UpstreamLineage, so `get_lineage_paths_between` cannot establish this
 * edge. This narrow read-only GMS call supplies the missing proof and returns a receipt binding
 * the endpoint, timestamp, response digest, and credential class.
 *
 * Returns `{ proven: false }` when the aspect omits the dataset — an observed absence, not a
 * failure. Throws on every transport, size, and schema fault so an unreadable aspect can never be
 * mistaken for a proven relationship.
 */
export async function readTrainingDataAspect(
  options: AspectReaderOptions,
): Promise<TrainingDataResult> {
  const endpoint = aspectEndpoint(options.gmsBaseUrl, options.modelUrn);
  const maxBytes = options.maxResponseBytes ?? DEFAULT_MAX_RESPONSE_BYTES;

  const response = await fetchAspect(
    endpoint,
    options.readToken,
    options.timeoutMs ?? DEFAULT_TIMEOUT_MS,
    options.fetchImpl ?? fetch,
  );
  const body = await boundedBody(response, maxBytes);
  const trainingData = parsedTrainingData(body.text);

  if (!trainingData.some((entry) => entry.dataset === options.expectedDatasetUrn)) {
    return Object.freeze({ proven: false });
  }
  return Object.freeze({
    proven: true,
    proof: Object.freeze({
      aspectName: "mlModelTrainingData" as const,
      credentialClass: "READ" as const,
      endpoint,
      modelUrn: options.modelUrn,
      provenDatasetUrn: options.expectedDatasetUrn,
      responseSha256: body.responseSha256,
      retrievedAt: (options.clock ?? (() => new Date()))().toISOString(),
    }),
  });
}
