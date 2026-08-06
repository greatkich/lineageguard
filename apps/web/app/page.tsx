import { Badge } from "@/components/ui/badge";
import { fetchRuns } from "@/lib/db";
import Link from "next/link";

const statusMap: Record<string, "pass" | "fail" | "info" | "neutral"> = {
  COMPLETED: "pass",
  VALIDATED: "pass",
  FAILED_CONTEXT: "fail",
  FAILED_GENERATION: "fail",
  FAILED_VALIDATION: "fail",
};

export const dynamic = "force-dynamic";

export default async function DashboardPage() {
  const runs = await fetchRuns();

  return (
    <div className="mx-auto max-w-5xl px-6 py-8">
      <div className="mb-8">
        <h1 className="text-2xl font-semibold tracking-tight">Runs</h1>
        <p className="text-sm text-muted-foreground mt-1">Schema change analysis history</p>
      </div>
      {runs.length === 0 ? (
        <div className="flex flex-col items-center justify-center py-24 text-muted-foreground">
          <p className="text-lg">No runs yet</p>
          <p className="text-sm mt-1">Run the pipeline to see results here</p>
        </div>
      ) : (
        <div className="divide-y divide-border rounded-lg border border-border">
          {runs.map((run) => (
            <Link
              key={run.id}
              href={`/runs/${run.id}`}
              className="flex items-center justify-between px-6 py-4 hover:bg-accent transition-colors"
            >
              <div className="flex flex-col gap-1">
                <div className="flex items-center gap-3">
                  <span className="font-mono text-sm text-muted-foreground">{run.id.slice(0, 20)}...</span>
                  <Badge status={statusMap[run.status] ?? "info"}>
                    {run.status.replace(/_/g, " ")}
                  </Badge>
                </div>
                <span className="text-sm text-muted-foreground">
                  {run.repository} &middot; {run.field}
                </span>
              </div>
              <div className="flex items-center gap-4 text-sm">
                {run.groundedDecision && (
                  <span className="font-medium">
                    {run.baselineDecision} &rarr; {run.groundedDecision}
                  </span>
                )}
                <span className="text-muted-foreground">{run.consumersFound} consumers</span>
              </div>
            </Link>
          ))}
        </div>
      )}
    </div>
  );
}
