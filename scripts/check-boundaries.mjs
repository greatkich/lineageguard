#!/usr/bin/env node
// @ts-check

/**
 * check-boundaries.mjs
 * Deterministic source/import graph check enforcing the internal dependency policy.
 * Exits non-zero on any forbidden edge, containment violation, or cycle.
 */

import { readFileSync, readdirSync, existsSync } from "node:fs";
import { join, relative, resolve, dirname } from "node:path";

export const INTERNAL_DEPENDENCY_POLICY = {
  "packages/domain": [],
  "packages/agent": ["packages/domain"],
  "packages/datahub": ["packages/domain"],
  "packages/github": ["packages/domain"],
  "packages/validation": ["packages/domain"],
  "packages/db": ["packages/domain"],
  "packages/ui": ["packages/domain"],
  "apps/worker": [
    "packages/domain",
    "packages/agent",
    "packages/datahub",
    "packages/github",
    "packages/validation",
    "packages/db",
  ],
  "apps/web": ["packages/domain", "packages/db", "packages/ui"],
};

const DOMAIN_DENIED_IMPORTS = [
  /^next/,
  /^react/,
  /^pg/,
  /^drizzle/,
  /^@modelcontextprotocol/,
  /^@anthropic/,
  /^@openai/,
  /^langchain/,
];

/**
 * @param {string} rootDir
 */
function collectSourceFiles(rootDir) {
  const files = [];
  if (!existsSync(rootDir)) return files;

  function walk(dir) {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (
        entry.name === "node_modules" ||
        entry.name === "dist" ||
        entry.name === ".next"
      )
        continue;
      const full = join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (
        /\.(ts|tsx|js|mjs)$/.test(entry.name) &&
        !entry.name.endsWith(".test.ts")
      ) {
        files.push(full);
      }
    }
  }
  walk(rootDir);
  return files;
}

/**
 * @param {string} content
 */
function extractImports(content) {
  const imports = [];
  const re =
    /(?:import|export)\s+.*?from\s+["']([^"']+)["']|require\(["']([^"']+)["']\)/g;
  let match;
  while ((match = re.exec(content)) !== null) {
    imports.push(match[1] || match[2]);
  }
  return imports;
}

/**
 * @param {string} importPath
 * @param {Record<string, string[]>} policy
 */
function resolveInternalOwner(importPath, policy) {
  for (const owner of Object.keys(policy)) {
    const pkgName = `@lineageguard/${owner.split("/")[1]}`;
    if (importPath === pkgName || importPath.startsWith(`${pkgName}/`)) {
      return owner;
    }
  }
  return null;
}

/**
 * @param {string} repoRoot
 * @param {string[]=} fixtureRoots
 */
export function checkBoundaries(repoRoot, fixtureRoots) {
  const violations = [];
  const _roots =
    fixtureRoots ||
    Object.keys(INTERNAL_DEPENDENCY_POLICY).map((p) => join(repoRoot, p));
  const graph = new Map();

  for (const ownerPath of Object.keys(INTERNAL_DEPENDENCY_POLICY)) {
    const absRoot = fixtureRoots ? null : join(repoRoot, ownerPath);
    const srcDir = absRoot ? join(absRoot, "src") : null;
    if (!srcDir) continue;

    const files = collectSourceFiles(srcDir);
    for (const file of files) {
      const content = readFileSync(file, "utf8");
      const imports = extractImports(content);

      for (const imp of imports) {
        const target = resolveInternalOwner(imp, INTERNAL_DEPENDENCY_POLICY);
        if (target === null) {
          // Check domain denied imports
          if (ownerPath === "packages/domain") {
            for (const denied of DOMAIN_DENIED_IMPORTS) {
              if (denied.test(imp)) {
                violations.push({
                  type: "DOMAIN_DENIED_IMPORT",
                  owner: ownerPath,
                  file: relative(repoRoot, file),
                  import: imp,
                });
              }
            }
          }
          // Check raw MCP containment
          if (
            imp.includes("@modelcontextprotocol") &&
            ownerPath !== "packages/datahub"
          ) {
            violations.push({
              type: "MCP_CONTAINMENT",
              owner: ownerPath,
              file: relative(repoRoot, file),
              import: imp,
            });
          }
          continue;
        }
        if (target === ownerPath) continue;

        // Check packages -> apps forbidden
        if (ownerPath.startsWith("packages/") && target.startsWith("apps/")) {
          violations.push({
            type: "FORBIDDEN_INTERNAL_EDGE",
            from: ownerPath,
            to: target,
            file: relative(repoRoot, file),
            import: imp,
          });
          continue;
        }

        const allowed = INTERNAL_DEPENDENCY_POLICY[ownerPath];
        if (!allowed?.includes(target)) {
          violations.push({
            type: "FORBIDDEN_INTERNAL_EDGE",
            from: ownerPath,
            to: target,
            file: relative(repoRoot, file),
            import: imp,
          });
        }

        // Build graph for cycle detection
        if (!graph.has(ownerPath)) graph.set(ownerPath, new Set());
        graph.get(ownerPath).add(target);
      }
    }
  }

  // Also check manifest dependencies
  for (const ownerPath of Object.keys(INTERNAL_DEPENDENCY_POLICY)) {
    const pkgJsonPath = fixtureRoots
      ? null
      : join(repoRoot, ownerPath, "package.json");
    if (!pkgJsonPath || !existsSync(pkgJsonPath)) continue;
    const pkgJson = JSON.parse(readFileSync(pkgJsonPath, "utf8"));
    const deps = { ...pkgJson.dependencies, ...pkgJson.devDependencies };

    for (const dep of Object.keys(deps)) {
      if (!dep.startsWith("@lineageguard/")) continue;
      const targetPkg = dep.replace("@lineageguard/", "");
      // find matching owner
      const target = Object.keys(INTERNAL_DEPENDENCY_POLICY).find(
        (o) => o.split("/")[1] === targetPkg,
      );
      if (!target) continue;
      if (target === ownerPath) continue;

      // packages -> apps
      if (ownerPath.startsWith("packages/") && target.startsWith("apps/")) {
        violations.push({
          type: "FORBIDDEN_INTERNAL_EDGE",
          from: ownerPath,
          to: target,
          file: relative(repoRoot, join(ownerPath, "package.json")),
          import: dep,
        });
        continue;
      }

      const allowed = INTERNAL_DEPENDENCY_POLICY[ownerPath];
      if (!allowed?.includes(target)) {
        violations.push({
          type: "FORBIDDEN_INTERNAL_EDGE",
          from: ownerPath,
          to: target,
          file: relative(repoRoot, join(ownerPath, "package.json")),
          import: dep,
        });
      }

      if (!graph.has(ownerPath)) graph.set(ownerPath, new Set());
      graph.get(ownerPath).add(target);
    }
  }

  // Cycle detection (DFS)
  const cycles = detectCycles(graph);
  for (const cycle of cycles) {
    violations.push({
      type: "INTERNAL_DEPENDENCY_CYCLE",
      path: cycle,
    });
  }

  return violations;
}

/**
 * @param {Map<string, Set<string>>} graph
 */
function detectCycles(graph) {
  const WHITE = 0;
  const GRAY = 1;
  const BLACK = 2;
  const color = new Map();
  const _parent = new Map();
  const cycles = [];

  for (const node of graph.keys()) {
    color.set(node, WHITE);
  }
  // Also include targets that might not be keys
  for (const [, targets] of graph) {
    for (const t of targets) {
      if (!color.has(t)) color.set(t, WHITE);
    }
  }

  function dfs(u, path) {
    color.set(u, GRAY);
    path.push(u);
    const neighbors = graph.get(u) || new Set();
    for (const v of neighbors) {
      if (color.get(v) === GRAY) {
        // Found cycle
        const cycleStart = path.indexOf(v);
        const cyclePath = [...path.slice(cycleStart), v];
        cycles.push(cyclePath.join(" -> "));
      } else if (color.get(v) === WHITE) {
        dfs(v, path);
      }
    }
    path.pop();
    color.set(u, BLACK);
  }

  for (const node of graph.keys()) {
    if (color.get(node) === WHITE) {
      dfs(node, []);
    }
  }
  return cycles;
}

// CLI mode
if (
  process.argv[1] &&
  resolve(process.argv[1]) === resolve(import.meta.filename)
) {
  const repoRoot = resolve(dirname(import.meta.filename), "..");
  const violations = checkBoundaries(repoRoot);
  if (violations.length === 0) {
    console.log("boundaries: all edges permitted, no cycles");
    process.exit(0);
  }
  for (const v of violations) {
    if (v.type === "INTERNAL_DEPENDENCY_CYCLE") {
      console.error(`CYCLE: ${v.path}`);
    } else if (v.type === "FORBIDDEN_INTERNAL_EDGE") {
      console.error(`FORBIDDEN: ${v.from} -> ${v.to} (${v.file}: ${v.import})`);
    } else {
      console.error(`${v.type}: ${v.owner} (${v.file}: ${v.import})`);
    }
  }
  process.exit(1);
}
