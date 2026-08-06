import { Badge } from "@/components/ui/badge";
import Link from "next/link";

const demoRuns = [
  {
    id: "run_000000000000000000000001",
    status: "COMPLETED",
    repository: "greatkich/lineageguard",
    field: "customer_id",
    baselineDecision: "ALLOW",
    groundedDecision: "BLOCK",
    consumersFound: 4,
    createdAt: "2026-08-06T10:00:00Z",
  },
];

const statusMap: Record<string, "pass" | "fail" | "info" | "neutral"> = {
  COMPLETED: "pass",
  VALIDATED: "pass",
  FAILED_CONTEXT: "fail",
  FAILED_GENERATION: "fail",
  FAILED_VALIDATION: "fail",
};

export default function DashboardPage() {
  return (
    <div className="mx-auto max-w-5xl px-6 py-8">
      <div className="mb-8">
        <h1 className="text-2xl font-semibold tracking-tight">Runs</h1>
        <p className="text-sm text-muted-foreground mt-1">Schema change analysis history</p>
      </div>
      <div className="divide-y divide-border rounded-lg border border-border">
        {demoRuns.map((run) => (
          <Link
            key={run.id}
            href={`/runs/${run.id}`}
            className="flex items-center justify-between px-6 py-4 hover:bg-accent transition-colors"
          >
            <div className="flex flex-col gap-1">
              <div className="flex items-center gap-3">
                <span className="font-mono text-sm text-muted-foreground">{run.id.slice(0, 16)}...</span>
                <Badge status={statusMap[run.status] ?? "info"}>
                  {run.status.replace(/_/g, " ")}
                </Badge>
              </div>
              <span className="text-sm text-muted-foreground">
                {run.repository} &middot; {run.field}
              </span>
            </div>
            <div className="flex items-center gap-4 text-sm">
              <span className="font-medium">
                {run.baselineDecision} &rarr; {run.groundedDecision}
              </span>
              <span className="text-muted-foreground">{run.consumersFound} consumers</span>
            </div>
          </Link>
        ))}
      </div>
    </div>
  );
}
