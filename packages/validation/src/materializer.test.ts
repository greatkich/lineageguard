import { execFile } from "node:child_process";
import {
  chmod,
  copyFile,
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  stat,
  symlink,
  unlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { promisify } from "node:util";
import { type MigrationCandidate, sha256 } from "@lineageguard/domain";
import { afterEach, describe, expect, it } from "vitest";
import { SpawnCommandRunner } from "./command-runner.js";
import {
  materializeCandidate,
  observeMaterializedArtifacts,
  requireMaterialization,
} from "./materializer.js";

const execute = promisify(execFile);
const temporaryRoots: string[] = [];

async function temporaryRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "lineageguard-validation-test-"));
  temporaryRoots.push(root);
  return root;
}

async function repository(options: { symlinkModel?: boolean } = {}) {
  const root = await temporaryRoot();
  const repositoryPath = join(root, "repository");
  const sandboxRoot = join(root, "sandboxes");
  await mkdir(join(repositoryPath, "walkthrough/models"), { recursive: true });
  await mkdir(sandboxRoot);
  if (options.symlinkModel) {
    await writeFile(join(repositoryPath, "outside.sql"), "select 1\n");
    await symlink("../../outside.sql", join(repositoryPath, "walkthrough/models/orders.sql"));
  } else {
    await writeFile(
      join(repositoryPath, "walkthrough/models/orders.sql"),
      "select order_id, customer_id from commerce.orders\n",
    );
  }
  await execute("git", ["init", "-q"], { cwd: repositoryPath });
  await execute("git", ["config", "user.name", "LineageGuard Tests"], { cwd: repositoryPath });
  await execute("git", ["config", "user.email", "tests@lineageguard.invalid"], {
    cwd: repositoryPath,
  });
  await execute("git", ["add", "."], { cwd: repositoryPath });
  await execute("git", ["commit", "-qm", "base"], { cwd: repositoryPath });
  const { stdout } = await execute("git", ["rev-parse", "HEAD"], { cwd: repositoryPath });
  return {
    root,
    repositoryPath,
    sandboxRoot,
    baseSha: stdout.trim(),
    sandboxId: "sandbox-materializer-test",
    worktreeId: "worktree-materializer-test",
  };
}

function candidate(baseSha: string): MigrationCandidate {
  const evidence = ["ev_aaaaaaaaaaaaaaaaaaaaaaaa"];
  return {
    strategy: "EXPAND_MIGRATE_CONTRACT",
    sourceChangeFingerprint: "a".repeat(64),
    sourcePatchFingerprint: "b".repeat(64),
    sourceImpactContextFingerprint: "c".repeat(64),
    sourceDecision: "BLOCK",
    sourceEvidenceIds: evidence,
    summary: "Backward compatible migration",
    steps: [
      {
        id: "step_expand",
        phase: "EXPAND",
        title: "Expand",
        rationale: "Add buyer identifier and rollback",
        affectedEvidenceIds: evidence,
        artifactTargets: [
          "walkthrough/migrations/add-buyer-id-rollback.sql",
          "walkthrough/migrations/add-buyer-id.sql",
        ],
      },
      {
        id: "step_migrate",
        phase: "MIGRATE",
        title: "Migrate",
        rationale: "Update model and equality test",
        affectedEvidenceIds: evidence,
        artifactTargets: ["walkthrough/models/orders.sql", "walkthrough/tests/orders_equality.sql"],
      },
      {
        id: "step_contract",
        phase: "CONTRACT",
        title: "Contract",
        rationale: "Document the removal gate",
        affectedEvidenceIds: evidence,
        artifactTargets: ["docs/migrations/customer-id.md"],
      },
    ],
    artifacts: (
      [
        {
          kind: "MIGRATION_DOCUMENT",
          operation: "CREATE",
          path: "docs/migrations/customer-id.md",
          content: "# Migration\n\nRemove only after owner approval.\n",
        },
        {
          kind: "DBT_MODEL",
          operation: "MODIFY",
          path: "walkthrough/models/orders.sql",
          expectedBaseSha: baseSha,
          content: "select order_id, customer_id, buyer_id from commerce.orders\n",
        },
        {
          kind: "DBT_TEST",
          operation: "CREATE",
          path: "walkthrough/tests/orders_equality.sql",
          content:
            "select * from {{ ref('orders') }} where customer_id is distinct from buyer_id\n",
        },
        {
          kind: "ROLLBACK_SQL",
          operation: "CREATE",
          path: "walkthrough/migrations/add-buyer-id-rollback.sql",
          content: "alter table commerce.orders drop column buyer_id;\n",
        },
        {
          kind: "SQL_MIGRATION",
          operation: "CREATE",
          path: "walkthrough/migrations/add-buyer-id.sql",
          content: "alter table commerce.orders add column buyer_id bigint;\n",
        },
      ] satisfies MigrationCandidate["artifacts"]
    ).sort((left, right) => left.path.localeCompare(right.path)),
    requiredReviewers: [
      {
        kind: "OWNER",
        ownerUrn: "urn:li:corpuser:finance",
        affectedAssetUrns: ["urn:li:dashboard:finance"],
        reason: "Affected asset owner",
      },
    ],
    compatibilityWindowDays: 30,
    rollbackPlan: "Run the rollback artifact before contract removal.",
  };
}

afterEach(async () => {
  const { rm } = await import("node:fs/promises");
  await Promise.all(
    temporaryRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  );
});

describe("isolated materialization", () => {
  it("clones the exact base, writes accepted artifacts, and cleans only its owned directory", async () => {
    const fixture = await repository();
    const sibling = join(fixture.sandboxRoot, "do-not-delete.txt");
    await writeFile(sibling, "sentinel");
    const value = candidate(fixture.baseSha);
    const materialized = await materializeCandidate(value, fixture);
    const internal = requireMaterialization(materialized);
    expect(
      await readFile(join(internal.checkoutPath, "walkthrough/models/orders.sql"), "utf8"),
    ).toContain("buyer_id");
    expect(
      await observeMaterializedArtifacts(
        materialized,
        value,
        value.artifacts.map((a) => a.path),
      ),
    ).toHaveLength(5);
    const owned = internal.ownedDirectory;
    await materialized.cleanup();
    await expect(stat(owned)).rejects.toMatchObject({ code: "ENOENT" });
    expect(await readFile(sibling, "utf8")).toBe("sentinel");
  });

  it.each([
    ["traversal", "../escape.sql"],
    ["absolute", "/tmp/escape.sql"],
  ])("rejects %s paths before checkout", async (_label, path) => {
    const fixture = await repository();
    const value = candidate(fixture.baseSha) as unknown as {
      artifacts: Array<Record<string, unknown>>;
    };
    if (!value.artifacts[0]) throw new Error("fixture missing artifact");
    value.artifacts[0].path = path;
    await expect(materializeCandidate(value, fixture)).rejects.toMatchObject({
      code: "INVALID_PATH",
    });
  });

  it("rejects duplicates, oversized content, and non-UTF-8 surrogate content", async () => {
    const fixture = await repository();
    const duplicate = structuredClone(candidate(fixture.baseSha));
    const first = duplicate.artifacts[0];
    const second = duplicate.artifacts[1];
    if (!first || !second) throw new Error("fixture missing artifacts");
    second.path = first.path as typeof second.path;
    await expect(materializeCandidate(duplicate, fixture)).rejects.toMatchObject({
      code: "DUPLICATE_TARGET",
    });
    const oversized = structuredClone(candidate(fixture.baseSha));
    if (!oversized.artifacts[0]) throw new Error("fixture missing artifact");
    oversized.artifacts[0].content = "x".repeat(100_001);
    await expect(materializeCandidate(oversized, fixture)).rejects.toMatchObject({
      code: "OVERSIZE",
    });
    const invalidUtf8 = structuredClone(candidate(fixture.baseSha));
    if (!invalidUtf8.artifacts[0]) throw new Error("fixture missing artifact");
    invalidUtf8.artifacts[0].content = "bad\uD800";
    await expect(materializeCandidate(invalidUtf8, fixture)).rejects.toMatchObject({
      code: "NON_UTF8",
    });
  });

  it("rejects the wrong base SHA and symlink targets", async () => {
    const fixture = await repository();
    await expect(materializeCandidate(candidate("1".repeat(40)), fixture)).rejects.toMatchObject({
      code: "WRONG_BASE_SHA",
    });
    const symlinkFixture = await repository({ symlinkModel: true });
    await expect(
      materializeCandidate(candidate(symlinkFixture.baseSha), symlinkFixture),
    ).rejects.toMatchObject({ code: "SYMLINK" });
  });

  it("treats command-looking artifact content only as bytes", async () => {
    const fixture = await repository();
    const value = candidate(fixture.baseSha);
    const document = value.artifacts.find((artifact) => artifact.kind === "MIGRATION_DOCUMENT");
    if (!document) throw new Error("fixture missing document");
    const marker = join(fixture.root, "injected");
    document.content = `$(touch ${marker})`;
    const materialized = await materializeCandidate(value, fixture);
    await expect(stat(marker)).rejects.toMatchObject({ code: "ENOENT" });
    await materialized.cleanup();
  });

  it("rejects structural synthetic checkout handles", async () => {
    const fixture = await repository();
    const value = candidate(fixture.baseSha);
    await expect(
      observeMaterializedArtifacts(
        { cleanup: async () => undefined } as never,
        value,
        value.artifacts.map((artifact) => artifact.path),
      ),
    ).rejects.toMatchObject({ code: "ARTIFACT_CONFLICT" });
  });

  it("rejects changed bytes and symlink replacement after materialization", async () => {
    const fixture = await repository();
    const value = candidate(fixture.baseSha);
    const handle = await materializeCandidate(value, fixture);
    const internal = requireMaterialization(handle);
    const artifact = value.artifacts.find((item) => item.kind === "SQL_MIGRATION");
    if (!artifact) throw new Error("fixture missing migration");
    const target = join(internal.checkoutPath, artifact.path);
    const sentinel = join(fixture.root, "external-sentinel.sql");
    await writeFile(sentinel, "select 1\n", { mode: 0o444 });
    await chmod(target, 0o600);
    await writeFile(target, `${artifact.content}\n-- changed`);
    await expect(
      observeMaterializedArtifacts(handle, value, [artifact.path]),
    ).rejects.toMatchObject({
      code: "ARTIFACT_CONFLICT",
    });
    await chmod(dirname(target), 0o700);
    await unlink(target);
    await symlink(sentinel, target);
    await expect(
      observeMaterializedArtifacts(handle, value, [artifact.path]),
    ).rejects.toMatchObject({
      code: "SYMLINK",
    });
    await handle.cleanup();
    expect((await stat(sentinel)).mode & 0o777).toBe(0o444);
  });
});

describe("fixed command runner", () => {
  it("pins executable and interpreter bytes across spawn", async () => {
    const root = await temporaryRoot();
    const executable = join(root, "validator-tool");
    await copyFile("/bin/sleep", executable);
    await chmod(executable, 0o500);
    const interpreterPath = await realpath("/bin/sh");
    const command = {
      executable,
      args: ["0.2"],
      cwd: root,
      timeoutMs: 1_000,
      maxOutputBytes: 1_000,
      executableDigest: sha256((await readFile(executable)).toString("base64")),
    };
    const running = new SpawnCommandRunner().run(command);
    await new Promise((resolve) => setTimeout(resolve, 50));
    await chmod(executable, 0o700);
    await copyFile("/usr/bin/true", executable);
    await expect(running).rejects.toMatchObject({ code: "MISSING_TOOL" });
    await writeFile(executable, "#!/bin/sh\nexit 0\n");
    await chmod(executable, 0o500);
    await expect(
      new SpawnCommandRunner().run({
        ...command,
        args: [],
        executableDigest: sha256((await readFile(executable)).toString("base64")),
        interpreter: { path: interpreterPath, digest: "0".repeat(64) },
      }),
    ).rejects.toMatchObject({ code: "MISSING_TOOL" });
  });

  it("fails closed on timeout and output limit without a shell", async () => {
    const root = await temporaryRoot();
    const runner = new SpawnCommandRunner();
    await expect(
      runner.run({
        executable: process.execPath,
        args: ["-e", "setTimeout(() => {}, 10000)"],
        cwd: root,
        timeoutMs: 20,
        maxOutputBytes: 100,
      }),
    ).rejects.toMatchObject({ code: "COMMAND_TIMEOUT" });
    await expect(
      runner.run({
        executable: process.execPath,
        args: ["-e", "process.stdout.write('x'.repeat(1000))"],
        cwd: root,
        timeoutMs: 1_000,
        maxOutputBytes: 10,
      }),
    ).rejects.toMatchObject({ code: "OUTPUT_LIMIT" });
  });

  it("kills descendants when a command times out", async () => {
    const root = await temporaryRoot();
    const pidPath = join(root, "child.pid");
    const runner = new SpawnCommandRunner();
    await expect(
      runner.run({
        executable: process.execPath,
        args: [
          "-e",
          `const {spawn}=require('node:child_process');const {writeFileSync}=require('node:fs');const child=spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{stdio:'ignore'});writeFileSync(${JSON.stringify(pidPath)},String(child.pid));setInterval(()=>{},1000);`,
        ],
        cwd: root,
        timeoutMs: 100,
        maxOutputBytes: 1_000,
      }),
    ).rejects.toMatchObject({ code: "COMMAND_TIMEOUT" });
    const childPid = Number(await readFile(pidPath, "utf8"));
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(() => process.kill(childPid, 0)).toThrow();
  });
});
