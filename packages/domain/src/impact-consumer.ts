import type { ImpactContext } from "./evidence.js";

export type ImpactConsumerKind = "DATA_MODEL" | "DASHBOARD" | "ML_CONSUMER" | "UNMANAGED_QUERY";

/**
 * The canonical consumer groups, in the order the walkthrough presents them. Derivation emits at
 * most one group per kind, so this doubles as the expected shape of a complete canonical run.
 */
export const canonicalConsumerKinds: readonly ImpactConsumerKind[] = Object.freeze([
  "DATA_MODEL",
  "DASHBOARD",
  "ML_CONSUMER",
  "UNMANAGED_QUERY",
]);

interface BaseConsumer {
  kind: ImpactConsumerKind;
  title: string;
  entityUrn: string;
  evidenceIds: string[];
  owners: string[];
}

export interface DataModelConsumer extends BaseConsumer {
  kind: "DATA_MODEL";
  lineagePath: string[];
}

export interface DashboardConsumer extends BaseConsumer {
  kind: "DASHBOARD";
}

export interface MlConsumer extends BaseConsumer {
  kind: "ML_CONSUMER";
  featureDatasetUrn: string;
}

export interface UnmanagedQueryConsumer extends BaseConsumer {
  kind: "UNMANAGED_QUERY";
}

export type ImpactConsumer =
  | DataModelConsumer
  | DashboardConsumer
  | MlConsumer
  | UnmanagedQueryConsumer;

/**
 * Derives exactly the canonical impact consumer groups from DataHub evidence.
 * Single source of truth — used by both the backend pipeline and the web UI.
 *
 * Canonical order: DATA_MODEL, DASHBOARD, ML_CONSUMER, UNMANAGED_QUERY
 *
 * A LINEAGE_PATH evidence item is a graph edge, not an independent consumer:
 * its terminal node is often a dashboard/model URN already counted below, and
 * an intermediate dataset node may be the feature dataset an ML model reads
 * from — that dataset is grouped into the ML_CONSUMER card, not counted
 * separately. Staging/intermediate views are never consumers.
 */
export function deriveImpactConsumers(context: ImpactContext): ImpactConsumer[] {
  const consumers: ImpactConsumer[] = [];
  const seenUrns = new Set<string>();

  // Feature datasets are absorbed into their ML_CONSUMER card below, so they
  // must not also surface as independent DATA_MODEL consumers.
  const featureDatasetUrns = new Set(
    context.evidence
      .filter((item) => item.kind === "ML_MODEL")
      .map((item) => item.payload.featureDatasetUrn),
  );

  // First: LINEAGE_PATH intermediate dataset nodes become DATA_MODEL consumers.
  for (const item of context.evidence) {
    if (item.kind !== "LINEAGE_PATH") continue;
    const nodes = item.payload.nodes;
    for (let i = 1; i < nodes.length; i++) {
      const urn = nodes[i];
      if (!urn || !urn.includes("urn:li:dataset:")) continue;
      if (urn === context.datasetUrn) continue;
      if (isIntermediateNode(urn)) continue;
      if (featureDatasetUrns.has(urn)) continue;
      if (seenUrns.has(urn)) continue;
      seenUrns.add(urn);
      consumers.push({
        kind: "DATA_MODEL",
        title: extractDatasetName(urn),
        entityUrn: urn,
        evidenceIds: [item.id],
        owners: [],
        lineagePath: [...nodes],
      });
    }
  }

  // Second: DASHBOARD
  for (const item of context.evidence) {
    if (item.kind !== "DASHBOARD") continue;
    const urn = item.payload.dashboardUrn;
    if (seenUrns.has(urn)) continue;
    seenUrns.add(urn);
    consumers.push({
      kind: "DASHBOARD",
      title: item.title,
      entityUrn: urn,
      evidenceIds: [item.id],
      owners: [...item.payload.ownerUrns],
    });
  }

  // Third: ML_MODEL -> ML_CONSUMER (grouped with its feature dataset)
  for (const item of context.evidence) {
    if (item.kind !== "ML_MODEL") continue;
    const urn = item.payload.modelUrn;
    if (seenUrns.has(urn)) continue;
    seenUrns.add(urn);
    seenUrns.add(item.payload.featureDatasetUrn);
    consumers.push({
      kind: "ML_CONSUMER",
      title: item.title,
      entityUrn: urn,
      evidenceIds: [item.id],
      owners: [...item.payload.ownerUrns],
      featureDatasetUrn: item.payload.featureDatasetUrn,
    });
  }

  // Fourth: QUERY_USAGE -> UNMANAGED_QUERY
  for (const item of context.evidence) {
    if (item.kind !== "QUERY_USAGE") continue;
    const urn = item.payload.queryUrn;
    if (seenUrns.has(urn)) continue;
    seenUrns.add(urn);
    consumers.push({
      kind: "UNMANAGED_QUERY",
      title: item.title,
      entityUrn: urn,
      evidenceIds: [item.id],
      owners: [],
    });
  }

  return consumers;
}

function isIntermediateNode(urn: string): boolean {
  // Staging views are intermediate, not user-facing consumers.
  return urn.includes("stg_orders") || urn.includes(".stg_");
}

function extractDatasetName(urn: string): string {
  // "urn:li:dataset:(urn:li:dataPlatform:dbt,analytics.customer_revenue,PROD)"
  const match = urn.match(/,([^,]+),\w+\)$/);
  return match?.[1] ?? urn;
}

/**
 * Fails closed when derivation does not yield the canonical four groups in canonical order.
 *
 * The walkthrough's whole claim is that DataHub reveals exactly four hidden consumer groups, so a
 * count or ordering change is a regression in the product story, not a cosmetic difference. Callers
 * that render or persist a consumer count must assert through this helper rather than trusting a
 * separately stored number.
 */
export function assertExactlyFourConsumers(consumers: readonly ImpactConsumer[]): void {
  if (consumers.length !== canonicalConsumerKinds.length) {
    throw new Error(
      `IMPACT_CARD_COUNT_MISMATCH: expected ${String(canonicalConsumerKinds.length)}, got ${String(consumers.length)}`,
    );
  }
  const kinds = consumers.map((consumer) => consumer.kind);
  const mismatch = kinds.findIndex((kind, index) => kind !== canonicalConsumerKinds[index]);
  if (mismatch !== -1) {
    throw new Error(`IMPACT_CARD_ORDER_MISMATCH: got ${JSON.stringify(kinds)}`);
  }
  const urns = consumers.map((consumer) => consumer.entityUrn);
  if (new Set(urns).size !== urns.length) {
    throw new Error(`IMPACT_CARD_DUPLICATE_URN: got ${JSON.stringify(urns)}`);
  }
  const unevidenced = consumers.find((consumer) => consumer.evidenceIds.length === 0);
  if (unevidenced) {
    throw new Error(`IMPACT_CARD_WITHOUT_EVIDENCE: ${unevidenced.kind}`);
  }
}
