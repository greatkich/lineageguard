import pg from "pg";
import { databaseConfigFromEnv } from "./config.js";
import {
  grantApprovalAuthorityPrivileges,
  grantEffectAuthorityPrivileges,
  grantRuntimePrivileges,
  grantValidationSignerPrivileges,
  migrate,
} from "./migrations.js";

const migrationUrl = process.env.LINEAGEGUARD_DATABASE_MIGRATION_URL;
if (!migrationUrl) throw new Error("LINEAGEGUARD_DATABASE_MIGRATION_URL is required");

const config = databaseConfigFromEnv({
  ...process.env,
  LINEAGEGUARD_DATABASE_URL: migrationUrl,
});
const pool = new pg.Pool({
  connectionString: config.connectionString,
  max: config.maxConnections,
  idleTimeoutMillis: config.idleTimeoutMillis,
  connectionTimeoutMillis: config.connectionTimeoutMillis,
  ssl: config.ssl,
});
let ownerSchemaCreateGranted = false;

try {
  const loginRoles = [
    ["lineageguard_runtime", "LINEAGEGUARD_RUNTIME_DB_PASSWORD"],
    ["lineageguard_validation_signer", "LINEAGEGUARD_VALIDATION_SIGNER_DB_PASSWORD"],
    ["lineageguard_approval_authority", "LINEAGEGUARD_APPROVAL_AUTHORITY_DB_PASSWORD"],
    ["lineageguard_effect_authority", "LINEAGEGUARD_EFFECT_AUTHORITY_DB_PASSWORD"],
  ] as const;
  for (const [role, variable] of loginRoles) {
    const password = process.env[variable];
    if (!password) throw new Error(`${variable} is required`);
    const exists = await pool.query<{ exists: boolean }>(
      "SELECT EXISTS(SELECT 1 FROM pg_roles WHERE rolname=$1) AS exists",
      [role],
    );
    const quotedPassword = await pool.query<{ literal: string }>(
      "SELECT quote_literal($1::text) AS literal",
      [password],
    );
    const literal = quotedPassword.rows[0]?.literal;
    if (!literal) throw new Error("database password quoting failed");
    await pool.query(
      exists.rows[0]?.exists
        ? `ALTER ROLE ${role} LOGIN PASSWORD ${literal}`
        : `CREATE ROLE ${role} LOGIN PASSWORD ${literal}`,
    );
  }
  const ownerExists = await pool.query<{ exists: boolean }>(
    "SELECT EXISTS(SELECT 1 FROM pg_roles WHERE rolname='lineageguard_procedure_owner') AS exists",
  );
  await pool.query(
    ownerExists.rows[0]?.exists
      ? "ALTER ROLE lineageguard_procedure_owner NOLOGIN"
      : "CREATE ROLE lineageguard_procedure_owner NOLOGIN",
  );
  const currentRole = await pool.query<{ identifier: string }>(
    "SELECT quote_ident(current_user) AS identifier",
  );
  const currentRoleIdentifier = currentRole.rows[0]?.identifier;
  if (!currentRoleIdentifier) throw new Error("migration role identity is unavailable");
  await pool.query(`GRANT lineageguard_procedure_owner TO ${currentRoleIdentifier} WITH SET TRUE`);
  await pool.query("CREATE SCHEMA IF NOT EXISTS lineageguard");
  await pool.query("GRANT USAGE,CREATE ON SCHEMA lineageguard TO lineageguard_procedure_owner");
  ownerSchemaCreateGranted = true;
  await migrate(pool);
  await grantRuntimePrivileges(pool, "lineageguard_runtime");
  await grantValidationSignerPrivileges(pool, "lineageguard_validation_signer");
  await grantApprovalAuthorityPrivileges(pool, "lineageguard_approval_authority");
  await grantEffectAuthorityPrivileges(pool, "lineageguard_effect_authority");
  process.stdout.write("LineageGuard run-store migrations and grants applied.\n");
} finally {
  try {
    if (ownerSchemaCreateGranted) {
      await pool.query("REVOKE CREATE ON SCHEMA lineageguard FROM lineageguard_procedure_owner");
      await pool.query("GRANT USAGE ON SCHEMA lineageguard TO lineageguard_procedure_owner");
    }
  } finally {
    await pool.end();
  }
}
