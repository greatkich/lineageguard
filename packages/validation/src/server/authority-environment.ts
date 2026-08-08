import { ValidationError } from "../errors.js";

export type AuthorityEnvironment = Readonly<Record<string, string | undefined>>;

/**
 * Credentials the orchestrating pipeline legitimately holds and an authority runtime must never
 * receive. A developer shell — or a CI job — routinely carries these, so the projection below
 * drops them rather than relying on the caller to unset them. They remain in the forbidden set so
 * that injecting one directly into an authority runtime is still refused.
 */
export const orchestrationCredentials = [
  "DATAHUB_GMS_TOKEN",
  "DATAHUB_TOKEN",
  "GITHUB_TOKEN",
  "OPENAI_API_KEY",
] as const;

/** Variables a validation-signer authority legitimately reads from its own process. */
const signerRuntimeVariables = [
  "LINEAGEGUARD_PROCESS_ROLE",
  "LINEAGEGUARD_VALIDATION_SIGNER_DATABASE_URL",
  "VALIDATION_ATTESTATION_ISSUER",
  "VALIDATION_ATTESTATION_KEY_ID",
  "VALIDATION_ATTESTATION_PRIVATE_KEY_PKCS8_PEM",
] as const;

/** Variables an effect authority legitimately reads from its own process. */
const effectRuntimeVariables = [
  "LINEAGEGUARD_EFFECT_AUTHORITY_DATABASE_URL",
  "LINEAGEGUARD_PROCESS_ROLE",
] as const;

/**
 * Credentials owned by a different authority role. Unlike orchestration credentials these are
 * deliberately carried through the projection: their presence means the deployment composed two
 * roles into one process, which is a real configuration fault that must surface as a rejection
 * rather than be silently scrubbed.
 */
const signerCrossRoleCredentials = [
  "LINEAGEGUARD_APPROVAL_AUTHORITY_DATABASE_URL",
  "LINEAGEGUARD_EFFECT_AUTHORITY_DATABASE_URL",
] as const;

const effectCrossRoleCredentials = [
  "LINEAGEGUARD_APPROVAL_AUTHORITY_DATABASE_URL",
  "LINEAGEGUARD_VALIDATION_SIGNER_DATABASE_URL",
  "VALIDATION_ATTESTATION_PRIVATE_KEY_PKCS8_PEM",
] as const;

export const forbiddenSignerCredentials = [
  ...orchestrationCredentials,
  ...signerCrossRoleCredentials,
] as const;

export const forbiddenEffectCredentials = [
  ...orchestrationCredentials,
  ...effectCrossRoleCredentials,
] as const;

/** Copies only the named variables, so nothing else in the parent environment propagates. */
function project(parent: AuthorityEnvironment, allowed: readonly string[]): AuthorityEnvironment {
  const projected: Record<string, string> = {};
  for (const name of allowed) {
    const value = parent[name];
    if (value !== undefined) projected[name] = value;
  }
  return Object.freeze(projected);
}

/**
 * Builds the environment a validation-signer authority runs with. Orchestration credentials in the
 * parent environment are dropped; cross-role authority credentials are preserved so that a
 * mis-composed process is still rejected.
 */
export function validationSignerEnvironment(
  parent: AuthorityEnvironment = process.env,
): AuthorityEnvironment {
  return project(parent, [...signerRuntimeVariables, ...signerCrossRoleCredentials]);
}

/** Builds the environment an effect authority runs with, under the same rules as the signer. */
export function effectAuthorityEnvironment(
  parent: AuthorityEnvironment = process.env,
): AuthorityEnvironment {
  return project(parent, [...effectRuntimeVariables, ...effectCrossRoleCredentials]);
}

/** Defence in depth: refuses a runtime that was handed a credential it must never hold. */
export function assertNoForbiddenCredentials(
  environment: AuthorityEnvironment,
  forbidden: readonly string[],
): void {
  for (const name of forbidden) {
    if (environment[name]) {
      throw new ValidationError("ATTESTATION_INVALID", `co-resident credential=${name}`);
    }
  }
}

export function requiredAuthorityVariable(environment: AuthorityEnvironment, name: string): string {
  const value = environment[name]?.trim();
  if (!value) throw new ValidationError("ATTESTATION_INVALID", `missing=${name}`);
  return value;
}
