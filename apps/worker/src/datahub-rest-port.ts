/**
 * Lightweight DataHub REST context port for MVP.
 * Queries lineage, tags, and ownership directly via GMS REST API.
 * Replaces the mock in worker/orchestration.ts with real DataHub data.
 */

interface DataHubRestConfig {
  gmsUrl: string;
  token: string;
}

interface Consumer {
  kind: string;
  title: string;
  criticality: string;
  entityUrn: string;
}

async function gmsGet(config: DataHubRestConfig, path: string): Promise<unknown> {
  const res = await fetch(`${config.gmsUrl}${path}`, {
    headers: { Authorization: `Bearer ${config.token}` },
  });
  if (!res.ok) throw new Error(`DataHub ${path}: ${res.status}`);
  return res.json();
}

async function getDownstreamLineage(
  config: DataHubRestConfig,
  datasetUrn: string,
): Promise<string[]> {
  const encoded = encodeURIComponent(datasetUrn);
  const data = (await gmsGet(
    config,
    `/relationships?direction=INCOMING&urn=${encoded}&types=DownstreamOf`,
  )) as { relationships?: Array<{ entity: string }> };
  return (data.relationships ?? []).map((r) => r.entity);
}

async function getEntityInfo(
  config: DataHubRestConfig,
  urn: string,
): Promise<{ name: string; type: string }> {
  const encoded = encodeURIComponent(urn);
  try {
    const data = (await gmsGet(config, `/entities/${encoded}`)) as any;
    const snapshot = Object.values(data?.value ?? {})[0] as any;
    const aspects = snapshot?.aspects ?? [];
    let name = urn.split(",")[1] ?? urn;
    for (const aspect of aspects) {
      const props =
        aspect["com.linkedin.dataset.DatasetProperties"] ??
        aspect["com.linkedin.dashboard.DashboardInfo"] ??
        aspect["com.linkedin.ml.metadata.MLModelProperties"];
      if (props?.name) name = props.name;
      if (props?.title) name = props.title;
    }
    const type = urn.includes("dashboard")
      ? "DASHBOARD"
      : urn.includes("mlModel")
        ? "ML_MODEL"
        : urn.includes("query")
          ? "QUERY"
          : "DATASET";
    return { name, type };
  } catch {
    return { name: urn, type: "UNKNOWN" };
  }
}

async function getTags(config: DataHubRestConfig, urn: string): Promise<string[]> {
  const encoded = encodeURIComponent(urn);
  try {
    const data = (await gmsGet(config, `/entities/${encoded}`)) as any;
    const snapshot = Object.values(data?.value ?? {})[0] as any;
    const aspects = snapshot?.aspects ?? [];
    for (const aspect of aspects) {
      const tags = aspect["com.linkedin.common.GlobalTags"];
      if (tags?.tags) return tags.tags.map((t: any) => t.tag as string);
    }
  } catch {}
  return [];
}

export async function collectFromDataHub(
  config: DataHubRestConfig,
  datasetUrn: string,
): Promise<{ outcome: string; context: { evidence: Consumer[] } }> {
  // Get downstream consumers
  const downstreamUrns = await getDownstreamLineage(config, datasetUrn);
  const tags = await getTags(config, datasetUrn);
  const isCritical = tags.some((t) => t.includes("critical"));

  const evidence: Consumer[] = [];
  for (const urn of downstreamUrns) {
    const info = await getEntityInfo(config, urn);
    evidence.push({
      kind: info.type,
      title: info.name,
      criticality: isCritical ? "CRITICAL" : "HIGH",
      entityUrn: urn,
    });
  }

  return {
    outcome: "COLLECTED_LIVE",
    context: { evidence },
  };
}

export function createRestDataHubPort(config: DataHubRestConfig) {
  const datasetUrn =
    "urn:li:dataset:(urn:li:dataPlatform:postgres,lineageguard-canonical.commerce.orders,PROD)";

  return {
    collect: async (_input: { changeId: string }) => {
      return collectFromDataHub(config, datasetUrn);
    },
  };
}
