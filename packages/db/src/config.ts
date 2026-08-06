import { ConfigurationError } from "./errors.js";

const LOCAL_HOSTS = new Set(["127.0.0.1", "localhost", "::1"]);
export const DEFAULT_DATABASE_URL =
  "postgresql://lineageguard_runtime@127.0.0.1:55432/lineageguard";

export interface DatabaseConfig {
  connectionString: string;
  maxConnections: number;
  idleTimeoutMillis: number;
  connectionTimeoutMillis: number;
  ssl: false | { rejectUnauthorized: true };
}

export interface AuthorityDatabaseConfigs {
  validationSigner: DatabaseConfig;
  approvalAuthority: DatabaseConfig;
  effectAuthority: DatabaseConfig;
}

function positiveInteger(value: string | undefined, fallback: number, name: string): number {
  if (value === undefined) return fallback;
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed <= 0) {
    throw new ConfigurationError(`${name} must be a positive integer`);
  }
  return parsed;
}

export function databaseConfigFromEnv(
  env: Readonly<Record<string, string | undefined>> = process.env,
): DatabaseConfig {
  const connectionString = env.LINEAGEGUARD_DATABASE_URL ?? DEFAULT_DATABASE_URL;
  let url: URL;
  try {
    url = new URL(connectionString);
  } catch {
    throw new ConfigurationError("LINEAGEGUARD_DATABASE_URL must be a valid URL");
  }
  if (url.protocol !== "postgres:" && url.protocol !== "postgresql:") {
    throw new ConfigurationError("LINEAGEGUARD_DATABASE_URL must use postgres or postgresql");
  }
  if (!url.username || !url.hostname || !url.pathname.slice(1)) {
    throw new ConfigurationError("database URL must include username, host, and database");
  }

  const local = LOCAL_HOSTS.has(url.hostname);
  const allowRemote = env.LINEAGEGUARD_DB_ALLOW_REMOTE === "true";
  if (!local && !allowRemote) {
    throw new ConfigurationError("remote database hosts require LINEAGEGUARD_DB_ALLOW_REMOTE=true");
  }

  const tlsRequested = url.searchParams.get("sslmode") === "verify-full";
  if (!local && !tlsRequested) {
    throw new ConfigurationError("remote database hosts require sslmode=verify-full");
  }

  return {
    connectionString,
    maxConnections: positiveInteger(env.LINEAGEGUARD_DB_POOL_MAX, 10, "pool max"),
    idleTimeoutMillis: positiveInteger(env.LINEAGEGUARD_DB_IDLE_TIMEOUT_MS, 30_000, "idle timeout"),
    connectionTimeoutMillis: positiveInteger(
      env.LINEAGEGUARD_DB_CONNECT_TIMEOUT_MS,
      5_000,
      "connection timeout",
    ),
    ssl: local ? false : { rejectUnauthorized: true },
  };
}

export function authorityDatabaseConfigsFromEnv(
  env: Readonly<Record<string, string | undefined>> = process.env,
): AuthorityDatabaseConfigs {
  const config = (name: string): DatabaseConfig => {
    const connectionString = env[name];
    if (!connectionString) throw new ConfigurationError(`${name} is required`);
    return databaseConfigFromEnv({
      ...env,
      LINEAGEGUARD_DATABASE_URL: connectionString,
    });
  };
  return {
    validationSigner: config("LINEAGEGUARD_VALIDATION_SIGNER_DATABASE_URL"),
    approvalAuthority: config("LINEAGEGUARD_APPROVAL_AUTHORITY_DATABASE_URL"),
    effectAuthority: config("LINEAGEGUARD_EFFECT_AUTHORITY_DATABASE_URL"),
  };
}

export function requireLocalIntegrationUrl(value: string | undefined): string {
  if (!value) {
    throw new ConfigurationError(
      "LINEAGEGUARD_TEST_DATABASE_URL is required for database integration tests",
    );
  }
  const url = new URL(value);
  if (!LOCAL_HOSTS.has(url.hostname)) {
    throw new ConfigurationError("integration tests refuse non-loopback database hosts");
  }
  return value;
}

export function requireLocalMigrationIntegrationUrl(value: string | undefined): string {
  if (!value) {
    throw new ConfigurationError(
      "LINEAGEGUARD_TEST_MIGRATION_DATABASE_URL is required for database integration tests",
    );
  }
  return requireLocalIntegrationUrl(value);
}
