import { readdir } from "node:fs/promises";
import { dirname, extname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const workerDist = resolve(repositoryRoot, "apps/worker/dist");

async function listFiles(directory) {
  const entries = await readdir(directory, { withFileTypes: true });
  const files = [];

  for (const entry of entries) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) files.push(...(await listFiles(path)));
    if (entry.isFile()) files.push(path);
  }

  return files;
}

const files = await listFiles(workerDist);
const testModules = files.filter((file) =>
  /(?:^|\.)(?:spec|test)\.[cm]?[jt]sx?$/.test(relative(workerDist, file)),
);
if (testModules.length > 0) {
  throw new Error(`worker build contains test modules: ${testModules.join(", ")}`);
}

const runtimeModules = files.filter((file) => extname(file) === ".js");
if (!runtimeModules.some((file) => file.endsWith("worker.js"))) {
  throw new Error("worker build is missing worker.js");
}

console.log(
  `worker artifact: verified (${runtimeModules.length} runtime modules, no test modules)`,
);
