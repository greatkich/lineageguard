/**
 * Content-addressed identity for the effects a run publishes.
 *
 * The derivations themselves live in `@lineageguard/domain` so the pipeline, the worker's
 * publication ports, and the acceptance harness all compute one identity. This module re-exports
 * them and adds only the worker-local environment lookup.
 */
export {
  canonicalCandidateFingerprint,
  decisionMarker,
  generatedBranchName,
} from "@lineageguard/domain";

export function sourcePrNumberFromEnv(): number | undefined {
  const raw = process.env.SOURCE_PR_NUMBER;
  if (!raw) return undefined;
  const parsed = Number.parseInt(raw, 10);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : undefined;
}
