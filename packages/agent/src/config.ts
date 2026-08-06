export interface AgentEnvConfig {
  omnirouteBaseUrl: string;
  omnirouteModel: string;
  omnirouteApiKey: string;
  datahubGmsUrl: string;
  datahubToken: string;
  workerId: string;
}

export function agentEnvConfigFromEnv(): AgentEnvConfig {
  return {
    omnirouteBaseUrl: process.env.OMNIROUTE_BASE_URL ?? "http://localhost:20128/v1",
    omnirouteModel: process.env.OMNIROUTE_MODEL ?? "auto",
    omnirouteApiKey: process.env.OMNIROUTE_API_KEY ?? "local",
    datahubGmsUrl: process.env.DATAHUB_GMS_URL ?? "http://localhost:8080",
    datahubToken: process.env.DATAHUB_TOKEN ?? "",
    workerId: process.env.WORKER_ID ?? `worker-${process.pid}`,
  };
}
