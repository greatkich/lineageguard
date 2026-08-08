import type { SignedLiveValidationReceipt } from "@lineageguard/domain";
import {
  createValidationReceiptIssuerServer,
  readRuntimeVerifiedLiveReceipt,
  type TrustedValidationPublicKey,
  type ValidationReceiptAuthorityStore,
} from "../attestation.js";
import { ValidationError } from "../errors.js";
import type {
  ValidationMaterializationReference,
  ValidationReceiptIssuerIpcClient,
} from "../ipc.js";
import type { MaterializedCandidateHandle } from "../materializer.js";
import type { ValidationRuntimePolicy } from "../validator.js";
import {
  type AuthorityEnvironment,
  assertNoForbiddenCredentials,
  forbiddenSignerCredentials,
  requiredAuthorityVariable,
  validationSignerEnvironment,
} from "./authority-environment.js";

export interface ValidationReceiptIssuerProcessDependencies {
  trustedPublicKeys: readonly TrustedValidationPublicKey[];
  runtimePolicy: ValidationRuntimePolicy;
  createStore(databaseUrl: string): ValidationReceiptAuthorityStore;
  resolveMaterialization(
    request: ValidationMaterializationReference,
  ): Promise<MaterializedCandidateHandle>;
  /**
   * The environment this authority runs with. Defaults to an allowlisted projection of
   * `process.env`, so orchestration credentials held by the calling shell never reach the runtime.
   */
  environment?: AuthorityEnvironment;
}

/** Server-only production entrypoint. It reads credentials from an explicit, allowlisted env. */
export function startValidationReceiptIssuerProcess(
  dependencies: ValidationReceiptIssuerProcessDependencies,
): ValidationReceiptIssuerIpcClient {
  const environment = dependencies.environment ?? validationSignerEnvironment();
  if (environment.LINEAGEGUARD_PROCESS_ROLE !== "VALIDATION_AUTHORITY") {
    throw new ValidationError("ATTESTATION_INVALID", "validation signer process role is required");
  }
  assertNoForbiddenCredentials(environment, forbiddenSignerCredentials);
  const store = dependencies.createStore(
    requiredAuthorityVariable(environment, "LINEAGEGUARD_VALIDATION_SIGNER_DATABASE_URL"),
  );
  const issuer = createValidationReceiptIssuerServer(
    {
      privateKeyPkcs8Pem: requiredAuthorityVariable(
        environment,
        "VALIDATION_ATTESTATION_PRIVATE_KEY_PKCS8_PEM",
      ),
      issuer: requiredAuthorityVariable(environment, "VALIDATION_ATTESTATION_ISSUER"),
      keyId: requiredAuthorityVariable(environment, "VALIDATION_ATTESTATION_KEY_ID"),
    },
    dependencies.trustedPublicKeys,
    store,
    dependencies.runtimePolicy,
  );
  return Object.freeze({
    async issueValidationReceipt(
      request: ValidationMaterializationReference,
    ): Promise<SignedLiveValidationReceipt> {
      if (
        request.runId.length < 1 ||
        request.sandboxId.length < 1 ||
        request.worktreeId.length < 1
      ) {
        throw new ValidationError("ATTESTATION_INVALID", "materialization reference is malformed");
      }
      const handle = await dependencies.resolveMaterialization(request);
      return readRuntimeVerifiedLiveReceipt(await issuer.validateAndIssue(request.runId, handle));
    },
  });
}
