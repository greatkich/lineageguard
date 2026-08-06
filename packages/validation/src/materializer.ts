import { constants as filesystemConstants } from "node:fs";
import {
  chmod,
  lstat,
  mkdir,
  mkdtemp,
  open,
  readFile,
  realpath,
  rm,
  writeFile,
} from "node:fs/promises";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import {
  type MigrationArtifact,
  type MigrationCandidate,
  migrationArtifactFingerprint,
  migrationArtifactPathSchema,
  migrationCandidateFingerprint,
  migrationCandidateSchema,
  sha256,
} from "@lineageguard/domain";
import {
  type CommandRunner,
  type FixedCommand,
  runRequired,
  SpawnCommandRunner,
} from "./command-runner.js";
import { ValidationError } from "./errors.js";

const maximumArtifactBytes = 100_000;
const trustedGitExecutable = "/usr/bin/git";

interface OwnedPathIdentity {
  path: string;
  device: number;
  inode: number;
  realPath: string;
}

function inside(parent: string, child: string): boolean {
  const path = relative(parent, child);
  return path !== "" && path !== ".." && !path.startsWith(`..${sep}`) && !isAbsolute(path);
}

function strictUtf8Bytes(content: string, maximum: number): Buffer {
  const bytes = Buffer.from(content, "utf8");
  if (bytes.length > maximum) throw new ValidationError("OVERSIZE", "content exceeds byte limit");
  if (bytes.toString("utf8") !== content || /[\uD800-\uDFFF]/u.test(content)) {
    throw new ValidationError("NON_UTF8", "content is not strict UTF-8");
  }
  return bytes;
}

async function rejectSymlinkPath(checkout: string, artifactPath: string): Promise<string> {
  if (isAbsolute(artifactPath) || !migrationArtifactPathSchema.safeParse(artifactPath).success) {
    throw new ValidationError("INVALID_PATH", "artifact path is outside the domain allowlist");
  }
  const target = resolve(checkout, artifactPath);
  if (!inside(checkout, target)) {
    throw new ValidationError("INVALID_PATH", "artifact path escapes checkout");
  }
  let current = checkout;
  for (const segment of artifactPath.split("/")) {
    current = join(current, segment);
    try {
      const stat = await lstat(current);
      if (stat.isSymbolicLink()) throw new ValidationError("SYMLINK", "symlink target rejected");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") break;
      throw error;
    }
  }
  return target;
}

function gitCommand(
  cwd: string,
  args: readonly string[],
  executableDigest: string,
  stdin?: string,
): FixedCommand {
  return {
    executable: trustedGitExecutable,
    args,
    cwd,
    timeoutMs: 30_000,
    maxOutputBytes: 256_000,
    executableDigest,
    ...(stdin === undefined ? {} : { stdin }),
  };
}

const materializedHandleBrand: unique symbol = Symbol("materialized-candidate-handle");
export interface MaterializedCandidateHandle {
  readonly [materializedHandleBrand]: true;
  cleanup(): Promise<void>;
}

interface MaterializationRecord {
  checkoutPath: string;
  baseSha: string;
  sandboxId: string;
  worktreeId: string;
  candidateFingerprint: string;
  ownedDirectory: string;
  ownedDirectoryIdentity: OwnedPathIdentity;
  sandboxRoot: string;
  cleaned: boolean;
  lockedPaths: OwnedPathIdentity[];
}

const materializations = new WeakMap<object, MaterializationRecord>();

class RuntimeMaterializedCandidateHandle implements MaterializedCandidateHandle {
  readonly [materializedHandleBrand] = true as const;

  async cleanup(): Promise<void> {
    const record = materializations.get(this);
    if (!record) {
      throw new ValidationError("CLEANUP_FAILED", "materialization handle is not runtime-issued");
    }
    if (record.cleaned) return;
    if (
      !inside(record.sandboxRoot, record.ownedDirectory) ||
      basename(record.ownedDirectory).startsWith("lineageguard-") === false
    ) {
      throw new ValidationError("CLEANUP_FAILED", "refused cleanup outside owned sandbox");
    }
    await assertOwnedIdentity(record.ownedDirectoryIdentity, "owned sandbox");
    for (const identity of record.lockedPaths) await restoreOwnedMode(identity);
    await assertOwnedIdentity(record.ownedDirectoryIdentity, "owned sandbox");
    await rm(record.ownedDirectory, { recursive: true, force: true });
    record.cleaned = true;
  }
}

async function captureIdentity(path: string): Promise<OwnedPathIdentity> {
  const metadata = await lstat(path);
  if (metadata.isSymbolicLink()) {
    throw new ValidationError("SYMLINK", "owned path cannot be a symlink");
  }
  return {
    path,
    device: metadata.dev,
    inode: metadata.ino,
    realPath: await realpath(path),
  };
}

async function assertOwnedIdentity(identity: OwnedPathIdentity, label: string): Promise<void> {
  const metadata = await lstat(identity.path).catch(() => undefined);
  if (
    !metadata ||
    metadata.isSymbolicLink() ||
    metadata.dev !== identity.device ||
    metadata.ino !== identity.inode ||
    (await realpath(identity.path).catch(() => undefined)) !== identity.realPath
  ) {
    throw new ValidationError("CLEANUP_FAILED", `${label} identity changed`);
  }
}

async function restoreOwnedMode(identity: OwnedPathIdentity): Promise<void> {
  const metadata = await lstat(identity.path).catch(() => undefined);
  if (
    !metadata ||
    metadata.isSymbolicLink() ||
    metadata.dev !== identity.device ||
    metadata.ino !== identity.inode ||
    (await realpath(identity.path).catch(() => undefined)) !== identity.realPath
  ) {
    return;
  }
  await chmod(identity.path, metadata.isDirectory() ? 0o700 : 0o600);
}

/** @internal Runtime-only extraction; omitted from the package root export. */
export function requireMaterialization(handle: unknown): MaterializationRecord {
  if (!handle || typeof handle !== "object") {
    throw new ValidationError("ARTIFACT_CONFLICT", "materialization handle is not runtime-issued");
  }
  const record = materializations.get(handle);
  if (!record || record.cleaned) {
    throw new ValidationError("ARTIFACT_CONFLICT", "materialization handle is not runtime-issued");
  }
  return record;
}

/** @internal Re-reads exact bytes from the opaque checkout and rejects replacement or symlinks. */
export async function snapshotMaterializedArtifacts(
  handle: MaterializedCandidateHandle,
  candidate: MigrationCandidate,
  paths: readonly string[],
) {
  const record = requireMaterialization(handle);
  if (record.candidateFingerprint !== migrationCandidateFingerprint(candidate)) {
    throw new ValidationError("ARTIFACT_CONFLICT", "materialization candidate binding mismatch");
  }
  const files: Array<{
    path: string;
    bytes: Buffer;
    observation: {
      path: string;
      candidateArtifactFingerprint: string;
      materializedSha256: string;
    };
  }> = [];
  for (const path of [...paths].sort()) {
    const artifact = candidate.artifacts.find((item) => item.path === path);
    if (!artifact) throw new ValidationError("ARTIFACT_CONFLICT", "unknown artifact observation");
    const target = resolve(record.checkoutPath, artifact.path);
    const identity = record.lockedPaths.find((item) => item.path === target);
    const stat = await lstat(target).catch(() => undefined);
    if (
      !identity ||
      !stat?.isFile() ||
      stat.isSymbolicLink() ||
      stat.dev !== identity.device ||
      stat.ino !== identity.inode
    ) {
      throw new ValidationError("SYMLINK", "executed artifact is not a regular file");
    }
    const canonicalTarget = await realpath(target);
    if (!inside(record.checkoutPath, canonicalTarget)) {
      throw new ValidationError("INVALID_PATH", "executed artifact escaped opaque checkout");
    }
    const descriptor = await open(
      target,
      filesystemConstants.O_RDONLY | (filesystemConstants.O_NOFOLLOW ?? 0),
    );
    let bytes: Buffer;
    try {
      const before = await descriptor.stat();
      if (before.dev !== identity.device || before.ino !== identity.inode || !before.isFile()) {
        throw new ValidationError("ARTIFACT_CONFLICT", "executed artifact identity changed");
      }
      bytes = await descriptor.readFile();
      const after = await descriptor.stat();
      if (after.dev !== before.dev || after.ino !== before.ino || after.size !== before.size) {
        throw new ValidationError("ARTIFACT_CONFLICT", "executed artifact changed while reading");
      }
    } finally {
      await descriptor.close();
    }
    const expected = strictUtf8Bytes(artifact.content, maximumArtifactBytes);
    if (!bytes.equals(expected)) {
      throw new ValidationError("ARTIFACT_CONFLICT", "executed artifact bytes changed");
    }
    files.push({
      path: artifact.path,
      bytes,
      observation: {
        path: artifact.path,
        candidateArtifactFingerprint: migrationArtifactFingerprint(artifact),
        materializedSha256: sha256(bytes.toString("utf8")),
      },
    });
  }
  return files;
}

/** @internal Re-reads exact bytes from the opaque checkout and rejects replacement or symlinks. */
export async function observeMaterializedArtifacts(
  handle: MaterializedCandidateHandle,
  candidate: MigrationCandidate,
  paths: readonly string[],
) {
  return (await snapshotMaterializedArtifacts(handle, candidate, paths)).map(
    (file) => file.observation,
  );
}

export interface MaterializeOptions {
  repositoryPath: string;
  sandboxRoot: string;
  baseSha: string;
  sandboxId: string;
  worktreeId: string;
  runner?: CommandRunner;
}

async function verifyRoot(root: string): Promise<string> {
  const resolved = resolve(root);
  try {
    if ((await lstat(resolved)).isSymbolicLink()) {
      throw new ValidationError("INVALID_SANDBOX_ROOT", "sandbox root cannot be a symlink");
    }
  } catch (error) {
    if (error instanceof ValidationError) throw error;
    throw new ValidationError("INVALID_SANDBOX_ROOT", "sandbox root must already exist");
  }
  let canonical: string;
  try {
    canonical = await realpath(resolved);
  } catch {
    throw new ValidationError("INVALID_SANDBOX_ROOT", "sandbox root must already exist");
  }
  const stat = await lstat(canonical);
  if (!stat.isDirectory() || stat.isSymbolicLink()) {
    throw new ValidationError("INVALID_SANDBOX_ROOT", "sandbox root must be a real directory");
  }
  return canonical;
}

async function verifyTrustedGit(): Promise<string> {
  const metadata = await lstat(trustedGitExecutable).catch(() => undefined);
  if (
    !metadata?.isFile() ||
    metadata.isSymbolicLink() ||
    metadata.uid !== 0 ||
    (metadata.mode & 0o022) !== 0 ||
    (metadata.mode & 0o111) === 0
  ) {
    throw new ValidationError("MISSING_TOOL", "trusted system git is unavailable or mutable");
  }
  return sha256((await readFile(trustedGitExecutable)).toString("base64"));
}

async function verifyCheckoutSha(
  runner: CommandRunner,
  checkout: string,
  expected: string,
  gitDigest: string,
): Promise<void> {
  const result = await runRequired(runner, gitCommand(checkout, ["rev-parse", "HEAD"], gitDigest));
  if (result.stdout.trim() !== expected) {
    throw new ValidationError("WRONG_BASE_SHA", "checkout HEAD does not match expected base SHA");
  }
}

async function materializeArtifact(checkout: string, artifact: MigrationArtifact): Promise<string> {
  const target = await rejectSymlinkPath(checkout, artifact.path);
  const bytes = strictUtf8Bytes(artifact.content, maximumArtifactBytes);
  let existing: Awaited<ReturnType<typeof lstat>> | undefined;
  try {
    existing = await lstat(target);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  if (artifact.operation === "CREATE" && existing) {
    throw new ValidationError("ARTIFACT_CONFLICT", "CREATE target already exists");
  }
  if (artifact.operation === "MODIFY" && !existing?.isFile()) {
    throw new ValidationError(
      "ARTIFACT_CONFLICT",
      "MODIFY target must be an existing regular file",
    );
  }
  await mkdir(dirname(target), { recursive: true });
  await writeFile(target, bytes, {
    flag: artifact.operation === "CREATE" ? "wx" : "w",
    mode: 0o600,
  });
  return sha256((await readFile(target)).toString("utf8"));
}

function preflightCandidate(untrustedCandidate: unknown): void {
  if (!untrustedCandidate || typeof untrustedCandidate !== "object") return;
  const artifacts = Reflect.get(untrustedCandidate, "artifacts");
  if (!Array.isArray(artifacts)) return;
  const seen = new Set<string>();
  for (const value of artifacts) {
    if (!value || typeof value !== "object") continue;
    const path = Reflect.get(value, "path");
    if (typeof path === "string") {
      if (seen.has(path)) throw new ValidationError("DUPLICATE_TARGET", "duplicate artifact path");
      seen.add(path);
      if (
        isAbsolute(path) ||
        path.split("/").some((segment) => segment === ".." || segment === ".")
      ) {
        throw new ValidationError("INVALID_PATH", "absolute or traversing artifact path");
      }
    }
    const content = Reflect.get(value, "content");
    if (typeof content === "string") strictUtf8Bytes(content, maximumArtifactBytes);
  }
}

export async function materializeCandidate(
  untrustedCandidate: unknown,
  options: MaterializeOptions,
): Promise<MaterializedCandidateHandle> {
  if (
    !/^[A-Za-z0-9._-]{1,120}$/.test(options.sandboxId) ||
    !/^[A-Za-z0-9._/-]{1,200}$/.test(options.worktreeId)
  ) {
    throw new ValidationError("INVALID_SANDBOX_ROOT", "sandbox/worktree identity is invalid");
  }
  preflightCandidate(untrustedCandidate);
  const parsed = migrationCandidateSchema.safeParse(untrustedCandidate);
  if (!parsed.success) {
    const duplicate = parsed.error.issues.some((issue) => issue.message.includes("unique"));
    throw new ValidationError(
      duplicate ? "DUPLICATE_TARGET" : "INVALID_PATH",
      "candidate failed authoritative domain validation",
    );
  }
  const candidate: MigrationCandidate = parsed.data;
  if (
    candidate.artifacts.some(
      (artifact) => artifact.operation === "MODIFY" && artifact.expectedBaseSha !== options.baseSha,
    )
  ) {
    throw new ValidationError("WRONG_BASE_SHA", "modified artifact expects a different base SHA");
  }
  const sandboxRoot = await verifyRoot(options.sandboxRoot);
  const repositoryPath = await realpath(resolve(options.repositoryPath));
  const runner = options.runner ?? new SpawnCommandRunner();
  const gitDigest = await verifyTrustedGit();
  const ownedDirectory = await mkdtemp(join(sandboxRoot, "lineageguard-"));
  await chmod(ownedDirectory, 0o700);
  const ownedDirectoryIdentity = await captureIdentity(ownedDirectory);
  const checkout = join(ownedDirectory, "checkout");
  const cleanup = async () => {
    if (
      !inside(sandboxRoot, ownedDirectory) ||
      basename(ownedDirectory).startsWith("lineageguard-") === false
    ) {
      throw new ValidationError("CLEANUP_FAILED", "refused cleanup outside owned sandbox");
    }
    await assertOwnedIdentity(ownedDirectoryIdentity, "owned sandbox");
    await rm(ownedDirectory, { recursive: true, force: true });
  };
  try {
    await runRequired(
      runner,
      gitCommand(
        sandboxRoot,
        [
          "-c",
          "core.hooksPath=/dev/null",
          "-c",
          "filter.lfs.smudge=",
          "-c",
          "filter.lfs.required=false",
          "clone",
          "--no-hardlinks",
          "--no-local",
          "--no-checkout",
          "--",
          repositoryPath,
          checkout,
        ],
        gitDigest,
      ),
    );
    await runRequired(
      runner,
      gitCommand(
        checkout,
        [
          "-c",
          "core.hooksPath=/dev/null",
          "-c",
          "filter.lfs.smudge=",
          "-c",
          "filter.lfs.required=false",
          "checkout",
          "--detach",
          options.baseSha,
        ],
        gitDigest,
      ),
    );
    await verifyCheckoutSha(runner, checkout, options.baseSha, gitDigest);
    for (const artifact of candidate.artifacts) {
      await materializeArtifact(checkout, artifact);
    }
    for (const artifact of candidate.artifacts)
      await chmod(resolve(checkout, artifact.path), 0o400);
    const lockedDirectories = [
      ...new Set(candidate.artifacts.map((artifact) => dirname(artifact.path))),
    ];
    for (const directory of lockedDirectories) {
      await chmod(resolve(checkout, directory), 0o500);
    }
    const lockedPaths = await Promise.all([
      ...lockedDirectories.map((directory) => captureIdentity(resolve(checkout, directory))),
      ...candidate.artifacts.map((artifact) => captureIdentity(resolve(checkout, artifact.path))),
    ]);
    const handle = new RuntimeMaterializedCandidateHandle();
    materializations.set(handle, {
      checkoutPath: checkout,
      baseSha: options.baseSha,
      sandboxId: options.sandboxId,
      worktreeId: options.worktreeId,
      candidateFingerprint: migrationCandidateFingerprint(candidate),
      ownedDirectory,
      ownedDirectoryIdentity,
      sandboxRoot,
      cleaned: false,
      lockedPaths,
    });
    return Object.freeze(handle);
  } catch (error) {
    await cleanup();
    throw error;
  }
}
