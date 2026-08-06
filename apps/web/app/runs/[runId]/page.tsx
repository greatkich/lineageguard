import { Badge } from "@/components/ui/badge";
import { fetchRun } from "@/lib/db";
import { notFound } from "next/navigation";
import Link from "next/link";

const pipelineSteps = [
  { key: "CREATED", label: "Created", icon: "○", description: "Run initialized" },
  { key: "CHANGE_PARSED", label: "Parse Change", icon: "📝", description: "SQL diff analyzed" },
  { key: "BASELINE_ASSESSED", label: "Baseline", icon: "🔍", description: "Repository-only assessment" },
  { key: "CONTEXT_COLLECTED", label: "DataHub Context", icon: "🏛️", description: "Lineage & ownership collected" },
  { key: "RISK_DECIDED", label: "Risk Decision", icon: "⚡", description: "5-rule policy engine" },
  { key: "MIGRATION_PLANNED", label: "Migration Plan", icon: "🤖", description: "LLM generates strategy" },
  { key: "PATCH_GENERATED", label: "Patch Generated", icon: "📦", description: "SQL + dbt artifacts" },
  { key: "VALIDATED", label: "Validated", icon: "🐳", description: "Docker Postgres + 8 checks" },
  { key: "REVIEW_ARTIFACT_CREATED", label: "GitHub PR", icon: "📋", description: "Draft PR created" },
  { key: "COMPLETED", label: "Complete", icon: "✅", description: "Writeback to DataHub" },
];

const failedSteps = new Set([
  "FAILED_CONTEXT", "FAILED_GENERATION", "FAILED_VALIDATION", "FAILED_GITHUB", "FAILED_WRITEBACK",
]);

function getStepIndex(status: string): number {
  if (failedSteps.has(status)) {
    if (status === "FAILED_CONTEXT") return 3;
    if (status === "FAILED_GENERATION") return 5;
    if (status === "FAILED_VALIDATION") return 7;
    if (status === "FAILED_GITHUB") return 8;
    if (status === "FAILED_WRITEBACK") return 9;
  }
  const idx = pipelineSteps.findIndex((s) => s.key === status);
  return idx >= 0 ? idx : 0;
}

const ruleDescriptions: Record<string, string> = {
  LG001: "Downstream field-level lineage paths exist",
  LG002: "Production ML model depends on renamed field",
  LG003: "Observed system query references renamed field",
  LG004: "Critical dashboard depends on field change",
  LG005: "Affected critical asset has no recorded owner",
};

export const dynamic = "force-dynamic";

export default async function RunDetailPage({ params }: { params: Promise<{ runId: string }> }) {
  const { runId } = await params;
  const run = await fetchRun(runId);
  if (!run) notFound();

  const currentIdx = getStepIndex(run.status);
  const isFailed = failedSteps.has(run.status);
  const isComplete = run.status === "COMPLETED";
  const rules = run.triggeredRules?.split(",").filter(Boolean) ?? [];

  return (
    <div className="mx-auto max-w-6xl px-6 py-6">
      {/* Header */}
      <div className="flex items-center gap-4 mb-6">
        <Link href="/" className="text-muted-foreground hover:text-foreground transition-colors">← Runs</Link>
        <div className="flex-1" />
        <Badge status={isComplete ? "pass" : isFailed ? "fail" : "info"}>
          {run.status.replace(/_/g, " ")}
        </Badge>
      </div>

      {/* Title row */}
      <div className="mb-8">
        <h1 className="text-2xl font-semibold tracking-tight font-mono">{run.field}</h1>
        <p className="text-sm text-muted-foreground mt-1">{run.repository} · {new Date(run.createdAt).toLocaleString()}</p>
      </div>

      {/* Pipeline visualization */}
      <div className="mb-8 rounded-xl border border-border bg-card p-6">
        <h2 className="text-xs font-medium text-muted-foreground uppercase tracking-wider mb-5">Pipeline Progress</h2>
        <div className="relative">
          {/* Progress bar background */}
          <div className="absolute top-5 left-5 right-5 h-0.5 bg-border" />
          {/* Progress bar fill */}
          <div
            className={`absolute top-5 left-5 h-0.5 transition-all duration-500 ${isFailed ? "bg-status-fail" : "bg-status-pass"}`}
            style={{ width: `${(currentIdx / (pipelineSteps.length - 1)) * 100}%`, maxWidth: "calc(100% - 40px)" }}
          />

          <div className="relative flex justify-between">
            {pipelineSteps.map((step, i) => {
              const isPast = i < currentIdx;
              const isCurrent = i === currentIdx;
              const isFailedHere = isCurrent && isFailed;

              return (
                <div key={step.key} className="flex flex-col items-center w-0 flex-1">
                  <div className={`
                    w-10 h-10 rounded-full flex items-center justify-center text-base
                    border-2 transition-all relative z-10
                    ${isFailedHere ? "border-status-fail bg-status-fail/10" :
                      isCurrent ? "border-status-info bg-status-info/10 ring-4 ring-status-info/20" :
                      isPast ? "border-status-pass bg-status-pass/10" :
                      "border-border bg-card"}
                  `}>
                    {isFailedHere ? "✗" : step.icon}
                  </div>
                  <span className={`text-[10px] mt-2 text-center leading-tight whitespace-nowrap ${
                    isCurrent ? "font-semibold text-foreground" :
                    isPast ? "text-muted-foreground" :
                    "text-muted-foreground/50"
                  }`}>
                    {step.label}
                  </span>
                </div>
              );
            })}
          </div>
        </div>
      </div>

      {/* Main content: 3-panel grid */}
      <div className="grid grid-cols-3 gap-4 mb-6">
        {/* Left: Proposed Change */}
        <Panel title="Proposed Change" subtitle={`Repo-only: ${run.baselineDecision ?? "ALLOW"}`} accent="allow">
          <pre className="text-xs font-mono leading-relaxed overflow-x-auto">
            {(run.patch || "ALTER TABLE commerce.orders\n  RENAME COLUMN customer_id TO buyer_id;").split("\n").map((line, i) => (
              <div key={i} className={
                line.startsWith("+") ? "text-status-allow bg-status-allow/5 px-2 -mx-2" :
                line.startsWith("-") ? "text-status-block bg-status-block/5 px-2 -mx-2" :
                "text-muted-foreground"
              }>
                {line || " "}
              </div>
            ))}
          </pre>
          <div className="mt-4 pt-3 border-t border-border">
            <div className="flex items-center gap-2">
              <span className="text-xs text-muted-foreground">Without DataHub:</span>
              <Badge status="allow">ALLOW</Badge>
            </div>
            <p className="text-[11px] text-muted-foreground mt-1">No consumers visible from repository alone</p>
          </div>
        </Panel>

        {/* Center: DataHub Evidence */}
        <Panel
          title="DataHub Evidence"
          subtitle={`${run.consumersFound} evidence items collected`}
          accent={run.groundedDecision === "BLOCK" ? "block" : "allow"}
        >
          <div className="space-y-3">
            {/* Decision change highlight */}
            <div className={`rounded-lg p-3 ${run.groundedDecision === "BLOCK" ? "bg-status-block/5 border border-status-block/20" : "bg-status-allow/5 border border-status-allow/20"}`}>
              <div className="flex items-center justify-between">
                <span className="text-xs text-muted-foreground">Decision</span>
                <div className="flex items-center gap-1.5">
                  <Badge status="allow">{run.baselineDecision ?? "ALLOW"}</Badge>
                  <span className="text-muted-foreground text-xs">→</span>
                  <Badge status={run.groundedDecision === "BLOCK" ? "block" : "allow"}>{run.groundedDecision ?? "—"}</Badge>
                </div>
              </div>
            </div>

            {/* Triggered rules */}
            {rules.length > 0 && (
              <div>
                <p className="text-xs text-muted-foreground mb-2">Triggered Rules</p>
                <div className="space-y-1.5">
                  {rules.map((rule) => (
                    <div key={rule} className="flex items-start gap-2 text-xs">
                      <span className="font-mono text-status-block font-medium shrink-0">{rule}</span>
                      <span className="text-muted-foreground">{ruleDescriptions[rule] ?? "Policy rule triggered"}</span>
                    </div>
                  ))}
                </div>
              </div>
            )}

            {/* Evidence summary */}
            <div className="grid grid-cols-2 gap-2 pt-2">
              <MiniStat label="Consumers" value={String(run.consumersFound)} />
              <MiniStat label="Rules fired" value={String(rules.length)} />
            </div>
          </div>
        </Panel>

        {/* Right: Migration Output */}
        <Panel title="Safe Migration" subtitle={`${run.artifactsGenerated} artifacts generated`} accent={isComplete ? "pass" : "info"}>
          <div className="space-y-3">
            <div>
              <p className="text-xs text-muted-foreground mb-1">Strategy</p>
              <p className="text-sm font-medium">Expand → Migrate → Contract</p>
            </div>

            <div>
              <p className="text-xs text-muted-foreground mb-1">Artifacts</p>
              <p className="text-2xl font-semibold">{run.artifactsGenerated}</p>
              <p className="text-[11px] text-muted-foreground">SQL + dbt models + tests + docs</p>
            </div>

            <div className="grid grid-cols-2 gap-2">
              <MiniStat label="Validation" value={run.status === "COMPLETED" || run.status === "VALIDATED" ? "8/8 ✓" : "—"} />
              <MiniStat label="Writeback" value={run.writebackStatus ?? "—"} />
            </div>

            {run.prUrl && (
              <a href={run.prUrl} target="_blank" rel="noopener noreferrer" className="block mt-2 text-xs text-status-info hover:underline">
                → View PR on GitHub
              </a>
            )}
          </div>
        </Panel>
      </div>

      {/* Bottom: Key insight */}
      {isComplete && (
        <div className="rounded-xl border border-status-pass/30 bg-status-pass/5 p-4 flex items-center gap-4">
          <span className="text-2xl">🛡️</span>
          <div>
            <p className="text-sm font-medium">Breaking change prevented</p>
            <p className="text-xs text-muted-foreground">
              DataHub lineage revealed {run.consumersFound} downstream dependencies invisible from the repository.
              A safe expand-migrate-contract migration was generated and validated.
            </p>
          </div>
        </div>
      )}
      {isFailed && (
        <div className="rounded-xl border border-status-fail/30 bg-status-fail/5 p-4 flex items-center gap-4">
          <span className="text-2xl">⚠️</span>
          <div>
            <p className="text-sm font-medium">Pipeline stopped at: {run.status.replace(/_/g, " ").toLowerCase()}</p>
            <p className="text-xs text-muted-foreground">
              The issue was detected and the change was blocked before reaching production.
            </p>
          </div>
        </div>
      )}
    </div>
  );
}

function Panel({ title, subtitle, accent, children }: { title: string; subtitle: string; accent: "allow" | "block" | "pass" | "info"; children: React.ReactNode }) {
  const accentColor = accent === "allow" ? "border-status-allow/30" : accent === "block" ? "border-status-block/30" : accent === "pass" ? "border-status-pass/30" : "border-status-info/30";
  return (
    <div className={`rounded-xl border ${accentColor} bg-card overflow-hidden`}>
      <div className="px-4 py-3 border-b border-border bg-muted/30">
        <h3 className="text-sm font-medium">{title}</h3>
        <p className="text-[11px] text-muted-foreground">{subtitle}</p>
      </div>
      <div className="p-4">{children}</div>
    </div>
  );
}

function MiniStat({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-lg bg-muted/50 px-3 py-2">
      <p className="text-[10px] text-muted-foreground uppercase tracking-wider">{label}</p>
      <p className="text-sm font-semibold mt-0.5">{value}</p>
    </div>
  );
}
