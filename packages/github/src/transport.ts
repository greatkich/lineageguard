import { GitHubEffectError } from "./errors.js";
import type { GitHubHttpRequest, GitHubHttpResponse, GitHubHttpTransport } from "./types.js";

const MAX_RESPONSE_BYTES = 1_000_000;

function malformed(input: GitHubHttpRequest, message: string): GitHubEffectError {
  return new GitHubEffectError({
    code: "REMOTE_FAILURE",
    operation: input.operation,
    retry: "NEVER",
    message,
  });
}

async function readBoundedJson(response: Response, input: GitHubHttpRequest): Promise<unknown> {
  const declared = response.headers.get("content-length");
  if (declared !== null) {
    if (!/^[0-9]+$/.test(declared) || Number(declared) > MAX_RESPONSE_BYTES)
      throw malformed(input, "GitHub response exceeded the allowed size");
  }
  if (!response.body) return null;
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const result = await reader.read();
    if (result.done) break;
    size += result.value.byteLength;
    if (size > MAX_RESPONSE_BYTES) {
      await reader.cancel();
      throw malformed(input, "GitHub response exceeded the allowed size");
    }
    chunks.push(result.value);
  }
  if (size === 0) return null;
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  let value: unknown;
  try {
    value = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
  } catch {
    throw malformed(input, "GitHub response body is malformed JSON");
  }
  return value;
}

export class FetchGitHubTransport implements GitHubHttpTransport {
  async request(input: GitHubHttpRequest): Promise<GitHubHttpResponse> {
    try {
      const response = await fetch(input.url, {
        method: input.method,
        headers: input.headers,
        ...(input.body === undefined ? {} : { body: JSON.stringify(input.body) }),
        redirect: "manual",
        signal: AbortSignal.timeout(input.timeoutMs),
      });
      const body = await readBoundedJson(response, input);
      return { status: response.status, headers: Object.fromEntries(response.headers), body };
    } catch (error) {
      if (error instanceof GitHubEffectError) throw error;
      throw new GitHubEffectError({
        code: input.method === "POST" ? "TRANSPORT_AMBIGUOUS" : "TRANSPORT_RETRYABLE",
        operation: input.operation,
        retry: input.method === "POST" ? "RECONCILE" : "RETRY",
        message:
          error instanceof DOMException && error.name === "TimeoutError"
            ? "GitHub request timed out"
            : "GitHub transport failed",
      });
    }
  }
}
