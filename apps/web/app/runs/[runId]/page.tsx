import { Badge } from "@/components/ui/badge";
import { fetchRun } from "@/lib/db";
import { notFound } from "next/navigation";

const steps = [
  { status: "CREATED", label: "Created" },
  { status: "CHANGE_PARSED", label: "Parsed" },
  { status: "BASELINE_ASSESSED", label: "Baseline" },
  { status: "CONTEXT_COLLECTED", label: "Context" },
  { status: "RISK_DECIDED", label: "Decision" },
  { status: "MIGRATION_PLANNED", label: "Planned" },
  { status: "PATCH_GENERATED", label: "Generated" },
  { status: "VALIDATED", label: "Validated" },
  { status: "COMPLETED", label: "Complete" },
];

export const dynamic = "force-dynamic";

export default async function RunDetailPage({ params }: { params: Promise<{ runId: string }> }) {
  const { runId } = await params;
  const run = await fetchRun(runId);
  if (!run) notFound();

  const currentIdx = steps.findIndex((s) => s.status === run.status);
  const patchLines = (run.patch || "- customer_id\n+ buyer_id").split("\n");

  return (
    <div className="flex flex-col h-[calc(100vh-3.5rem)]">
      <div className="flex-1 grid grid-cols-3 gap-4 p-6 overflow-hidden">
        {/* Left: Proposed Change */}
        <div className="overflow-y-auto">
          <div className="rounded-lg border border-border overflow-hidden">
            <div className="bg-muted px-4 py-2 text-sm font-medium border-b border-border">
              Proposed Change
            </div>
            <pre className="p-4 text-sm font-mono overflow-x-auto">
              {patchLines.map((line, i) => (
                <div
                  key={i}
                  className={
                    line.startsWith("+") ? "text-status-allow" : line.startsWith("-") ? "text-status-block" : "text-muted-foreground"
                  }
                >
                  {line}
                </div>
              ))}
            </pre>
            <div className="bg-muted px-4 py-2 text-xs border-t border-border">
              Repository-only: <span className="font-medium text-status-allow">{run.baselineDecision ?? "ALLOW"}</span>
            </div>
          </div>
        </div>

        {/* Center: DataHub Evidence */}
        <div className="overflow-y-auto">
          <div className="rounded-lg border border-border overflow-hidden">
            <div className="bg-muted px-4 py-2 text-sm font-medium border-b border-border flex items-center justify-between">
              <span>DataHub Evidence</span>
              <Badge status={run.groundedDecision === "BLOCK" ? "block" : "info"}>
                {run.groundedDecision ?? "PENDING"}
              </Badge>
            </div>
            <div className="p-4">
              <p className="text-sm">{run.consumersFound} downstream consumers discovered</p>
              <p className="text-xs text-muted-foreground mt-2">
                Field: <span className="font-mono">{run.field}</span> in <span className="font-mono">{run.repository}</span>
              </p>
            </div>
            <div className="bg-muted px-4 py-2 text-xs border-t border-border">
              Decision changed: {run.baselineDecision} → {run.groundedDecision}
            </div>
          </div>
        </div>

        {/* Right: Migration Result */}
        <div className="overflow-y-auto">
          <div className="rounded-lg border border-border overflow-hidden">
            <div className="bg-muted px-4 py-2 text-sm font-medium border-b border-border">
              Migration
            </div>
            <div className="p-4 space-y-3">
              <div>
                <p className="text-xs text-muted-foreground uppercase tracking-wide mb-1">Status</p>
                <Badge status={run.status === "COMPLETED" ? "pass" : "info"}>{run.status}</Badge>
              </div>
              <div>
                <p className="text-xs text-muted-foreground uppercase tracking-wide mb-1">Artifacts Generated</p>
                <p className="text-2xl font-semibold">{run.artifactsGenerated}</p>
              </div>
              <div>
                <p className="text-xs text-muted-foreground uppercase tracking-wide mb-1">Strategy</p>
                <p className="text-sm">Expand-Migrate-Contract</p>
              </div>
            </div>
          </div>
        </div>
      </div>

      {/* Bottom: Timeline */}
      <div className="border-t border-border bg-card px-6 py-4">
        <div className="flex items-center gap-1">
          {steps.map((step, i) => (
            <div key={step.status} className="flex items-center">
              <div className="flex flex-col items-center">
                <div
                  className={`w-3 h-3 rounded-full ${
                    i < currentIdx
                      ? "bg-status-pass"
                      : i === currentIdx
                        ? "bg-status-info ring-2 ring-status-info/30"
                        : "bg-muted"
                  }`}
                />
                <span
                  className={`text-[10px] mt-1 whitespace-nowrap ${
                    i === currentIdx ? "text-foreground font-medium" : "text-muted-foreground"
                  }`}
                >
                  {step.label}
                </span>
              </div>
              {i < steps.length - 1 && (
                <div className={`w-6 h-px mx-1 ${i < currentIdx ? "bg-status-pass" : "bg-border"}`} />
              )}
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
