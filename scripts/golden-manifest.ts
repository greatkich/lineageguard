import {
  type AcceptanceCodeStateReader,
  withAcceptanceCodeState,
} from "./acceptance-code-state.js";

export const canonicalGoldenStates = [
  "01-baseline-allow",
  "02-datahub-consumers",
  "03-allow-to-block",
  "04-uuid-migration",
  "05-validation-pass",
  "06-generated-pr",
  "07-datahub-writeback",
  "08-completed-summary",
] as const;

export interface GoldenScreenshotRun {
  id: string;
  applicationCodeSha: string;
  executionMode: string;
  status: string;
  prUrl: string | null;
}

export interface GoldenScreenshotManifestInput {
  run: GoldenScreenshotRun;
  capturedAt: string;
  viewport: Readonly<{ width: number; height: number }>;
  states: readonly string[];
}

export interface GoldenScreenshotManifest {
  runId: string;
  applicationCodeSha: string;
  executionMode: string;
  status: string;
  prUrl: string | null;
  capturedAt: string;
  viewport: { width: number; height: number };
  states: string[];
}

export interface GoldenScreenshotCaptureInput {
  run: GoldenScreenshotRun;
  viewport: Readonly<{ width: number; height: number }>;
  readState?: AcceptanceCodeStateReader;
  capture: () => Promise<{ capturedAt: string; states: readonly string[] }>;
}

function hasCanonicalStates(states: readonly string[]): boolean {
  return (
    states.length === canonicalGoldenStates.length &&
    canonicalGoldenStates.every((state, index) => states[index] === state)
  );
}

export function buildGoldenScreenshotManifest(
  input: GoldenScreenshotManifestInput,
): GoldenScreenshotManifest {
  if (!/^[0-9a-f]{40}$/.test(input.run.applicationCodeSha)) {
    throw new Error("GOLDEN_MANIFEST_INVALID: applicationCodeSha must be 40 lowercase hex chars");
  }
  if (input.run.executionMode !== "LIVE" || input.run.status !== "COMPLETED") {
    throw new Error("GOLDEN_MANIFEST_INVALID: run must be COMPLETED in LIVE mode");
  }
  if (!hasCanonicalStates(input.states)) {
    throw new Error(
      "GOLDEN_MANIFEST_INVALID: states must equal the canonical ordered eight states",
    );
  }
  return {
    runId: input.run.id,
    applicationCodeSha: input.run.applicationCodeSha,
    executionMode: input.run.executionMode,
    status: input.run.status,
    prUrl: input.run.prUrl,
    capturedAt: input.capturedAt,
    viewport: { ...input.viewport },
    states: [...input.states],
  };
}

export async function captureGoldenScreenshotManifest(
  input: GoldenScreenshotCaptureInput,
): Promise<GoldenScreenshotManifest> {
  const guarded = await withAcceptanceCodeState({
    expectedApplicationCodeSha: input.run.applicationCodeSha,
    ...(input.readState ? { readState: input.readState } : {}),
    action: async () => input.capture(),
  });
  return buildGoldenScreenshotManifest({
    run: { ...input.run, applicationCodeSha: guarded.accepted.applicationCodeSha },
    capturedAt: guarded.value.capturedAt,
    viewport: input.viewport,
    states: guarded.value.states,
  });
}
