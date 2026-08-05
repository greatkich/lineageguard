import { afterEach, describe, expect, it, vi } from "vitest";
import { FetchGitHubTransport } from "./transport.js";
import type { GitHubHttpRequest } from "./types.js";

const request: GitHubHttpRequest = {
  method: "GET",
  operation: "VERIFY_REPOSITORY",
  url: "https://api.github.com/repos/lineageguard/demo",
  headers: {},
  timeoutMs: 1_000,
  redirect: "error",
};

afterEach(() => vi.unstubAllGlobals());

describe("FetchGitHubTransport response bounds", () => {
  it("rejects an oversized declared body before reading JSON", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(
        async () => new Response("{}", { status: 200, headers: { "content-length": "1000001" } }),
      ),
    );
    await expect(new FetchGitHubTransport().request(request)).rejects.toMatchObject({
      code: "REMOTE_FAILURE",
      retry: "NEVER",
    });
  });

  it("enforces the streaming byte cap when content-length is absent", async () => {
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new Uint8Array(600_000));
        controller.enqueue(new Uint8Array(600_000));
        controller.close();
      },
    });
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response(stream, { status: 200 })),
    );
    await expect(new FetchGitHubTransport().request(request)).rejects.toMatchObject({
      code: "REMOTE_FAILURE",
      retry: "NEVER",
    });
  });

  it("rejects malformed JSON instead of returning an untrusted fallback", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response("{", { status: 200 })),
    );
    await expect(new FetchGitHubTransport().request(request)).rejects.toMatchObject({
      code: "REMOTE_FAILURE",
      retry: "NEVER",
    });
  });

  it("classifies an unreadable POST response as ambiguous", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response("{", { status: 201 })),
    );
    await expect(
      new FetchGitHubTransport().request({
        ...request,
        method: "POST",
        operation: "CREATE_BLOB",
      }),
    ).rejects.toMatchObject({
      code: "TRANSPORT_AMBIGUOUS",
      operation: "CREATE_BLOB",
      retry: "RECONCILE",
    });
  });

  it("classifies a POST transport failure against the exact operation without leaking details", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => Promise.reject(new Error("secret-token"))),
    );
    const failure = new FetchGitHubTransport().request({
      ...request,
      method: "POST",
      operation: "CREATE_PULL_REQUEST",
    });
    await expect(failure).rejects.toMatchObject({
      code: "TRANSPORT_AMBIGUOUS",
      operation: "CREATE_PULL_REQUEST",
      retry: "RECONCILE",
    });
    await expect(failure).rejects.not.toThrow("secret-token");
  });
});
