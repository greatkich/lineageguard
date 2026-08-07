import { execFile } from "node:child_process";
import { generateKeyPairSync } from "node:crypto";
import { readFileSync } from "node:fs";
import { mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import {
  bindMigrationCandidate,
  canonicalDatasetRef,
  evaluateGroundedRisk,
  type MigrationCandidate,
  parseProposedChange,
  type RunEventStream,
} from "@lineageguard/domain";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  createLiveValidationReceiptVerifier,
  createValidationReceiptIssuerServer,
  readRuntimeVerifiedLiveReceipt,
  type ValidationAuthorityBinding,
  type ValidationReceiptAuthorityStore,
  type VerifiedLiveValidation,
} from "./attestation.js";
import { createCanonicalLiveImpactContextTestFixture } from "./canonical-impact-context.test-support.js";
import { materializeCandidate } from "./materializer.js";
import {
  canonicalValidationChecks,
  sqlDriverDigest,
  type ValidationRuntimePolicy,
} from "./validator.js";

const enabled = process.env.LINEAGEGUARD_EXECUTABLE_INTEGRATION === "1";
const suite = enabled ? describe : describe.skip;
const executeFile = promisify(execFile);
const runId = `run_${"a".repeat(24)}`;
const validationLeaseId = `lease_${"b".repeat(24)}`;
const workerId = "worker-validation-integration";
let root = "";
let repositoryPath = "";
let sandboxRoot = "";
let baseSha = "";
let runtimePolicy: ValidationRuntimePolicy;

function iso(milliseconds: number) {
  return new Date(milliseconds).toISOString();
}

function canonicalBinding(candidateVariant?: (candidate: MigrationCandidate) => void) {
  const parsed = parseProposedChange({
    source: "FIXTURE",
    repository: "lineageguard/canonical",
    baseSha,
    headSha: "2".repeat(40),
    files: [
      {
        path: "walkthrough/migrations/rename.sql",
        datasetRef: canonicalDatasetRef,
        patch: "ALTER TABLE commerce.orders RENAME COLUMN customer_id TO buyer_id;",
      },
    ],
  });
  if (!parsed.ok) throw new Error(parsed.error.message);
  const context = createCanonicalLiveImpactContextTestFixture(parsed.value.id);
  const assessment = evaluateGroundedRisk(parsed.value, context, "2026-08-04T09:00:00.000Z");
  const source = structuredClone(
    JSON.parse(
      readFileSync(
        new URL("../../../examples/canonical/accepted-generation-response.json", import.meta.url),
        "utf8",
      ),
    ) as MigrationCandidate,
  );
  const evidenceIds = [
    ...new Set(assessment.reasons.flatMap((reason) => reason.evidenceIds)),
  ].sort();
  source.sourceChangeFingerprint = parsed.value.fingerprint;
  source.sourcePatchFingerprint = parsed.value.sourcePatchFingerprint;
  source.sourceImpactContextFingerprint = context.impactContextFingerprint;
  source.sourceEvidenceIds = evidenceIds;
  for (const step of source.steps) step.affectedEvidenceIds = evidenceIds;
  source.requiredReviewers = context.evidence
    .filter((item) => item.kind === "OWNER")
    .map((item) => ({
      kind: "OWNER" as const,
      ownerUrn: item.payload.ownerUrn,
      affectedAssetUrns: [item.payload.assetUrn],
      reason: "DataHub identifies this owner for an affected asset.",
    }))
    .sort((left, right) => left.ownerUrn.localeCompare(right.ownerUrn));
  for (const artifact of source.artifacts) {
    if (artifact.operation === "MODIFY") artifact.expectedBaseSha = baseSha;
  }
  candidateVariant?.(source);
  const candidate = bindMigrationCandidate(source, parsed.value, context, assessment);
  const start = Date.now() - 30_000;
  const statuses = [
    "CHANGE_PARSED",
    "BASELINE_ASSESSED",
    "CONTEXT_COLLECTING",
    "CONTEXT_COLLECTED",
    "RISK_DECIDED",
    "MIGRATION_PLANNED",
    "PATCH_GENERATED",
    "VALIDATING",
  ] as const;
  const stream = [
    {
      eventId: `evt_${"0".repeat(24)}`,
      runId,
      sequence: 0,
      occurredAt: iso(start),
      type: "RUN_LEASE_ACQUIRED",
      leaseId: validationLeaseId,
      workerId,
      generation: 1,
      expiresAt: iso(Date.now() + 120_000),
    },
    ...statuses.map((to, index) => ({
      eventId: `evt_${(index + 1).toString(16).padStart(24, "0")}`,
      runId,
      sequence: index + 1,
      occurredAt: iso(start + (index + 1) * 1_000),
      type: "RUN_STATUS_CHANGED" as const,
      leaseId: validationLeaseId,
      workerId,
      generation: 1,
      from: index === 0 ? ("CREATED" as const) : (statuses[index - 1] as (typeof statuses)[number]),
      to,
    })),
  ] as RunEventStream;
  const dbtDigest = runtimePolicy.validationRunnerImageId.slice("sha256:".length);
  const commandIds = {
    SQL_MIGRATION: "VALIDATE_SQL_MIGRATION_V1",
    BACKFILL_EQUALITY: "VALIDATE_BACKFILL_EQUALITY_V1",
    DBT_PARSE: "VALIDATE_DBT_PARSE_V1",
    DBT_COMPILE: "VALIDATE_DBT_COMPILE_V1",
    DBT_TEST: "VALIDATE_DBT_TEST_V1",
    OLD_CONSUMER_COMPATIBILITY: "VALIDATE_OLD_CONSUMER_V1",
    NEW_CONSUMER_COMPATIBILITY: "VALIDATE_NEW_CONSUMER_V1",
    ROLLBACK: "VALIDATE_ROLLBACK_V1",
  } as const;
  const binding: ValidationAuthorityBinding = {
    change: parsed.value,
    context,
    authoritativeAssessment: assessment,
    candidate,
    authorizedRunEventStream: stream,
    expectedExecution: {
      schemaVersion: 1,
      purpose: "LINEAGEGUARD_EXPECTED_VALIDATION_EXECUTION",
      runId,
      sandboxId: "sandbox-integration",
      worktreeId: "worktree-integration",
      leaseId: validationLeaseId,
      workerId,
      generation: 1,
      validators: canonicalValidationChecks.map((check) => ({
        check,
        commandId: commandIds[check],
        implementationId: check.startsWith("DBT")
          ? runtimePolicy.dbtImplementationId
          : runtimePolicy.sqlDriverImplementationId,
        version: check.startsWith("DBT")
          ? runtimePolicy.dbtVersion
          : runtimePolicy.sqlDriverVersion,
        digest: check.startsWith("DBT") ? dbtDigest : sqlDriverDigest,
      })),
    },
  };
  return binding;
}

function signer(
  binding: ValidationAuthorityBinding,
  validationBinding: () => ValidationAuthorityBinding = () => binding,
) {
  const { privateKey, publicKey } = generateKeyPairSync("ed25519");
  const validationStore: ValidationReceiptAuthorityStore = {
    async loadValidationExecutionClaim() {
      return validationBinding();
    },
    async issueAndStoreValidationReceipt(_request, issue) {
      return issue(validationBinding(), new Date().toISOString());
    },
  };
  const keys = [
    {
      algorithm: "ED25519",
      issuer: "lineageguard-integration",
      keyId: "integration-key",
      publicKeySpkiPem: publicKey.export({ type: "spki", format: "pem" }).toString(),
    },
  ] as const;
  return {
    issuer: createValidationReceiptIssuerServer(
      {
        privateKeyPkcs8Pem: privateKey.export({ type: "pkcs8", format: "pem" }).toString(),
        issuer: "lineageguard-integration",
        keyId: "integration-key",
      },
      keys,
      validationStore,
      runtimePolicy,
    ),
    verifier: createLiveValidationReceiptVerifier(keys),
  };
}

async function materialize(candidate: MigrationCandidate) {
  return materializeCandidate(candidate, {
    repositoryPath,
    sandboxRoot,
    baseSha,
    sandboxId: "sandbox-integration",
    worktreeId: "worktree-integration",
  });
}

suite("public executable validation and attestation path", () => {
  beforeAll(async () => {
    root = await realpath(await mkdtemp(join(tmpdir(), "lineageguard-public-validation-")));
    repositoryPath = join(root, "repository");
    sandboxRoot = join(root, "sandboxes");
    await mkdir(join(repositoryPath, "walkthrough/models"), { recursive: true });
    await mkdir(sandboxRoot);
    await writeFile(
      join(repositoryPath, "walkthrough/models/orders.sql"),
      "select order_id, customer_id from commerce.orders\n",
    );
    await writeFile(
      join(repositoryPath, "walkthrough/models/sources.yml"),
      "version: 2\nsources:\n  - name: commerce\n    schema: commerce\n    tables:\n      - name: orders\n",
    );
    await writeFile(
      join(repositoryPath, "walkthrough/dbt_project.yml"),
      "name: lineageguard_validation\nversion: '1.0'\nconfig-version: 2\nprofile: lineageguard\nmodel-paths: [models]\ntest-paths: [tests]\n",
    );
    await executeFile("git", ["init", "-q"], { cwd: repositoryPath });
    await executeFile("git", ["config", "user.name", "LineageGuard Tests"], {
      cwd: repositoryPath,
    });
    await executeFile("git", ["config", "user.email", "tests@lineageguard.invalid"], {
      cwd: repositoryPath,
    });
    await executeFile("git", ["add", "."], { cwd: repositoryPath });
    await executeFile("git", ["commit", "-qm", "base"], { cwd: repositoryPath });
    baseSha = (
      await executeFile("git", ["rev-parse", "HEAD"], { cwd: repositoryPath })
    ).stdout.trim();
    const validationRunnerImageId = process.env.LINEAGEGUARD_VALIDATION_RUNNER_IMAGE_ID;
    const postgresImageId = process.env.LINEAGEGUARD_VALIDATION_POSTGRES_IMAGE_ID;
    const dockerExecutable = process.env.LINEAGEGUARD_DOCKER_EXECUTABLE;
    if (!validationRunnerImageId || !postgresImageId || !dockerExecutable) {
      throw new Error("content-addressed validation images and Docker path are required");
    }
    runtimePolicy = {
      baseFixtureSql:
        "create schema commerce; create table commerce.orders (order_id uuid primary key, customer_id uuid not null); insert into commerce.orders values ('00000000-0000-4000-8000-000000000001','00000000-0000-4000-8000-0000000000a1'),('00000000-0000-4000-8000-000000000002','00000000-0000-4000-8000-0000000000a2');",
      dockerExecutable,
      validationRunnerImageId,
      postgresImageId,
      sqlDriverImplementationId: "postgresql-17.6-container",
      sqlDriverVersion: "pg 8.16.3/PostgreSQL 17.6",
      dbtImplementationId: "dbt-core-postgres",
      dbtVersion: "dbt-core 1.12.0/dbt-postgres 1.11.0",
      timeoutMs: 120_000,
      maxOutputBytes: 512_000,
    };
  }, 30_000);

  afterAll(async () => {
    if (root) {
      await executeFile("chmod", ["-R", "u+w", root]).catch(() => undefined);
      await rm(root, { recursive: true, force: true });
    }
  });

  it("materializes, validates eight checks, signs, and audits exact receipt lineage", async () => {
    const binding = canonicalBinding();
    const handle = await materialize(binding.candidate);
    const authority = signer(binding);
    let live: VerifiedLiveValidation;
    try {
      live = await authority.issuer.validateAndIssue(runId, handle);
    } catch (error) {
      throw new Error(
        `public validation failed: ${String(Reflect.get(error as object, "diagnostic"))}`,
      );
    }
    expect(readRuntimeVerifiedLiveReceipt(live).payload.checks.map((check) => check.check)).toEqual(
      canonicalValidationChecks,
    );
    expect(live.receipt.payload.checks.every((check) => check.exitCode === 0)).toBe(true);
    expect(authority.verifier.verifyHistoricalLive(live.receipt, binding).receipt).toEqual(
      live.receipt,
    );
    await handle.cleanup();
  }, 180_000);

  it.each([
    [
      "cancelled run",
      (binding: ValidationAuthorityBinding): ValidationAuthorityBinding => ({
        ...binding,
        authorizedRunEventStream: [
          ...binding.authorizedRunEventStream,
          {
            eventId: `evt_${"d".repeat(24)}`,
            runId,
            sequence: binding.authorizedRunEventStream.length,
            occurredAt: iso(Date.now()),
            type: "RUN_STATUS_CHANGED",
            leaseId: validationLeaseId,
            workerId,
            generation: 1,
            from: "VALIDATING",
            to: "CANCELLED",
          },
        ] as RunEventStream,
      }),
    ],
    [
      "reassigned lease",
      (binding: ValidationAuthorityBinding): ValidationAuthorityBinding => {
        const releasedAt = Date.now();
        return {
          ...binding,
          authorizedRunEventStream: [
            ...binding.authorizedRunEventStream,
            {
              eventId: `evt_${"d".repeat(24)}`,
              runId,
              sequence: binding.authorizedRunEventStream.length,
              occurredAt: iso(releasedAt),
              type: "RUN_LEASE_RELEASED",
              leaseId: validationLeaseId,
              workerId,
              generation: 1,
            },
            {
              eventId: `evt_${"e".repeat(24)}`,
              runId,
              sequence: binding.authorizedRunEventStream.length + 1,
              occurredAt: iso(releasedAt + 1),
              type: "RUN_LEASE_ACQUIRED",
              leaseId: `lease_${"f".repeat(24)}`,
              workerId: "worker-validation-reassigned",
              generation: 2,
              expiresAt: iso(releasedAt + 120_000),
            },
          ] as RunEventStream,
        };
      },
    ],
    [
      "changed candidate",
      (binding: ValidationAuthorityBinding): ValidationAuthorityBinding => ({
        ...binding,
        candidate: { ...binding.candidate, summary: `${binding.candidate.summary} changed` },
      }),
    ],
  ] as const)(
    "does not mint after execution for a %s",
    async (_label, afterExecution) => {
      const binding = canonicalBinding();
      const handle = await materialize(binding.candidate);
      let reads = 0;
      const authority = signer(binding, () => {
        reads += 1;
        return reads === 1 ? binding : afterExecution(binding);
      });
      try {
        await expect(authority.issuer.validateAndIssue(runId, handle)).rejects.toMatchObject({
          code: "ATTESTATION_INVALID",
        });
        expect(reads).toBe(2);
      } finally {
        await handle.cleanup();
      }
    },
    180_000,
  );

  it.each([
    [
      "broken migration",
      (candidate: MigrationCandidate) => {
        const artifact = candidate.artifacts.find((item) => item.kind === "SQL_MIGRATION");
        if (artifact) artifact.content = "select definitely_invalid_migration syntax;";
      },
      "SQL_MIGRATION",
    ],
    [
      "broken old/new compatibility",
      (candidate: MigrationCandidate) => {
        const artifact = candidate.artifacts.find((item) => item.kind === "SQL_MIGRATION");
        if (artifact) {
          artifact.content +=
            "drop trigger orders_customer_buyer_compat on commerce.orders;\ndrop function commerce.sync_order_customer_buyer();\nalter table commerce.orders drop column customer_id;\n";
        }
      },
      "SQL_MIGRATION",
    ],
    [
      "broken rollback",
      (candidate: MigrationCandidate) => {
        const artifact = candidate.artifacts.find((item) => item.kind === "ROLLBACK_SQL");
        if (artifact) artifact.content = "select definitely_invalid_rollback syntax;";
      },
      "ROLLBACK",
    ],
  ] as const)(
    "refuses to issue for %s through the same public path",
    async (_label, mutate, check) => {
      const binding = canonicalBinding(mutate);
      const handle = await materialize(binding.candidate);
      const authority = signer(binding);
      await expect(authority.issuer.validateAndIssue(runId, handle)).rejects.toMatchObject({
        code: "ATTESTATION_INVALID",
        diagnostic: expect.stringContaining(check),
      });
      await handle.cleanup();
    },
    180_000,
  );
});
