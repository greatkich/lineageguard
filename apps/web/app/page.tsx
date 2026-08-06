import { Badge } from "@/components/ui/badge";
import { fetchRuns } from "@/lib/db";
import Link from "next/link";

const statusConfig: Record<string, { badge: "pass" | "fail" | "info" | "neutral" | "block"; icon: string }> = {
  COMPLETED: { badge: "pass", icon: "✓" },
  VALIDATED: { badge: "pass", icon: "✓" },
  FAILED_CONTEXT: { badge: "fail", icon: "✗" },
  FAILED_GENERATION: { badge: "fail", icon: "✗" },
  FAILED_VALIDATION: { badge: "fail", icon: "✗" },
  FAILED_GITHUB: { badge: "fail", icon: "✗" },
  FAILED_WRITEBACK: { badge: "fail", icon: "✗" },
  RISK_DECIDED: { badge: "block", icon: "⚠" },
  PATCH_GENERATED: { badge: "info", icon: "◎" },
  MIGRATION_PLANNED: { badge: "info", icon: "◎" },
};

export const dynamic = "force-dynamic";

export default async function DashboardPage() {
  const runs = await fetchRuns();
  const completedRuns = runs.filter((r) => r.status === "COMPLETED");
  const blockedRuns = runs.filter((r) => r.groundedDecision === "BLOCK");

  return (
    <div className="mx-auto max-w-6xl px-6 py-8">
      {/* Hero stats */}
      <div className="mb-8">
        <h1 className="text-3xl font-semibold tracking-tight">Mission Control</h1>
        <p className="text-sm text-muted-foreground mt-1">Organization-aware schema change safety powered by DataHub lineage</p>
      </div>

      {/* Stats row */}
      <div className="grid grid-cols-4 gap-4 mb-8">
        <StatCard label="Total Runs" value={runs.length} />
        <StatCard label="Completed" value={completedRuns.length} accent="pass" />
        <StatCard label="Blocked by DataHub" value={blockedRuns.length} accent="block" />
        <StatCard label="Avg Consumers" value={runs.length > 0 ? Math.round(runs.reduce((s, r) => s + r.consumersFound, 0) / runs.length) : 0} accent="info" />
      </div>

      {/* Pipeline explanation */}
      <div className="mb-8 rounded-xl border border-border bg-card p-6">
        <h2 className="text-sm font-medium text-muted-foreground uppercase tracking-wider mb-4">Pipeline Flow</h2>
        <div className="flex items-center justify-between gap-2">
          <PipelineStep icon="📝" label="Parse Change" sublabel="SQL diff" />
          <Arrow />
          <PipelineStep icon="🔍" label="Baseline" sublabel="Repo-only → ALLOW" />
          <Arrow />
          <PipelineStep icon="🏛️" label="DataHub" sublabel="Lineage + Owners" />
          <Arrow />
          <PipelineStep icon="⚡" label="Risk Engine" sublabel="5 Rules" />
          <Arrow />
          <PipelineStep icon="🤖" label="LLM Plan" sublabel="Migration" />
          <Arrow />
          <PipelineStep icon="🐳" label="Validate" sublabel="Docker PG" />
          <Arrow />
          <PipelineStep icon="📋" label="GitHub PR" sublabel="Draft" />
          <Arrow />
          <PipelineStep icon="✅" label="Writeback" sublabel="DataHub Tag" />
        </div>
      </div>

      {/* Runs list */}
      {runs.length === 0 ? (
        <div className="flex flex-col items-center justify-center py-24 text-muted-foreground rounded-xl border border-dashed border-border">
          <p className="text-lg">No runs yet</p>
          <p className="text-sm mt-1">Run <code className="font-mono bg-muted px-1.5 py-0.5 rounded">pnpm demo</code> to execute the pipeline</p>
        </div>
      ) : (
        <div className="space-y-3">
          <h2 className="text-sm font-medium text-muted-foreground uppercase tracking-wider">Recent Runs</h2>
          <div className="divide-y divide-border rounded-xl border border-border overflow-hidden">
            {runs.map((run) => {
              const cfg = statusConfig[run.status] ?? { badge: "neutral", icon: "○" };
              const rules = run.triggeredRules?.split(",").filter(Boolean) ?? [];
              return (
                <Link
                  key={run.id}
                  href={`/runs/${run.id}`}
                  className="flex items-center justify-between px-6 py-4 hover:bg-accent/50 transition-colors group"
                >
                  <div className="flex items-center gap-4">
                    <div className={`w-10 h-10 rounded-lg flex items-center justify-center text-lg ${
                      run.status === "COMPLETED" ? "bg-status-pass/10" :
                      run.status.startsWith("FAILED") ? "bg-status-fail/10" :
                      "bg-status-info/10"
                    }`}>
                      {cfg.icon}
                    </div>
                    <div className="flex flex-col gap-0.5">
                      <div className="flex items-center gap-2">
                        <span className="font-mono text-sm font-medium">{run.field}</span>
                        <Badge status={cfg.badge}>{run.status.replace(/_/g, " ")}</Badge>
                      </div>
                      <span className="text-xs text-muted-foreground">
                        {run.repository} · {new Date(run.createdAt).toLocaleString()}
                      </span>
                    </div>
                  </div>
                  <div className="flex items-center gap-6 text-sm">
                    {run.groundedDecision && (
                      <div className="flex items-center gap-1.5">
                        <span className="text-status-allow font-medium">{run.baselineDecision}</span>
                        <span className="text-muted-foreground">→</span>
                        <span className={`font-medium ${run.groundedDecision === "BLOCK" ? "text-status-block" : "text-status-allow"}`}>
                          {run.groundedDecision}
                        </span>
                      </div>
                    )}
                    {rules.length > 0 && (
                      <span className="text-xs text-muted-foreground font-mono">{rules.length} rules</span>
                    )}
                    {run.consumersFound > 0 && (
                      <span className="text-xs text-muted-foreground">{run.consumersFound} consumers</span>
                    )}
                    {run.artifactsGenerated > 0 && (
                      <span className="text-xs text-muted-foreground">{run.artifactsGenerated} artifacts</span>
                    )}
                    <span className="text-muted-foreground opacity-0 group-hover:opacity-100 transition-opacity">→</span>
                  </div>
                </Link>
              );
            })}
          </div>
        </div>
      )}
    </div>
  );
}

function StatCard({ label, value, accent }: { label: string; value: number; accent?: "pass" | "block" | "info" }) {
  const colorClass = accent === "pass" ? "text-status-pass" : accent === "block" ? "text-status-block" : accent === "info" ? "text-status-info" : "text-foreground";
  return (
    <div className="rounded-xl border border-border bg-card p-4">
      <p className="text-xs text-muted-foreground uppercase tracking-wider">{label}</p>
      <p className={`text-3xl font-semibold mt-1 ${colorClass}`}>{value}</p>
    </div>
  );
}

function PipelineStep({ icon, label, sublabel }: { icon: string; label: string; sublabel: string }) {
  return (
    <div className="flex flex-col items-center gap-1 min-w-0">
      <span className="text-xl">{icon}</span>
      <span className="text-xs font-medium whitespace-nowrap">{label}</span>
      <span className="text-[10px] text-muted-foreground whitespace-nowrap">{sublabel}</span>
    </div>
  );
}

function Arrow() {
  return <div className="w-6 h-px bg-border flex-shrink-0 mt-[-12px]" />;
}
