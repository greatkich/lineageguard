import { createHash, generateKeyPairSync, sign, verify } from "node:crypto";
import {
  canonicalDatasetUrn,
  canonicalFieldPath,
  canonicalGlossaryTermUrn,
  canonicalImpactRequest,
  canonicalNativeFieldPath,
  canonicalSchemaFieldUrn,
  computeImpactCollectionFingerprint,
  computeImpactContextFingerprint,
  createEvidence,
  type ImpactContext,
  type ImpactContextData,
  impactCollectionResultSchema,
  impactContextSchema,
  impactResolutionSchema,
  liveValidationSignedPayloadFingerprint,
  migrationArtifactFingerprint,
  migrationCandidateFingerprint,
  migrationCandidateSchema,
  type RunStatus,
  sha256,
  signedLiveValidationReceiptFingerprint,
  signedLiveValidationReceiptSchema,
  stableId,
  validationArtifactSetFingerprint,
  validationOutputFingerprint,
} from "@lineageguard/domain";
import pg from "pg";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { requireLocalIntegrationUrl, requireLocalMigrationIntegrationUrl } from "./config.js";
import { CorruptDataError, IdempotencyConflictError } from "./errors.js";
import { newEventId } from "./ids.js";
import {
  grantApprovalAuthorityPrivileges,
  grantEffectAuthorityPrivileges,
  grantRuntimePrivileges,
  grantValidationSignerPrivileges,
  MIGRATIONS,
  migrate,
} from "./migrations.js";
import {
  ApprovalAuthorityStore,
  EffectInvocationAuthority,
  effectApprovalSignedPayloadFingerprint,
  effectInputFingerprint,
  RunStore,
  ValidationSignerStore,
  type ApprovalAuthorityPort,
  type EffectApprovalAssertion,
  type ValidationAuthorityBinding,
  type ValidationAuthorityPort,
  type VerifiedLiveValidation,
} from "./store.js";
import type { RunRecord } from "./types.js";

const { Pool } = pg;
type Payload = { value: string };
type ReceiptPayload = Payload & {
  intentId: string;
  runId: string;
  effectKind: "GITHUB_REVIEW" | "DATAHUB_WRITEBACK";
  target: string;
  inputFingerprint: string;
  validationReceiptId: string;
  candidateFingerprint: string;
  artifactSetFingerprint: string;
};

const objectCodec = {
  parse(value: unknown): Payload {
    if (
      typeof value !== "object" ||
      value === null ||
      !("value" in value) ||
      typeof value.value !== "string"
    ) {
      throw new TypeError("expected an object with a string value");
    }
    return { value: value.value };
  },
};

const receiptCodec = {
  parse(value: unknown): ReceiptPayload {
    const base = objectCodec.parse(value);
    if (typeof value !== "object" || value === null) throw new TypeError("receipt expected");
    const item = value as Record<string, unknown>;
    if (
      typeof item.runId !== "string" ||
      typeof item.intentId !== "string" ||
      typeof item.target !== "string" ||
      (item.effectKind !== "GITHUB_REVIEW" && item.effectKind !== "DATAHUB_WRITEBACK") ||
      typeof item.inputFingerprint !== "string" ||
      typeof item.validationReceiptId !== "string" ||
      typeof item.candidateFingerprint !== "string" ||
      typeof item.artifactSetFingerprint !== "string"
    ) {
      throw new TypeError("receipt binding expected");
    }
    return {
      ...base,
      intentId: item.intentId,
      runId: item.runId,
      effectKind: item.effectKind,
      target: item.target,
      inputFingerprint: item.inputFingerprint,
      validationReceiptId: item.validationReceiptId,
      candidateFingerprint: item.candidateFingerprint,
      artifactSetFingerprint: item.artifactSetFingerprint,
    };
  },
};

const codecs = {
  run: objectCodec,
  bundle: objectCodec,
  decision: objectCodec,
  migration: migrationCandidateSchema,
  validation: signedLiveValidationReceiptSchema,
  effectInput: objectCodec,
  effectReceipt: receiptCodec,
  effectFailure: objectCodec,
};

const payload = (value: string): Payload => ({ value });
const inputFingerprint = (value = "input") => effectInputFingerprint(payload(value));

const collectedAt = "2026-08-04T08:00:00.000Z";
const provenance = (
  role: "RESOLUTION" | "GLOSSARY_BINDING" | "GLOSSARY_DETAILS",
  tool: "search" | "list_schema_fields" | "get_entities",
  invocationId: string,
) => ({
  source: "DATAHUB_MCP" as const,
  role,
  tool,
  invocationId,
  retrievedAt: collectedAt,
  responseFingerprint: sha256(`response:${invocationId}`),
});

function commonImpactContext(changeId: string): Omit<ImpactContextData, "collectionOrigin"> {
  const resolution = impactResolutionSchema.parse({
    requested: canonicalImpactRequest,
    datasetUrn: canonicalDatasetUrn,
    schemaFieldUrn: canonicalSchemaFieldUrn,
    nativeFieldPath: canonicalNativeFieldPath,
    provenance: [provenance("RESOLUTION", "search", "resolution")],
  });
  const glossary = createEvidence({
    kind: "GLOSSARY_TERM",
    sourceUrn: canonicalDatasetUrn,
    targetUrn: canonicalGlossaryTermUrn,
    fieldPath: canonicalFieldPath,
    title: "Customer Identifier",
    summary: "The source field carries the governed Customer Identifier term.",
    criticality: "HIGH",
    relatedEvidenceIds: [],
    provenance: [
      provenance("GLOSSARY_BINDING", "list_schema_fields", "glossary-binding"),
      provenance("GLOSSARY_DETAILS", "get_entities", "glossary-details"),
    ],
    payload: {
      termUrn: canonicalGlossaryTermUrn,
      name: "Customer Identifier",
      schemaFieldUrn: canonicalSchemaFieldUrn,
      fieldPath: canonicalFieldPath,
    },
  });
  return {
    changeId,
    datasetUrn: canonicalDatasetUrn,
    fieldPath: canonicalFieldPath,
    resolution,
    collectedAt,
    collectionStatus: "PARTIAL" as const,
    evidence: [glossary],
    failures: [
      {
        tool: "get_lineage" as const,
        invocationId: "lineage-timeout",
        code: "TIMEOUT" as const,
        message: "Lineage collection timed out.",
      },
    ],
  };
}

function liveImpactContext(changeId = `chg_${"c".repeat(24)}`): ImpactContext {
  const common = commonImpactContext(changeId);
  const data = { ...common, collectionOrigin: { mode: "LIVE" as const } };
  return impactContextSchema.parse({
    ...data,
    impactContextFingerprint: computeImpactContextFingerprint(data),
    collectionFingerprint: computeImpactCollectionFingerprint(data),
  });
}

function replayImpactContext(changeId = `chg_${"d".repeat(24)}`): ImpactContext {
  const live = liveImpactContext(changeId);
  const common = commonImpactContext(changeId);
  const data = {
    ...common,
    collectionOrigin: {
      mode: "VERIFIED_REPLAY" as const,
      manifestFingerprint: sha256(`manifest:${changeId}`),
      sourceLiveCollectionFingerprint: live.collectionFingerprint,
      sourceImpactContextFingerprint: live.impactContextFingerprint,
    },
  };
  return impactContextSchema.parse({
    ...data,
    impactContextFingerprint: computeImpactContextFingerprint(data),
    collectionFingerprint: computeImpactCollectionFingerprint(data),
  });
}

const checkCommands = {
  SQL_MIGRATION: "VALIDATE_SQL_MIGRATION_V1",
  BACKFILL_EQUALITY: "VALIDATE_BACKFILL_EQUALITY_V1",
  DBT_PARSE: "VALIDATE_DBT_PARSE_V1",
  DBT_COMPILE: "VALIDATE_DBT_COMPILE_V1",
  DBT_TEST: "VALIDATE_DBT_TEST_V1",
  OLD_CONSUMER_COMPATIBILITY: "VALIDATE_OLD_CONSUMER_V1",
  NEW_CONSUMER_COMPATIBILITY: "VALIDATE_NEW_CONSUMER_V1",
  ROLLBACK: "VALIDATE_ROLLBACK_V1",
} as const;

function validationCandidate(
  impactContextFingerprint = liveImpactContext().impactContextFingerprint,
) {
  const evidenceId = "ev_aaaaaaaaaaaaaaaaaaaaaaaa";
  return migrationCandidateSchema.parse({
    strategy: "EXPAND_MIGRATE_CONTRACT",
    sourceChangeFingerprint: "1".repeat(64),
    sourcePatchFingerprint: "2".repeat(64),
    sourceImpactContextFingerprint: impactContextFingerprint,
    sourceDecision: "BLOCK",
    sourceEvidenceIds: [evidenceId],
    summary: "Safe expand, migrate, and contract sequence.",
    steps: [
      {
        id: "step_expand",
        phase: "EXPAND",
        title: "Expand",
        rationale: "Keep the old contract available.",
        affectedEvidenceIds: [evidenceId],
        artifactTargets: [
          "walkthrough/migrations/001_expand.sql",
          "walkthrough/migrations/001_rollback.sql",
        ],
      },
      {
        id: "step_migrate",
        phase: "MIGRATE",
        title: "Migrate",
        rationale: "Move controlled consumers.",
        affectedEvidenceIds: [evidenceId],
        artifactTargets: ["walkthrough/models/orders.sql", "walkthrough/tests/orders.sql"],
      },
      {
        id: "step_contract",
        phase: "CONTRACT",
        title: "Contract",
        rationale: "Retire after the compatibility window.",
        affectedEvidenceIds: [evidenceId],
        artifactTargets: ["docs/migrations/orders.md"],
      },
    ],
    artifacts: [
      {
        operation: "CREATE",
        path: "docs/migrations/orders.md",
        kind: "MIGRATION_DOCUMENT",
        content: "Migration and rollback plan.",
      },
      {
        operation: "CREATE",
        path: "walkthrough/migrations/001_expand.sql",
        kind: "SQL_MIGRATION",
        content: "alter table commerce.orders add column buyer_id uuid;",
      },
      {
        operation: "CREATE",
        path: "walkthrough/migrations/001_rollback.sql",
        kind: "ROLLBACK_SQL",
        content: "alter table commerce.orders drop column buyer_id;",
      },
      {
        operation: "MODIFY",
        expectedBaseSha: "4".repeat(40),
        path: "walkthrough/models/orders.sql",
        kind: "DBT_MODEL",
        content: "select customer_id,buyer_id from commerce.orders",
      },
      {
        operation: "CREATE",
        path: "walkthrough/tests/orders.sql",
        kind: "DBT_TEST",
        content: "select * from commerce.orders where customer_id<>buyer_id",
      },
    ],
    requiredReviewers: [
      {
        kind: "OWNER",
        ownerUrn: "urn:li:corpuser:data-owner",
        affectedAssetUrns: ["urn:li:dataset:orders"],
        reason: "Recorded owner.",
      },
    ],
    compatibilityWindowDays: 30,
    rollbackPlan: "Apply the rollback artifact before contract.",
  });
}

function signedReceipt(
  candidate: ReturnType<typeof validationCandidate>,
  run: RunRecord<Payload>,
  events: ValidationAuthorityBinding["authorizedRunEventStream"],
  privateKey: ReturnType<typeof generateKeyPairSync>["privateKey"],
) {
  if (!run.leaseId || !run.workerId || !run.leaseExpiresAt) throw new Error("lease required");
  const leaseId = run.leaseId;
  const workerId = run.workerId;
  const leaseExpiresAt = run.leaseExpiresAt;
  const acquired = events.find((event) => event.type === "RUN_LEASE_ACQUIRED");
  if (acquired?.type !== "RUN_LEASE_ACQUIRED") throw new Error("acquisition required");
  const observations = candidate.artifacts.map((artifact) => ({
    path: artifact.path,
    candidateArtifactFingerprint: migrationArtifactFingerprint(artifact),
    materializedSha256: sha256(artifact.content),
  }));
  const pathsFor = (check: keyof typeof checkCommands) =>
    candidate.artifacts
      .filter((artifact) => {
        if (check === "ROLLBACK") return artifact.kind === "ROLLBACK_SQL";
        if (check === "SQL_MIGRATION" || check === "BACKFILL_EQUALITY")
          return artifact.kind === "SQL_MIGRATION";
        if (check === "DBT_PARSE" || check === "DBT_COMPILE" || check === "DBT_TEST")
          return artifact.kind === "DBT_MODEL" || artifact.kind === "DBT_TEST";
        return ["SQL_MIGRATION", "DBT_MODEL", "DBT_TEST"].includes(artifact.kind);
      })
      .map((artifact) => artifact.path)
      .sort();
  const started = new Date(acquired.occurredAt).getTime() + 10;
  const checks = Object.entries(checkCommands).map(([name, commandId], index) => {
    const check = name as keyof typeof checkCommands;
    const artifactPaths = pathsFor(check);
    const artifactObservations = observations.filter((item) => artifactPaths.includes(item.path));
    const stdoutFingerprint = sha256(`${check}:stdout`);
    const stderrFingerprint = sha256(`${check}:stderr`);
    return {
      check,
      status: "PASS" as const,
      artifactPaths,
      artifactObservations,
      artifactSetFingerprint: validationArtifactSetFingerprint(artifactObservations),
      validatorImplementationId: `lineageguard-${check.toLowerCase()}`,
      validatorVersion: "1.0.0",
      validatorDigest: sha256(`validator:${check}`),
      commandId,
      exitCode: 0 as const,
      startedAt: new Date(started + index * 2).toISOString(),
      finishedAt: new Date(started + index * 2 + 1).toISOString(),
      runId: run.id,
      sandboxId: "sandbox-db-integration",
      worktreeId: "worktree-db-integration",
      leaseId,
      workerId,
      generation: run.leaseGeneration,
      stdoutFingerprint,
      stderrFingerprint,
      outputFingerprint: validationOutputFingerprint({
        schemaVersion: 1,
        purpose: "LINEAGEGUARD_VALIDATOR_OUTPUT",
        check,
        exitCode: 0,
        stdoutFingerprint,
        stderrFingerprint,
        artifactObservations,
      }),
    };
  });
  const unsigned = {
    protectedHeaders: {
      schemaVersion: 1 as const,
      purpose: "LINEAGEGUARD_VALIDATION_LIVE" as const,
      algorithm: "ED25519" as const,
      issuer: "lineageguard-db-integration",
      keyId: "db-integration-key",
      candidateFingerprint: migrationCandidateFingerprint(candidate),
      changeFingerprint: candidate.sourceChangeFingerprint,
      impactContextFingerprint: candidate.sourceImpactContextFingerprint,
      authoritativeGroundedAssessmentFingerprint: "5".repeat(64),
      authoritativeGroundedDecision: "BLOCK" as const,
      authorizedRunEventStreamFingerprint: sha256({
        domain: "lineageguard.validation.authorized-run-stream.v1",
        events,
      }),
      leaseAcquiredAt: acquired.occurredAt,
      leaseExpiresAt: leaseExpiresAt.toISOString(),
      runId: run.id,
      sandboxId: "sandbox-db-integration",
      worktreeId: "worktree-db-integration",
      leaseId,
      workerId,
      generation: run.leaseGeneration,
    },
    payload: {
      status: "PASS" as const,
      artifactPaths: candidate.artifacts.map((artifact) => artifact.path),
      artifactObservations: observations,
      artifactSetFingerprint: validationArtifactSetFingerprint(observations),
      checks,
      completedAt: new Date(started + 20).toISOString(),
    },
  };
  const fingerprint = liveValidationSignedPayloadFingerprint(unsigned);
  return signedLiveValidationReceiptSchema.parse({
    ...unsigned,
    signedPayloadFingerprint: fingerprint,
    signature: sign(null, Buffer.from(fingerprint), privateKey).toString("base64url"),
  });
}

const hasIntegrationDb = Boolean(process.env.LINEAGEGUARD_TEST_MIGRATION_DATABASE_URL);

describe.skipIf(!hasIntegrationDb)("domain-bound durable run store", () => {
  let migrationPool: InstanceType<typeof Pool> = undefined!;
  let runtimePool: InstanceType<typeof Pool> = undefined!;
  let signerPool: InstanceType<typeof Pool> = undefined!;
  let approvalPool: InstanceType<typeof Pool> = undefined!;
  let effectPool: InstanceType<typeof Pool> = undefined!;
  const keys = generateKeyPairSync("ed25519");
  const approvalKeys = generateKeyPairSync("ed25519");

  beforeAll(() => {
    migrationPool = new Pool({
      connectionString: requireLocalMigrationIntegrationUrl(
        process.env.LINEAGEGUARD_TEST_MIGRATION_DATABASE_URL,
      ),
    });
    runtimePool = new Pool({
      connectionString: requireLocalIntegrationUrl(process.env.LINEAGEGUARD_TEST_DATABASE_URL),
      max: 8,
    });
    signerPool = new Pool({
      connectionString: requireLocalIntegrationUrl(
        process.env.LINEAGEGUARD_TEST_VALIDATION_SIGNER_DATABASE_URL,
      ),
      max: 8,
    });
    approvalPool = new Pool({
      connectionString: requireLocalIntegrationUrl(
        process.env.LINEAGEGUARD_TEST_APPROVAL_AUTHORITY_DATABASE_URL,
      ),
      max: 8,
    });
    effectPool = new Pool({
      connectionString: requireLocalIntegrationUrl(
        process.env.LINEAGEGUARD_TEST_EFFECT_AUTHORITY_DATABASE_URL,
      ),
      max: 8,
    });
  });
  const bindingBases = new Map<
    string,
    Omit<ValidationAuthorityBinding, "candidate" | "authorizedRunEventStream">
  >();
  const authority: ValidationAuthorityPort = {
    verifyHistoricalLive(input, binding) {
      const receipt = signedLiveValidationReceiptSchema.parse(input);
      const eventFingerprint = sha256({
        domain: "lineageguard.validation.authorized-run-stream.v1",
        events: binding.authorizedRunEventStream,
      });
      if (
        receipt.protectedHeaders.candidateFingerprint !==
          migrationCandidateFingerprint(binding.candidate) ||
        receipt.protectedHeaders.authorizedRunEventStreamFingerprint !== eventFingerprint ||
        !verify(
          null,
          Buffer.from(receipt.signedPayloadFingerprint),
          keys.publicKey,
          Buffer.from(receipt.signature, "base64url"),
        )
      ) {
        throw new Error("signed validation receipt is not trusted");
      }
      return { receipt } as VerifiedLiveValidation;
    },
  };
  const approvalAuthority: ApprovalAuthorityPort = {
    verify(input, expectedPayload) {
      const assertion = input as EffectApprovalAssertion;
      if (
        !assertion ||
        sha256(assertion.payload) !== sha256(expectedPayload) ||
        assertion.signedPayloadFingerprint !== effectApprovalSignedPayloadFingerprint(assertion) ||
        !verify(
          null,
          Buffer.from(assertion.signedPayloadFingerprint),
          approvalKeys.publicKey,
          Buffer.from(assertion.signature, "base64url"),
        )
      ) {
        throw new Error("approval assertion is not trusted");
      }
      return assertion;
    },
  };
  const options = {
    mutationMode: "WALKTHROUGH",
    validationAuthority: authority,
    approvalAuthority,
    validationBindingForRun: async (runId: string) => {
      const binding = bindingBases.get(runId);
      if (!binding) throw new Error("validation binding missing");
      return binding;
    },
  } as const;
  const productionOptions = {
    mutationMode: "PRODUCTION",
    validationAuthority: authority,
    approvalAuthority,
    validationBindingForRun: async (runId: string) => {
      const binding = bindingBases.get(runId);
      if (!binding) throw new Error("validation binding missing");
      return binding;
    },
  } as const;
  const store = new RunStore(runtimePool, codecs, options);
  const validationStore = new ValidationSignerStore(signerPool, codecs, options);
  const approvalStore = new ApprovalAuthorityStore(approvalPool, codecs, options);
  const effectStore = new EffectInvocationAuthority(effectPool, codecs, options);
  const productionEffectStore = new EffectInvocationAuthority(
    effectPool,
    codecs,
    productionOptions,
  );

  beforeAll(async () => {
    await migrate(migrationPool);
    await migrate(migrationPool);
    await grantRuntimePrivileges(migrationPool, "lineageguard_runtime");
    await grantValidationSignerPrivileges(migrationPool, "lineageguard_validation_signer");
    await grantApprovalAuthorityPrivileges(migrationPool, "lineageguard_approval_authority");
    await grantEffectAuthorityPrivileges(migrationPool, "lineageguard_effect_authority");
  });

  beforeEach(async () => {
    await migrationPool.query("TRUNCATE lineageguard.runs CASCADE");
    bindingBases.clear();
  });

  it("keeps critical authority tables and procedures outside runtime credentials", async () => {
    const criticalTables = [
      "validation_receipts",
      "effect_approvals",
      "external_effect_intents",
      "external_effect_attempts",
      "external_effect_receipts",
      "external_effect_failures",
      "external_effect_reconciliations",
      "effect_invocation_reservations",
    ];
    for (const table of criticalTables) {
      await expect(
        runtimePool.query(`DELETE FROM lineageguard.${table} WHERE false`),
      ).rejects.toThrow(/permission denied/);
      for (const authorityPool of [signerPool, approvalPool, effectPool]) {
        await expect(
          authorityPool.query(`DELETE FROM lineageguard.${table} WHERE false`),
        ).rejects.toThrow(/permission denied/);
      }
    }
    await expect(
      runtimePool.query("SELECT * FROM lineageguard.signer_lock_validation_run($1::text)", [
        "run_deadbeefdeadbeefdeadbeef",
      ]),
    ).rejects.toThrow(/permission denied/);
    for (const wrongPool of [approvalPool, effectPool]) {
      await expect(
        wrongPool.query("SELECT * FROM lineageguard.signer_lock_validation_run($1::text)", [
          `run_${"d".repeat(24)}`,
        ]),
      ).rejects.toThrow(/permission denied/);
    }
    const signerCapabilities = await signerPool.query<{ approval: boolean; effect: boolean }>(
      `SELECT
        has_function_privilege(current_user,
          'lineageguard.approval_insert_effect_approval(text,text,text,text,text,text,text,timestamptz,text,timestamptz,timestamptz,jsonb,text,jsonb,text,text,integer,bigint)',
          'EXECUTE') AS approval,
        has_function_privilege(current_user,
          'lineageguard.effect_consume_current(text,text,text,text,text,text,text,text,text,text,text,text,text)',
          'EXECUTE') AS effect`,
    );
    expect(signerCapabilities.rows[0]).toEqual({ approval: false, effect: false });
    const approvalCapabilities = await approvalPool.query<{ signer: boolean; effect: boolean }>(
      `SELECT
        has_function_privilege(current_user,
          'lineageguard.signer_insert_validation_receipt(text,text,integer,jsonb,text,text,integer,bigint)',
          'EXECUTE') AS signer,
        has_function_privilege(current_user,
          'lineageguard.effect_consume_current(text,text,text,text,text,text,text,text,text,text,text,text,text)',
          'EXECUTE') AS effect`,
    );
    expect(approvalCapabilities.rows[0]).toEqual({ signer: false, effect: false });
    const effectCapabilities = await effectPool.query<{ signer: boolean; approval: boolean }>(
      `SELECT
        has_function_privilege(current_user,
          'lineageguard.signer_insert_validation_receipt(text,text,integer,jsonb,text,text,integer,bigint)',
          'EXECUTE') AS signer,
        has_function_privilege(current_user,
          'lineageguard.approval_insert_effect_approval(text,text,text,text,text,text,text,timestamptz,text,timestamptz,timestamptz,jsonb,text,jsonb,text,text,integer,bigint)',
          'EXECUTE') AS approval`,
    );
    expect(effectCapabilities.rows[0]).toEqual({ signer: false, approval: false });
    for (const narrowPool of [signerPool, approvalPool, effectPool]) {
      await expect(
        narrowPool.query("UPDATE lineageguard.runs SET status='FAILED' WHERE false"),
      ).rejects.toThrow(/permission denied/);
    }
    await expect(
      runtimePool.query("SELECT token_hash FROM lineageguard.effect_invocation_reservations"),
    ).rejects.toThrow(/permission denied/);
    await expect(
      runtimePool.query("SELECT approved_by FROM lineageguard.effect_approvals"),
    ).rejects.toThrow(/permission denied/);
  });

  it("owns authority procedures with a NOLOGIN role and a fixed search path", async () => {
    const result = await migrationPool.query<{
      proname: string;
      prosecdef: boolean;
      rolname: string;
      rolcanlogin: boolean;
      proconfig: string[] | null;
    }>(
      `SELECT p.proname,p.prosecdef,r.rolname,r.rolcanlogin,p.proconfig
       FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
       JOIN pg_roles r ON r.oid=p.proowner
       WHERE n.nspname='lineageguard' AND p.prosecdef`,
    );
    expect(result.rows.length).toBeGreaterThanOrEqual(12);
    for (const row of result.rows) {
      expect(row).toMatchObject({
        prosecdef: true,
        rolname: "lineageguard_procedure_owner",
        rolcanlogin: false,
      });
      expect(row.proconfig).toContain("search_path=pg_catalog, lineageguard");
    }
    const schemaCreate = await migrationPool.query<{ allowed: boolean }>(
      `SELECT has_schema_privilege(
        'lineageguard_procedure_owner','lineageguard','CREATE'
      ) AS allowed`,
    );
    expect(schemaCreate.rows[0]?.allowed).toBe(false);
  });

  afterAll(async () => {
    await Promise.all([
      signerPool.end(),
      approvalPool.end(),
      effectPool.end(),
      runtimePool.end(),
      migrationPool.end(),
    ]);
  });

  async function create(
    requestKey = `request-${crypto.randomUUID()}`,
    executionMode: "LIVE" | "VERIFIED_REPLAY" = "LIVE",
  ) {
    return store.createRun({
      requestKey,
      inputFingerprint: inputFingerprint(),
      executionMode,
      payload: { value: "run", ignored: "removed" },
      nextAttemptAt: new Date("2020-01-01T00:00:00.000Z"),
    });
  }

  function statusEvent(run: RunRecord<Payload>, sequence: number, from: RunStatus, to: RunStatus) {
    if (!run.leaseId || !run.workerId || !run.leaseExpiresAt)
      throw new Error("active lease required");
    return {
      eventId: newEventId(),
      runId: run.id,
      sequence,
      occurredAt: new Date(Math.min(Date.now(), run.leaseExpiresAt.getTime() - 1)).toISOString(),
      type: "RUN_STATUS_CHANGED" as const,
      leaseId: run.leaseId,
      workerId: run.workerId,
      generation: run.leaseGeneration,
      from,
      to,
    };
  }

  async function advance(
    run: RunRecord<Payload>,
    path: readonly RunStatus[],
    firstSequence = 1,
  ): Promise<RunRecord<Payload>> {
    let current = run;
    let sequence = firstSequence;
    for (const next of path) {
      current = (
        await store.transition(
          statusEvent(current, sequence, current.status, next),
          current.version,
        )
      ).run;
      sequence += 1;
    }
    return current;
  }

  async function validatedRun(
    context: ImpactContext = liveImpactContext(),
    leaseMillis = 60_000,
  ): Promise<RunRecord<Payload>> {
    await create(`request-${crypto.randomUUID()}`, context.collectionOrigin.mode);
    const claimed = await store.claimDue("validation-worker", leaseMillis);
    if (!claimed?.leaseId || !claimed.workerId) throw new Error("claim required");
    const collection = await store.appendImpactCollectionResult(
      claimed.id,
      {
        leaseId: claimed.leaseId,
        workerId: claimed.workerId,
        generation: claimed.leaseGeneration,
        fencingVersion: claimed.version,
      },
      {
        outcome:
          context.collectionOrigin.mode === "LIVE" ? "COLLECTED_LIVE" : "COLLECTED_VERIFIED_REPLAY",
        context,
      },
    );
    let current = await advance({ ...claimed, version: collection.version }, [
      "CHANGE_PARSED",
      "BASELINE_ASSESSED",
      "CONTEXT_COLLECTING",
      "CONTEXT_COLLECTED",
      "RISK_DECIDED",
      "MIGRATION_PLANNED",
      "PATCH_GENERATED",
    ]);
    const candidate = validationCandidate(context.impactContextFingerprint);
    const appendedCandidate = await store.appendMigrationCandidate(
      current.id,
      {
        leaseId: current.leaseId as string,
        workerId: current.workerId as string,
        generation: current.leaseGeneration,
        fencingVersion: current.version,
      },
      candidate,
    );
    current = { ...current, version: appendedCandidate.version };
    current = (
      await store.transition(
        statusEvent(current, 8, "PATCH_GENERATED", "VALIDATING"),
        current.version,
      )
    ).run;
    const events = (await store.snapshot(current.id)).events.map((event) => event.payload);
    bindingBases.set(current.id, {
      change: {} as never,
      context,
      authoritativeAssessment: {} as never,
      expectedExecution: {} as never,
    });
    const receipt = signedReceipt(candidate, current, events, keys.privateKey);
    const validationGuard = {
      leaseId: current.leaseId as string,
      workerId: current.workerId as string,
      generation: current.leaseGeneration,
      fencingVersion: current.version,
    };
    if (current.executionMode === "LIVE") {
      const binding = await validationStore.loadValidationExecutionClaim(current.id);
      let issuedUnderLock = false;
      await validationStore.issueAndStoreValidationReceipt(
        {
          runId: current.id,
          claimedBindingFingerprint: sha256({
            domain: "lineageguard.validation-authority-binding.v1",
            change: binding.change,
            context: binding.context,
            assessment: binding.authoritativeAssessment,
            candidate: binding.candidate,
            expectedExecution: binding.expectedExecution,
          }),
          claimedRunEventStreamFingerprint: sha256({
            domain: "lineageguard.validation.authorized-run-stream.v1",
            events: binding.authorizedRunEventStream,
          }),
          candidateFingerprint: migrationCandidateFingerprint(binding.candidate),
          expectedExecutionFingerprint: sha256(binding.expectedExecution),
          leaseId: validationGuard.leaseId,
          workerId: validationGuard.workerId,
          generation: validationGuard.generation,
        },
        (lockedBinding, trustedDatabaseTime) => {
          expect(lockedBinding).toEqual(binding);
          expect(new Date(trustedDatabaseTime).getTime()).toBeGreaterThan(0);
          issuedUnderLock = true;
          return receipt;
        },
      );
      expect(issuedUnderLock).toBe(true);
    } else {
      const base = bindingBases.get(current.id);
      if (!base) throw new Error("replay validation binding required");
      authority.verifyHistoricalLive(receipt, {
        ...base,
        candidate,
        authorizedRunEventStream: events,
      });
      await migrationPool.query(
        `INSERT INTO lineageguard.validation_receipts(id,run_id,position,payload)
         VALUES($1,$2,1,$3)`,
        [stableId("val", receipt), current.id, receipt],
      );
      await migrationPool.query(
        "UPDATE lineageguard.runs SET version=version+1,updated_at=clock_timestamp() WHERE id=$1",
        [current.id],
      );
    }
    current = (await store.snapshot(current.id)).run;
    return (
      await store.transition(statusEvent(current, 9, "VALIDATING", "VALIDATED"), current.version)
    ).run;
  }

  async function effectReceipt(
    run: RunRecord<Payload>,
    intent: {
      id: string;
      kind: "GITHUB_REVIEW" | "DATAHUB_WRITEBACK";
      target: string;
      inputFingerprint: string;
    },
    value = "receipt",
  ): Promise<ReceiptPayload> {
    const validation = (await store.snapshot(run.id)).validationReceipts.at(-1)?.payload;
    if (!validation) throw new Error("validation receipt required");
    return {
      value,
      intentId: intent.id,
      runId: run.id,
      effectKind: intent.kind,
      target: intent.target,
      inputFingerprint: intent.inputFingerprint,
      validationReceiptId: stableId("val", validation),
      candidateFingerprint: validation.protectedHeaders.candidateFingerprint,
      artifactSetFingerprint: validation.payload.artifactSetFingerprint,
    };
  }

  async function approvalTimes(durationMillis: number) {
    const result = await migrationPool.query<{ now: Date }>("SELECT clock_timestamp() AS now");
    const now = result.rows[0]?.now;
    if (!now) throw new Error("database time required");
    return { approvedAt: now, expiresAt: new Date(now.getTime() + durationMillis) };
  }

  async function approveCurrentEffect(input: {
    runId: string;
    kind: "GITHUB_REVIEW" | "DATAHUB_WRITEBACK";
    target: string;
    inputFingerprint: string;
    durationMillis?: number;
    assertionSchemaVersion?: number;
  }) {
    const snapshot = await store.snapshot(input.runId);
    const validation = snapshot.validationReceipts.at(-1)?.payload;
    if (!validation) throw new Error("validation receipt required");
    const times = await approvalTimes(input.durationMillis ?? 60_000);
    const approvalPayload = {
      domain: "lineageguard.effect-approval.v2" as const,
      runId: input.runId,
      effectKind:
        input.kind === "GITHUB_REVIEW" ? ("GITHUB_WRITE" as const) : ("DATAHUB_WRITE" as const),
      target: input.target,
      inputFingerprint: input.inputFingerprint,
      validationReceiptId: stableId("val", validation),
      validationReceiptFingerprint: signedLiveValidationReceiptFingerprint(validation),
      validationCompletedAt: validation.payload.completedAt,
      approvedBy: "reviewer@example.invalid",
      approvedAt: times.approvedAt.toISOString(),
      expiresAt: times.expiresAt.toISOString(),
    };
    const unsigned = {
      protectedHeaders: {
        schemaVersion: input.assertionSchemaVersion ?? 2,
        purpose: "LINEAGEGUARD_EFFECT_APPROVAL" as const,
        algorithm: "ED25519" as const,
        issuer: "lineageguard-db-integration",
        keyId: "db-integration-approval-key",
        nonce: crypto.randomUUID(),
      },
      payload: approvalPayload,
    };
    const signedPayloadFingerprint = sha256({
      domain: "lineageguard.effect-approval-assertion.v2",
      protectedHeaders: unsigned.protectedHeaders,
      payload: unsigned.payload,
    });
    return approvalStore.recordEffectApproval({
      ...input,
      guard: {
        leaseId: snapshot.run.leaseId as string,
        workerId: snapshot.run.workerId as string,
        generation: snapshot.run.leaseGeneration,
        fencingVersion: snapshot.run.version,
      },
      approvedBy: approvalPayload.approvedBy,
      ...times,
      assertion: {
        ...unsigned,
        signedPayloadFingerprint,
        signature: sign(
          null,
          Buffer.from(signedPayloadFingerprint),
          approvalKeys.privateKey,
        ).toString("base64url"),
      },
    });
  }

  async function consumeIntent(
    intentId: string,
    _workerId: string,
    _claimMillis: number,
    authorityStore = effectStore,
  ) {
    const intentResult = await migrationPool.query<{
      run_id: string;
      kind: "GITHUB_REVIEW" | "DATAHUB_WRITEBACK";
      target: string;
      idempotency_key: string;
      input_fingerprint: string;
      validation_receipt_id: string;
    }>("SELECT * FROM lineageguard.external_effect_intents WHERE id=$1", [intentId]);
    const intent = intentResult.rows[0];
    if (!intent) throw new Error("effect intent required");
    const existingApproval = await migrationPool.query<{ count: string }>(
      `SELECT count(*) FROM lineageguard.effect_approvals
       WHERE run_id=$1 AND kind=$2 AND target=$3 AND input_fingerprint=$4
         AND expires_at > clock_timestamp()`,
      [intent.run_id, intent.kind, intent.target, intent.input_fingerprint],
    );
    if (existingApproval.rows[0]?.count === "0") {
      await approveCurrentEffect({
        runId: intent.run_id,
        kind: intent.kind,
        target: intent.target,
        inputFingerprint: intent.input_fingerprint,
      });
    }
    const validation = await migrationPool.query<{ payload: unknown }>(
      "SELECT payload FROM lineageguard.validation_receipts WHERE id=$1",
      [intent.validation_receipt_id],
    );
    const receipt = signedLiveValidationReceiptSchema.parse(validation.rows[0]?.payload);
    const reserved = await authorityStore.reserveCurrentEffect({
      runId: intent.run_id,
      effectKind: intent.kind === "GITHUB_REVIEW" ? "GITHUB_WRITE" : "DATAHUB_WRITE",
      inputFingerprint: intent.input_fingerprint,
      target: intent.target,
      intentId,
      idempotencyKey: intent.idempotency_key,
      validationReceiptFingerprint: signedLiveValidationReceiptFingerprint(receipt),
    });
    const claim = {
      reservationId: reserved.reservationId,
      reservationToken: reserved.reservationToken,
      runId: intent.run_id,
      intentId: reserved.intentId,
      idempotencyKey: reserved.idempotencyKey,
      effectKind: reserved.effectKind,
      inputFingerprint: reserved.inputFingerprint,
      target: reserved.target,
      validationReceiptId: reserved.validationReceiptId,
      validationReceiptFingerprint: reserved.validationReceiptFingerprint,
      approvalId: reserved.approvalId,
      approvalFingerprint: reserved.approvalFingerprint,
      intentFingerprint: reserved.intentFingerprint,
    };
    await authorityStore.verifyCurrentEffectReservation(claim, intent.input_fingerprint);
    const consumed = await authorityStore.consumeCurrentEffect(claim, intent.input_fingerprint);
    return {
      state: "READY_TO_INVOKE" as const,
      readyToInvoke: true,
      reservation: reserved,
      claim,
      attempt: {
        id: consumed.attemptId,
        workerId: reserved.currentLease.workerId,
        fencingToken: consumed.attemptFence,
        attempt: 1,
        claimExpiresAt: new Date(consumed.invokeBy),
      },
    };
  }

  async function withLegacyDatabase<T>(
    exercise: (legacyPool: pg.Pool) => Promise<T>,
    migrationCount = 3,
  ): Promise<T> {
    const database = `lineageguard_upgrade_${crypto.randomUUID().replaceAll("-", "")}`;
    if (!/^lineageguard_upgrade_[a-f0-9]{32}$/.test(database)) {
      throw new Error("unsafe upgrade database name");
    }
    await migrationPool.query(`CREATE DATABASE "${database}"`);
    const sourceUrl = process.env.LINEAGEGUARD_TEST_MIGRATION_DATABASE_URL;
    if (!sourceUrl) throw new Error("migration database URL required");
    const url = new URL(sourceUrl);
    url.pathname = `/${database}`;
    const legacyPool = new Pool({ connectionString: url.toString() });
    try {
      for (const migration of MIGRATIONS.slice(0, migrationCount)) {
        await legacyPool.query(migration.sql);
      }
      return await exercise(legacyPool);
    } finally {
      await legacyPool.end();
      await migrationPool.query(`DROP DATABASE "${database}" WITH (FORCE)`);
    }
  }

  async function insertLegacyContext(
    legacyPool: pg.Pool,
    context: ImpactContext,
    position: number,
  ) {
    const runId = `run_${"a".repeat(24)}`;
    if (position === 1) {
      await legacyPool.query(
        `INSERT INTO lineageguard.runs
           (id,request_key,input_fingerprint,status,payload,next_attempt_at)
         VALUES ($1,'legacy-upgrade',$2,'CREATED',$3,clock_timestamp())`,
        [runId, inputFingerprint(), payload("legacy-run")],
      );
    }
    const legacyContext = structuredClone(context) as unknown as Record<string, unknown>;
    const resolution = legacyContext.resolution as Record<string, unknown>;
    const provenance = resolution.provenance;
    if (!Array.isArray(provenance) || !provenance[0]) throw new Error("provenance required");
    resolution.provenance = provenance[0];
    await legacyPool.query(
      `INSERT INTO lineageguard.run_bundles (id,run_id,kind,position,payload)
       VALUES ($1,$2,'CONTEXT',$3,$4)`,
      [
        `bundle_${String(position).padStart(24, "a")}`,
        runId,
        position,
        {
          outcome:
            context.collectionOrigin.mode === "LIVE"
              ? "COLLECTED_LIVE"
              : "COLLECTED_VERIFIED_REPLAY",
          context: legacyContext,
        },
      ],
    );
    return runId;
  }

  it("migrates idempotently and separates runtime privileges", async () => {
    const ledger = await migrationPool.query<{ count: string }>(
      "SELECT count(*) FROM lineageguard.schema_migrations",
    );
    expect(ledger.rows[0]?.count).toBe("5");
    await expect(
      runtimePool.query("CREATE TABLE lineageguard.forbidden(id int)"),
    ).rejects.toMatchObject({
      code: "42501",
    });
    await expect(runtimePool.query("TRUNCATE lineageguard.run_events")).rejects.toMatchObject({
      code: "42501",
    });
  });

  it("upgrades legacy replay provenance and derives replay execution mode", async () => {
    await withLegacyDatabase(async (legacyPool) => {
      const runId = await insertLegacyContext(legacyPool, replayImpactContext(), 1);
      await legacyPool.query(MIGRATIONS[3]?.sql as string);
      const upgraded = await legacyPool.query<{
        execution_mode: string;
        provenance: unknown;
        payload: unknown;
      }>(
        `SELECT r.execution_mode,b.payload#>'{context,resolution,provenance}' AS provenance,b.payload
         FROM lineageguard.runs r JOIN lineageguard.run_bundles b ON b.run_id=r.id
         WHERE r.id=$1`,
        [runId],
      );
      expect(upgraded.rows[0]?.execution_mode).toBe("VERIFIED_REPLAY");
      expect(upgraded.rows[0]?.provenance).toEqual([
        provenance("RESOLUTION", "search", "resolution"),
      ]);
      expect(() => impactCollectionResultSchema.parse(upgraded.rows[0]?.payload)).not.toThrow();
    });
  });

  it("applies the authority split as a forward-only migration over 0004", async () => {
    await withLegacyDatabase(async (legacyPool) => {
      const committed0004Checksum =
        "fe30099b8317baba56252f42a5595d2761c9b6656627c81453d2a633e853a0a2";
      expect(
        createHash("sha256")
          .update(MIGRATIONS[3]?.sql as string)
          .digest("hex"),
      ).toBe(committed0004Checksum);
      const legacyRunId = `run_${"9".repeat(24)}`;
      await legacyPool.query(
        `INSERT INTO lineageguard.runs(
          id,request_key,input_fingerprint,status,payload,next_attempt_at,execution_mode
        ) VALUES($1,'legacy-unsigned-approval',$2,'VALIDATED',$3,clock_timestamp(),'LIVE')`,
        [legacyRunId, inputFingerprint(), payload("legacy unsigned approval")],
      );
      await legacyPool.query("ALTER TABLE lineageguard.effect_approvals DISABLE TRIGGER ALL");
      await legacyPool.query(
        `INSERT INTO lineageguard.effect_approvals(
          id,run_id,kind,target,input_fingerprint,approved_by,approved_at,
          approval_fingerprint,expires_at,payload,validation_receipt_id,
          validation_receipt_fingerprint,validation_completed_at
        ) VALUES($1,$2,'GITHUB_REVIEW','owner/repository',$3,'legacy-reviewer',clock_timestamp(),
          $4,clock_timestamp()+interval '30 minutes',$5,$6,$7,clock_timestamp())`,
        [
          `approval_${"8".repeat(24)}`,
          legacyRunId,
          inputFingerprint(),
          "7".repeat(64),
          {},
          `val_${"6".repeat(24)}`,
          "5".repeat(64),
        ],
      );
      await legacyPool.query("ALTER TABLE lineageguard.effect_approvals ENABLE TRIGGER ALL");
      await legacyPool.query(`CREATE TABLE lineageguard.schema_migrations(
        id text PRIMARY KEY,checksum text NOT NULL,applied_at timestamptz NOT NULL DEFAULT clock_timestamp()
      )`);
      for (const migration of MIGRATIONS.slice(0, 4)) {
        await legacyPool.query(
          "INSERT INTO lineageguard.schema_migrations(id,checksum) VALUES($1,$2)",
          [migration.id, createHash("sha256").update(migration.sql).digest("hex")],
        );
      }
      const deployerRole = `lineageguard_upgrade_owner_${crypto.randomUUID().slice(0, 8)}`;
      const deployerPassword = crypto.randomUUID().replaceAll("-", "");
      if (!/^lineageguard_upgrade_owner_[a-f0-9]{8}$/.test(deployerRole)) {
        throw new Error("unsafe upgrade owner role");
      }
      await migrationPool.query(
        `CREATE ROLE "${deployerRole}" LOGIN CREATEROLE PASSWORD '${deployerPassword}'`,
      );
      const deployerUrl = new URL(legacyPool.options.connectionString as string);
      deployerUrl.username = deployerRole;
      deployerUrl.password = deployerPassword;
      const deployerPool = new Pool({ connectionString: deployerUrl.toString() });
      try {
        await legacyPool.query(`GRANT lineageguard_procedure_owner TO "${deployerRole}"`);
        const upgradeDatabase = deployerUrl.pathname.slice(1);
        if (!/^lineageguard_upgrade_[a-f0-9]{32}$/.test(upgradeDatabase)) {
          throw new Error("unsafe upgrade database grant target");
        }
        await legacyPool.query(
          `GRANT CREATE ON DATABASE "${upgradeDatabase}" TO "${deployerRole}"`,
        );
        await legacyPool.query(`ALTER SCHEMA lineageguard OWNER TO "${deployerRole}"`);
        await legacyPool.query(`DO $do$ DECLARE item record; BEGIN
          FOR item IN SELECT c.relkind,n.nspname,c.relname
            FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
            JOIN pg_roles r ON r.oid=c.relowner
            WHERE n.nspname='lineageguard' AND r.rolname='lineageguard_migrator'
              AND c.relkind IN ('r','p','S','v','m')
          LOOP
            EXECUTE CASE item.relkind
              WHEN 'S' THEN format('ALTER SEQUENCE %I.%I OWNER TO "${deployerRole}"',item.nspname,item.relname)
              WHEN 'v' THEN format('ALTER VIEW %I.%I OWNER TO "${deployerRole}"',item.nspname,item.relname)
              WHEN 'm' THEN format('ALTER MATERIALIZED VIEW %I.%I OWNER TO "${deployerRole}"',item.nspname,item.relname)
              ELSE format('ALTER TABLE %I.%I OWNER TO "${deployerRole}"',item.nspname,item.relname)
            END;
          END LOOP;
          FOR item IN SELECT n.nspname,p.proname,pg_get_function_identity_arguments(p.oid) AS args
            FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
            JOIN pg_roles r ON r.oid=p.proowner
            WHERE n.nspname='lineageguard' AND r.rolname='lineageguard_migrator'
          LOOP
            EXECUTE format('ALTER FUNCTION %I.%I(%s) OWNER TO "${deployerRole}"',
              item.nspname,item.proname,item.args);
          END LOOP;
        END $do$`);
        await legacyPool.query(
          `GRANT USAGE,CREATE ON SCHEMA lineageguard TO lineageguard_procedure_owner`,
        );
        await migrate(deployerPool);
        await grantRuntimePrivileges(deployerPool, "lineageguard_runtime");
        await grantValidationSignerPrivileges(deployerPool, "lineageguard_validation_signer");
        await grantApprovalAuthorityPrivileges(deployerPool, "lineageguard_approval_authority");
        await grantEffectAuthorityPrivileges(deployerPool, "lineageguard_effect_authority");
      } finally {
        await deployerPool.end();
      }
      const result = await legacyPool.query<{ reservations: string; procedures: string }>(
        `SELECT
          to_regclass('lineageguard.effect_invocation_reservations')::text AS reservations,
          to_regprocedure('lineageguard.effect_consume_current(text,text,text,text,text,text,text,text,text,text,text,text,text)')::text AS procedures`,
      );
      expect(result.rows[0]).toMatchObject({
        reservations: "lineageguard.effect_invocation_reservations",
        procedures:
          "lineageguard.effect_consume_current(text,text,text,text,text,text,text,text,text,text,text,text,text)",
      });
      const ledger = await legacyPool.query<{ count: string }>(
        "SELECT count(*) FROM lineageguard.schema_migrations",
      );
      expect(ledger.rows[0]?.count).toBe("5");
      const legacyApproval = await legacyPool.query<{
        active: boolean;
        approval_assertion: unknown;
      }>(
        `SELECT expires_at>clock_timestamp() AS active,approval_assertion
         FROM lineageguard.effect_approvals WHERE run_id=$1`,
        [legacyRunId],
      );
      expect(legacyApproval.rows[0]).toEqual({ active: false, approval_assertion: null });
      const schemaCreate = await legacyPool.query<{ allowed: boolean }>(
        `SELECT has_schema_privilege(
          'lineageguard_procedure_owner','lineageguard','CREATE'
        ) AS allowed`,
      );
      expect(schemaCreate.rows[0]?.allowed).toBe(false);
      await legacyPool.query(`REASSIGN OWNED BY "${deployerRole}" TO lineageguard_migrator`);
      await legacyPool.query(`DROP OWNED BY "${deployerRole}"`);
      await legacyPool.query(`REVOKE lineageguard_procedure_owner FROM "${deployerRole}"`);
      await migrationPool.query(`DROP ROLE "${deployerRole}"`);
    }, 4);
  });

  it("aborts the legacy mode upgrade when one run contains mixed origins", async () => {
    await withLegacyDatabase(async (legacyPool) => {
      const changeId = `chg_${"e".repeat(24)}`;
      await insertLegacyContext(legacyPool, liveImpactContext(changeId), 1);
      await insertLegacyContext(legacyPool, replayImpactContext(changeId), 2);
      await expect(legacyPool.query(MIGRATIONS[3]?.sql as string)).rejects.toMatchObject({
        code: "23514",
      });
      const column = await legacyPool.query<{ count: string }>(
        `SELECT count(*) FROM information_schema.columns
         WHERE table_schema='lineageguard' AND table_name='runs' AND column_name='execution_mode'`,
      );
      expect(column.rows[0]?.count).toBe("0");
    });
  });

  it("uses domain IDs, zero-based events, canonical writes, and lease generations", async () => {
    const created = await create("domain-contract");
    expect(created.id).toMatch(/^run_[a-f0-9]{24}$/);
    const raw = await migrationPool.query<{ payload: Payload }>(
      "SELECT payload FROM lineageguard.runs WHERE id=$1",
      [created.id],
    );
    expect(raw.rows[0]?.payload).toEqual(payload("run"));
    const claimed = await store.claimDue("worker-a", 10_000);
    if (!claimed) throw new Error("claim required");
    const snapshot = await store.snapshot(created.id);
    expect(snapshot.events[0]).toMatchObject({ sequence: 0, type: "RUN_LEASE_ACQUIRED" });
    expect(snapshot.events[0]?.id).toMatch(/^evt_[a-f0-9]{24}$/);
    expect(claimed.leaseId).toMatch(/^lease_[a-f0-9]{24}$/);
    expect(snapshot.leases).toMatchObject([
      { leaseId: claimed.leaseId, workerId: "worker-a", generation: 1 },
    ]);
  });

  it("persists distinct LIVE and VERIFIED_REPLAY collection results with composed provenance", async () => {
    await create("typed-impact-collections");
    const claim = await store.claimDue("collector", 60_000);
    if (!claim?.leaseId || !claim.workerId) throw new Error("claim required");
    const guard = {
      leaseId: claim.leaseId,
      workerId: claim.workerId,
      generation: claim.leaseGeneration,
      fencingVersion: claim.version,
    };
    const live = liveImpactContext();
    await store.appendImpactCollectionResult(claim.id, guard, {
      outcome: "COLLECTED_LIVE",
      context: live,
    });
    const replay = replayImpactContext(live.changeId);
    await create("typed-replay-collection", "VERIFIED_REPLAY");
    const replayClaim = await store.claimDue("replay-collector", 60_000);
    if (!replayClaim?.leaseId || !replayClaim.workerId) throw new Error("replay claim required");
    await store.appendBundle(
      replayClaim.id,
      {
        leaseId: replayClaim.leaseId,
        workerId: replayClaim.workerId,
        generation: replayClaim.leaseGeneration,
        fencingVersion: replayClaim.version,
      },
      "CONTEXT",
      { outcome: "COLLECTED_VERIFIED_REPLAY", context: replay },
    );
    const contexts = (await store.snapshot(claim.id)).bundles.filter(
      (bundle) => bundle.kind === "CONTEXT",
    );
    const replayContexts = (await store.snapshot(replayClaim.id)).bundles.filter(
      (bundle) => bundle.kind === "CONTEXT",
    );
    expect(contexts.map((bundle) => bundle.payload.outcome)).toEqual(["COLLECTED_LIVE"]);
    expect(replayContexts.map((bundle) => bundle.payload.outcome)).toEqual([
      "COLLECTED_VERIFIED_REPLAY",
    ]);
    const liveResult = impactCollectionResultSchema.parse(contexts[0]?.payload);
    if (liveResult.outcome !== "COLLECTED_LIVE") throw new Error("live result required");
    expect(liveResult.context.evidence.some((item) => item.provenance.length > 1)).toBe(true);
    await expect(
      store.appendBundle(
        replayClaim.id,
        {
          leaseId: replayClaim.leaseId,
          workerId: replayClaim.workerId,
          generation: replayClaim.leaseGeneration,
          fencingVersion: replayClaim.version + 1,
        },
        "CONTEXT",
        {
          outcome: "COLLECTED_LIVE",
          context: replay,
        },
      ),
    ).rejects.toThrow();
    await expect(
      runtimePool.query(
        `INSERT INTO lineageguard.run_bundles (id,run_id,kind,position,payload)
         VALUES ($1,$2,'CONTEXT',3,$3)`,
        [
          `bundle_${"f".repeat(24)}`,
          claim.id,
          {
            outcome: "COLLECTED_LIVE",
            context: { ...live, evidence: [{ provenance: [] }] },
          },
        ],
      ),
    ).rejects.toMatchObject({ code: "23514" });
  });

  it("rejects arbitrary jumps and binds SQL event columns to domain payload", async () => {
    const run = await create();
    const claim = await store.claimDue("worker", 10_000);
    if (!claim) throw new Error("claim required");
    await expect(
      store.transition(statusEvent(claim, 1, "CREATED", "COMPLETED"), claim.version),
    ).rejects.toThrow(/Invalid run status transition/);
    const valid = await store.transition(
      statusEvent(claim, 1, "CREATED", "CHANGE_PARSED"),
      claim.version,
    );
    await expect(
      store.transition(
        statusEvent(valid.run, 2, "CHANGE_PARSED", "BASELINE_ASSESSED"),
        claim.version,
      ),
    ).rejects.toThrow(/stale|version/);
    expect(valid.run.status).toBe("CHANGE_PARSED");
    const forged = { ...statusEvent(valid.run, 2, "CHANGE_PARSED", "BASELINE_ASSESSED") };
    await expect(
      migrationPool.query(
        `INSERT INTO lineageguard.run_events
          (id,run_id,sequence,type,payload,created_at,lease_id,worker_id,generation,from_status,to_status)
         VALUES ($1,$2,2,'RUN_STATUS_CHANGED',$3,$4,$5,$6,$7,'CREATED','COMPLETED')`,
        [
          forged.eventId,
          forged.runId,
          forged,
          forged.occurredAt,
          forged.leaseId,
          forged.workerId,
          forged.generation,
        ],
      ),
    ).rejects.toMatchObject({ code: "23514" });
    expect((await store.snapshot(run.id)).events.map((event) => event.sequence)).toEqual([0, 1]);
  });

  it("allows one concurrent run claim and fences expired generations", async () => {
    const run = await create();
    const claims = await Promise.all([
      store.claimDue("worker-a", 20),
      store.claimDue("worker-b", 20),
    ]);
    expect(claims.filter(Boolean)).toHaveLength(1);
    const first = claims.find(Boolean);
    if (!first) throw new Error("claim required");
    await new Promise((resolve) => setTimeout(resolve, 40));
    const second = await store.claimDue("worker-b", 10_000);
    if (!second) throw new Error("reclaim required");
    expect(second).toMatchObject({ leaseGeneration: 2, workerId: "worker-b" });
    expect(second.leaseId).not.toBe(first.leaseId);
    const snapshot = await store.snapshot(run.id);
    expect(snapshot.events.map((event) => `${event.sequence}:${event.type}`)).toEqual([
      "0:RUN_LEASE_ACQUIRED",
      "1:RUN_LEASE_EXPIRED",
      "2:RUN_LEASE_ACQUIRED",
    ]);
    expect(snapshot.leases.map((lease) => lease.generation)).toEqual([1, 2]);
  });

  it("rolls back renew and release when persisted run JSON is corrupt", async () => {
    const run = await create();
    const claim = await store.claimDue("worker", 10_000);
    if (!claim?.leaseId || !claim.workerId) throw new Error("claim required");
    await migrationPool.query("UPDATE lineageguard.runs SET payload=$2 WHERE id=$1", [
      run.id,
      { corrupt: true },
    ]);
    const guard = {
      leaseId: claim.leaseId,
      workerId: claim.workerId,
      generation: claim.leaseGeneration,
      fencingVersion: claim.version,
    };
    await expect(store.renewLease(run.id, guard, 10_000)).rejects.toBeInstanceOf(CorruptDataError);
    await expect(store.releaseLease(run.id, guard)).rejects.toBeInstanceOf(CorruptDataError);
    const raw = await migrationPool.query<{ version: string; count: string }>(
      `SELECT r.version,(SELECT count(*) FROM lineageguard.run_events e WHERE e.run_id=r.id) AS count
       FROM lineageguard.runs r WHERE r.id=$1`,
      [run.id],
    );
    expect(raw.rows[0]).toMatchObject({ version: String(claim.version), count: "1" });
  });

  it("authorizes retry by domain state and preserves exact global backoff", async () => {
    const run = await create();
    const claim = await store.claimDue("worker-1", 60_000);
    if (!claim?.leaseExpiresAt) throw new Error("claim required");
    await expect(
      store.scheduleRetry({
        eventId: newEventId(),
        runId: run.id,
        sequence: 1,
        occurredAt: new Date().toISOString(),
        type: "RUN_RETRY_SCHEDULED",
        leaseId: claim.leaseId,
        workerId: claim.workerId,
        generation: claim.leaseGeneration,
        operation: "DATAHUB_READ",
        attempt: 1,
        retryAt: new Date(Date.now() + 1_000).toISOString(),
        reason: "wrong state",
      }),
    ).rejects.toThrow();

    const collecting = await advance(claim, [
      "CHANGE_PARSED",
      "BASELINE_ASSESSED",
      "CONTEXT_COLLECTING",
    ]);
    const occurredAt = new Date();
    const retry = await store.scheduleRetry({
      eventId: newEventId(),
      runId: run.id,
      sequence: 4,
      occurredAt: occurredAt.toISOString(),
      type: "RUN_RETRY_SCHEDULED",
      leaseId: collecting.leaseId,
      workerId: collecting.workerId,
      generation: collecting.leaseGeneration,
      operation: "DATAHUB_READ",
      attempt: 1,
      retryAt: new Date(occurredAt.getTime() + 1_000).toISOString(),
      reason: "bounded retry",
    });
    expect(retry.retry.retryAt.getTime() - retry.retry.createdAt.getTime()).toBe(1_000);
    expect(retry.run.leaseId).toBeNull();
  });

  it("consumes one reservation atomically and makes ambiguous execution reconcile-only", async () => {
    const claim = await validatedRun(liveImpactContext(), 60_000);
    if (!claim.leaseId || !claim.workerId) throw new Error("validated lease required");
    const intent = await effectStore.beginEffect({
      runId: claim.id,
      guard: {
        leaseId: claim.leaseId,
        workerId: claim.workerId,
        generation: claim.leaseGeneration,
        fencingVersion: claim.version,
      },
      kind: "GITHUB_REVIEW",
      target: "owner/repository",
      idempotencyKey: "review-1",
      inputFingerprint: inputFingerprint(),
      payload: payload("input"),
    });
    const claims = await Promise.allSettled([
      consumeIntent(intent.intent.id, "effect-worker-a", 10_000),
      consumeIntent(intent.intent.id, "effect-worker-b", 10_000),
    ]);
    expect(claims.filter((result) => result.status === "fulfilled")).toHaveLength(1);
    expect(claims.filter((result) => result.status === "rejected")).toHaveLength(1);
    const result = claims.find((candidate) => candidate.status === "fulfilled");
    if (result?.status !== "fulfilled" || !result.value.attempt) {
      throw new Error("effect claim required");
    }
    const attempt = result.value.attempt;
    await expect(
      effectStore.verifyCurrentEffectReservation(
        result.value.claim,
        result.value.claim.inputFingerprint,
      ),
    ).resolves.toMatchObject({ state: "CONSUMED", attemptId: attempt.id });
    await expect(
      effectStore.consumeCurrentEffect(result.value.claim, result.value.claim.inputFingerprint),
    ).rejects.toThrow(/consume rejected/);
    await effectStore.recordEffectAmbiguous({
      attemptId: attempt.id,
      workerId: attempt.workerId,
      fencingToken: attempt.fencingToken,
      payload: payload("timeout after write"),
    });
    const ambiguousSnapshot = await store.snapshot(claim.id);
    const ambiguousRun = ambiguousSnapshot.run;
    const ambiguousGuard = {
      leaseId: ambiguousRun.leaseId as string,
      workerId: ambiguousRun.workerId as string,
      generation: ambiguousRun.leaseGeneration,
      fencingVersion: ambiguousRun.version,
    };
    await expect(
      store.transition(
        statusEvent(ambiguousRun, ambiguousSnapshot.events.length, "VALIDATED", "FAILED_GITHUB"),
        ambiguousRun.version,
      ),
    ).rejects.toThrow(/active effect invocation/);
    await expect(store.releaseLease(claim.id, ambiguousGuard)).rejects.toThrow(
      /active effect invocation/,
    );
    await expect(
      effectStore.reconcileEffectAttempt({
        runId: claim.id,
        guard: {
          leaseId: claim.leaseId,
          workerId: claim.workerId,
          generation: claim.leaseGeneration,
          fencingVersion: intent.version,
        },
        attemptId: attempt.id,
        workerId: "different-effect-worker",
        fencingToken: attempt.fencingToken,
        proofOutcome: "NOT_APPLIED",
        proof: payload("wrong attempt owner must not unlock retry"),
      }),
    ).rejects.toThrow(/fence is stale/);
    await effectStore.reconcileEffectAttempt({
      runId: claim.id,
      guard: {
        leaseId: claim.leaseId,
        workerId: claim.workerId,
        generation: claim.leaseGeneration,
        fencingVersion: intent.version,
      },
      attemptId: attempt.id,
      workerId: attempt.workerId,
      fencingToken: attempt.fencingToken,
      proofOutcome: "NOT_APPLIED",
      proof: payload("remote marker absent"),
    });
    await expect(consumeIntent(intent.intent.id, "effect-worker-c", 10_000)).rejects.toThrow(
      /duplicate key|unique constraint/,
    );
    await expect(store.releaseLease(claim.id, ambiguousGuard)).resolves.toMatchObject({
      leaseId: null,
      workerId: null,
    });
    expect("claimEffectAttempt" in effectStore).toBe(false);
    expect((await store.snapshot(claim.id)).effects[0]?.reconciliations).toMatchObject([
      {
        attemptId: attempt.id,
        proofOutcome: "NOT_APPLIED",
        payload: payload("remote marker absent"),
      },
    ]);
  });

  it("replays identical success without updating the immutable receipt", async () => {
    const claim = await validatedRun();
    if (!claim.leaseId || !claim.workerId) throw new Error("validated lease required");
    const intent = await effectStore.beginEffect({
      runId: claim.id,
      guard: {
        leaseId: claim.leaseId,
        workerId: claim.workerId,
        generation: claim.leaseGeneration,
        fencingVersion: claim.version,
      },
      kind: "GITHUB_REVIEW",
      target: "owner/repository",
      idempotencyKey: "review-success-1",
      inputFingerprint: inputFingerprint(),
      payload: payload("input"),
    });
    const claimed = await consumeIntent(intent.intent.id, "effect-worker", 10_000);
    if (!claimed.attempt) throw new Error("effect attempt required");
    const request = {
      attemptId: claimed.attempt.id,
      workerId: claimed.attempt.workerId,
      fencingToken: claimed.attempt.fencingToken,
      payload: await effectReceipt(claim, intent.intent),
    };
    const first = await effectStore.recordEffectSuccess(request);
    const replay = await effectStore.recordEffectSuccess(request);
    expect(replay).toEqual(first);
    await expect(
      effectStore.recordEffectSuccess({
        ...request,
        payload: await effectReceipt(claim, intent.intent, "changed"),
      }),
    ).rejects.toBeInstanceOf(IdempotencyConflictError);
    await expect(
      runtimePool.query("UPDATE lineageguard.external_effect_receipts SET payload='{}'::jsonb"),
    ).rejects.toMatchObject({ code: "42501" });
  });

  it("rejects validated status without an authenticated executed receipt", async () => {
    const run = await create();
    const claim = await store.claimDue("worker", 60_000);
    if (!claim) throw new Error("claim required");
    const pending = await advance(claim, [
      "CHANGE_PARSED",
      "BASELINE_ASSESSED",
      "CONTEXT_COLLECTING",
      "CONTEXT_COLLECTED",
      "RISK_DECIDED",
      "MIGRATION_PLANNED",
      "PATCH_GENERATED",
      "VALIDATING",
    ]);
    await expect(
      store.transition(statusEvent(pending, 9, "VALIDATING", "VALIDATED"), pending.version),
    ).rejects.toThrow(/authenticated|domain-valid|requires/);
    expect((await store.snapshot(run.id)).run.status).toBe("VALIDATING");
  });

  it("rejects effect key reuse with changed input and reconstructs deterministic history", async () => {
    const claim = await validatedRun();
    if (!claim.leaseId || !claim.workerId) throw new Error("validated lease required");
    const guard = {
      leaseId: claim.leaseId,
      workerId: claim.workerId,
      generation: claim.leaseGeneration,
      fencingVersion: claim.version,
    };
    await effectStore.beginEffect({
      runId: claim.id,
      guard,
      kind: "GITHUB_REVIEW",
      target: "owner/repository",
      idempotencyKey: "key",
      inputFingerprint: inputFingerprint(),
      payload: payload("input"),
    });
    await expect(
      effectStore.beginEffect({
        runId: claim.id,
        guard: { ...guard, fencingVersion: guard.fencingVersion + 1 },
        kind: "GITHUB_REVIEW",
        target: "owner/repository",
        idempotencyKey: "key",
        inputFingerprint: inputFingerprint(),
        payload: payload("changed"),
      }),
    ).rejects.toThrow(/fingerprint/);
    const snapshot = await store.snapshot(claim.id);
    expect(snapshot.events.map((event) => event.sequence)).toEqual([0, 1, 2, 3, 4, 5, 6, 7, 8, 9]);
    expect(snapshot.leases.map((lease) => lease.generation)).toEqual([1]);
    expect(snapshot.effects).toHaveLength(1);
  });

  it("persists verified replay for reconstruction but never grants external-effect authority", async () => {
    const replay = replayImpactContext();
    const claim = await validatedRun(replay);
    if (!claim.leaseId || !claim.workerId) throw new Error("validated lease required");
    const request = {
      runId: claim.id,
      guard: {
        leaseId: claim.leaseId,
        workerId: claim.workerId,
        generation: claim.leaseGeneration,
        fencingVersion: claim.version,
      },
      kind: "GITHUB_REVIEW" as const,
      target: "owner/repository",
      idempotencyKey: "replay-must-not-write",
      inputFingerprint: inputFingerprint(),
      payload: payload("input"),
    };
    const binding = bindingBases.get(claim.id);
    if (!binding) throw new Error("validation binding required");
    bindingBases.set(claim.id, { ...binding, context: liveImpactContext(replay.changeId) });
    await expect(effectStore.beginEffect(request)).rejects.toThrow(/replay|LIVE/);
    bindingBases.set(claim.id, { ...binding, context: replay });
    await expect(
      approvalStore.recordEffectApproval({
        ...request,
        approvedBy: "reviewer@example.invalid",
        approvedAt: new Date(),
        expiresAt: new Date(Date.now() + 60_000),
        assertion: {},
      }),
    ).rejects.toThrow(/replay|LIVE/);
    expect((await store.snapshot(claim.id)).effects).toEqual([]);
  });

  it("rejects mixed collection origins in the store and at the SQL boundary", async () => {
    const run = await create(`request-${crypto.randomUUID()}`, "VERIFIED_REPLAY");
    const claim = await store.claimDue("mode-worker", 60_000);
    if (!claim?.leaseId || !claim.workerId || claim.id !== run.id)
      throw new Error("claim required");
    const live = liveImpactContext();
    const result = { outcome: "COLLECTED_LIVE" as const, context: live };
    await expect(
      store.appendImpactCollectionResult(
        claim.id,
        {
          leaseId: claim.leaseId,
          workerId: claim.workerId,
          generation: claim.leaseGeneration,
          fencingVersion: claim.version,
        },
        result,
      ),
    ).rejects.toThrow(/immutable run mode/);
    await expect(
      runtimePool.query(
        `INSERT INTO lineageguard.run_bundles (id,run_id,kind,position,payload)
         VALUES ($1,$2,'CONTEXT',1,$3)`,
        [`bundle_${"f".repeat(24)}`, claim.id, impactCollectionResultSchema.parse(result)],
      ),
    ).rejects.toMatchObject({ code: "23514" });
    await expect(
      migrationPool.query("UPDATE lineageguard.runs SET execution_mode='LIVE' WHERE id=$1", [
        claim.id,
      ]),
    ).rejects.toMatchObject({ code: "23514" });
    expect((await store.snapshot(run.id)).run.executionMode).toBe("VERIFIED_REPLAY");
  });

  it("rejects legacy approval assertion envelope versions", async () => {
    const claim = await validatedRun();
    await expect(
      approveCurrentEffect({
        runId: claim.id,
        kind: "GITHUB_REVIEW",
        target: "owner/repository",
        inputFingerprint: inputFingerprint(),
        assertionSchemaVersion: 1,
      }),
    ).rejects.toThrow(/canonical|authority/);
  });

  it("rejects an expired reservation before any external invocation", async () => {
    const claim = await validatedRun();
    const guard = {
      leaseId: claim.leaseId as string,
      workerId: claim.workerId as string,
      generation: claim.leaseGeneration,
      fencingVersion: claim.version,
    };
    const approval = await approveCurrentEffect({
      runId: claim.id,
      kind: "GITHUB_REVIEW",
      target: "owner/repository",
      inputFingerprint: inputFingerprint(),
      durationMillis: 500,
    });
    const intent = await productionEffectStore.beginEffect({
      runId: claim.id,
      guard,
      kind: "GITHUB_REVIEW",
      target: "owner/repository",
      idempotencyKey: "expiring-approval",
      inputFingerprint: inputFingerprint(),
      payload: payload("input"),
    });
    const validation = (await store.snapshot(claim.id)).validationReceipts.at(-1)?.payload;
    if (!validation) throw new Error("validation receipt required");
    const reserved = await productionEffectStore.reserveCurrentEffect({
      runId: claim.id,
      effectKind: "GITHUB_WRITE",
      target: "owner/repository",
      inputFingerprint: inputFingerprint(),
      intentId: intent.intent.id,
      idempotencyKey: intent.intent.idempotencyKey,
      validationReceiptFingerprint: signedLiveValidationReceiptFingerprint(validation),
    });
    expect(new Date(reserved.invokeBy).getTime()).toBeLessThanOrEqual(approval.expiresAt.getTime());
    const reservationClaim = {
      reservationId: reserved.reservationId,
      reservationToken: reserved.reservationToken,
      runId: claim.id,
      intentId: intent.intent.id,
      idempotencyKey: intent.intent.idempotencyKey,
      effectKind: "GITHUB_WRITE" as const,
      inputFingerprint: intent.intent.inputFingerprint,
      target: intent.intent.target,
      validationReceiptId: reserved.validationReceiptId,
      validationReceiptFingerprint: reserved.validationReceiptFingerprint,
      approvalId: reserved.approvalId,
      approvalFingerprint: reserved.approvalFingerprint,
      intentFingerprint: reserved.intentFingerprint,
    };
    await migrationPool.query("SELECT pg_sleep(0.65)");
    await expect(
      productionEffectStore.verifyCurrentEffectReservation(
        reservationClaim,
        intent.intent.inputFingerprint,
      ),
    ).rejects.toThrow(/expired|rejected/);
    const attempts = await migrationPool.query<{ count: string }>(
      "SELECT count(*) FROM lineageguard.external_effect_attempts WHERE intent_id=$1",
      [intent.intent.id],
    );
    expect(attempts.rows[0]?.count).toBe("0");
    await productionEffectStore.cancelCurrentEffectBeforeSend(
      reservationClaim,
      intent.intent.inputFingerprint,
    );
    await approveCurrentEffect({
      runId: claim.id,
      kind: "GITHUB_REVIEW",
      target: intent.intent.target,
      inputFingerprint: intent.intent.inputFingerprint,
    });
    await expect(
      productionEffectStore.reserveCurrentEffect({
        runId: claim.id,
        effectKind: "GITHUB_WRITE",
        target: intent.intent.target,
        inputFingerprint: intent.intent.inputFingerprint,
        intentId: intent.intent.id,
        idempotencyKey: intent.intent.idempotencyKey,
        validationReceiptFingerprint: signedLiveValidationReceiptFingerprint(validation),
      }),
    ).resolves.not.toMatchObject({ reservationId: reserved.reservationId });
  });

  it("rejects receipt payloads bound to a different candidate", async () => {
    const claim = await validatedRun();
    const intent = await effectStore.beginEffect({
      runId: claim.id,
      guard: {
        leaseId: claim.leaseId as string,
        workerId: claim.workerId as string,
        generation: claim.leaseGeneration,
        fencingVersion: claim.version,
      },
      kind: "GITHUB_REVIEW",
      target: "owner/repository",
      idempotencyKey: "cross-candidate-receipt",
      inputFingerprint: inputFingerprint(),
      payload: payload("input"),
    });
    const attempt = await consumeIntent(intent.intent.id, "effect-worker", 10_000);
    if (!attempt.attempt) throw new Error("effect attempt required");
    const receipt = await effectReceipt(claim, intent.intent);
    await expect(
      effectStore.recordEffectSuccess({
        attemptId: attempt.attempt.id,
        workerId: attempt.attempt.workerId,
        fencingToken: attempt.attempt.fencingToken,
        payload: { ...receipt, target: "different-owner/different-repository" },
      }),
    ).rejects.toThrow(/authenticated binding/);
    const persisted = await migrationPool.query<{ payload: unknown }>(
      "SELECT payload FROM lineageguard.validation_receipts WHERE run_id=$1 ORDER BY position DESC LIMIT 1",
      [claim.id],
    );
    const original = signedLiveValidationReceiptSchema.parse(persisted.rows[0]?.payload);
    await migrationPool.query(
      `INSERT INTO lineageguard.validation_receipts (id,run_id,position,payload)
       VALUES ($1,$2,2,$3)`,
      [`val_${"f".repeat(24)}`, claim.id, original],
    );
    await expect(
      effectStore.recordEffectSuccess({
        attemptId: attempt.attempt.id,
        workerId: attempt.attempt.workerId,
        fencingToken: attempt.attempt.fencingToken,
        payload: receipt,
      }),
    ).rejects.toThrow(/ID does not match|stale|current authenticated|binding mismatch/);
  });

  it("completes only with GitHub and DataHub receipts sharing one validation binding", async () => {
    let run = await validatedRun();
    const guard = () => ({
      leaseId: run.leaseId as string,
      workerId: run.workerId as string,
      generation: run.leaseGeneration,
      fencingVersion: run.version,
    });
    const github = await effectStore.beginEffect({
      runId: run.id,
      guard: guard(),
      kind: "GITHUB_REVIEW",
      target: "owner/repository",
      idempotencyKey: "completion-github",
      inputFingerprint: inputFingerprint("github-input"),
      payload: payload("github-input"),
    });
    run = { ...run, version: github.version };
    const githubAttempt = await consumeIntent(github.intent.id, "github-effect-worker", 10_000);
    if (!githubAttempt.attempt) throw new Error("GitHub attempt required");
    await effectStore.recordEffectSuccess({
      attemptId: githubAttempt.attempt.id,
      workerId: githubAttempt.attempt.workerId,
      fencingToken: githubAttempt.attempt.fencingToken,
      payload: await effectReceipt(run, github.intent),
    });
    run = (
      await store.transition(
        statusEvent(run, 10, "VALIDATED", "REVIEW_ARTIFACT_CREATED"),
        run.version,
      )
    ).run;
    run = (
      await store.transition(
        statusEvent(run, 11, "REVIEW_ARTIFACT_CREATED", "WRITEBACK_PENDING"),
        run.version,
      )
    ).run;
    const datahub = await effectStore.beginEffect({
      runId: run.id,
      guard: guard(),
      kind: "DATAHUB_WRITEBACK",
      target: canonicalDatasetUrn,
      idempotencyKey: "completion-datahub",
      inputFingerprint: inputFingerprint("datahub-input"),
      payload: payload("datahub-input"),
    });
    run = { ...run, version: datahub.version };
    const datahubAttempt = await consumeIntent(datahub.intent.id, "datahub-effect-worker", 10_000);
    if (!datahubAttempt.attempt) throw new Error("DataHub attempt required");
    await effectStore.recordEffectSuccess({
      attemptId: datahubAttempt.attempt.id,
      workerId: datahubAttempt.attempt.workerId,
      fencingToken: datahubAttempt.attempt.fencingToken,
      payload: await effectReceipt(run, datahub.intent),
    });
    await expect(
      store.transition(statusEvent(run, 12, "WRITEBACK_PENDING", "COMPLETED"), run.version),
    ).resolves.toMatchObject({ run: { status: "COMPLETED" } });
  });

  it("fails closed on wrong effect kind, state, lease, receipt, candidate, and approval", async () => {
    await create();
    const created = await store.claimDue("state-worker", 60_000);
    if (!created?.leaseId || !created.workerId) throw new Error("claim required");
    const createdGuard = {
      leaseId: created.leaseId,
      workerId: created.workerId,
      generation: created.leaseGeneration,
      fencingVersion: created.version,
    };
    await expect(
      effectStore.beginEffect({
        runId: created.id,
        guard: createdGuard,
        kind: "UNSAFE_EFFECT" as never,
        target: "owner/repository",
        idempotencyKey: "unsafe",
        inputFingerprint: inputFingerprint(),
        payload: payload("input"),
      }),
    ).rejects.toThrow(/allowlisted/);
    await expect(
      effectStore.beginEffect({
        runId: created.id,
        guard: createdGuard,
        kind: "GITHUB_REVIEW",
        target: "owner/repository",
        idempotencyKey: "wrong-state",
        inputFingerprint: inputFingerprint(),
        payload: payload("input"),
      }),
    ).rejects.toThrow(/not allowed from CREATED/);

    const wrongLease = await validatedRun();
    if (!wrongLease.leaseId || !wrongLease.workerId) throw new Error("validated lease required");
    await expect(
      effectStore.beginEffect({
        runId: wrongLease.id,
        guard: {
          leaseId: `lease_${"f".repeat(24)}`,
          workerId: wrongLease.workerId,
          generation: wrongLease.leaseGeneration,
          fencingVersion: wrongLease.version,
        },
        kind: "GITHUB_REVIEW",
        target: "owner/repository",
        idempotencyKey: "wrong-lease",
        inputFingerprint: inputFingerprint(),
        payload: payload("input"),
      }),
    ).rejects.toThrow(/stale/);

    const wrongReceipt = await validatedRun();
    const persisted = await migrationPool.query<{ payload: unknown }>(
      "SELECT payload FROM lineageguard.validation_receipts WHERE run_id=$1 ORDER BY position DESC LIMIT 1",
      [wrongReceipt.id],
    );
    const original = signedLiveValidationReceiptSchema.parse(persisted.rows[0]?.payload);
    const changedEnvelope = {
      protectedHeaders: {
        ...original.protectedHeaders,
        candidateFingerprint: "e".repeat(64),
      },
      payload: original.payload,
    };
    const forged = signedLiveValidationReceiptSchema.parse({
      ...changedEnvelope,
      signedPayloadFingerprint: liveValidationSignedPayloadFingerprint(changedEnvelope),
      signature: original.signature,
    });
    await migrationPool.query(
      `INSERT INTO lineageguard.validation_receipts (id,run_id,position,payload)
       VALUES ($1,$2,2,$3)`,
      [`val_${"e".repeat(24)}`, wrongReceipt.id, forged],
    );
    await expect(
      effectStore.beginEffect({
        runId: wrongReceipt.id,
        guard: {
          leaseId: wrongReceipt.leaseId as string,
          workerId: wrongReceipt.workerId as string,
          generation: wrongReceipt.leaseGeneration,
          fencingVersion: wrongReceipt.version,
        },
        kind: "GITHUB_REVIEW",
        target: "owner/repository",
        idempotencyKey: "forged-receipt",
        inputFingerprint: inputFingerprint(),
        payload: payload("input"),
      }),
    ).rejects.toThrow(/rejected|trusted/);

    const wrongCandidate = await validatedRun();
    const candidate = validationCandidate();
    await migrationPool.query(
      `INSERT INTO lineageguard.migration_candidates (id,run_id,position,payload)
       VALUES ($1,$2,2,$3)`,
      [
        `migration_${"d".repeat(24)}`,
        wrongCandidate.id,
        migrationCandidateSchema.parse({ ...candidate, summary: "Different candidate bytes." }),
      ],
    );
    await expect(
      effectStore.beginEffect({
        runId: wrongCandidate.id,
        guard: {
          leaseId: wrongCandidate.leaseId as string,
          workerId: wrongCandidate.workerId as string,
          generation: wrongCandidate.leaseGeneration,
          fencingVersion: wrongCandidate.version,
        },
        kind: "GITHUB_REVIEW",
        target: "owner/repository",
        idempotencyKey: "wrong-candidate",
        inputFingerprint: inputFingerprint(),
        payload: payload("input"),
      }),
    ).rejects.toThrow(/rejected|trusted/);

    const approved = await validatedRun();
    const approvalGuard = {
      leaseId: approved.leaseId as string,
      workerId: approved.workerId as string,
      generation: approved.leaseGeneration,
      fencingVersion: approved.version,
    };
    const effect = {
      runId: approved.id,
      guard: approvalGuard,
      kind: "GITHUB_REVIEW" as const,
      target: "owner/repository",
      idempotencyKey: "production-approved",
      inputFingerprint: inputFingerprint(),
      payload: payload("input"),
    };
    await expect(productionEffectStore.beginEffect(effect)).rejects.toThrow(/approval/);
    await approveCurrentEffect({
      runId: effect.runId,
      kind: effect.kind,
      target: effect.target,
      inputFingerprint: effect.inputFingerprint,
    });
    const begun = await productionEffectStore.beginEffect(effect);
    const storedValidation = (await store.snapshot(approved.id)).validationReceipts.at(-1)?.payload;
    if (!storedValidation) throw new Error("validation receipt required");
    const authorization = await productionEffectStore.reserveCurrentEffect({
      runId: approved.id,
      effectKind: "GITHUB_WRITE",
      inputFingerprint: inputFingerprint(),
      target: "owner/repository",
      intentId: begun.intent.id,
      idempotencyKey: effect.idempotencyKey,
      validationReceiptFingerprint: signedLiveValidationReceiptFingerprint(storedValidation),
    });
    expect(authorization).toMatchObject({
      currentStatus: "VALIDATED",
      currentLease: {
        leaseId: approved.leaseId,
        workerId: approved.workerId,
        generation: approved.leaseGeneration,
      },
      effectKind: "GITHUB_WRITE",
      inputFingerprint: inputFingerprint(),
      target: "owner/repository",
      approval: { status: "APPROVED", approvedBy: "reviewer@example.invalid" },
    });
    expect(authorization.currentRunEventStream).toEqual(
      (await store.snapshot(approved.id)).events.map((event) => event.payload),
    );
    expect(authorization.originalValidationEventPrefix.at(-1)).toMatchObject({
      type: "RUN_STATUS_CHANGED",
      to: "VALIDATING",
    });
    const storedReservation = await migrationPool.query<{
      token_hash: string;
      run_status: string;
    }>(
      "SELECT token_hash,run_status FROM lineageguard.effect_invocation_reservations WHERE id=$1",
      [authorization.reservationId],
    );
    expect(storedReservation.rows[0]?.token_hash).toMatch(/^[a-f0-9]{64}$/);
    expect(storedReservation.rows[0]?.token_hash).not.toBe(authorization.reservationToken);
    expect(storedReservation.rows[0]?.run_status).toBe("VALIDATED");
    const reservedRun = (await store.snapshot(approved.id)).run;
    await expect(
      store.releaseLease(approved.id, {
        leaseId: reservedRun.leaseId as string,
        workerId: reservedRun.workerId as string,
        generation: reservedRun.leaseGeneration,
        fencingVersion: reservedRun.version,
      }),
    ).rejects.toThrow(/active effect invocation/);
    const consumption = {
      reservationId: authorization.reservationId,
      reservationToken: authorization.reservationToken,
      runId: approved.id,
      intentId: begun.intent.id,
      idempotencyKey: effect.idempotencyKey,
      effectKind: "GITHUB_WRITE" as const,
      inputFingerprint: effect.inputFingerprint,
      target: effect.target,
      validationReceiptId: authorization.validationReceiptId,
      validationReceiptFingerprint: authorization.validationReceiptFingerprint,
      approvalId: authorization.approvalId,
      approvalFingerprint: authorization.approvalFingerprint,
      intentFingerprint: authorization.intentFingerprint,
    };
    await expect(
      productionEffectStore.consumeCurrentEffect(consumption, effect.inputFingerprint),
    ).resolves.toMatchObject({ canonicalEffectFingerprint: effect.inputFingerprint });
    await expect(
      productionEffectStore.consumeCurrentEffect(consumption, effect.inputFingerprint),
    ).rejects.toThrow(/invalid|consumed|consume rejected/);
  });

  it("fails closed on corrupt snapshot payloads", async () => {
    const run = await create();
    await migrationPool.query("UPDATE lineageguard.runs SET payload=$2 WHERE id=$1", [
      run.id,
      { corrupt: true },
    ]);
    await expect(store.snapshot(run.id)).rejects.toBeInstanceOf(CorruptDataError);
  });
});
