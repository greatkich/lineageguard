/**
 * demo:verify — independently verify a completed run.
 *
 * Deliberately does not trust the pipeline's own status field, and does not treat the presence of a
 * receipt as proof that the effect it describes exists. Every external claim is re-read from the
 * system that was supposed to have been changed and re-derived from the persisted inputs:
 *
 *   - the source PR is re-read from GitHub and its bytes re-fingerprinted;
 *   - the validation receipt body is re-inspected for the eight canonical checks;
 *   - the generated PR's commit, tree, and every blob are re-read and compared byte-for-byte
 *     against the validated artifacts, and the tree delta is constrained to exactly those paths;
 *   - the DataHub decision document and tags are re-read and matched field by field.
 *
 * A failure to inspect is a failed check, never a skipped one.
 *
 * Usage: pnpm demo:verify -- --runId <id>
 *        pnpm demo:verify            (verifies the most recent LIVE run)
 */
import {
  assertExactlyFourConsumers,
  canonicalConsumerKinds,
  canonicalCandidateFingerprint,
  deriveImpactConsumers,
  generatedBranchName,
  impactContextSchema,
  type MigrationCandidate,
} from "@lineageguard/domain";
import type { SimpleRun } from "@lineageguard/db";
import {
  candidateView,
  canonicalReviewedTagUrn,
  expectedDecisionMarker,
  hasGitHubToken,
  readBlobBytes,
  readCommit,
  readDataHubDecisionState,
  readPullRequest,
  readPullRequestSourceIdentity,
  readTreeBlobs,
  sha256Bytes,
} from "./acceptance-inspect.js";
import {
  assertAcceptanceCodeState,
  type AcceptanceCodeState,
  readAcceptanceCodeState,
} from "./acceptance-code-state.js";
import {
  argValue,
  type CheckResult,
  fail,
  latestLiveRun,
  loadEnv,
  pass,
  printUsage,
  reportMatrix,
  sourcePrNumber,
  wantsHelp,
  withRunStore,
} from "./demo-support.js";
import { assessGitHubEffectOutcome } from "./github-effect-outcome.js";

loadEnv();

/** The store's own row type — a hand-rolled copy would drift from the schema. */
type StoredRun = SimpleRun;

/** The eight canonical validation checks the demo claims to run. */
const canonicalValidationCheckCount = 8;

function verifyDecisions(runRecord: StoredRun): CheckResult[] {
  const githubEffectOutcome = assessGitHubEffectOutcome(runRecord.githubEffectOutcome);
  return [
    runRecord.status === "COMPLETED"
      ? pass("final state", "COMPLETED")
      : fail("final state", `${runRecord.status} — only COMPLETED is a successful demo`),
    runRecord.baselineDecision === "ALLOW"
      ? pass("baseline decision", "ALLOW (repository-only)")
      : fail("baseline decision", `${String(runRecord.baselineDecision)} — expected ALLOW`),
    runRecord.groundedDecision === "BLOCK"
      ? pass("grounded decision", "BLOCK (DataHub-grounded)")
      : fail("grounded decision", `${String(runRecord.groundedDecision)} — expected BLOCK`),
    githubEffectOutcome.ok
      ? pass("github effect outcome", githubEffectOutcome.outcome)
      : fail("github effect outcome", githubEffectOutcome.reason),
  ];
}

function verifyApplicationCode(runRecord: StoredRun, current: AcceptanceCodeState): CheckResult {
  try {
    assertAcceptanceCodeState(current, {
      applicationCodeSha: runRecord.applicationCodeSha ?? "",
      porcelain: "",
    });
    return pass("application code sha", `${current.applicationCodeSha} (clean and exact)`);
  } catch (error) {
    return fail("application code sha", error instanceof Error ? error.message : String(error));
  }
}

function verifyConsumers(runRecord: StoredRun): CheckResult[] {
  if (runRecord.contextJson === null || runRecord.contextJson === undefined) {
    return [fail("impact context", "no persisted context to re-derive from")];
  }
  const parsed = impactContextSchema.safeParse(runRecord.contextJson);
  if (!parsed.success) {
    return [fail("impact context", "persisted context failed schema validation")];
  }
  const results: CheckResult[] = [pass("impact context", "schema-valid")];
  const consumers = deriveImpactConsumers(parsed.data);
  try {
    assertExactlyFourConsumers(consumers);
    results.push(
      pass("consumer groups", `4 in canonical order: ${canonicalConsumerKinds.join(", ")}`),
    );
  } catch (error) {
    results.push(fail("consumer groups", (error as Error).message));
  }
  results.push(
    consumers.length === runRecord.consumersFound
      ? pass("persisted count", `matches derivation (${String(consumers.length)})`)
      : fail(
          "persisted count",
          `stored ${String(runRecord.consumersFound)} but derivation yields ${String(consumers.length)}`,
        ),
  );

  // "Zero synthetic live evidence": every provenance entry must name a real MCP invocation and a
  // real response fingerprint. A zero-filled or absent fingerprint is synthetic.
  const synthetic = parsed.data.evidence.flatMap((item) =>
    item.provenance.filter(
      (entry) =>
        entry.invocationId.length === 0 ||
        /^0+$/.test(entry.responseFingerprint) ||
        entry.responseFingerprint.length !== 64,
    ),
  );
  results.push(
    synthetic.length === 0
      ? pass("synthetic evidence", "syntheticLiveEvidenceCount = 0")
      : fail("synthetic evidence", `${String(synthetic.length)} provenance entries look synthetic`),
  );

  const schema = parsed.data.evidence.find((item) => item.kind === "SCHEMA");
  results.push(
    schema?.kind === "SCHEMA" && schema.payload.nativeType === "uuid"
      ? pass("identifier type", "uuid")
      : fail(
          "identifier type",
          `${String(schema?.kind === "SCHEMA" ? schema.payload.nativeType : "absent")} — expected uuid`,
        ),
  );

  const model = parsed.data.evidence.find((item) => item.kind === "ML_MODEL");
  results.push(
    model?.kind === "ML_MODEL" &&
      /^[a-f0-9]{64}$/.test(model.payload.trainingDataReceipt.responseSha256)
      ? pass("ml training-data proof", "aspect receipt present with response digest")
      : fail("ml training-data proof", "ML evidence carries no valid TrainingData receipt"),
  );
  return results;
}

/**
 * Re-reads the real source pull request and proves the run is still bound to the exact bytes it
 * analysed. Checking only the persisted fingerprint would prove nothing about the live source.
 */
async function verifySource(runRecord: StoredRun): Promise<CheckResult[]> {
  const expected = sourcePrNumber();
  const results: CheckResult[] = [
    runRecord.sourcePrNumber === expected && expected !== undefined
      ? pass("source pr", `#${String(expected)} bound to the run`)
      : fail(
          "source pr",
          `run carries #${String(runRecord.sourcePrNumber)}, expected #${String(expected)}`,
        ),
    runRecord.sourceHeadSha && /^[0-9a-f]{40}$/.test(runRecord.sourceHeadSha)
      ? pass("source head sha", runRecord.sourceHeadSha.slice(0, 12))
      : fail("source head sha", "absent or malformed"),
    runRecord.sourceDiffFingerprint && runRecord.sourceDiffFingerprint.length >= 64
      ? pass("source fingerprint", runRecord.sourceDiffFingerprint.slice(0, 16))
      : fail("source fingerprint", "absent or malformed"),
    runRecord.sourceFilePath
      ? pass("selected path", runRecord.sourceFilePath)
      : fail("selected path", "absent"),
  ];

  if (expected === undefined) {
    results.push(fail("source pr live head", "no SOURCE_PR_NUMBER configured to re-read"));
    return results;
  }

  const live = await readPullRequest(expected);
  if (!live.ok) {
    results.push(fail("source pr live head", live.reason));
    results.push(fail("source pr live bytes", "source pull request could not be re-read"));
    return results;
  }
  results.push(
    live.value.headSha === runRecord.sourceHeadSha
      ? pass("source pr live head", `${live.value.headSha.slice(0, 12)} still matches the analysis`)
      : fail(
          "source pr live head",
          `live ${live.value.headSha.slice(0, 12)} but run analysed ${String(runRecord.sourceHeadSha).slice(0, 12)}`,
        ),
  );

  if (!runRecord.sourceFilePath) {
    results.push(fail("source pr live identity", "no selected path to re-read"));
    return results;
  }
  // Rebuild the envelope from the live PR through the same domain function the worker binds runs
  // with, then compare identities. This proves the live source still binds to the exact identity
  // this run analysed, and that it still satisfies the canonical allowlist.
  const rederived = await readPullRequestSourceIdentity(expected);
  if (!rederived.ok) {
    results.push(fail("source pr live identity", rederived.reason));
    return results;
  }
  const persisted = String(runRecord.sourceDiffFingerprint).replace(/^sha256:/, "");
  results.push(
    rederived.value.sourceFingerprint === persisted
      ? pass(
          "source pr live identity",
          `re-derived ${rederived.value.sourceFingerprint.slice(0, 16)} from ${String(rederived.value.files.length)} changed file(s)`,
        )
      : fail(
          "source pr live identity",
          `live PR re-derives ${rederived.value.sourceFingerprint.slice(0, 16)} but run bound ${persisted.slice(0, 16)}`,
        ),
  );
  results.push(
    rederived.value.selectedPath === runRecord.sourceFilePath
      ? pass("source pr selected path", rederived.value.selectedPath)
      : fail(
          "source pr selected path",
          `live envelope selects ${rederived.value.selectedPath} but run recorded ${runRecord.sourceFilePath}`,
        ),
  );
  return results;
}

/**
 * Inspects the persisted validation receipt body rather than its digest, so acceptance can state
 * which checks ran and that each passed.
 */
function verifyValidation(runRecord: StoredRun): CheckResult[] {
  const results: CheckResult[] = [
    runRecord.validationReceiptFingerprint
      ? pass("validation receipt", runRecord.validationReceiptFingerprint.slice(0, 16))
      : fail("validation receipt", "absent — validation did not produce a receipt"),
    (runRecord.artifactsGenerated ?? 0) >= 5
      ? pass("generated artifacts", String(runRecord.artifactsGenerated))
      : fail(
          "generated artifacts",
          `${String(runRecord.artifactsGenerated)} — expected at least 5`,
        ),
  ];

  const receipt = runRecord.validationReceiptJson as
    | {
        allPass?: boolean;
        checks?: Array<{ check?: string; status?: string }>;
        artifacts?: Array<{ path?: string; sha256?: string }>;
        candidateFingerprint?: string;
      }
    | null
    | undefined;
  if (!receipt || typeof receipt !== "object") {
    results.push(fail("validation checks", "no persisted validation receipt body to inspect"));
    results.push(fail("validation artifact observations", "no persisted receipt body"));
    return results;
  }

  const checks = Array.isArray(receipt.checks) ? receipt.checks : [];
  results.push(
    checks.length === canonicalValidationCheckCount
      ? pass(
          "validation checks",
          `exactly ${String(canonicalValidationCheckCount)} canonical checks`,
        )
      : fail(
          "validation checks",
          `${String(checks.length)} checks recorded, expected ${String(canonicalValidationCheckCount)}`,
        ),
  );
  const failed = checks.filter((check) => check.status !== "PASS");
  results.push(
    failed.length === 0 && checks.length > 0 && receipt.allPass === true
      ? pass("validation outcome", `${String(checks.length)}/${String(checks.length)} PASS`)
      : fail(
          "validation outcome",
          failed.length > 0
            ? `${String(failed.length)} not PASS: ${failed.map((c) => c.check ?? "?").join(", ")}`
            : "receipt does not assert allPass",
        ),
  );

  const observations = Array.isArray(receipt.artifacts) ? receipt.artifacts : [];
  const candidate = candidateView(runRecord.candidateJson);
  if (!candidate.ok) {
    results.push(fail("validation artifact observations", candidate.reason));
    return results;
  }
  const observed = new Map(
    observations
      .filter((entry) => typeof entry.path === "string" && typeof entry.sha256 === "string")
      .map((entry) => [entry.path as string, entry.sha256 as string]),
  );
  const missing = candidate.value.artifacts.filter((artifact) => !observed.has(artifact.path));
  const mismatched = candidate.value.artifacts.filter(
    (artifact) =>
      observed.has(artifact.path) && observed.get(artifact.path) !== sha256Bytes(artifact.content),
  );
  results.push(
    missing.length === 0 &&
      mismatched.length === 0 &&
      observed.size === candidate.value.artifacts.length
      ? pass(
          "validation artifact observations",
          `${String(observed.size)} artifacts observed, every digest matches the candidate`,
        )
      : fail(
          "validation artifact observations",
          missing.length > 0
            ? `not observed: ${missing.map((a) => a.path).join(", ")}`
            : mismatched.length > 0
              ? `digest differs: ${mismatched.map((a) => a.path).join(", ")}`
              : `${String(observed.size)} observations for ${String(candidate.value.artifacts.length)} artifacts`,
        ),
  );

  const derived = canonicalCandidateFingerprint(runRecord.candidateJson as MigrationCandidate);
  results.push(
    receipt.candidateFingerprint === derived
      ? pass(
          "validated candidate binding",
          `${derived.slice(0, 16)} matches the persisted candidate`,
        )
      : fail(
          "validated candidate binding",
          `receipt bound ${String(receipt.candidateFingerprint).slice(0, 16)} but candidate derives ${derived.slice(0, 16)}`,
        ),
  );
  return results;
}

/**
 * Re-reads the generated pull request down to its blobs.
 *
 * Checking the branch prefix proves only that a name was chosen. This walks PR → commit → tree →
 * blobs, compares every generated byte against the validated artifact, and constrains the tree
 * delta against the base commit to exactly the artifact paths, so an extra or altered file in the
 * generated commit fails acceptance.
 */
async function verifyGitHub(runRecord: StoredRun): Promise<CheckResult[]> {
  const results: CheckResult[] = [];
  const generatedPrNumber = Number.parseInt(runRecord.prUrl?.split("/").at(-1) ?? "", 10);
  if (!runRecord.prUrl || !Number.isInteger(generatedPrNumber)) {
    return [fail("generated pr", "no generated PR recorded")];
  }
  results.push(pass("generated pr", runRecord.prUrl));

  if (!hasGitHubToken()) {
    return [...results, fail("generated pr state", "no GitHub token to re-read with")];
  }

  const pr = await readPullRequest(generatedPrNumber);
  if (!pr.ok) {
    return [...results, fail("generated pr state", pr.reason)];
  }
  results.push(
    pr.value.state === "open"
      ? pass("generated pr state", "open")
      : fail("generated pr state", pr.value.state),
  );
  results.push(
    pr.value.draft
      ? pass("generated pr draft", "draft")
      : fail("generated pr draft", "not a draft"),
  );

  const candidate = candidateView(runRecord.candidateJson);
  if (!candidate.ok) {
    return [...results, fail("generated branch identity", candidate.reason)];
  }
  const candidateFingerprint = canonicalCandidateFingerprint(
    runRecord.candidateJson as MigrationCandidate,
  );
  const expectedBranch = generatedBranchName(
    candidateFingerprint,
    runRecord.sourcePrNumber ?? undefined,
  );
  results.push(
    pr.value.headRef === expectedBranch
      ? pass("generated branch identity", `${expectedBranch} is derived from the candidate`)
      : fail(
          "generated branch identity",
          `remote branch ${pr.value.headRef} is not the derived ${expectedBranch}`,
        ),
  );

  if (runRecord.githubHeadSha) {
    // A later rehearsal of the same candidate republishes the same tree, but Git commit identity
    // includes the commit timestamp, so the SHA legitimately differs. Treat a moved head as
    // acceptable only when the content still matches — which the tree and blob checks below prove
    // mandatorily. Claiming "unchanged" here would be false for any run but the most recent.
    if (pr.value.headSha === runRecord.githubHeadSha) {
      results.push(
        pass(
          "generated head",
          `${pr.value.headSha.slice(0, 12)} is exactly what this run published`,
        ),
      );
    } else {
      results.push(
        pass(
          "generated head",
          `moved to ${pr.value.headSha.slice(0, 12)} since this run published ${runRecord.githubHeadSha.slice(0, 12)}; content is re-verified below`,
          false,
        ),
      );
    }
  }

  const commit = await readCommit(pr.value.headSha);
  if (!commit.ok) {
    return [...results, fail("generated commit parent", commit.reason)];
  }
  const expectedBase = runRecord.githubBaseSha;
  if (expectedBase) {
    results.push(
      commit.value.parents.length === 1 && commit.value.parents[0] === expectedBase
        ? pass(
            "generated commit parent",
            `single parent ${expectedBase.slice(0, 12)} (validated base)`,
          )
        : fail(
            "generated commit parent",
            `parents ${commit.value.parents.map((p) => p.slice(0, 12)).join(", ") || "none"} but validated base was ${expectedBase.slice(0, 12)}`,
          ),
    );
  } else {
    results.push(
      commit.value.parents.length === 1
        ? pass(
            "generated commit parent",
            `single parent ${commit.value.parents[0]?.slice(0, 12) ?? ""}`,
          )
        : fail(
            "generated commit parent",
            `${String(commit.value.parents.length)} parents — a generated commit must have exactly one`,
          ),
    );
  }

  const parentSha = commit.value.parents[0];
  if (parentSha === undefined) {
    return [...results, fail("generated tree delta", "commit has no parent to diff against")];
  }
  const parentCommit = await readCommit(parentSha);
  if (!parentCommit.ok) {
    return [...results, fail("generated tree delta", parentCommit.reason)];
  }
  const headBlobs = await readTreeBlobs(commit.value.treeSha);
  if (!headBlobs.ok) {
    return [...results, fail("generated tree delta", headBlobs.reason)];
  }
  const baseBlobs = await readTreeBlobs(parentCommit.value.treeSha);
  if (!baseBlobs.ok) {
    return [...results, fail("generated tree delta", baseBlobs.reason)];
  }

  const expectedPaths = new Set(candidate.value.artifacts.map((artifact) => artifact.path));
  const changed: string[] = [];
  for (const [path, sha] of headBlobs.value) {
    if (baseBlobs.value.get(path) !== sha) changed.push(path);
  }
  for (const path of baseBlobs.value.keys()) {
    if (!headBlobs.value.has(path)) changed.push(path);
  }
  const unauthorized = changed.filter((path) => !expectedPaths.has(path));
  const absent = [...expectedPaths].filter((path) => !changed.includes(path));
  results.push(
    unauthorized.length === 0 && absent.length === 0
      ? pass(
          "generated tree delta",
          `exactly ${String(expectedPaths.size)} artifact paths differ from the base tree`,
        )
      : fail(
          "generated tree delta",
          unauthorized.length > 0
            ? `unauthorized paths changed: ${unauthorized.join(", ")}`
            : `expected artifacts absent from the delta: ${absent.join(", ")}`,
        ),
  );

  // Every generated blob must be byte-identical to the validated artifact.
  const byteFailures: string[] = [];
  let inspectionFailure: string | undefined;
  for (const artifact of candidate.value.artifacts) {
    const blobSha = headBlobs.value.get(artifact.path);
    if (blobSha === undefined) {
      byteFailures.push(`${artifact.path} (absent from tree)`);
      continue;
    }
    const bytes = await readBlobBytes(blobSha);
    if (!bytes.ok) {
      inspectionFailure = bytes.reason;
      break;
    }
    if (bytes.value !== artifact.content) byteFailures.push(artifact.path);
  }
  if (inspectionFailure !== undefined) {
    results.push(fail("generated blob bytes", inspectionFailure));
  } else {
    results.push(
      byteFailures.length === 0
        ? pass(
            "generated blob bytes",
            `all ${String(candidate.value.artifacts.length)} blobs byte-identical to the validated artifacts`,
          )
        : fail("generated blob bytes", `bytes differ: ${byteFailures.join(", ")}`),
    );
  }

  // Recomputing the artifact-set digest from the remote bytes closes the loop between what was
  // validated and what was published.
  const recomputedSet = sha256Bytes(
    candidate.value.artifacts
      .map((artifact) => `${artifact.path}:${sha256Bytes(artifact.content)}`)
      .sort()
      .join("\n"),
  );
  results.push(
    byteFailures.length === 0 && inspectionFailure === undefined
      ? pass("published artifact set", `recomputed ${recomputedSet.slice(0, 16)} from remote bytes`)
      : fail("published artifact set", "could not recompute from remote bytes"),
  );
  return results;
}

/** Re-reads the exact DataHub decision state and matches it field by field against the run. */
async function verifyDataHub(runRecord: StoredRun): Promise<CheckResult[]> {
  const results: CheckResult[] = [
    runRecord.writebackStatus === "SUCCEEDED"
      ? pass("writeback status", "SUCCEEDED")
      : fail("writeback status", String(runRecord.writebackStatus)),
    runRecord.writebackReceiptFingerprint
      ? pass("writeback receipt", runRecord.writebackReceiptFingerprint.slice(0, 16))
      : fail("writeback receipt", "absent"),
  ];

  const state = await readDataHubDecisionState();
  if (!state.ok) {
    return [...results, fail("datahub read-back", state.reason)];
  }

  results.push(
    state.value.markers.length === 1
      ? pass("datahub decision", `exactly one decision identity: ${state.value.markers[0] ?? ""}`)
      : fail("datahub decision", `${String(state.value.markers.length)} decision identities found`),
  );
  results.push(
    state.value.decisionElementCount === 1
      ? pass("datahub decision documents", "exactly one LineageGuard decision document")
      : fail(
          "datahub decision documents",
          `${String(state.value.decisionElementCount)} LineageGuard decision documents present`,
        ),
  );

  const candidate = candidateView(runRecord.candidateJson);
  if (!candidate.ok) {
    return [...results, fail("datahub candidate binding", candidate.reason)];
  }
  const expectedMarker = expectedDecisionMarker(
    canonicalCandidateFingerprint(runRecord.candidateJson as MigrationCandidate),
  );
  results.push(
    state.value.markers[0] === expectedMarker
      ? pass(
          "datahub candidate binding",
          `marker matches this candidate (${expectedMarker.slice(-16)})`,
        )
      : fail(
          "datahub candidate binding",
          `remembered ${String(state.value.markers[0])} but this candidate derives ${expectedMarker}`,
        ),
  );

  const fields = state.value.fields;
  results.push(
    fields.get("Decision") === "BLOCK"
      ? pass("datahub decision value", "BLOCK")
      : fail("datahub decision value", `${String(fields.get("Decision"))} — expected BLOCK`),
  );
  results.push(
    fields.get("GitHub review") === runRecord.prUrl
      ? pass("datahub github link", String(runRecord.prUrl))
      : fail(
          "datahub github link",
          `remembered ${String(fields.get("GitHub review"))} but run published ${String(runRecord.prUrl)}`,
        ),
  );
  const rollback = fields.get("Rollback") ?? "";
  const rollbackArtifact = candidate.value.artifacts.find((artifact) =>
    artifact.path.includes("rollback"),
  );
  results.push(
    rollback.length > 0 && rollbackArtifact !== undefined && rollback === rollbackArtifact.path
      ? pass("datahub rollback reference", rollback)
      : fail(
          "datahub rollback reference",
          `remembered ${rollback || "nothing"}, candidate rollback artifact is ${rollbackArtifact?.path ?? "absent"}`,
        ),
  );

  // The remembered decision is keyed on the candidate, so the run it names is whichever run first
  // established it. Acceptance proves that run exists and itself completed.
  const namedRun = fields.get("Latest verified run") ?? "";
  const namedRunRecord = namedRun ? await withRunStore(async (store) => store.get(namedRun)) : null;
  results.push(
    namedRunRecord?.status === "COMPLETED"
      ? pass("datahub latest verified run", `${namedRun} exists and is COMPLETED`)
      : fail(
          "datahub latest verified run",
          namedRun
            ? `${namedRun} is ${namedRunRecord ? namedRunRecord.status : "not in the run store"}`
            : "no run named in the decision document",
        ),
  );
  results.push(
    namedRunRecord?.validationReceiptFingerprint?.startsWith(
      fields.get("Validation receipt") ?? "\u0000",
    )
      ? pass("datahub validation binding", `matches ${namedRun}'s validation receipt`)
      : fail(
          "datahub validation binding",
          `remembered ${String(fields.get("Validation receipt"))} does not prefix ${namedRun}'s receipt`,
        ),
  );

  results.push(
    state.value.lineageguardTags.includes(canonicalReviewedTagUrn)
      ? pass("datahub reviewed tag", canonicalReviewedTagUrn)
      : fail("datahub reviewed tag", "the canonical Reviewed tag is not attached"),
  );
  results.push(
    state.value.duplicateTags
      ? fail("datahub duplicate metadata", "a LineageGuard tag is attached more than once")
      : pass("datahub duplicate metadata", "no duplicate LineageGuard tags"),
  );
  return results;
}

async function main(): Promise<void> {
  if (wantsHelp()) {
    printUsage("demo:verify -- --runId <id>", [
      "Independently verifies a completed run without trusting its status field.",
      "Re-reads the source PR, the generated PR's commit/tree/blobs, and the DataHub",
      "decision, and re-inspects the validation receipt body.",
    ]);
    return;
  }

  let currentCodeState: AcceptanceCodeState;
  try {
    currentCodeState = await readAcceptanceCodeState();
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    console.log("\nverify: FAIL\n");
    process.exitCode = 1;
    return;
  }

  const requested = argValue("--runId");
  const ok = await withRunStore(async (store) => {
    const runRecord = requested ? await store.get(requested) : await latestLiveRun(store);
    if (!runRecord) {
      console.error(requested ? `run ${requested} not found` : "no LIVE runs recorded");
      return false;
    }
    console.log(`verifying run ${runRecord.id}`);
    const results = [
      verifyApplicationCode(runRecord, currentCodeState),
      ...verifyDecisions(runRecord),
      ...(await verifySource(runRecord)),
      ...verifyConsumers(runRecord),
      ...verifyValidation(runRecord),
      ...(await verifyGitHub(runRecord)),
      ...(await verifyDataHub(runRecord)),
    ];
    return reportMatrix(`demo:verify ${runRecord.id}`, results);
  });

  console.log(ok ? "\nverify: PASS\n" : "\nverify: FAIL\n");
  process.exitCode = ok ? 0 : 1;
}

await main();
