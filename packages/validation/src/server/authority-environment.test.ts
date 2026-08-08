import { generateKeyPairSync } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  type AuthorityEnvironment,
  assertNoForbiddenCredentials,
  effectAuthorityEnvironment,
  forbiddenEffectCredentials,
  forbiddenSignerCredentials,
  orchestrationCredentials,
  validationSignerEnvironment,
} from "./authority-environment.js";
import { startEffectAuthorizationProcess } from "./effect-authorization.js";
import { startValidationReceiptIssuerProcess } from "./validation-receipt-issuer.js";

/** A developer or CI shell that legitimately holds every orchestration credential. */
function credentialBearingShell(): Record<string, string> {
  return {
    DATAHUB_GMS_TOKEN: "dh_gms_ambient_token",
    DATAHUB_TOKEN: "dh_ambient_token",
    GITHUB_TOKEN: "ghp_ambient_token",
    OPENAI_API_KEY: "sk-ambient-key",
    PATH: "/usr/bin:/bin",
    SHELL: "/bin/zsh",
  };
}

function signerKeyMaterial() {
  const { privateKey, publicKey } = generateKeyPairSync("ed25519");
  return {
    privateKeyPkcs8Pem: privateKey.export({ type: "pkcs8", format: "pem" }).toString(),
    trustedPublicKeys: [
      {
        algorithm: "ED25519" as const,
        issuer: "lineageguard-test",
        keyId: "test-key",
        publicKeySpkiPem: publicKey.export({ type: "spki", format: "pem" }).toString(),
      },
    ],
  };
}

function signerDependencies(
  environment: AuthorityEnvironment,
  expectedUrl: string,
  trustedPublicKeys: ReturnType<typeof signerKeyMaterial>["trustedPublicKeys"] = [],
) {
  return {
    environment,
    trustedPublicKeys,
    runtimePolicy: {} as never,
    createStore: (databaseUrl: string) => {
      expect(databaseUrl).toBe(expectedUrl);
      return {} as never;
    },
    async resolveMaterialization() {
      return {} as never;
    },
  };
}

describe("A. parent-shell isolation", () => {
  it("drops every orchestration credential from the signer projection", () => {
    const parent = {
      ...credentialBearingShell(),
      LINEAGEGUARD_PROCESS_ROLE: "VALIDATION_AUTHORITY",
      LINEAGEGUARD_VALIDATION_SIGNER_DATABASE_URL: "postgresql://signer-only",
      VALIDATION_ATTESTATION_ISSUER: "lineageguard-test",
      VALIDATION_ATTESTATION_KEY_ID: "test-key",
      VALIDATION_ATTESTATION_PRIVATE_KEY_PKCS8_PEM: "pem",
    };

    const projected = validationSignerEnvironment(parent);

    for (const name of orchestrationCredentials) {
      expect(projected[name]).toBeUndefined();
    }
    expect(projected.LINEAGEGUARD_VALIDATION_SIGNER_DATABASE_URL).toBe("postgresql://signer-only");
    expect(projected.PATH).toBeUndefined();
    expect(projected.SHELL).toBeUndefined();
  });

  it("drops every orchestration credential from the effect projection", () => {
    const parent = {
      ...credentialBearingShell(),
      LINEAGEGUARD_EFFECT_AUTHORITY_DATABASE_URL: "postgresql://effect-only",
      LINEAGEGUARD_PROCESS_ROLE: "EFFECT_AUTHORITY",
    };

    const projected = effectAuthorityEnvironment(parent);

    for (const name of orchestrationCredentials) {
      expect(projected[name]).toBeUndefined();
    }
    expect(projected.LINEAGEGUARD_EFFECT_AUTHORITY_DATABASE_URL).toBe("postgresql://effect-only");
  });

  it("starts the signer authority from a credential-bearing parent shell", () => {
    const { privateKeyPkcs8Pem, trustedPublicKeys } = signerKeyMaterial();
    const parent = {
      ...credentialBearingShell(),
      LINEAGEGUARD_PROCESS_ROLE: "VALIDATION_AUTHORITY",
      LINEAGEGUARD_VALIDATION_SIGNER_DATABASE_URL: "postgresql://signer-only",
      VALIDATION_ATTESTATION_ISSUER: "lineageguard-test",
      VALIDATION_ATTESTATION_KEY_ID: "test-key",
      VALIDATION_ATTESTATION_PRIVATE_KEY_PKCS8_PEM: privateKeyPkcs8Pem,
    };

    const client = startValidationReceiptIssuerProcess(
      signerDependencies(
        validationSignerEnvironment(parent),
        "postgresql://signer-only",
        trustedPublicKeys,
      ),
    );

    expect(Object.keys(client)).toEqual(["issueValidationReceipt"]);
  });

  it("starts the effect authority from a credential-bearing parent shell", () => {
    const parent = {
      ...credentialBearingShell(),
      LINEAGEGUARD_EFFECT_AUTHORITY_DATABASE_URL: "postgresql://effect-only",
      LINEAGEGUARD_PROCESS_ROLE: "EFFECT_AUTHORITY",
    };

    const client = startEffectAuthorizationProcess({
      environment: effectAuthorityEnvironment(parent),
      trustedPublicKeys: [],
      createStore: (databaseUrl) => {
        expect(databaseUrl).toBe("postgresql://effect-only");
        return {} as never;
      },
    });

    expect("issueValidationReceipt" in client).toBe(false);
  });

  it("keeps the real ambient process environment out of the projections", () => {
    for (const name of orchestrationCredentials) {
      expect(validationSignerEnvironment()[name]).toBeUndefined();
      expect(effectAuthorityEnvironment()[name]).toBeUndefined();
    }
  });
});

describe("B. boundary rejection", () => {
  it.each(orchestrationCredentials)(
    "refuses the signer authority when %s is injected into its runtime",
    (credential) => {
      const { privateKeyPkcs8Pem } = signerKeyMaterial();
      const polluted: AuthorityEnvironment = {
        [credential]: "injected",
        LINEAGEGUARD_PROCESS_ROLE: "VALIDATION_AUTHORITY",
        LINEAGEGUARD_VALIDATION_SIGNER_DATABASE_URL: "postgresql://signer-only",
        VALIDATION_ATTESTATION_ISSUER: "lineageguard-test",
        VALIDATION_ATTESTATION_KEY_ID: "test-key",
        VALIDATION_ATTESTATION_PRIVATE_KEY_PKCS8_PEM: privateKeyPkcs8Pem,
      };

      expect(() =>
        startValidationReceiptIssuerProcess(
          signerDependencies(polluted, "postgresql://signer-only"),
        ),
      ).toThrowError(
        expect.objectContaining({
          code: "ATTESTATION_INVALID",
          diagnostic: `co-resident credential=${credential}`,
        }),
      );
    },
  );

  it.each(orchestrationCredentials)(
    "refuses the effect authority when %s is injected into its runtime",
    (credential) => {
      const polluted: AuthorityEnvironment = {
        [credential]: "injected",
        LINEAGEGUARD_EFFECT_AUTHORITY_DATABASE_URL: "postgresql://effect-only",
        LINEAGEGUARD_PROCESS_ROLE: "EFFECT_AUTHORITY",
      };

      expect(() =>
        startEffectAuthorizationProcess({
          environment: polluted,
          trustedPublicKeys: [],
          createStore: () => ({}) as never,
        }),
      ).toThrowError(
        expect.objectContaining({
          code: "ATTESTATION_INVALID",
          diagnostic: `co-resident credential=${credential}`,
        }),
      );
    },
  );

  it("never places a credential name or value in the thrown message", () => {
    let thrown: unknown;
    try {
      startEffectAuthorizationProcess({
        environment: {
          DATAHUB_TOKEN: "dh_secret_value_must_not_leak",
          LINEAGEGUARD_EFFECT_AUTHORITY_DATABASE_URL: "postgresql://effect-only",
          LINEAGEGUARD_PROCESS_ROLE: "EFFECT_AUTHORITY",
        },
        trustedPublicKeys: [],
        createStore: () => ({}) as never,
      });
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toBeInstanceOf(Error);
    const message = (thrown as Error).message;
    expect(message).toBe("Validation boundary rejected input: ATTESTATION_INVALID");
    expect(message).not.toContain("dh_secret_value_must_not_leak");
    expect(JSON.stringify(thrown)).not.toContain("dh_secret_value_must_not_leak");
  });

  it("refuses a store connection before it is opened", () => {
    let storeOpened = false;

    expect(() =>
      startEffectAuthorizationProcess({
        environment: {
          DATAHUB_TOKEN: "injected",
          LINEAGEGUARD_EFFECT_AUTHORITY_DATABASE_URL: "postgresql://effect-only",
          LINEAGEGUARD_PROCESS_ROLE: "EFFECT_AUTHORITY",
        },
        trustedPublicKeys: [],
        createStore: () => {
          storeOpened = true;
          return {} as never;
        },
      }),
    ).toThrowError(expect.objectContaining({ code: "ATTESTATION_INVALID" }));
    expect(storeOpened).toBe(false);
  });

  it("carries cross-role credentials through the projection so mis-composition is refused", () => {
    const parent = {
      ...credentialBearingShell(),
      LINEAGEGUARD_EFFECT_AUTHORITY_DATABASE_URL: "postgresql://poison",
      LINEAGEGUARD_PROCESS_ROLE: "VALIDATION_AUTHORITY",
      LINEAGEGUARD_VALIDATION_SIGNER_DATABASE_URL: "postgresql://signer-only",
      VALIDATION_ATTESTATION_ISSUER: "lineageguard-test",
      VALIDATION_ATTESTATION_KEY_ID: "test-key",
      VALIDATION_ATTESTATION_PRIVATE_KEY_PKCS8_PEM: "pem",
    };
    const projected = validationSignerEnvironment(parent);

    expect(projected.LINEAGEGUARD_EFFECT_AUTHORITY_DATABASE_URL).toBe("postgresql://poison");
    expect(() =>
      startValidationReceiptIssuerProcess(
        signerDependencies(projected, "postgresql://signer-only"),
      ),
    ).toThrowError(expect.objectContaining({ code: "ATTESTATION_INVALID" }));
  });

  it("names every credential each role must refuse", () => {
    expect(assertNoForbiddenCredentials({}, forbiddenSignerCredentials)).toBeUndefined();
    expect(assertNoForbiddenCredentials({}, forbiddenEffectCredentials)).toBeUndefined();
    for (const name of orchestrationCredentials) {
      expect(forbiddenSignerCredentials).toContain(name);
      expect(forbiddenEffectCredentials).toContain(name);
    }
  });
});
