/**
 * Regenerates `examples/canonical/accepted-generation-response.json` from the canonical candidate
 * builder — the same code path a live run uses to generate artifacts.
 *
 * That file is the "accepted generation response" the executable integration suite feeds through the
 * public validation path. Maintained by hand, it drifted twice: it carried an older trigger shape and
 * still claimed bigint identifiers.
 *
 * It must be generated from the BUILDER, not from the validator's allowlist constant. The allowlist
 * string is a normalized comparison form — it lowercases `TG_OP` literals, which PostgreSQL reports
 * uppercase, so executing it leaves the compatibility trigger inert and every post-migration check
 * fails on a NOT NULL violation. The builder emits the executable form.
 *
 * Usage: pnpm regenerate:canonical-example
 */
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { buildCanonicalCandidate } from "@lineageguard/agent";
import {
  canonicalDatasetRef,
  compareAuthoritativeRisk,
  parseProposedChange,
} from "@lineageguard/domain";
import { createCanonicalLiveImpactContextTestFixture } from "@lineageguard/validation";

const assessedAt = "2026-08-04T09:00:00.000Z";
function canonicalChange() {
  const parsed = parseProposedChange({
    source: "FIXTURE",
    repository: "lineageguard/canonical",
    baseSha: "1".repeat(40),
    headSha: "2".repeat(40),
    files: [
      {
        path: "walkthrough/migrations/rename.sql",
        datasetRef: canonicalDatasetRef,
        patch: "ALTER TABLE commerce.orders RENAME COLUMN customer_id TO buyer_id;",
      },
    ],
  });
  if (!parsed.ok) throw new Error(`canonical change did not parse: ${parsed.error.message}`);
  return parsed.value;
}

function main(): void {
  const change = canonicalChange();
  const context = createCanonicalLiveImpactContextTestFixture(change.id);
  const comparison = compareAuthoritativeRisk(change, context, {
    baseline: assessedAt,
    grounded: assessedAt,
  });
  const candidate = buildCanonicalCandidate({ change, context, comparison });

  const migration = candidate.artifacts.find((artifact) => artifact.kind === "SQL_MIGRATION");
  const rollback = candidate.artifacts.find((artifact) => artifact.kind === "ROLLBACK_SQL");
  if (!migration || !rollback) throw new Error("generated candidate is missing its SQL artifacts");
  if (migration.content.includes("bigint")) {
    throw new Error("generated migration still claims bigint identifiers");
  }
  // The guard that would have caught the allowlist-vs-builder mix-up.
  if (!migration.content.includes("TG_OP") && !migration.content.includes("'INSERT'")) {
    throw new Error(
      "generated migration lowercases TG_OP literals; the compatibility trigger would never fire",
    );
  }

  const target = join(process.cwd(), "examples/canonical/accepted-generation-response.json");
  writeFileSync(target, `${JSON.stringify(candidate, null, 2)}\n`);

  console.log(`wrote ${target}`);
  console.log(`artifacts: ${String(candidate.artifacts.length)}`);
  console.log(`evidence bound: ${String(candidate.sourceEvidenceIds.length)}`);
}

main();
