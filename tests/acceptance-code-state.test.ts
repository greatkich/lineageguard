import { describe, expect, it } from "vitest";
import {
  AcceptanceCodeStateError,
  assertAcceptanceCodeState,
  readAcceptanceCodeState,
  type AcceptanceGitExecutor,
} from "../scripts/acceptance-code-state.js";

const acceptedSha = "0123456789abcdef0123456789abcdef01234567";
const changedSha = "89abcdef0123456789abcdef0123456789abcdef";

function gitExecutor(head: string, porcelain = ""): AcceptanceGitExecutor {
  return async (executable, args) => {
    expect(executable).toBe("git");
    if (args[0] === "rev-parse") return `${head}\n`;
    if (args[0] === "status") return porcelain;
    throw new Error(`unexpected git command: ${args.join(" ")}`);
  };
}

describe("readAcceptanceCodeState", () => {
  it("accepts a clean 40-hex HEAD", async () => {
    await expect(readAcceptanceCodeState(gitExecutor(acceptedSha))).resolves.toEqual({
      applicationCodeSha: acceptedSha,
      porcelain: "",
    });
  });

  it("rejects a non-empty porcelain status", async () => {
    await expect(
      readAcceptanceCodeState(gitExecutor(acceptedSha, " M scripts/demo-repeat.ts\n")),
    ).rejects.toMatchObject({
      name: "AcceptanceCodeStateError",
      code: "DIRTY_WORKTREE",
    });
  });

  it.each([
    ["unavailable", async () => Promise.reject(new Error("git unavailable"))],
    ["malformed", gitExecutor("not-a-sha")],
  ] as const)("rejects an %s HEAD", async (_case, execute) => {
    await expect(readAcceptanceCodeState(execute)).rejects.toBeInstanceOf(AcceptanceCodeStateError);
  });
});

describe("assertAcceptanceCodeState", () => {
  it("rejects a changed clean HEAD between acceptance checks", () => {
    expect(() =>
      assertAcceptanceCodeState(
        { applicationCodeSha: acceptedSha, porcelain: "" },
        { applicationCodeSha: changedSha, porcelain: "" },
      ),
    ).toThrowError(/changed/);
  });

  it("accepts a clean matching HEAD", () => {
    expect(() =>
      assertAcceptanceCodeState(
        { applicationCodeSha: acceptedSha, porcelain: "" },
        { applicationCodeSha: acceptedSha, porcelain: "" },
      ),
    ).not.toThrow();
  });
});
