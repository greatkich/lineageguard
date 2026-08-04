import { sha256 } from "@lineageguard/domain";

function withoutSqlComments(statement: string): string {
  return statement.replace(/\/\*[\s\S]*?\*\//gu, " ").replace(/--[^\r\n]*/gu, " ");
}

export function normalizeSqlStatement(statement: string): string {
  return withoutSqlComments(statement)
    .trim()
    .split(/\s+/u)
    .join(" ")
    .replace(/;+$/u, "")
    .toLowerCase();
}

export function normalizedSqlFingerprint(statement: string): string {
  return sha256(normalizeSqlStatement(statement));
}
