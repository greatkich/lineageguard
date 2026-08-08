import { describe, expect, it, vi } from "vitest";
import { readTrainingDataAspect } from "./aspect-reader.js";

const modelUrn =
  "urn:li:mlModel:(urn:li:dataPlatform:mlflow,lineageguard-canonical.fraud-model-v3,PROD)";
const expectedDatasetUrn =
  "urn:li:dataset:(urn:li:dataPlatform:postgres,lineageguard-canonical.lineageguard.fraud.customer_features,PROD)";
const gmsBaseUrl = "http://127.0.0.1:8080";
const readToken = "test-read-token-12345678";

function validTrainingDataResponse() {
  return JSON.stringify({
    value: {
      trainingData: [
        { dataset: expectedDatasetUrn, motivation: "FEATURE_TABLE" },
        { dataset: "urn:li:dataset:(urn:li:dataPlatform:postgres,other.dataset,PROD)" },
      ],
    },
  });
}

function mockFetchResponse(body: string, status = 200): typeof fetch {
  return vi.fn(async () => ({
    ok: status >= 200 && status < 300,
    status,
    headers: new Headers({ "content-length": String(new TextEncoder().encode(body).length) }),
    text: async () => body,
  })) as unknown as typeof fetch;
}

describe("readTrainingDataAspect", () => {
  it("returns proven with proof when TrainingData contains the expected dataset URN", async () => {
    const body = validTrainingDataResponse();
    const fetchImpl = mockFetchResponse(body);
    const clock = () => new Date("2026-08-07T10:00:00.000Z");

    const result = await readTrainingDataAspect({
      gmsBaseUrl,
      readToken,
      modelUrn,
      expectedDatasetUrn,
      fetchImpl,
      clock,
    });

    expect(result.proven).toBe(true);
    if (result.proven) {
      expect(result.proof.aspectName).toBe("mlModelTrainingData");
      expect(result.proof.credentialClass).toBe("READ");
      expect(result.proof.modelUrn).toBe(modelUrn);
      expect(result.proof.provenDatasetUrn).toBe(expectedDatasetUrn);
      expect(result.proof.retrievedAt).toBe("2026-08-07T10:00:00.000Z");
      expect(result.proof.responseSha256).toMatch(/^[a-f0-9]{64}$/);
      expect(result.proof.endpoint).toContain("/openapi/v3/entity/mlModel/");
    }

    expect(fetchImpl).toHaveBeenCalledOnce();
    const [url, options] = (fetchImpl as ReturnType<typeof vi.fn>).mock.calls[0] as [
      string,
      RequestInit,
    ];
    expect(url).toContain(encodeURIComponent(modelUrn));
    expect((options.headers as Record<string, string>).Authorization).toBe(`Bearer ${readToken}`);
  });

  it("returns not proven when TrainingData does not reference the expected dataset URN", async () => {
    const body = JSON.stringify({
      value: {
        trainingData: [
          {
            dataset: "urn:li:dataset:(urn:li:dataPlatform:postgres,other.unrelated.dataset,PROD)",
          },
        ],
      },
    });
    const fetchImpl = mockFetchResponse(body);

    const result = await readTrainingDataAspect({
      gmsBaseUrl,
      readToken,
      modelUrn,
      expectedDatasetUrn,
      fetchImpl,
    });

    expect(result.proven).toBe(false);
  });

  it("throws TRAINING_DATA_READ_FAILED on HTTP 404", async () => {
    const fetchImpl = mockFetchResponse("Not Found", 404);

    await expect(
      readTrainingDataAspect({
        gmsBaseUrl,
        readToken,
        modelUrn,
        expectedDatasetUrn,
        fetchImpl,
      }),
    ).rejects.toMatchObject({ code: "TRAINING_DATA_READ_FAILED" });
  });

  it("throws TRAINING_DATA_READ_FAILED on HTTP 500", async () => {
    const fetchImpl = mockFetchResponse("Internal Server Error", 500);

    await expect(
      readTrainingDataAspect({
        gmsBaseUrl,
        readToken,
        modelUrn,
        expectedDatasetUrn,
        fetchImpl,
      }),
    ).rejects.toMatchObject({ code: "TRAINING_DATA_READ_FAILED" });
  });

  it("throws TRAINING_DATA_READ_FAILED on timeout (AbortError)", async () => {
    const fetchImpl = vi.fn(
      async (_url: string, init?: RequestInit) =>
        new Promise<Response>((_resolve, reject) => {
          const signal = init?.signal;
          if (signal) {
            signal.addEventListener("abort", () => {
              reject(new DOMException("The operation was aborted.", "AbortError"));
            });
          }
          // Never resolves — relies on abort signal
        }),
    ) as unknown as typeof fetch;

    await expect(
      readTrainingDataAspect({
        gmsBaseUrl,
        readToken,
        modelUrn,
        expectedDatasetUrn,
        fetchImpl,
        timeoutMs: 10,
      }),
    ).rejects.toMatchObject({ code: "TRAINING_DATA_READ_FAILED" });
  });

  it("throws TRAINING_DATA_RESPONSE_TOO_LARGE when content-length exceeds limit", async () => {
    const largeBody = "x".repeat(300_000);
    const fetchImpl = vi.fn(async () => ({
      ok: true,
      status: 200,
      headers: new Headers({ "content-length": String(largeBody.length) }),
      text: async () => largeBody,
    })) as unknown as typeof fetch;

    await expect(
      readTrainingDataAspect({
        gmsBaseUrl,
        readToken,
        modelUrn,
        expectedDatasetUrn,
        fetchImpl,
        maxResponseBytes: 256 * 1024,
      }),
    ).rejects.toMatchObject({ code: "TRAINING_DATA_RESPONSE_TOO_LARGE" });
  });

  it("throws TRAINING_DATA_READ_FAILED on malformed JSON response", async () => {
    const fetchImpl = mockFetchResponse("not valid json {{{");

    await expect(
      readTrainingDataAspect({
        gmsBaseUrl,
        readToken,
        modelUrn,
        expectedDatasetUrn,
        fetchImpl,
      }),
    ).rejects.toMatchObject({ code: "TRAINING_DATA_READ_FAILED" });
  });

  it("throws TRAINING_DATA_READ_FAILED on schema validation failure", async () => {
    const body = JSON.stringify({ unexpected: "shape" });
    const fetchImpl = mockFetchResponse(body);

    await expect(
      readTrainingDataAspect({
        gmsBaseUrl,
        readToken,
        modelUrn,
        expectedDatasetUrn,
        fetchImpl,
      }),
    ).rejects.toMatchObject({ code: "TRAINING_DATA_READ_FAILED" });
  });

  it("validates GMS base URL rejects remote HTTP", async () => {
    const fetchImpl = mockFetchResponse(validTrainingDataResponse());

    await expect(
      readTrainingDataAspect({
        gmsBaseUrl: "http://datahub.example.com",
        readToken,
        modelUrn,
        expectedDatasetUrn,
        fetchImpl,
      }),
    ).rejects.toMatchObject({ code: "CONFIGURATION" });
  });

  it("accepts HTTPS remote GMS URL", async () => {
    const body = validTrainingDataResponse();
    const fetchImpl = mockFetchResponse(body);

    const result = await readTrainingDataAspect({
      gmsBaseUrl: "https://datahub.example.com",
      readToken,
      modelUrn,
      expectedDatasetUrn,
      fetchImpl,
    });

    expect(result.proven).toBe(true);
  });

  it("throws TRAINING_DATA_READ_FAILED on network error", async () => {
    const fetchImpl = vi.fn(async () => {
      throw new TypeError("fetch failed");
    }) as unknown as typeof fetch;

    await expect(
      readTrainingDataAspect({
        gmsBaseUrl,
        readToken,
        modelUrn,
        expectedDatasetUrn,
        fetchImpl,
      }),
    ).rejects.toMatchObject({ code: "TRAINING_DATA_READ_FAILED" });
  });
});
