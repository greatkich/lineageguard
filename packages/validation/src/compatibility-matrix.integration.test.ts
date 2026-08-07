/**
 * Compatibility matrix: 8 behaviors of the expand-migrate-contract trigger.
 *
 * These tests run against a REAL PostgreSQL instance (the walkthrough Postgres container)
 * and prove every path through the sync trigger that keeps old and new consumers compatible
 * during the migration window.
 *
 * Requires: LINEAGEGUARD_DATABASE_URL pointing to a live PostgreSQL instance.
 * Skip condition: LINEAGEGUARD_EXECUTABLE_INTEGRATION !== "1"
 */
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const SKIP = process.env.LINEAGEGUARD_EXECUTABLE_INTEGRATION !== "1";

describe.skipIf(SKIP)("compatibility matrix (8 behaviors)", () => {
  let pool: pg.Pool;

  const EXPAND_SQL = `
    ALTER TABLE commerce.orders ADD COLUMN buyer_id uuid;
    UPDATE commerce.orders SET buyer_id = customer_id;
    CREATE FUNCTION commerce.sync_order_customer_buyer() RETURNS trigger LANGUAGE plpgsql AS $$
    BEGIN
      IF TG_OP = 'INSERT' THEN
        IF NEW.buyer_id IS NULL AND NEW.customer_id IS NOT NULL THEN
          NEW.buyer_id := NEW.customer_id;
        ELSIF NEW.customer_id IS NULL AND NEW.buyer_id IS NOT NULL THEN
          NEW.customer_id := NEW.buyer_id;
        ELSIF NEW.customer_id IS NULL AND NEW.buyer_id IS NULL THEN
          RAISE EXCEPTION 'at least one identifier must be provided';
        ELSIF NEW.customer_id IS DISTINCT FROM NEW.buyer_id THEN
          RAISE EXCEPTION 'customer_id and buyer_id must match during compatibility window';
        END IF;
      ELSIF TG_OP = 'UPDATE' THEN
        IF NEW.customer_id IS DISTINCT FROM OLD.customer_id AND NEW.buyer_id IS NOT DISTINCT FROM OLD.buyer_id THEN
          NEW.buyer_id := NEW.customer_id;
        ELSIF NEW.buyer_id IS DISTINCT FROM OLD.buyer_id AND NEW.customer_id IS NOT DISTINCT FROM OLD.customer_id THEN
          NEW.customer_id := NEW.buyer_id;
        ELSIF NEW.customer_id IS DISTINCT FROM OLD.customer_id AND NEW.buyer_id IS DISTINCT FROM OLD.buyer_id THEN
          IF NEW.customer_id IS DISTINCT FROM NEW.buyer_id THEN
            RAISE EXCEPTION 'customer_id and buyer_id must match during compatibility window';
          END IF;
        END IF;
      END IF;
      RETURN NEW;
    END $$;
    CREATE TRIGGER orders_customer_buyer_compat
      BEFORE INSERT OR UPDATE ON commerce.orders
      FOR EACH ROW EXECUTE FUNCTION commerce.sync_order_customer_buyer();
  `;

  const SCHEMA = "compat_matrix_test";
  const TABLE = `${SCHEMA}.orders`;

  beforeAll(async () => {
    pool = new pg.Pool({
      connectionString:
        process.env.LINEAGEGUARD_DATABASE_URL ??
        "postgresql://lineageguard:lineageguard@127.0.0.1:5432/lineageguard",
      max: 2,
    });
    // Create an isolated schema for this test
    await pool.query(`DROP SCHEMA IF EXISTS ${SCHEMA} CASCADE`);
    await pool.query(`CREATE SCHEMA ${SCHEMA}`);
    await pool.query(`
      CREATE TABLE ${TABLE} (
        order_id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        customer_id uuid NOT NULL,
        order_total numeric(10,2) NOT NULL DEFAULT 0,
        ordered_at timestamptz NOT NULL DEFAULT now()
      )
    `);
    // Insert seed row for UPDATE tests
    await pool.query(
      `INSERT INTO ${TABLE} (order_id, customer_id) VALUES ('aaaaaaaa-0000-0000-0000-000000000001', 'cccccccc-0000-0000-0000-000000000001')`,
    );
    // Apply the expand migration (add buyer_id + trigger)
    const expandSql = EXPAND_SQL.replace(/commerce\.orders/g, TABLE).replace(
      /commerce\.sync_order_customer_buyer/g,
      `${SCHEMA}.sync_order_customer_buyer`,
    );
    await pool.query(expandSql);
  });

  afterAll(async () => {
    await pool.query(`DROP SCHEMA IF EXISTS ${SCHEMA} CASCADE`);
    await pool.end();
  });

  it("1. old-only INSERT populates buyer_id from customer_id", async () => {
    const { rows } = await pool.query(
      `INSERT INTO ${TABLE} (order_id, customer_id) VALUES ('aaaaaaaa-1111-0000-0000-000000000001', 'cccccccc-1111-0000-0000-000000000001') RETURNING buyer_id`,
    );
    expect(rows[0]?.buyer_id).toBe("cccccccc-1111-0000-0000-000000000001");
  });

  it("2. new-only INSERT populates customer_id from buyer_id", async () => {
    const { rows } = await pool.query(
      `INSERT INTO ${TABLE} (order_id, buyer_id) VALUES ('aaaaaaaa-2222-0000-0000-000000000001', 'cccccccc-2222-0000-0000-000000000001') RETURNING customer_id`,
    );
    expect(rows[0]?.customer_id).toBe("cccccccc-2222-0000-0000-000000000001");
  });

  it("3. equal dual INSERT accepted", async () => {
    const { rows } = await pool.query(
      `INSERT INTO ${TABLE} (order_id, customer_id, buyer_id) VALUES ('aaaaaaaa-3333-0000-0000-000000000001', 'cccccccc-3333-0000-0000-000000000001', 'cccccccc-3333-0000-0000-000000000001') RETURNING customer_id, buyer_id`,
    );
    expect(rows[0]?.customer_id).toBe("cccccccc-3333-0000-0000-000000000001");
    expect(rows[0]?.buyer_id).toBe("cccccccc-3333-0000-0000-000000000001");
  });

  it("4. conflicting dual INSERT rejected", async () => {
    await expect(
      pool.query(
        `INSERT INTO ${TABLE} (order_id, customer_id, buyer_id) VALUES ('aaaaaaaa-4444-0000-0000-000000000001', 'cccccccc-4444-0000-0000-000000000001', 'dddddddd-4444-0000-0000-000000000001')`,
      ),
    ).rejects.toThrow(/customer_id and buyer_id must match/);
  });

  it("5. UPDATE customer_id syncs buyer_id", async () => {
    const { rows } = await pool.query(
      `UPDATE ${TABLE} SET customer_id = 'cccccccc-5555-0000-0000-000000000001' WHERE order_id = 'aaaaaaaa-0000-0000-0000-000000000001' RETURNING buyer_id`,
    );
    expect(rows[0]?.buyer_id).toBe("cccccccc-5555-0000-0000-000000000001");
  });

  it("6. UPDATE buyer_id syncs customer_id", async () => {
    const { rows } = await pool.query(
      `UPDATE ${TABLE} SET buyer_id = 'cccccccc-6666-0000-0000-000000000001' WHERE order_id = 'aaaaaaaa-0000-0000-0000-000000000001' RETURNING customer_id`,
    );
    expect(rows[0]?.customer_id).toBe("cccccccc-6666-0000-0000-000000000001");
  });

  it("7. backfill is safe (existing rows have buyer_id populated)", async () => {
    const { rows } = await pool.query(
      `SELECT count(*) AS total, count(*) FILTER (WHERE buyer_id IS NOT NULL) AS with_buyer FROM ${TABLE}`,
    );
    expect(Number(rows[0]?.total)).toBeGreaterThan(0);
    expect(rows[0]?.total).toBe(rows[0]?.with_buyer);
  });

  it("8. buyer_id is NOT NULL after migration, customer_id retained", async () => {
    // Apply NOT NULL constraint (same as the migration does after backfill)
    await pool.query(`ALTER TABLE ${TABLE} ALTER COLUMN buyer_id SET NOT NULL`);

    // Verify customer_id column still exists and is NOT NULL
    const { rows } = await pool.query(`
      SELECT column_name, is_nullable
      FROM information_schema.columns
      WHERE table_schema = '${SCHEMA}' AND table_name = 'orders'
        AND column_name IN ('customer_id', 'buyer_id')
      ORDER BY column_name
    `);
    expect(rows).toEqual([
      { column_name: "buyer_id", is_nullable: "NO" },
      { column_name: "customer_id", is_nullable: "NO" },
    ]);
  });
});
