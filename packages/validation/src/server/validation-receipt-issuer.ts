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

const forbiddenSignerCredentials = [
  "OPENAI_API_KEY",
  "GITHUB_TOKEN",
  "DATAHUB_TOKEN",
  "DATAHUB_GMS_TOKEN",
  "LINEAGEGUARD_APPROVAL_AUTHORITY_DATABASE_URL",
  "LINEAGEGUARD_EFFECT_AUTHORITY_DATABASE_URL",
] as const;

function required(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) throw new ValidationError("ATTESTATION_INVALID", `missing=${name}`);
  return value;
}

export interface ValidationReceiptIssuerProcessDependencies {
  trustedPublicKeys: readonly TrustedValidationPublicKey[];
  runtimePolicy: ValidationRuntimePolicy;
  createStore(databaseUrl: string): ValidationReceiptAuthorityStore;
  resolveMaterialization(
    request: ValidationMaterializationReference,
  ): Promise<MaterializedCandidateHandle>;
}

/** Server-only production entrypoint. It reads credentials directly from its isolated process. */
export function startValidationReceiptIssuerProcess(
  dependencies: ValidationReceiptIssuerProcessDependencies,
): ValidationReceiptIssuerIpcClient {
  if (process.env.LINEAGEGUARD_PROCESS_ROLE !== "VALIDATION_AUTHORITY") {
    throw new ValidationError("ATTESTATION_INVALID", "validation signer process role is required");
  }
  for (const name of forbiddenSignerCredentials) {
    if (process.env[name]) {
      throw new ValidationError("ATTESTATION_INVALID", `co-resident credential=${name}`);
    }
  }
  const store = dependencies.createStore(required("LINEAGEGUARD_VALIDATION_SIGNER_DATABASE_URL"));
  const issuer = createValidationReceiptIssuerServer(
    {
      privateKeyPkcs8Pem: required("VALIDATION_ATTESTATION_PRIVATE_KEY_PKCS8_PEM"),
      issuer: required("VALIDATION_ATTESTATION_ISSUER"),
      keyId: required("VALIDATION_ATTESTATION_KEY_ID"),
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
