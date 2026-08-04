import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { chmod, mkdtemp, mkdir, readFile, rm, unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import test from "node:test";

const repositoryRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
const verifierPath = join(repositoryRoot, "scripts/verify-agent-skills.mjs");
const bootstrapPath = join(repositoryRoot, "scripts/bootstrap-agent-tooling.sh");
const immutableRef = "f22f93074cf265ba6f9401947404f090c2584d9d";
const vendoredRoots = [
  ".agents/skills/datahub-enrich",
  ".agents/skills/datahub-lineage",
  ".agents/skills/datahub-quality",
  ".agents/skills/datahub-search",
  ".agents/skills/datahub-setup",
  ".agents/skills/load-standards",
  ".agents/skills/shared-references",
  ".agents/skills/using-datahub",
];

function sha256(content) {
  return createHash("sha256").update(content).digest("hex");
}

async function createSnapshot() {
  const root = await mkdtemp(join(tmpdir(), "lineageguard-agent-skills-"));
  const files = {};

  for (const vendoredRoot of vendoredRoots) {
    const relativePath =
      vendoredRoot === ".agents/skills/datahub-setup"
        ? `${vendoredRoot}/SKILL.md`
        : `${vendoredRoot}/fixture.txt`;
    const content =
      vendoredRoot === ".agents/skills/datahub-setup"
        ? "locally patched setup skill\n"
        : `${vendoredRoot}\n`;
    await mkdir(join(root, dirname(relativePath)), { recursive: true });
    await writeFile(join(root, relativePath), content);
    files[relativePath] = sha256(content);
  }

  const setupPath = ".agents/skills/datahub-setup/SKILL.md";
  const lock = {
    version: 2,
    source: {
      repository: "datahub-project/datahub-skills",
      sourceType: "github",
      ref: immutableRef,
      license: "Apache-2.0",
    },
    vendoredRoots,
    files,
    localPatches: {
      [setupPath]: {
        description: "Prevent credential disclosure and require verified TLS.",
        upstreamSha256: sha256("original upstream setup skill\n"),
        vendoredSha256: files[setupPath],
      },
    },
  };
  await writeFile(join(root, "skills-lock.json"), `${JSON.stringify(lock, null, 2)}\n`);
  return { root, lock };
}

async function writeLock(root, lock) {
  await writeFile(join(root, "skills-lock.json"), `${JSON.stringify(lock, null, 2)}\n`);
}

function runVerifier(root) {
  return spawnSync(process.execPath, [verifierPath, "--root", root], {
    cwd: repositoryRoot,
    encoding: "utf8",
  });
}

async function writeExecutable(path, content) {
  await writeFile(path, content);
  await chmod(path, 0o755);
}

test("accepts a complete immutable vendored snapshot", async () => {
  const snapshot = await createSnapshot();
  try {
    const result = runVerifier(snapshot.root);
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /agent skills snapshot: verified/);
  } finally {
    await rm(snapshot.root, { recursive: true, force: true });
  }
});

test("rejects a tampered vendored file", async () => {
  const snapshot = await createSnapshot();
  try {
    const target = ".agents/skills/datahub-search/fixture.txt";
    await writeFile(join(snapshot.root, target), "tampered\n");
    const result = runVerifier(snapshot.root);
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /hash mismatch/);
  } finally {
    await rm(snapshot.root, { recursive: true, force: true });
  }
});

test("rejects a missing locked file", async () => {
  const snapshot = await createSnapshot();
  try {
    const target = ".agents/skills/datahub-quality/fixture.txt";
    await unlink(join(snapshot.root, target));
    const result = runVerifier(snapshot.root);
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /missing locked file/);
  } finally {
    await rm(snapshot.root, { recursive: true, force: true });
  }
});

test("rejects an extra vendored file", async () => {
  const snapshot = await createSnapshot();
  try {
    const target = ".agents/skills/datahub-enrich/extra.txt";
    await writeFile(join(snapshot.root, target), "extra\n");
    const result = runVerifier(snapshot.root);
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /unexpected vendored file/);
  } finally {
    await rm(snapshot.root, { recursive: true, force: true });
  }
});

test("rejects a non-immutable upstream ref", async () => {
  const snapshot = await createSnapshot();
  try {
    snapshot.lock.source.ref = "main";
    await writeLock(snapshot.root, snapshot.lock);
    const result = runVerifier(snapshot.root);
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /immutable 40-hex source ref/);
  } finally {
    await rm(snapshot.root, { recursive: true, force: true });
  }
});

test("rejects a missing upstream ref", async () => {
  const snapshot = await createSnapshot();
  try {
    delete snapshot.lock.source.ref;
    await writeLock(snapshot.root, snapshot.lock);
    const result = runVerifier(snapshot.root);
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /immutable 40-hex source ref/);
  } finally {
    await rm(snapshot.root, { recursive: true, force: true });
  }
});

test("rejects local patch metadata that does not match the vendored file", async () => {
  const snapshot = await createSnapshot();
  try {
    const patch = snapshot.lock.localPatches[".agents/skills/datahub-setup/SKILL.md"];
    patch.vendoredSha256 = sha256("wrong patched content\n");
    await writeLock(snapshot.root, snapshot.lock);
    const result = runVerifier(snapshot.root);
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /local patch metadata mismatch/);
  } finally {
    await rm(snapshot.root, { recursive: true, force: true });
  }
});

test("bootstrap invokes only the offline snapshot verifier", async () => {
  const sandbox = await mkdtemp(join(tmpdir(), "lineageguard-agent-bootstrap-"));
  try {
    const bin = join(sandbox, "bin");
    const log = join(sandbox, "commands.log");
    await mkdir(bin);
    await writeExecutable(
      join(bin, "node"),
      '#!/bin/sh\nprintf "node:%s\\n" "$*" >> "$VERIFY_LOG"\n',
    );
    for (const command of ["npx", "npm", "git", "curl", "wget"]) {
      await writeExecutable(
        join(bin, command),
        `#!/bin/sh\nprintf "forbidden:${command}:%s\\n" "$*" >> "$VERIFY_LOG"\nexit 97\n`,
      );
    }

    const result = spawnSync("/bin/bash", [bootstrapPath], {
      cwd: repositoryRoot,
      encoding: "utf8",
      env: { ...process.env, PATH: `${bin}:/usr/bin:/bin`, VERIFY_LOG: log },
    });
    assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
    const commands = (await readFile(log, "utf8")).trim().split("\n");
    assert.deepEqual(commands, [`node:${verifierPath} --root ${repositoryRoot}`]);
  } finally {
    await rm(sandbox, { recursive: true, force: true });
  }
});
