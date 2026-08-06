import { Badge } from "@/components/ui/badge";

const demoRun = {
  id: "run_000000000000000000000001",
  status: "COMPLETED",
  patch: "- customer_id\n+ buyer_id",
  baselineDecision: "ALLOW",
  groundedDecision: "BLOCK",
  consumers: [
    { name: "Finance Revenue Dashboard", type: "DASHBOARD", criticality: "CRITICAL" },
    { name: "analytics.customer_revenue", type: "DATASET", criticality: "HIGH" },
    { name: "Fraud Model v3", type: "ML_MODEL", criticality: "CRITICAL" },
    { name: "finance-monthly-close.sql", type: "QUERY", criticality: "HIGH" },
  ],
  strategy: "Expand-Migrate-Contract",
  artifacts: [
    { kind: "SQL_MIGRATION", path: "walkthrough/migrations/002_add_buyer_id.sql", operation: "CREATE" },
    { kind: "SQL_MIGRATION", path: "walkthrough/migrations/003_backfill.sql", operation: "CREATE" },
    { kind: "DBT_MODEL", path: "walkthrough/models/customer_revenue.sql", operation: "MODIFY" },
    { kind: "DBT_TEST", path: "walkthrough/tests/buyer_id_not_null.sql", operation: "CREATE" },
    { kind: "DBT_TEST", path: "walkthrough/tests/buyer_id_equality.sql", operation: "CREATE" },
    { kind: "MIGRATION_DOCUMENT", path: "docs/migrations/rename-customer-id.md", operation: "CREATE" },
  ],
  validations: [
    { name: "SQL Migration", status: "PASS" },
    { name: "Backfill Equality", status: "PASS" },
    { name: "dbt Compile", status: "PASS" },
    { name: "dbt Tests", status: "PASS" },
    { name: "Old Consumer Compatibility", status: "PASS" },
    { name: "Rollback", status: "PASS" },
  ],
};

const steps = [
  { status: "CREATED", label: "Created" },
  { status: "CHANGE_PARSED", label: "Parsed" },
  { status: "BASELINE_ASSESSED", label: "Baseline" },
  { status: "CONTEXT_COLLECTED", label: "Context" },
  { status: "RISK_DECIDED", label: "Decision" },
  { status: "MIGRATION_PLANNED", label: "Planned" },
  { status: "PATCH_GENERATED", label: "Generated" },
  { status: "VALIDATED", label: "Validated" },
  { status: "REVIEW_ARTIFACT_CREATED", label: "PR Created" },
  { status: "COMPLETED", label: "Complete" },
];

export default async function RunDetailPage({ params }: { params: Promise<{ runId: string }> }) {
  const { runId } = await params;
  const run = demoRun;
  const currentIdx = steps.findIndex((s) => s.status === run.status);

  return (
    <div className="flex flex-col h-[calc(100vh-3.5rem)]">
      {/* 3-panel grid */}
      <div className="flex-1 grid grid-cols-3 gap-4 p-6 overflow-hidden">
        {/* Left: Proposed Change */}
        <div className="overflow-y-auto">
          <div className="rounded-lg border border-border overflow-hidden">
            <div className="bg-muted px-4 py-2 text-sm font-medium border-b border-border">
              Proposed Change
            </div>
            <pre className="p-4 text-sm font-mono overflow-x-auto">
              {run.patch.split("\n").map((line, i) => (
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
              Repository-only: <span className="font-medium text-status-allow">{run.baselineDecision}</span>
            </div>
          </div>
        </div>

        {/* Center: DataHub Evidence */}
        <div className="overflow-y-auto">
          <div className="rounded-lg border border-border overflow-hidden">
            <div className="bg-muted px-4 py-2 text-sm font-medium border-b border-border flex items-center justify-between">
              <span>DataHub Evidence</span>
              <Badge status="block">{run.groundedDecision}</Badge>
            </div>
            <div className="divide-y divide-border">
              {run.consumers.map((consumer, i) => (
                <div key={i} className="px-4 py-3 flex items-center justify-between">
                  <div>
                    <p className="text-sm font-medium">{consumer.name}</p>
                    <p className="text-xs text-muted-foreground">{consumer.type}</p>
                  </div>
                  <Badge status={consumer.criticality === "CRITICAL" ? "block" : "review"}>
                    {consumer.criticality}
                  </Badge>
                </div>
              ))}
            </div>
            <div className="bg-muted px-4 py-2 text-xs border-t border-border">
              {run.consumers.length} downstream consumers discovered via DataHub
            </div>
          </div>
        </div>

        {/* Right: Safe Migration */}
        <div className="overflow-y-auto">
          <div className="rounded-lg border border-border overflow-hidden">
            <div className="bg-muted px-4 py-2 text-sm font-medium border-b border-border">
              Safe Migration
            </div>
            <div className="p-4 space-y-4">
              <div>
                <p className="text-xs text-muted-foreground uppercase tracking-wide mb-2">Strategy</p>
                <p className="text-sm font-medium">{run.strategy}</p>
              </div>
              <div>
                <p className="text-xs text-muted-foreground uppercase tracking-wide mb-2">Artifacts</p>
                <div className="space-y-1">
                  {run.artifacts.map((a, i) => (
                    <div key={i} className="flex items-center gap-2 text-sm">
                      <Badge status="info">{a.operation}</Badge>
                      <span className="font-mono text-xs truncate">{a.path}</span>
                    </div>
                  ))}
                </div>
              </div>
              <div>
                <p className="text-xs text-muted-foreground uppercase tracking-wide mb-2">Validations</p>
                <div className="space-y-1">
                  {run.validations.map((v, i) => (
                    <div key={i} className="flex items-center gap-2 text-sm">
                      <Badge status={v.status === "PASS" ? "pass" : "fail"}>{v.status}</Badge>
                      <span>{v.name}</span>
                    </div>
                  ))}
                </div>
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
