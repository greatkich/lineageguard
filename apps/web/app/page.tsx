import { Badge } from "@/components/ui/badge";
import { Card, CardBody, CardHeader, StatCard } from "@/components/ui/card";
import {
  IconActivity,
  IconArrowRight,
  IconCheckCircle,
  IconCode,
  IconContainer,
  IconCpu,
  IconDatabase,
  IconFileText,
  IconGitPullRequest,
  IconLayers,
  IconSearch,
  IconShield,
  IconShieldAlert,
  IconShieldCheck,
  IconUpload,
  IconZap,
} from "@/components/ui/icons";
import { PipelineStepper, type StepDef } from "@/components/ui/pipeline-stepper";
import { fetchRuns } from "@/lib/db";
import Link from "next/link";

const statusBadge: Record<string, "pass" | "fail" | "info" | "neutral" | "block"> = {
  COMPLETED: "pass",
  VALIDATED: "pass",
  FAILED_CONTEXT: "fail",
  FAILED_GENERATION: "fail",
  FAILED_VALIDATION: "fail",
  FAILED_GITHUB: "fail",
  FAILED_WRITEBACK: "fail",
  RISK_DECIDED: "block",
  PATCH_GENERATED: "info",
  MIGRATION_PLANNED: "info",
};

const pipelineOverview: StepDef[] = [
  { key: "CHANGE_PARSED", label: "Parse", icon: <IconCode className="w-4 h-4" /> },
  { key: "BASELINE_ASSESSED", label: "Baseline", icon: <IconSearch className="w-4 h-4" /> },
  { key: "CONTEXT_COLLECTED", label: "DataHub", icon: <IconDatabase className="w-4 h-4" /> },
  { key: "RISK_DECIDED", label: "Risk", icon: <IconZap className="w-4 h-4" /> },
  { key: "MIGRATION_PLANNED", label: "Plan", icon: <IconCpu className="w-4 h-4" /> },
  { key: "PATCH_GENERATED", label: "Generate", icon: <IconFileText className="w-4 h-4" /> },
  { key: "VALIDATED", label: "Validate", icon: <IconContainer className="w-4 h-4" /> },
  { key: "COMPLETED", label: "Complete", icon: <IconCheckCircle className="w-4 h-4" /> },
];

export const dynamic = "force-dynamic";

export default async function DashboardPage() {
  const runs = await fetchRuns();
  const completedRuns = runs.filter((r) => r.status === "COMPLETED");
  const blockedRuns = runs.filter((r) => r.groundedDecision === "BLOCK");
  const totalArtifacts = runs.reduce((s, r) => s + r.artifactsGenerated, 0);

  return (
    <div className="mx-auto max-w-7xl px-6 py-8 space-y-8">
      {/* Page header */}
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">Dashboard</h1>
        <p className="text-sm text-muted-foreground mt-1">Schema change safety analysis powered by DataHub lineage</p>
      </div>

      {/* Stats */}
      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4">
        <StatCard label="Total Runs" value={runs.length} icon={<IconActivity className="w-5 h-5" />} />
        <StatCard label="Blocked" value={blockedRuns.length} icon={<IconShieldAlert className="w-5 h-5" />} accent="danger" />
        <StatCard label="Completed" value={completedRuns.length} icon={<IconShieldCheck className="w-5 h-5" />} accent="success" />
        <StatCard label="Artifacts" value={totalArtifacts} icon={<IconLayers className="w-5 h-5" />} accent="info" />
      </div>

      {/* Pipeline overview */}
      <Card>
        <CardHeader>
          <h2 className="text-sm font-medium">Pipeline</h2>
          <p className="text-xs text-muted-foreground mt-0.5">Each schema change passes through these stages</p>
        </CardHeader>
        <CardBody>
          <PipelineStepper steps={pipelineOverview} currentStatus="COMPLETED" />
        </CardBody>
      </Card>

      {/* Runs table */}
      <Card>
        <CardHeader className="flex flex-row items-center justify-between">
          <div>
            <h2 className="text-sm font-medium">Recent Runs</h2>
            <p className="text-xs text-muted-foreground mt-0.5">{runs.length} total</p>
          </div>
        </CardHeader>
        {runs.length === 0 ? (
          <CardBody>
            <div className="flex flex-col items-center justify-center py-16 text-muted-foreground">
              <IconShield className="w-10 h-10 mb-3 opacity-30" />
              <p className="text-sm">No runs yet</p>
              <p className="text-xs mt-1">
                Run <code className="font-mono bg-muted px-1.5 py-0.5 rounded text-[11px]">pnpm demo</code> to start
              </p>
            </div>
          </CardBody>
        ) : (
          <div className="divide-y divide-border">
            {runs.map((run) => {
              const badge = statusBadge[run.status] ?? "neutral";
              const rules = run.triggeredRules?.split(",").filter(Boolean) ?? [];
              const isFailed = run.status.startsWith("FAILED");
              const isComplete = run.status === "COMPLETED";

              return (
                <Link
                  key={run.id}
                  href={`/runs/${run.id}`}
                  className="flex items-center gap-4 px-5 py-3.5 hover:bg-accent/40 transition-colors group"
                >
                  {/* Status indicator */}
                  <div className={`w-2 h-2 rounded-full flex-shrink-0 ${
                    isComplete ? "bg-status-pass" : isFailed ? "bg-status-fail" : "bg-status-info"
                  }`} />

                  {/* Main info */}
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-2">
                      <span className="text-sm font-medium truncate">{run.field}</span>
                      <Badge status={badge}>{run.status.replace(/_/g, " ")}</Badge>
                    </div>
                    <p className="text-xs text-muted-foreground mt-0.5 truncate">
                      {run.repository}
                    </p>
                  </div>

                  {/* Decision */}
                  {run.groundedDecision && (
                    <div className="hidden sm:flex items-center gap-1.5 text-xs flex-shrink-0">
                      <span className="text-status-allow font-mono">{run.baselineDecision}</span>
                      <IconArrowRight className="w-3 h-3 text-muted-foreground" />
                      <span className={`font-mono font-medium ${run.groundedDecision === "BLOCK" ? "text-status-block" : "text-status-allow"}`}>
                        {run.groundedDecision}
                      </span>
                    </div>
                  )}

                  {/* Meta */}
                  <div className="hidden md:flex items-center gap-4 text-xs text-muted-foreground flex-shrink-0">
                    {rules.length > 0 && <span>{rules.length} rules</span>}
                    {run.consumersFound > 0 && <span>{run.consumersFound} consumers</span>}
                    {run.artifactsGenerated > 0 && <span>{run.artifactsGenerated} artifacts</span>}
                  </div>

                  {/* Arrow */}
                  <IconArrowRight className="w-4 h-4 text-muted-foreground/0 group-hover:text-muted-foreground transition-colors flex-shrink-0" />
                </Link>
              );
            })}
          </div>
        )}
      </Card>
    </div>
  );
}
