import { randomBytes } from "node:crypto";
import {
  createEffectAuthorizationServer,
  type EffectReservationAuthorityStore,
  type TrustedValidationPublicKey,
  type VerifiedCurrentEffect,
} from "../attestation.js";
import { ValidationError } from "../errors.js";
import type { EffectAuthorizationIpcClient } from "../ipc.js";
import {
  type AuthorityEnvironment,
  assertNoForbiddenCredentials,
  effectAuthorityEnvironment,
  forbiddenEffectCredentials,
  requiredAuthorityVariable,
} from "./authority-environment.js";

export interface EffectAuthorizationProcessDependencies {
  trustedPublicKeys: readonly TrustedValidationPublicKey[];
  createStore(databaseUrl: string): EffectReservationAuthorityStore;
  /**
   * The environment this authority runs with. Defaults to an allowlisted projection of
   * `process.env`, so orchestration credentials held by the calling shell never reach the runtime.
   */
  environment?: AuthorityEnvironment;
}

/** Server-only production entrypoint. It never loads or retains the validation private key. */
export function startEffectAuthorizationProcess(
  dependencies: EffectAuthorizationProcessDependencies,
): EffectAuthorizationIpcClient {
  const environment = dependencies.environment ?? effectAuthorityEnvironment();
  if (environment.LINEAGEGUARD_PROCESS_ROLE !== "EFFECT_AUTHORITY") {
    throw new ValidationError("ATTESTATION_INVALID", "effect authority process role is required");
  }
  assertNoForbiddenCredentials(environment, forbiddenEffectCredentials);
  const store = dependencies.createStore(
    requiredAuthorityVariable(environment, "LINEAGEGUARD_EFFECT_AUTHORITY_DATABASE_URL"),
  );
  const authority = createEffectAuthorizationServer(dependencies.trustedPublicKeys, store);
  const capabilities = new Map<string, VerifiedCurrentEffect>();
  const take = (handle: string): VerifiedCurrentEffect => {
    const capability = capabilities.get(handle);
    if (!capability || !/^[A-Za-z0-9_-]{32,128}$/.test(handle)) {
      throw new ValidationError("ATTESTATION_INVALID", "effect IPC handle is invalid");
    }
    return capability;
  };
  const client: EffectAuthorizationIpcClient = {
    async reserveCurrentEffect(input) {
      if (capabilities.size >= 1_024) {
        throw new ValidationError("ATTESTATION_INVALID", "effect IPC capacity is exhausted");
      }
      const capability = await authority.reserveCurrentEffect(input.receipt, input.request);
      const authorizationHandle = randomBytes(32).toString("base64url");
      capabilities.set(authorizationHandle, capability);
      return { authorizationHandle };
    },
    verifyCurrentEffectReservation(input) {
      return authority.verifyCurrentEffectReservation(
        take(input.authorizationHandle),
        input.canonicalEffectFingerprint,
      );
    },
    async consumeCurrentEffect(input) {
      const capability = take(input.authorizationHandle);
      capabilities.delete(input.authorizationHandle);
      return authority.consumeCurrentEffect(capability, input.canonicalEffectFingerprint);
    },
    async cancelCurrentEffectBeforeSend(input) {
      const capability = take(input.authorizationHandle);
      capabilities.delete(input.authorizationHandle);
      await authority.cancelCurrentEffectBeforeSend(capability, input.canonicalEffectFingerprint);
    },
  };
  return Object.freeze(client);
}
