#!/usr/bin/env node

import { createHash } from "node:crypto";
import { lstat, readFile, readdir } from "node:fs/promises";
import { resolve } from "node:path";

const EXPECTED_REF = "f22f93074cf265ba6f9401947404f090c2584d9d";
const EXPECTED_ROOTS = [
  ".agents/skills/datahub-enrich",
  ".agents/skills/datahub-lineage",
  ".agents/skills/datahub-quality",
  ".agents/skills/datahub-search",
  ".agents/skills/datahub-setup",
  ".agents/skills/load-standards",
  ".agents/skills/shared-references",
  ".agents/skills/using-datahub",
];
const EXPECTED_LOCAL_PATCH = ".agents/skills/datahub-setup/SKILL.md";
const GIT_COMMIT_PATTERN = /^[a-f0-9]{40}$/;
const SHA256_PATTERN = /^[a-f0-9]{64}$/;

function parseRoot(argv) {
  const rootIndex = argv.indexOf("--root");
  if (rootIndex === -1) return process.cwd();
  const root = argv[rootIndex + 1];
  if (!root) throw new Error("--root requires a path");
  return resolve(root);
}

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function sameStringArray(actual, expected) {
  return actual.length === expected.length && actual.every((value, index) => value === expected[index]);
}

function validateLock(lock) {
  assert(lock && typeof lock === "object" && !Array.isArray(lock), "lock must be an object");
  assert(lock.version === 2, "lock version must be 2");
  assert(lock.source?.repository === "datahub-project/datahub-skills", "unexpected source repository");
  assert(lock.source?.sourceType === "github", "unexpected source type");
  assert(
    typeof lock.source?.ref === "string" && GIT_COMMIT_PATTERN.test(lock.source.ref),
    "immutable 40-hex source ref required",
  );
  assert(lock.source.ref === EXPECTED_REF, `source ref must be ${EXPECTED_REF}`);
  assert(lock.source?.license === "Apache-2.0", "source license must be Apache-2.0");
  assert(Array.isArray(lock.vendoredRoots), "vendoredRoots must be an array");
  assert(sameStringArray(lock.vendoredRoots, EXPECTED_ROOTS), "vendoredRoots must match the exact approved roots");
  assert(lock.files && typeof lock.files === "object" && !Array.isArray(lock.files), "files must be an object");
  assert(
    lock.localPatches && typeof lock.localPatches === "object" && !Array.isArray(lock.localPatches),
    "localPatches must be an object",
  );
}

function isInsideVendoredRoots(relativePath) {
  return EXPECTED_ROOTS.some((root) => relativePath.startsWith(`${root}/`));
}

function validateLockedPaths(files) {
  for (const [relativePath, expectedHash] of Object.entries(files)) {
    assert(
      relativePath.length > 0 &&
        !relativePath.startsWith("/") &&
        !relativePath.includes("\\") &&
        !relativePath.split("/").includes("..") &&
        isInsideVendoredRoots(relativePath),
      `invalid locked path: ${relativePath}`,
    );
    assert(SHA256_PATTERN.test(expectedHash), `invalid SHA-256 for ${relativePath}`);
  }
}

async function walkFiles(root, relativeDirectory) {
  const absoluteDirectory = resolve(root, ...relativeDirectory.split("/"));
  const entries = await readdir(absoluteDirectory, { withFileTypes: true });
  const files = [];
  for (const entry of entries.sort((left, right) => left.name.localeCompare(right.name))) {
    const relativePath = `${relativeDirectory}/${entry.name}`;
    if (entry.isSymbolicLink()) throw new Error(`vendored symlink is not allowed: ${relativePath}`);
    if (entry.isDirectory()) {
      files.push(...(await walkFiles(root, relativePath)));
      continue;
    }
    if (!entry.isFile()) throw new Error(`vendored path is not a regular file: ${relativePath}`);
    files.push(relativePath);
  }
  return files;
}

async function hashFile(root, relativePath) {
  const absolutePath = resolve(root, ...relativePath.split("/"));
  const metadata = await lstat(absolutePath);
  assert(metadata.isFile() && !metadata.isSymbolicLink(), `vendored path is not a regular file: ${relativePath}`);
  return createHash("sha256").update(await readFile(absolutePath)).digest("hex");
}

async function verifySnapshot(root, lock) {
  validateLock(lock);
  validateLockedPaths(lock.files);

  const actualFiles = [];
  for (const vendoredRoot of EXPECTED_ROOTS) actualFiles.push(...(await walkFiles(root, vendoredRoot)));
  actualFiles.sort();
  const lockedFiles = Object.keys(lock.files).sort();

  for (const relativePath of lockedFiles) {
    assert(actualFiles.includes(relativePath), `missing locked file: ${relativePath}`);
  }
  for (const relativePath of actualFiles) {
    assert(lockedFiles.includes(relativePath), `unexpected vendored file: ${relativePath}`);
  }

  for (const relativePath of lockedFiles) {
    const actualHash = await hashFile(root, relativePath);
    assert(actualHash === lock.files[relativePath], `hash mismatch: ${relativePath}`);
  }

  const patchPaths = Object.keys(lock.localPatches);
  assert(
    sameStringArray(patchPaths, [EXPECTED_LOCAL_PATCH]),
    `local patch metadata must cover exactly ${EXPECTED_LOCAL_PATCH}`,
  );
  const patch = lock.localPatches[EXPECTED_LOCAL_PATCH];
  assert(typeof patch.description === "string" && patch.description.trim().length > 0, "local patch description required");
  assert(SHA256_PATTERN.test(patch.upstreamSha256), "local patch upstream SHA-256 invalid");
  assert(SHA256_PATTERN.test(patch.vendoredSha256), "local patch vendored SHA-256 invalid");
  assert(
    patch.vendoredSha256 === lock.files[EXPECTED_LOCAL_PATCH] &&
      patch.upstreamSha256 !== patch.vendoredSha256,
    "local patch metadata mismatch",
  );

  return { fileCount: actualFiles.length, ref: lock.source.ref };
}

async function main() {
  const root = parseRoot(process.argv.slice(2));
  const lock = JSON.parse(await readFile(resolve(root, "skills-lock.json"), "utf8"));
  const result = await verifySnapshot(root, lock);
  process.stdout.write(`agent skills snapshot: verified (${result.fileCount} files at ${result.ref})\n`);
}

main().catch((error) => {
  process.stderr.write(`agent skills snapshot: ${error.message}\n`);
  process.exitCode = 1;
});
