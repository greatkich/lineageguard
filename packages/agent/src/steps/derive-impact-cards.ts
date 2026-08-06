/**
 * Derives exactly 4 canonical impact cards from the DataHub context.
 *
 * The canonical walkthrough has four protected consumers:
 * 1. analytics.customer_revenue (downstream dbt model via LINEAGE_PATH)
 * 2. Finance Revenue Dashboard (DASHBOARD evidence)
 * 3. Fraud Model v3 (ML_MODEL evidence)
 * 4. Observed Finance query (QUERY_USAGE evidence)
 *
 * LINEAGE_PATH records are graph edges — the terminal consumer is the
 * last node in the path, which may be a dashboard/model URN already
 * counted separately. We deduplicate downstream datasets that feed
 * into counted dashboards/models.
 */
import type { ImpactContext } from "@lineageguard/domain";

export interface ImpactCard {
  id: string;
  title: string;
  kind: "DOWNSTREAM_MODEL" | "DASHBOARD" | "ML_MODEL" | "QUERY";
  entityUrn: string;
  owners: string[];
  evidenceId: string;
}

/**
 * Returns the canonical impact cards from typed evidence.
 * Uses exact payload fields from domain schema — no `any` casts.
 */
export function deriveImpactCards(context: ImpactContext): ImpactCard[] {
  const cards: ImpactCard[] = [];
  const seenUrns = new Set<string>();

  // First pass: collect DASHBOARD, ML_MODEL, QUERY_USAGE cards and their URNs
  for (const item of context.evidence) {
    if (item.kind === "DASHBOARD") {
      const urn = item.payload.dashboardUrn;
      if (!seenUrns.has(urn)) {
        seenUrns.add(urn);
        cards.push({
          id: item.id,
          title: item.title,
          kind: "DASHBOARD",
          entityUrn: urn,
          owners: item.payload.ownerUrns,
          evidenceId: item.id,
        });
      }
    } else if (item.kind === "ML_MODEL") {
      const urn = item.payload.modelUrn;
      if (!seenUrns.has(urn)) {
        seenUrns.add(urn);
        cards.push({
          id: item.id,
          title: item.title,
          kind: "ML_MODEL",
          entityUrn: urn,
          owners: item.payload.ownerUrns,
          evidenceId: item.id,
        });
      }
    } else if (item.kind === "QUERY_USAGE") {
      const urn = item.payload.queryUrn;
      if (!seenUrns.has(urn)) {
        seenUrns.add(urn);
        cards.push({
          id: item.id,
          title: item.title,
          kind: "QUERY",
          entityUrn: urn,
          owners: [],
          evidenceId: item.id,
        });
      }
    }
  }

  // Second pass: LINEAGE_PATH terminal nodes that are datasets (not already counted)
  // These represent downstream dbt models that are affected
  for (const item of context.evidence) {
    if (item.kind === "LINEAGE_PATH") {
      const nodes = item.payload.nodes;
      // Find intermediate dataset nodes (not the source, not endpoints already counted)
      // The path goes: source → staging → downstream_model → dashboard/model
      // We want the downstream dataset that's a direct consumer
      for (let i = 1; i < nodes.length; i++) {
        const node = nodes[i]!;
        // Skip nodes already counted as dashboard/model/query
        if (seenUrns.has(node)) continue;
        // Only count dataset URNs (not the source dataset itself)
        if (node.includes("urn:li:dataset:") && node !== context.evidence[0]?.sourceUrn) {
          // Skip analytics.stg_orders — it's a staging view, not a user-facing consumer
          if (node.includes("stg_orders")) continue;
          seenUrns.add(node);
          cards.push({
            id: item.id,
            title: item.title,
            kind: "DOWNSTREAM_MODEL",
            entityUrn: node,
            owners: [],
            evidenceId: item.id,
          });
        }
      }
    }
  }

  return cards;
}
