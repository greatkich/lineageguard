import { readFile, readdir } from "node:fs/promises";
import { dirname, join, relative, resolve, sep } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const WORKSPACE_RULES = {
  agent: { path: "packages/agent", allowed: ["domain"] },
  datahub: { path: "packages/datahub", allowed: ["domain"] },
  db: { path: "packages/db", allowed: ["domain"] },
  domain: { path: "packages/domain", allowed: [] },
  github: { path: "packages/github", allowed: ["domain"] },
  ui: { path: "packages/ui", allowed: ["domain"] },
  validation: { path: "packages/validation", allowed: ["domain"] },
  web: { path: "apps/web", allowed: ["db", "domain", "ui"] },
  worker: {
    path: "apps/worker",
    allowed: ["agent", "datahub", "db", "domain", "github", "validation"],
  },
};

const SOURCE_EXTENSION = /\.(?:[cm]?[jt]s|tsx)$/;
const STATIC_IMPORT = /\b(?:import|export)\s+(?:type\s+)?(?:[^;"']*?\s+from\s+)?["']([^"']+)["']/g;
const DYNAMIC_IMPORT = /\b(?:import|require)\(\s*["']([^"']+)["']\s*\)/g;

function normalize(path) {
  return path.split(sep).join("/");
}

function workspaceForPath(filePath, repositoryRoot) {
  const repositoryRelative = normalize(relative(repositoryRoot, filePath));
  return Object.entries(WORKSPACE_RULES).find(
    ([, rule]) =>
      repositoryRelative === rule.path || repositoryRelative.startsWith(`${rule.path}/`),
  )?.[0];
}

export function extractImportSpecifiers(source) {
  const specifiers = new Set();
  for (const pattern of [STATIC_IMPORT, DYNAMIC_IMPORT]) {
    pattern.lastIndex = 0;
    for (const match of source.matchAll(pattern)) {
      if (match[1]) specifiers.add(match[1]);
    }
  }
  return [...specifiers];
}

function targetWorkspace(specifier, filePath, repositoryRoot) {
  if (specifier.startsWith("@lineageguard/")) {
    return specifier.slice("@lineageguard/".length).split("/")[0];
  }
  if (specifier.startsWith(".")) {
    return workspaceForPath(resolve(dirname(filePath), specifier), repositoryRoot);
  }
  return undefined;
}

export function findBoundaryViolations(files, repositoryRoot) {
  const violations = [];

  for (const file of files) {
    const sourceWorkspace = workspaceForPath(file.path, repositoryRoot);
    if (!sourceWorkspace) continue;

    const allowed = WORKSPACE_RULES[sourceWorkspace].allowed;
    for (const specifier of extractImportSpecifiers(file.source)) {
      const target = targetWorkspace(specifier, file.path, repositoryRoot);
      if (!target || target === sourceWorkspace) continue;

      if (!(target in WORKSPACE_RULES) || !allowed.includes(target)) {
        violations.push({
          file: normalize(relative(repositoryRoot, file.path)),
          source: sourceWorkspace,
          specifier,
          target,
        });
      }
    }
  }

  return violations;
}

async function collectSourceFiles(directory) {
  const entries = await readdir(directory, { withFileTypes: true });
  const files = [];

  for (const entry of entries) {
    if ([".next", "dist", "node_modules"].includes(entry.name)) continue;
    const path = join(directory, entry.name);
    if (entry.isDirectory()) files.push(...(await collectSourceFiles(path)));
    if (entry.isFile() && SOURCE_EXTENSION.test(entry.name)) {
      files.push({ path, source: await readFile(path, "utf8") });
    }
  }

  return files;
}

async function main() {
  const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
  const files = [
    ...(await collectSourceFiles(resolve(repositoryRoot, "apps"))),
    ...(await collectSourceFiles(resolve(repositoryRoot, "packages"))),
  ];
  const violations = findBoundaryViolations(files, repositoryRoot);

  if (violations.length > 0) {
    for (const violation of violations) {
      console.error(
        `${violation.file}: ${violation.source} cannot import ${violation.specifier} (${violation.target})`,
      );
    }
    process.exitCode = 1;
    return;
  }

  console.log(`dependency boundaries: verified (${files.length} source files)`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) await main();
