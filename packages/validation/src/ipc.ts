import type { SignedLiveValidationReceipt } from "@lineageguard/domain";
import type {
  ConsumedCurrentEffectAuthorization,
  ValidationEffectRequest,
  VerifiedCurrentEffectReservation,
} from "./attestation.js";

export interface ValidationMaterializationReference {
  runId: string;
  sandboxId: string;
  worktreeId: string;
}

export interface ValidationReceiptIssuerIpcClient {
  issueValidationReceipt(
    request: ValidationMaterializationReference,
  ): Promise<SignedLiveValidationReceipt>;
}

export interface EffectAuthorizationHandle {
  authorizationHandle: string;
}

export interface EffectAuthorizationIpcClient {
  reserveCurrentEffect(input: {
    receipt: unknown;
    request: ValidationEffectRequest;
  }): Promise<EffectAuthorizationHandle>;
  verifyCurrentEffectReservation(input: {
    authorizationHandle: string;
    canonicalEffectFingerprint: string;
  }): Promise<VerifiedCurrentEffectReservation>;
  consumeCurrentEffect(input: {
    authorizationHandle: string;
    canonicalEffectFingerprint: string;
  }): Promise<ConsumedCurrentEffectAuthorization>;
  cancelCurrentEffectBeforeSend(input: {
    authorizationHandle: string;
    canonicalEffectFingerprint: string;
  }): Promise<void>;
}
