import { GitHubEffectError } from "./errors.js";
import type { GitHubHttpRequest, GitHubHttpResponse, GitHubHttpTransport } from "./types.js";

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
      let body: unknown = null;
      const text = await response.text();
      if (text) {
        try {
          body = JSON.parse(text);
        } catch {
          body = null;
        }
      }
      return { status: response.status, headers: Object.fromEntries(response.headers), body };
    } catch (error) {
      if (error instanceof GitHubEffectError) throw error;
      throw new GitHubEffectError({
        code: input.method === "POST" ? "TRANSPORT_AMBIGUOUS" : "TRANSPORT_RETRYABLE",
        operation: input.method === "POST" ? "RECONCILE" : "VERIFY_REPOSITORY",
        retry: input.method === "POST" ? "RECONCILE" : "RETRY",
        message:
          error instanceof DOMException && error.name === "TimeoutError"
            ? "GitHub request timed out"
            : "GitHub transport failed",
      });
    }
  }
}
