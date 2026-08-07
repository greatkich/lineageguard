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
});
