/**
 * Derives exactly 4 canonical impact cards from the DataHub context.
 *
 * The canonical walkthrough has four protected consumers:
 * 1. analytics.customer_revenue (downstream dbt model)
 * 2. Finance Revenue Dashboard
 * 3. Fraud Model v3
 * 4. Observed Finance query
 *
 * LINEAGE_PATH records are NOT independent consumers — they are
 * intermediate graph edges that connect the source to the real consumers.
 */
import type { ImpactContext } from "@lineageguard/domain";

export interface ImpactCard {
  id: string;
  title: string;
  kind: "DOWNSTREAM_MODEL" | "DASHBOARD" | "ML_MODEL" | "QUERY";
  entityUrn: string;
  owner?: string;
  evidenceId: string;
}

/**
 * Returns exactly the 4 canonical impact cards.
 * Does NOT count LINEAGE_PATH as an independent consumer.
 */
export function deriveImpactCards(context: ImpactContext): ImpactCard[] {
  const cards: ImpactCard[] = [];

  for (const item of context.evidence) {
    if (item.kind === "LINEAGE_PATH") {
      // Lineage paths connect source to consumers — not independent cards
      // But we extract the downstream consumer name from the path
      const downstream = (item as any).payload?.downstreamUrn ?? (item as any).payload?.targetUrn;
      if (downstream && !cards.some((c) => c.entityUrn === downstream)) {
        cards.push({
          id: item.id,
          title: (item as any).title ?? (item as any).entityName ?? "Downstream model",
          kind: "DOWNSTREAM_MODEL",
          entityUrn: downstream,
          evidenceId: item.id,
        });
      }
    } else if (item.kind === "DASHBOARD") {
      cards.push({
        id: item.id,
        title: (item as any).title ?? (item as any).entityName ?? "Dashboard",
        kind: "DASHBOARD",
        entityUrn: (item as any).payload?.dashboardUrn ?? "",
        owner: (item as any).payload?.ownerUrn,
        evidenceId: item.id,
      });
    } else if (item.kind === "ML_MODEL") {
      cards.push({
        id: item.id,
        title: (item as any).title ?? (item as any).entityName ?? "ML Model",
        kind: "ML_MODEL",
        entityUrn: (item as any).payload?.modelUrn ?? "",
        owner: (item as any).payload?.ownerUrn,
        evidenceId: item.id,
      });
    } else if (item.kind === "QUERY_USAGE") {
      cards.push({
        id: item.id,
        title: (item as any).title ?? (item as any).entityName ?? "Query",
        kind: "QUERY",
        entityUrn: (item as any).payload?.queryUrn ?? "",
        evidenceId: item.id,
      });
    }
  }

  // Deduplicate by entityUrn (keep first occurrence)
  const seen = new Set<string>();
  return cards.filter((card) => {
    if (!card.entityUrn || seen.has(card.entityUrn)) return false;
    seen.add(card.entityUrn);
    return true;
  });
}
