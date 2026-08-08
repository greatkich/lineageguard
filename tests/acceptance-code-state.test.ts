import { describe, expect, it } from "vitest";
import {
  AcceptanceCodeStateError,
  type AcceptanceGitExecutor,
  assertAcceptanceCodeState,
  readAcceptanceCodeState,
  withAcceptanceCodeState,
} from "../scripts/acceptance-code-state.js";
import { exportEvidenceWithCodeState } from "../scripts/export-evidence.js";

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

  it("filters only validated evidence roots with literal git pathspec arguments", async () => {
    const calls: readonly string[][] = [];
    const mutableCalls = calls as string[][];
    const execute: AcceptanceGitExecutor = async (_executable, args) => {
      mutableCalls.push([...args]);
      return args[0] === "rev-parse" ? `${acceptedSha}\n` : "";
    };

    await readAcceptanceCodeState(execute, ["examples/canonical-run", "artifacts/demo-readiness"]);

    expect(calls).toEqual([
      ["rev-parse", "HEAD"],
      [
        "status",
        "--porcelain",
        "--",
        ".",
        ":(exclude)examples/canonical-run",
        ":(exclude)artifacts/demo-readiness",
      ],
    ]);
  });

  it("rejects an unapproved path before constructing a git pathspec", async () => {
    await expect(
      readAcceptanceCodeState(gitExecutor(acceptedSha), ["artifacts/demo-runs/run-from-input"]),
    ).rejects.toThrowError(/not an approved evidence root/);
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

describe("withAcceptanceCodeState", () => {
  it.each([
    ["dirty", async () => ({ applicationCodeSha: acceptedSha, porcelain: " M changed.ts\n" })],
    ["different", async () => ({ applicationCodeSha: changedSha, porcelain: "" })],
    ["unavailable", async () => Promise.reject(new Error("git unavailable"))],
  ] as const)("rejects a %s starting checkout before the action", async (_case, readState) => {
    let acted = false;
    await expect(
      withAcceptanceCodeState({
        expectedApplicationCodeSha: acceptedSha,
        readState,
        action: async () => {
          acted = true;
          return "not reached";
        },
      }),
    ).rejects.toThrow();
    expect(acted).toBe(false);
  });

  it("rejects a code change after the guarded action and before command success", async () => {
    const states = [
      { applicationCodeSha: acceptedSha, porcelain: "" },
      { applicationCodeSha: changedSha, porcelain: "" },
    ];
    let acted = false;

    await expect(
      withAcceptanceCodeState({
        expectedApplicationCodeSha: acceptedSha,
        readState: async () => states.shift() as (typeof states)[number],
        action: async () => {
          acted = true;
          return "work finished";
        },
      }),
    ).rejects.toMatchObject({ code: "CODE_SHA_CHANGED" });
    expect(acted).toBe(true);
  });

  it("returns action output only after the terminal clean matching check", async () => {
    let reads = 0;
    await expect(
      withAcceptanceCodeState({
        expectedApplicationCodeSha: acceptedSha,
        readState: async () => {
          reads += 1;
          return { applicationCodeSha: acceptedSha, porcelain: "" };
        },
        action: async () => "verified",
      }),
    ).resolves.toEqual({
      accepted: { applicationCodeSha: acceptedSha, porcelain: "" },
      value: "verified",
    });
    expect(reads).toBe(2);
  });

  it("requires a fully clean start but permits configured evidence dirt after the action", async () => {
    const requestedAllowances: readonly (readonly string[])[] = [];
    const mutableAllowances = requestedAllowances as (readonly string[])[];

    await expect(
      withAcceptanceCodeState({
        allowedDirtyPathsAfterAction: ["artifacts/demo-readiness"],
        readState: async (allowedDirtyPaths = []) => {
          mutableAllowances.push(allowedDirtyPaths);
          return { applicationCodeSha: acceptedSha, porcelain: "" };
        },
        action: async () => "captured",
      }),
    ).resolves.toMatchObject({ value: "captured" });
    expect(requestedAllowances).toEqual([[], ["artifacts/demo-readiness"]]);
  });

  it("still rejects unrelated dirt when evidence roots are allowed", async () => {
    const states = [
      { applicationCodeSha: acceptedSha, porcelain: "" },
      { applicationCodeSha: acceptedSha, porcelain: " M scripts/runtime.ts\n" },
    ];

    await expect(
      withAcceptanceCodeState({
        allowedDirtyPathsAfterAction: ["artifacts/demo-readiness"],
        readState: async () => states.shift() as (typeof states)[number],
        action: async () => "captured",
      }),
    ).rejects.toMatchObject({ code: "DIRTY_WORKTREE" });
  });
});

describe("exportEvidenceWithCodeState", () => {
  it("fails the export when code changes after evidence writing", async () => {
    const states = [
      { applicationCodeSha: acceptedSha, porcelain: "" },
      { applicationCodeSha: changedSha, porcelain: "" },
    ];
    let wrote = false;

    await expect(
      exportEvidenceWithCodeState({
        applicationCodeSha: acceptedSha,
        readState: async () => states.shift() as (typeof states)[number],
        writeEvidence: async () => {
          wrote = true;
          return "evidence paths";
        },
      }),
    ).rejects.toMatchObject({ code: "CODE_SHA_CHANGED" });
    expect(wrote).toBe(true);
  });

  it("passes the observed equal SHA to evidence generation", async () => {
    let emittedSha = "";
    await expect(
      exportEvidenceWithCodeState({
        applicationCodeSha: acceptedSha,
        readState: async () => ({ applicationCodeSha: acceptedSha, porcelain: "" }),
        writeEvidence: async (applicationCodeSha) => {
          emittedSha = applicationCodeSha;
          return "evidence paths";
        },
      }),
    ).resolves.toBe("evidence paths");
    expect(emittedSha).toBe(acceptedSha);
  });

  it("tolerates golden evidence dirt at both nested export checkpoints", async () => {
    const requestedAllowances: readonly (readonly string[])[] = [];
    const mutableAllowances = requestedAllowances as (readonly string[])[];

    await expect(
      exportEvidenceWithCodeState({
        applicationCodeSha: acceptedSha,
        readState: async (allowedDirtyPaths = []) => {
          mutableAllowances.push(allowedDirtyPaths);
          return { applicationCodeSha: acceptedSha, porcelain: "" };
        },
        writeEvidence: async () => "evidence paths",
      }),
    ).resolves.toBe("evidence paths");
    expect(requestedAllowances).toEqual([
      ["examples/canonical-run", "artifacts/demo-readiness", "artifacts/demo-runs"],
      ["examples/canonical-run", "artifacts/demo-readiness", "artifacts/demo-runs"],
    ]);
  });
});
