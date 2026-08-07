/**
 * demo:verify — independently verify a completed run.
 *
 * Deliberately does not trust the pipeline's own status field. Every claim is re-derived from
 * persisted state or re-read from the remote system that was supposed to have been changed.
 *
 * Usage: pnpm demo:verify --runId <id>
 *        pnpm demo:verify            (verifies the most recent run)
 */
import {
  assertExactlyFourConsumers,
  canonicalConsumerKinds,
  deriveImpactConsumers,
  impactContextSchema,
} from "@lineageguard/domain";
import type { SimpleRun } from "@lineageguard/db";
import {
  argValue,
  type CheckResult,
  expectedRepository,
  fail,
  gmsUrl,
  loadEnv,
  pass,
  printUsage,
  readToken,
  reportMatrix,
  sourcePrNumber,
  wantsHelp,
  withRunStore,
} from "./demo-support.js";

loadEnv();

/** The store's own row type — a hand-rolled copy would drift from the schema. */
type StoredRun = SimpleRun;

function verifyDecisions(runRecord: StoredRun): CheckResult[] {
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
  ];
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

function verifySource(runRecord: StoredRun): CheckResult[] {
  const expected = sourcePrNumber();
  return [
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
}

function verifyValidation(runRecord: StoredRun): CheckResult[] {
  return [
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
}

async function verifyGitHub(runRecord: StoredRun): Promise<CheckResult[]> {
  const results: CheckResult[] = [];
  // The store keeps the URL, not the number; derive it so we can re-read the PR.
  const generatedPrNumber = Number.parseInt(runRecord.prUrl?.split("/").at(-1) ?? "", 10);
  if (!runRecord.prUrl || !Number.isInteger(generatedPrNumber)) {
    return [fail("generated pr", "no generated PR recorded")];
  }
  results.push(pass("generated pr", runRecord.prUrl));

  const token = process.env.GITHUB_TOKEN ?? "";
  if (token.length < 8) {
    return [...results, fail("generated pr state", "no GitHub token to re-read with")];
  }
  try {
    const response = await fetch(
      `https://api.github.com/repos/${expectedRepository()}/pulls/${String(generatedPrNumber)}`,
      {
        headers: {
          Accept: "application/vnd.github+json",
          Authorization: `Bearer ${token}`,
          "X-GitHub-Api-Version": "2022-11-28",
        },
        signal: AbortSignal.timeout(10_000),
      },
    );
    if (!response.ok) {
      results.push(fail("generated pr state", `HTTP ${String(response.status)} on re-read`));
      return results;
    }
    const pr = (await response.json()) as { draft?: boolean; state: string; head: { ref: string } };
    results.push(
      pr.state === "open"
        ? pass("generated pr state", "open")
        : fail("generated pr state", pr.state),
    );
    results.push(
      pr.draft === true
        ? pass("generated pr draft", "draft")
        : fail("generated pr draft", "not a draft"),
    );
    results.push(
      pr.head.ref.startsWith("lineageguard/generated/")
        ? pass("generated branch", `${pr.head.ref} is content-addressed`)
        : fail("generated branch", `${pr.head.ref} is not content-addressed`),
    );
  } catch {
    results.push(fail("generated pr state", "GitHub API unreachable"));
  }
  return results;
}

async function verifyDataHub(runRecord: StoredRun): Promise<CheckResult[]> {
  const results: CheckResult[] = [];
  results.push(
    runRecord.writebackStatus === "SUCCEEDED"
      ? pass("writeback status", "SUCCEEDED")
      : fail("writeback status", String(runRecord.writebackStatus)),
  );
  results.push(
    runRecord.writebackReceiptFingerprint
      ? pass("writeback receipt", runRecord.writebackReceiptFingerprint.slice(0, 16))
      : fail("writeback receipt", "absent"),
  );

  const token = readToken();
  if (token.length < 8) return [...results, fail("datahub read-back", "no read token")];
  const datasetUrn =
    "urn:li:dataset:(urn:li:dataPlatform:postgres,lineageguard-canonical.lineageguard.commerce.orders,PROD)";
  try {
    const response = await fetch(
      `${gmsUrl()}/aspects/${encodeURIComponent(datasetUrn)}?aspect=institutionalMemory&version=0`,
      { headers: { Authorization: `Bearer ${token}` }, signal: AbortSignal.timeout(10_000) },
    );
    if (!response.ok) {
      results.push(fail("datahub read-back", `HTTP ${String(response.status)}`));
      return results;
    }
    const body = await response.text();
    const markers = [...body.matchAll(/lineageguard:decision:v1:[A-Za-z0-9-]+/g)].map((m) => m[0]);
    const unique = [...new Set(markers)];
    results.push(
      unique.length === 1
        ? pass("datahub decision", `exactly one decision identity: ${unique[0] ?? ""}`)
        : fail("datahub decision", `${String(unique.length)} decision identities found`),
    );
    results.push(
      unique[0]?.includes("candidate-")
        ? pass("decision identity", "content-addressed, not run-scoped")
        : fail("decision identity", "not content-addressed"),
    );
  } catch {
    results.push(fail("datahub read-back", "GMS unreachable"));
  }
  return results;
}

async function main(): Promise<void> {
  if (wantsHelp()) {
    printUsage("demo:verify --runId <id>", [
      "Independently verifies a completed run without trusting its status field.",
      "Re-derives consumers from the persisted context, re-reads the generated PR",
      "from GitHub, and re-reads the decision from DataHub.",
    ]);
    return;
  }

  const requested = argValue("--runId");
  const ok = await withRunStore(async (store) => {
    const runRecord = requested ? await store.get(requested) : ((await store.list(1))[0] ?? null);
    if (!runRecord) {
      console.error(requested ? `run ${requested} not found` : "no runs recorded");
      return false;
    }
    console.log(`verifying run ${runRecord.id}`);
    const results = [
      ...verifyDecisions(runRecord),
      ...verifySource(runRecord),
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
