import { createHash } from "node:crypto";
import type { MigrationCandidate } from "@lineageguard/domain";

/**
 * Content-addressed identity for the effects a run publishes.
 *
 * Both the generated GitHub branch and the DataHub decision record were previously keyed on the run
 * id, so every rehearsal of the same input created another PR and another decision marker. That made
 * the three-run repeatability proof impossible and turned institutional memory into a log.
 *
 * The candidate already carries the bindings that make it unique: the source change and patch
 * fingerprints, the impact-context fingerprint, the grounded decision, and the evidence that
 * justified it. Hashing those yields a key that is identical for identical input and necessarily
 * different when any of them moves.
 */
export function canonicalCandidateFingerprint(candidate: MigrationCandidate): string {
  const identity = {
    strategy: candidate.strategy,
    sourceChangeFingerprint: candidate.sourceChangeFingerprint,
    sourcePatchFingerprint: candidate.sourcePatchFingerprint,
    sourceImpactContextFingerprint: candidate.sourceImpactContextFingerprint,
    sourceDecision: candidate.sourceDecision,
    sourceEvidenceIds: [...candidate.sourceEvidenceIds].sort(),
    artifacts: [...candidate.artifacts]
      .map((artifact) => ({ path: artifact.path, kind: artifact.kind, content: artifact.content }))
      .sort((left, right) => left.path.localeCompare(right.path)),
  };
  return createHash("sha256").update(JSON.stringify(identity)).digest("hex");
}

/** `lineageguard/generated/pr-3-<prefix>`, or without the PR segment when none is bound. */
export function generatedBranchName(candidateFingerprint: string, prNumber?: number): string {
  if (!/^[a-f0-9]{64}$/.test(candidateFingerprint)) {
    throw new Error("candidate fingerprint must be 64 hex characters");
  }
  const prefix = candidateFingerprint.slice(0, 12);
  if (prNumber === undefined) return `lineageguard/generated/${prefix}`;
  if (!Number.isInteger(prNumber) || prNumber <= 0) {
    throw new Error("source pull request number must be a positive integer");
  }
  return `lineageguard/generated/pr-${String(prNumber)}-${prefix}`;
}

/** The stable marker that identifies this decision in DataHub across runs. */
export function decisionMarker(candidateFingerprint: string): string {
  if (!/^[a-f0-9]{64}$/.test(candidateFingerprint)) {
    throw new Error("candidate fingerprint must be 64 hex characters");
  }
  return `lineageguard:decision:v1:candidate-${candidateFingerprint.slice(0, 16)}`;
}

export function sourcePrNumberFromEnv(): number | undefined {
  const raw = process.env.SOURCE_PR_NUMBER;
  if (!raw) return undefined;
  const parsed = Number.parseInt(raw, 10);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : undefined;
}
