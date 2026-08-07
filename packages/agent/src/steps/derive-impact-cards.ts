/**
 * Backward-compatible wrapper around the shared domain derivation.
 *
 * Impact card/consumer derivation now lives in `@lineageguard/domain`
 * (`deriveImpactConsumers`) so both the backend pipeline and the web UI
 * derive the same canonical 4 consumers from the same source of truth.
 */
import { deriveImpactConsumers } from "@lineageguard/domain";
import type { ImpactConsumer, ImpactContext } from "@lineageguard/domain";

/** @deprecated Use `ImpactConsumer` from `@lineageguard/domain` instead. */
export type ImpactCard = ImpactConsumer;

/** @deprecated Use `deriveImpactConsumers` from `@lineageguard/domain` instead. */
export function deriveImpactCards(context: ImpactContext): ImpactConsumer[] {
  return deriveImpactConsumers(context);
}
