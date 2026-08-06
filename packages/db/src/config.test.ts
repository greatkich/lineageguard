import { describe, expect, it } from "vitest";
import {
  authorityDatabaseConfigsFromEnv,
  DEFAULT_DATABASE_URL,
  databaseConfigFromEnv,
  requireLocalIntegrationUrl,
} from "./config.js";
import { ConfigurationError } from "./errors.js";
import {
  newEventId,
  newLeaseId,
  newRunId,
  requireEventId,
  requireFingerprint,
  requireLeaseId,
  requireRunId,
} from "./ids.js";

describe("database configuration", () => {
  it("uses a loopback-only local default", () => {
    expect(databaseConfigFromEnv({})).toMatchObject({
      connectionString: DEFAULT_DATABASE_URL,
      ssl: false,
      maxConnections: 10,
    });
  });

  it("requires explicit opt-in and verified TLS for remote hosts", () => {
    const remote = "postgresql://user:pass@db.example.test/lineageguard";
    expect(() => databaseConfigFromEnv({ LINEAGEGUARD_DATABASE_URL: remote })).toThrow(
      ConfigurationError,
    );
    expect(() =>
      databaseConfigFromEnv({
        LINEAGEGUARD_DATABASE_URL: remote,
        LINEAGEGUARD_DB_ALLOW_REMOTE: "true",
      }),
    ).toThrow(/sslmode=verify-full/);
    expect(
      databaseConfigFromEnv({
        LINEAGEGUARD_DATABASE_URL: `${remote}?sslmode=verify-full`,
        LINEAGEGUARD_DB_ALLOW_REMOTE: "true",
      }).ssl,
    ).toEqual({ rejectUnauthorized: true });
  });

  it("refuses remote integration databases", () => {
    expect(() => requireLocalIntegrationUrl("postgresql://u:p@remote.test/db")).toThrow(
      /non-loopback/,
    );
  });

  it("requires independent authority connection URLs", () => {
    expect(() => authorityDatabaseConfigsFromEnv({})).toThrow(
      /LINEAGEGUARD_VALIDATION_SIGNER_DATABASE_URL is required/,
    );
    const configs = authorityDatabaseConfigsFromEnv({
      LINEAGEGUARD_VALIDATION_SIGNER_DATABASE_URL:
        "postgresql://lineageguard_validation_signer@127.0.0.1/lineageguard",
      LINEAGEGUARD_APPROVAL_AUTHORITY_DATABASE_URL:
        "postgresql://lineageguard_approval_authority@127.0.0.1/lineageguard",
      LINEAGEGUARD_EFFECT_AUTHORITY_DATABASE_URL:
        "postgresql://lineageguard_effect_authority@127.0.0.1/lineageguard",
    });
    expect(configs.validationSigner.connectionString).toContain("validation_signer");
    expect(configs.approvalAuthority.connectionString).toContain("approval_authority");
    expect(configs.effectAuthority.connectionString).toContain("effect_authority");
  });
});

describe("identifiers", () => {
  it("creates domain IDs and validates fingerprints", () => {
    expect(requireRunId(newRunId())).toMatch(/^run_/);
    expect(requireEventId(newEventId())).toMatch(/^evt_/);
    expect(requireLeaseId(newLeaseId())).toMatch(/^lease_/);
    expect(requireFingerprint("a".repeat(64))).toHaveLength(64);
    expect(() => requireFingerprint("ABC")).toThrow(/SHA-256/);
  });
});
