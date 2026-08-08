import { describe, expect, it } from "vitest";
import { buildCanonicalSourceEnvelope, type SourceAllowlistInput } from "./source-allowlist.js";
import {
  assertNoSourceDrift,
  createSourceChangeEnvelope,
  type SourceChangeEnvelope,
  sourceChangeEnvelopeSchema,
} from "./source-envelope.js";

const canonicalPatch = [
  "@@ -0,0 +1,3 @@",
  "+-- rename the customer identifier",
  "+ALTER TABLE commerce.orders RENAME COLUMN customer_id TO buyer_id;",
  "+",
].join("\n");

function input(overrides: Partial<SourceAllowlistInput> = {}): SourceAllowlistInput {
  return {
    repository: "greatkich/lineageguard",
    expectedRepository: "greatkich/lineageguard",
    prNumber: 3,
    prUrl: "https://github.com/greatkich/lineageguard/pull/3",
    prState: "open",
    baseSha: "a".repeat(40),
    headSha: "b".repeat(40),
    files: [{ path: "walkthrough/migrations/001_rename.sql", patch: canonicalPatch }],
    ...overrides,
  };
}

describe("canonical source allowlist", () => {
  it("accepts the canonical PR and binds raw bytes separately from semantics", () => {
    const envelope = buildCanonicalSourceEnvelope(input());

    expect(envelope.origin).toBe("GITHUB_PR");
    expect(envelope.prNumber).toBe(3);
    expect(envelope.selectedPath).toBe("walkthrough/migrations/001_rename.sql");
    expect(envelope.normalizedChange).toEqual({
      schema: "commerce",
      table: "orders",
      operation: "RENAME_COLUMN",
      fromColumn: "customer_id",
      toColumn: "buyer_id",
    });
    expect(envelope.files[0]?.patchSha256).toMatch(/^[a-f0-9]{64}$/);
    expect(envelope.sourceFingerprint).toMatch(/^[a-f0-9]{64}$/);
    expect(sourceChangeEnvelopeSchema.safeParse(envelope).success).toBe(true);
  });

  it("produces a stable fingerprint for identical input and a different one for new bytes", () => {
    const first = buildCanonicalSourceEnvelope(input());
    const second = buildCanonicalSourceEnvelope(input());
    expect(second.sourceFingerprint).toBe(first.sourceFingerprint);

    const moved = buildCanonicalSourceEnvelope(input({ headSha: "c".repeat(40) }));
    expect(moved.sourceFingerprint).not.toBe(first.sourceFingerprint);
  });

  it("tolerates inert documentation alongside the migration", () => {
    const envelope = buildCanonicalSourceEnvelope(
      input({
        files: [
          { path: "walkthrough/migrations/001_rename.sql", patch: canonicalPatch },
          { path: "docs/notes.md", patch: "@@ -0,0 +1 @@\n+notes" },
        ],
      }),
    );

    expect(envelope.files.map((file) => file.path)).toEqual([
      "docs/notes.md",
      "walkthrough/migrations/001_rename.sql",
    ]);
    expect(envelope.selectedPath).toBe("walkthrough/migrations/001_rename.sql");
  });

  it.each([
    ["REPOSITORY_MISMATCH", input({ repository: "someone-else/fork" })],
    ["PR_NOT_OPEN", input({ prState: "closed" })],
    ["PR_NOT_OPEN", input({ prState: "merged" })],
    [
      "UNRELATED_CHANGES",
      input({
        files: [
          { path: "walkthrough/migrations/001_rename.sql", patch: canonicalPatch },
          { path: "scripts/deploy.sh", patch: "@@ -0,0 +1 @@\n+rm -rf /" },
        ],
      }),
    ],
    [
      "UNRELATED_CHANGES",
      input({ files: [{ path: "migrations/001_rename.sql", patch: canonicalPatch }] }),
    ],
    ["NO_SUPPORTED_CHANGE", input({ files: [{ path: "docs/readme.md", patch: "+text" }] })],
    [
      "AMBIGUOUS_CHANGE",
      input({
        files: [
          { path: "walkthrough/migrations/001_rename.sql", patch: canonicalPatch },
          { path: "walkthrough/migrations/002_rename.sql", patch: canonicalPatch },
        ],
      }),
    ],
    [
      "AMBIGUOUS_CHANGE",
      input({
        files: [
          {
            path: "walkthrough/migrations/001_rename.sql",
            patch: `${canonicalPatch}\n+ALTER TABLE commerce.orders RENAME COLUMN customer_id TO buyer_id;`,
          },
        ],
      }),
    ],
    [
      "AMBIGUOUS_CHANGE",
      input({
        files: [
          {
            path: "walkthrough/migrations/001_rename.sql",
            patch: `${canonicalPatch}\n+ALTER TABLE commerce.orders RENAME COLUMN order_total TO total;`,
          },
        ],
      }),
    ],
    [
      "UNSUPPORTED_RENAME",
      input({
        files: [
          {
            path: "walkthrough/migrations/001_rename.sql",
            patch:
              "@@ -0,0 +1 @@\n+ALTER TABLE commerce.orders RENAME COLUMN order_total TO total;",
          },
        ],
      }),
    ],
    [
      "MALFORMED_PATCH",
      input({ files: [{ path: "walkthrough/migrations/001_rename.sql", patch: "   " }] }),
    ],
    [
      "NO_SUPPORTED_CHANGE",
      input({
        files: [
          {
            path: "walkthrough/migrations/001_rename.sql",
            patch:
              "@@ -1 +1 @@\n-ALTER TABLE commerce.orders RENAME COLUMN customer_id TO buyer_id;",
          },
        ],
      }),
    ],
  ])("rejects with %s", (code, rejected) => {
    expect(() => buildCanonicalSourceEnvelope(rejected)).toThrowError(
      expect.objectContaining({ code }),
    );
  });

  it("never leaks the raw patch text into the rejection message", () => {
    const secretish = "@@ -0,0 +1 @@\n+GITHUB_TOKEN=ghp_should_not_appear";
    let thrown: unknown;
    try {
      buildCanonicalSourceEnvelope(
        input({ files: [{ path: "walkthrough/migrations/001_rename.sql", patch: secretish }] }),
      );
    } catch (error) {
      thrown = error;
    }
    expect(JSON.stringify({ message: (thrown as Error).message })).not.toContain("ghp_");
  });
});

describe("source drift", () => {
  const analysed = buildCanonicalSourceEnvelope(input());

  function rebuilt(overrides: Partial<SourceAllowlistInput>): SourceChangeEnvelope {
    return buildCanonicalSourceEnvelope(input(overrides));
  }

  it("passes when the source is unchanged", () => {
    expect(() => assertNoSourceDrift("BEFORE_VALIDATION", analysed, rebuilt({}))).not.toThrow();
  });

  it.each([
    ["headSha", rebuilt({ headSha: "c".repeat(40) })],
    ["baseSha", rebuilt({ baseSha: "d".repeat(40) })],
    [
      "selectedPath",
      rebuilt({ files: [{ path: "walkthrough/migrations/999_other.sql", patch: canonicalPatch }] }),
    ],
    [
      "patchSha256",
      rebuilt({
        files: [
          {
            path: "walkthrough/migrations/001_rename.sql",
            patch: `${canonicalPatch}\n+-- an extra trailing comment`,
          },
        ],
      }),
    ],
  ])("fails closed when %s moves", (field, observed) => {
    expect(() => assertNoSourceDrift("BEFORE_PUBLICATION", analysed, observed)).toThrowError(
      expect.objectContaining({ code: "SOURCE_DRIFT" }),
    );
    try {
      assertNoSourceDrift("BEFORE_PUBLICATION", analysed, observed);
    } catch (error) {
      expect((error as Error).message).toContain("SOURCE_DRIFT at BEFORE_PUBLICATION");
      expect((error as { checkpoint: string }).checkpoint).toBe("BEFORE_PUBLICATION");
      expect((error as { expected: string }).expected).toContain(field);
    }
  });

  it("names the checkpoint so validation and publication failures are distinguishable", () => {
    const moved = rebuilt({ headSha: "c".repeat(40) });
    for (const checkpoint of ["BEFORE_VALIDATION", "BEFORE_PUBLICATION"]) {
      try {
        assertNoSourceDrift(checkpoint, analysed, moved);
        throw new Error("expected drift");
      } catch (error) {
        expect((error as { checkpoint?: string }).checkpoint).toBe(checkpoint);
      }
    }
  });
});

describe("envelope schema integrity", () => {
  const envelope = buildCanonicalSourceEnvelope(input());

  it("rejects a forged fingerprint", () => {
    const forged = { ...envelope, sourceFingerprint: "f".repeat(64) };
    expect(sourceChangeEnvelopeSchema.safeParse(forged).success).toBe(false);
  });

  it("rejects a selectedPath that names no file", () => {
    const identity = { ...envelope, selectedPath: "walkthrough/migrations/absent.sql" };
    const { sourceFingerprint: _ignored, ...rest } = identity;
    expect(() => createSourceChangeEnvelope(rest)).toThrow();
  });

  it("rejects identical base and head SHAs", () => {
    const { sourceFingerprint: _ignored, ...rest } = envelope;
    expect(() => createSourceChangeEnvelope({ ...rest, headSha: rest.baseSha })).toThrow();
  });

  it("rejects a repository that is not owner/name", () => {
    const { sourceFingerprint: _ignored, ...rest } = envelope;
    expect(() => createSourceChangeEnvelope({ ...rest, repository: "no-slash" })).toThrow();
  });
});
