import { readFile, readdir } from "node:fs/promises";
import { dirname, join, relative, resolve, sep } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import ts from "typescript";

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

const DEPENDENCY_SECTIONS = [
  "dependencies",
  "devDependencies",
  "optionalDependencies",
  "peerDependencies",
];
const SOURCE_EXTENSION = /\.[cm]?[jt]sx?$/;

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

function scriptKind(filePath) {
  if (/\.tsx$/i.test(filePath)) return ts.ScriptKind.TSX;
  if (/\.jsx$/i.test(filePath)) return ts.ScriptKind.JSX;
  if (/\.[cm]?js$/i.test(filePath)) return ts.ScriptKind.JS;
  return ts.ScriptKind.TS;
}

function moduleSpecifierText(node) {
  return node && ts.isStringLiteralLike(node) ? node.text : undefined;
}

export function extractImportSpecifiers(source, filePath = "source.ts") {
  const specifiers = new Set();
  const sourceFile = ts.createSourceFile(
    filePath,
    source,
    ts.ScriptTarget.Latest,
    true,
    scriptKind(filePath),
  );

  function visit(node) {
    if (ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) {
      const specifier = moduleSpecifierText(node.moduleSpecifier);
      if (specifier) specifiers.add(specifier);
    } else if (ts.isImportEqualsDeclaration(node)) {
      const reference = node.moduleReference;
      if (ts.isExternalModuleReference(reference)) {
        const specifier = moduleSpecifierText(reference.expression);
        if (specifier) specifiers.add(specifier);
      }
    } else if (ts.isCallExpression(node)) {
      const isDynamicImport = node.expression.kind === ts.SyntaxKind.ImportKeyword;
      const isRequire = ts.isIdentifier(node.expression) && node.expression.text === "require";
      if (isDynamicImport || isRequire) {
        const specifier = moduleSpecifierText(node.arguments[0]);
        if (specifier) specifiers.add(specifier);
      }
    }

    ts.forEachChild(node, visit);
  }

  visit(sourceFile);
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
    for (const specifier of extractImportSpecifiers(file.source, file.path)) {
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

export function findManifestBoundaryViolations(manifests, repositoryRoot) {
  const violations = [];

  for (const file of manifests) {
    const sourceWorkspace = workspaceForPath(file.path, repositoryRoot);
    if (!sourceWorkspace) continue;
    const allowed = WORKSPACE_RULES[sourceWorkspace].allowed;

    for (const section of DEPENDENCY_SECTIONS) {
      const dependencies = file.manifest[section];
      if (!dependencies || typeof dependencies !== "object" || Array.isArray(dependencies))
        continue;

      for (const specifier of Object.keys(dependencies)) {
        if (!specifier.startsWith("@lineageguard/")) continue;
        const target = targetWorkspace(specifier, file.path, repositoryRoot);
        if (!target || target === sourceWorkspace) continue;

        if (!(target in WORKSPACE_RULES) || !allowed.includes(target)) {
          violations.push({
            file: normalize(relative(repositoryRoot, file.path)),
            section,
            source: sourceWorkspace,
            specifier,
            target,
          });
        }
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
  const manifests = await Promise.all(
    Object.values(WORKSPACE_RULES).map(async (rule) => {
      const path = resolve(repositoryRoot, rule.path, "package.json");
      return { path, manifest: JSON.parse(await readFile(path, "utf8")) };
    }),
  );
  const sourceViolations = findBoundaryViolations(files, repositoryRoot);
  const manifestViolations = findManifestBoundaryViolations(manifests, repositoryRoot);
  const violations = [...sourceViolations, ...manifestViolations];

  if (violations.length > 0) {
    for (const violation of violations) {
      const relationship = violation.section
        ? `declare ${violation.specifier} in ${violation.section}`
        : `import ${violation.specifier}`;
      console.error(
        `${violation.file}: ${violation.source} cannot ${relationship} (${violation.target})`,
      );
    }
    process.exitCode = 1;
    return;
  }

  console.log(
    `dependency boundaries: verified (${files.length} source files, ${manifests.length} manifests)`,
  );
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) await main();
