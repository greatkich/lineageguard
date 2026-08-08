import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { requireLocalIntegrationUrl } from "./config.js";
import { createSimpleRunStore, type SimpleRunStore } from "./simple-runs.js";

const { Pool } = pg;

const hasIntegrationDb = Boolean(process.env.LINEAGEGUARD_TEST_DATABASE_URL);

describe.skipIf(!hasIntegrationDb)("SimpleRunStore source change persistence", () => {
  let pool: InstanceType<typeof Pool> = undefined!;
  let store: SimpleRunStore = undefined!;

  beforeAll(async () => {
    pool = new Pool({
      connectionString: requireLocalIntegrationUrl(process.env.LINEAGEGUARD_TEST_DATABASE_URL),
      max: 4,
    });
    store = createSimpleRunStore(pool);
    await store.ensureSchema();
  });

  afterAll(async () => {
    await pool.end();
  });

  it("persists source change metadata on create", async () => {
    const id = `test_${crypto.randomUUID().replaceAll("-", "")}`;
    await store.create({
      id,
      repository: "org/walkthrough",
      field: "customer_id",
      patch: "RENAME COLUMN customer_id TO buyer_id",
      sourcePrUrl: "https://github.com/org/walkthrough/pull/42",
      sourcePrNumber: 42,
      sourceBaseSha: "a".repeat(40),
      sourceHeadSha: "b".repeat(40),
      sourceDiffFingerprint: "sha256:abc123",
      sourceFilePath: "migrations/001.sql",
    });

    const fetched = await store.get(id);
    expect(fetched).toMatchObject({
      sourcePrUrl: "https://github.com/org/walkthrough/pull/42",
      sourcePrNumber: 42,
      sourceBaseSha: "a".repeat(40),
      sourceHeadSha: "b".repeat(40),
      sourceDiffFingerprint: "sha256:abc123",
      sourceFilePath: "migrations/001.sql",
    });
  });

  it("defaults source change fields to null when omitted", async () => {
    const id = `test_${crypto.randomUUID().replaceAll("-", "")}`;
    await store.create({
      id,
      repository: "org/walkthrough",
      field: "customer_id",
      patch: "RENAME COLUMN customer_id TO buyer_id",
    });

    const fetched = await store.get(id);
    expect(fetched).toMatchObject({
      sourcePrUrl: null,
      sourcePrNumber: null,
      sourceBaseSha: null,
      sourceHeadSha: null,
      sourceDiffFingerprint: null,
      sourceFilePath: null,
    });
  });

  it("updates source change metadata via the extra channel", async () => {
    const id = `test_${crypto.randomUUID().replaceAll("-", "")}`;
    await store.create({
      id,
      repository: "org/walkthrough",
      field: "customer_id",
      patch: "RENAME COLUMN customer_id TO buyer_id",
    });

    await store.update(id, "CREATED", {
      sourcePrUrl: "https://github.com/org/walkthrough/pull/7",
      sourcePrNumber: 7,
      sourceBaseSha: "c".repeat(40),
      sourceHeadSha: "d".repeat(40),
      sourceDiffFingerprint: "sha256:def456",
      sourceFilePath: "migrations/002.sql",
    });

    const fetched = await store.get(id);
    expect(fetched).toMatchObject({
      sourcePrUrl: "https://github.com/org/walkthrough/pull/7",
      sourcePrNumber: 7,
      sourceBaseSha: "c".repeat(40),
      sourceHeadSha: "d".repeat(40),
      sourceDiffFingerprint: "sha256:def456",
      sourceFilePath: "migrations/002.sql",
    });
  });

  it("adds, updates, and maps github_effect_outcome", async () => {
    const id = `test_${crypto.randomUUID().replaceAll("-", "")}`;
    try {
      const created = await store.create({
        id,
        repository: "org/walkthrough",
        field: "customer_id",
        patch: "RENAME COLUMN customer_id TO buyer_id",
      });
      expect(created.githubEffectOutcome).toBeNull();

      await store.update(id, "REVIEW_ARTIFACT_CREATED", {
        githubEffectOutcome: "SKIPPED_EXACT",
      });

      expect(await store.get(id)).toMatchObject({ githubEffectOutcome: "SKIPPED_EXACT" });
      const raw = await pool.query<{ github_effect_outcome: string }>(
        "SELECT github_effect_outcome FROM lineageguard.simple_runs WHERE id = $1",
        [id],
      );
      expect(raw.rows[0]?.github_effect_outcome).toBe("SKIPPED_EXACT");
    } finally {
      await pool.query("DELETE FROM lineageguard.simple_runs WHERE id = $1", [id]);
    }
  });
});
