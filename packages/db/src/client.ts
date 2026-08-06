import pg from "pg";
import type { DatabaseConfig } from "./config.js";

const { Pool } = pg;

export interface Database {
  readonly pool: pg.Pool;
  close(): Promise<void>;
}

export function createDatabase(config: DatabaseConfig): Database {
  const pool = new Pool({
    connectionString: config.connectionString,
    max: config.maxConnections,
    idleTimeoutMillis: config.idleTimeoutMillis,
    connectionTimeoutMillis: config.connectionTimeoutMillis,
    ssl: config.ssl,
  });
  let closing: Promise<void> | undefined;
  return {
    pool,
    close() {
      closing ??= pool.end();
      return closing;
    },
  };
}

export async function inTransaction<T>(
  pool: pg.Pool,
  operation: (client: pg.PoolClient) => Promise<T>,
): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const result = await operation(client);
    await client.query("COMMIT");
    return result;
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}
