import { rm } from "node:fs/promises";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const workerDist = resolve(repositoryRoot, "apps/worker/dist");

if (relative(repositoryRoot, workerDist) !== join("apps", "worker", "dist")) {
  throw new Error("refusing to clean an unexpected worker output path");
}

await rm(workerDist, { force: true, recursive: true });
