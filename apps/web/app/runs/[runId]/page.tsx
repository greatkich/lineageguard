import { Badge } from "@/components/ui/badge";
import { Card, CardBody, CardHeader } from "@/components/ui/card";
import {
  IconAlertCircle,
  IconArrowRight,
  IconCheck,
  IconCheckCircle,
  IconCode,
  IconContainer,
  IconCpu,
  IconDatabase,
  IconFileText,
  IconGitPullRequest,
  IconSearch,
  IconShieldCheck,
  IconUpload,
  IconX,
  IconZap,
} from "@/components/ui/icons";
import { PipelineStepper, type StepDef } from "@/components/ui/pipeline-stepper";
import { fetchRun } from "@/lib/db";
import {
  deriveImpactConsumers,
  impactContextSchema,
  type ImpactConsumer,
} from "@lineageguard/domain";
import Link from "next/link";
import { notFound } from "next/navigation";

const pipelineSteps: StepDef[] = [
  { key: "CREATED", label: "Created", icon: <IconCode className="w-4 h-4" /> },
  { key: "CHANGE_PARSED", label: "Parsed", icon: <IconCode className="w-4 h-4" /> },
  { key: "BASELINE_ASSESSED", label: "Baseline", icon: <IconSearch className="w-4 h-4" /> },
  { key: "CONTEXT_COLLECTED", label: "DataHub", icon: <IconDatabase className="w-4 h-4" /> },
  { key: "RISK_DECIDED", label: "Risk", icon: <IconZap className="w-4 h-4" /> },
  { key: "MIGRATION_PLANNED", label: "Plan", icon: <IconCpu className="w-4 h-4" /> },
  { key: "PATCH_GENERATED", label: "Generate", icon: <IconFileText className="w-4 h-4" /> },
  { key: "VALIDATED", label: "Validate", icon: <IconContainer className="w-4 h-4" /> },
  { key: "REVIEW_ARTIFACT_CREATED", label: "PR", icon: <IconGitPullRequest className="w-4 h-4" /> },
  { key: "COMPLETED", label: "Done", icon: <IconCheckCircle className="w-4 h-4" /> },
];

const failedStatusMap: Record<string, string> = {
  FAILED_CONTEXT: "CONTEXT_COLLECTED",
  FAILED_GENERATION: "PATCH_GENERATED",
  FAILED_VALIDATION: "VALIDATED",
  FAILED_GITHUB: "REVIEW_ARTIFACT_CREATED",
  FAILED_WRITEBACK: "COMPLETED",
};

const ruleDescriptions: Record<string, { title: string; severity: string }> = {
  LG001: { title: "Downstream field-level lineage paths exist", severity: "CRITICAL" },
  LG002: { title: "Production ML model depends on renamed field", severity: "CRITICAL" },
  LG003: { title: "Observed system query references renamed field", severity: "HIGH" },
  LG004: { title: "Critical dashboard depends on field change", severity: "CRITICAL" },
  LG005: { title: "Affected critical asset has no recorded owner", severity: "HIGH" },
};

export const dynamic = "force-dynamic";

export default async function RunDetailPage({ params }: { params: Promise<{ runId: string }> }) {
  const { runId } = await params;
  const run = await fetchRun(runId);
  if (!run) notFound();

  const isFailed = run.status.startsWith("FAILED");
  const isComplete = run.status === "COMPLETED";
  const effectiveStatus = failedStatusMap[run.status] ?? run.status;
  const rules = run.triggeredRules?.split(",").filter(Boolean) ?? [];

  // Derive impact consumers from persisted context using the same domain
  // function the pipeline uses — guarantees the UI and backend agree on
  // exactly which/how-many consumers are shown (no duplicated, drifted logic).
  const impactConsumers: ImpactConsumer[] = (() => {
    if (!run.contextJson) return [];
    const parsed = impactContextSchema.safeParse(run.contextJson);
    if (!parsed.success) return [];
    return deriveImpactConsumers(parsed.data);
  })();

  const kindLabels: Record<ImpactConsumer["kind"], string> = {
    DATA_MODEL: "Data Model",
    DASHBOARD: "Dashboard",
    ML_CONSUMER: "ML Consumer",
    UNMANAGED_QUERY: "Unmanaged Query",
  };

  // Extract candidate info from persisted data
  const candidate = run.candidateJson as { strategy?: string; artifacts?: Array<{ path: string; kind: string }> } | null;

  return (
    <div className="mx-auto max-w-7xl px-6 py-6 space-y-6">
      {/* Breadcrumb + header */}
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-3">
          <Link href="/" className="text-sm text-muted-foreground hover:text-foreground transition-colors">
            Dashboard
          </Link>
          <span className="text-muted-foreground/40">/</span>
          <span className="text-sm font-medium">Run Detail</span>
        </div>
        <div className="flex items-center gap-2">
          <Badge status="info">{run.executionMode}</Badge>
          <Badge status={isComplete ? "pass" : isFailed ? "fail" : "info"}>
            {run.status.replace(/_/g, " ")}
          </Badge>
        </div>
      </div>

      {/* Title */}
      <div>
        <h1 className="text-xl font-semibold tracking-tight">
          <span className="font-mono">{run.field}</span>
        </h1>
        <p className="text-sm text-muted-foreground mt-1">
          {run.repository} &middot; {new Date(run.createdAt).toLocaleString()}
          {run.sourcePrUrl && (
            <> &middot; <a href={run.sourcePrUrl} target="_blank" rel="noopener noreferrer" className="text-status-info hover:underline">Source PR</a></>
          )}
        </p>
      </div>

      {/* Pipeline stepper */}
      <Card>
        <CardHeader>
          <h2 className="text-sm font-medium">Pipeline Progress</h2>
        </CardHeader>
        <CardBody className="py-6">
          <PipelineStepper
            steps={pipelineSteps}
            currentStatus={effectiveStatus}
            failed={isFailed}
          />
        </CardBody>
      </Card>

      {/* 3-panel grid */}
      <div className="grid grid-cols-1 lg:grid-cols-3 gap-4">
        {/* Panel 1: Proposed Change */}
        <Card>
          <CardHeader className="flex flex-row items-center justify-between">
            <div className="flex items-center gap-2">
              <IconCode className="w-4 h-4 text-muted-foreground" />
              <h3 className="text-sm font-medium">Proposed Change</h3>
            </div>
            {run.baselineDecision && (
              <Badge status="allow">{run.baselineDecision}</Badge>
            )}
          </CardHeader>
          <CardBody>
            <div className="rounded-md bg-muted/50 p-3 overflow-x-auto">
              <pre className="text-xs font-mono leading-relaxed">
                {(run.patch || "No patch data available").split("\n").map((line, i) => (
                  <div key={i} className={
                    line.startsWith("+") ? "text-status-allow" :
                    line.startsWith("-") ? "text-status-block" :
                    "text-muted-foreground"
                  }>
                    {line || " "}
                  </div>
                ))}
              </pre>
            </div>
            <div className="mt-4 flex items-center gap-2 text-xs text-muted-foreground">
              <IconSearch className="w-3.5 h-3.5" />
              <span>
                {run.baselineDecision === "ALLOW"
                  ? "Repository-only assessment: no breaking change detected without DataHub context"
                  : run.baselineDecision
                    ? `Baseline assessment: ${run.baselineDecision}`
                    : "Assessment pending"}
              </span>
            </div>
          </CardBody>
        </Card>

        {/* Panel 2: DataHub Evidence */}
        <Card className={run.groundedDecision === "BLOCK" ? "ring-1 ring-status-block/20" : ""}>
          <CardHeader className="flex flex-row items-center justify-between">
            <div className="flex items-center gap-2">
              <IconDatabase className="w-4 h-4 text-muted-foreground" />
              <h3 className="text-sm font-medium">DataHub Evidence</h3>
            </div>
            {run.groundedDecision ? (
              <Badge status={run.groundedDecision === "BLOCK" ? "block" : "allow"}>
                {run.groundedDecision}
              </Badge>
            ) : (
              <Badge status="info">PENDING</Badge>
            )}
          </CardHeader>
          <CardBody className="space-y-4">
            {/* Decision transition */}
            {run.baselineDecision && run.groundedDecision && (
              <div className="flex items-center justify-between p-3 rounded-md bg-muted/50">
                <span className="text-xs text-muted-foreground">Decision</span>
                <div className="flex items-center gap-2">
                  <Badge status="allow">{run.baselineDecision}</Badge>
                  <IconArrowRight className="w-3.5 h-3.5 text-muted-foreground" />
                  <Badge status={run.groundedDecision === "BLOCK" ? "block" : "allow"}>
                    {run.groundedDecision}
                  </Badge>
                </div>
              </div>
            )}

            {/* Impact consumers from persisted context */}
            {impactConsumers.length > 0 && (
              <div>
                <p className="text-xs font-medium text-muted-foreground mb-2">Impact Consumers ({impactConsumers.length})</p>
                <div className="space-y-1.5">
                  {impactConsumers.slice(0, 6).map((item) => (
                    <div key={item.entityUrn} className="flex items-center gap-2 p-1.5 rounded bg-muted/30 text-xs">
                      <span className="font-mono text-[10px] text-muted-foreground">{kindLabels[item.kind]}</span>
                      <span className="truncate">{item.title}</span>
                    </div>
                  ))}
                </div>
              </div>
            )}

            {/* Triggered rules */}
            {rules.length > 0 && (
              <div>
                <p className="text-xs font-medium text-muted-foreground mb-2">Policy Rules Triggered</p>
                <div className="space-y-2">
                  {rules.map((rule) => {
                    const desc = ruleDescriptions[rule];
                    return (
                      <div key={rule} className="flex items-start gap-2.5 p-2 rounded-md bg-status-block/5">
                        <IconAlertCircle className="w-3.5 h-3.5 text-status-block mt-0.5 flex-shrink-0" />
                        <div className="min-w-0">
                          <span className="text-xs font-mono font-medium text-status-block">{rule}</span>
                          {desc && <p className="text-[11px] text-muted-foreground mt-0.5">{desc.title}</p>}
                        </div>
                        {desc && (
                          <Badge status={desc.severity === "CRITICAL" ? "fail" : "review"} className="ml-auto flex-shrink-0 text-[10px]">
                            {desc.severity}
                          </Badge>
                        )}
                      </div>
                    );
                  })}
                </div>
              </div>
            )}

            {/* Stats */}
            <div className="grid grid-cols-2 gap-3">
              <div className="p-2.5 rounded-md bg-muted/50">
                <p className="text-[10px] text-muted-foreground uppercase tracking-wider">Consumers</p>
                <p className="text-lg font-semibold mt-0.5">{run.consumersFound || "—"}</p>
              </div>
              <div className="p-2.5 rounded-md bg-muted/50">
                <p className="text-[10px] text-muted-foreground uppercase tracking-wider">Evidence</p>
                <p className="text-lg font-semibold mt-0.5">{run.evidenceItems || "—"}</p>
              </div>
            </div>
          </CardBody>
        </Card>

        {/* Panel 3: Migration */}
        <Card>
          <CardHeader className="flex flex-row items-center justify-between">
            <div className="flex items-center gap-2">
              <IconFileText className="w-4 h-4 text-muted-foreground" />
              <h3 className="text-sm font-medium">Safe Migration</h3>
            </div>
            {isComplete && <Badge status="pass">COMPLETE</Badge>}
          </CardHeader>
          <CardBody className="space-y-4">
            <div>
              <p className="text-xs text-muted-foreground mb-1">Strategy</p>
              <p className="text-sm font-medium">
                {candidate?.strategy
                  ? candidate.strategy.replace(/_/g, " → ").replace("EXPAND → MIGRATE → CONTRACT", "Expand → Migrate → Contract")
                  : "—"}
              </p>
            </div>

            <div className="grid grid-cols-2 gap-3">
              <div className="p-2.5 rounded-md bg-muted/50">
                <p className="text-[10px] text-muted-foreground uppercase tracking-wider">Artifacts</p>
                <p className="text-lg font-semibold mt-0.5">{run.artifactsGenerated || "—"}</p>
              </div>
              <div className="p-2.5 rounded-md bg-muted/50">
                <p className="text-[10px] text-muted-foreground uppercase tracking-wider">Validation</p>
                <p className="text-lg font-semibold mt-0.5 flex items-center gap-1">
                  {run.validationReceiptFingerprint ? (
                    <><IconCheck className="w-4 h-4 text-status-pass" /> <span className="text-sm">PASS</span></>
                  ) : isFailed && run.status === "FAILED_VALIDATION" ? (
                    <><IconX className="w-4 h-4 text-status-fail" /> <span className="text-sm">FAIL</span></>
                  ) : (
                    <span className="text-sm text-muted-foreground">—</span>
                  )}
                </p>
              </div>
            </div>

            {/* Generated artifacts list from persisted candidate */}
            {candidate?.artifacts && candidate.artifacts.length > 0 && (
              <div>
                <p className="text-xs font-medium text-muted-foreground mb-2">Generated Files</p>
                <div className="space-y-1">
                  {candidate.artifacts.map((a) => (
                    <div key={a.path} className="text-[11px] font-mono text-muted-foreground truncate">
                      {a.path}
                    </div>
                  ))}
                </div>
              </div>
            )}

            {/* Writeback */}
            {run.writebackStatus && (
              <div className="flex items-center gap-2 p-2.5 rounded-md bg-status-pass/5">
                <IconUpload className="w-4 h-4 text-status-pass" />
                <div>
                  <p className="text-xs font-medium">DataHub Writeback</p>
                  <p className="text-[11px] text-muted-foreground">
                    {run.writebackStatus}
                    {run.writebackReceiptFingerprint && (
                      <span className="ml-1 font-mono">[{run.writebackReceiptFingerprint.slice(0, 8)}]</span>
                    )}
                  </p>
                </div>
              </div>
            )}

            {/* PR link */}
            {run.prUrl && (
              <a
                href={run.prUrl}
                target="_blank"
                rel="noopener noreferrer"
                className="flex items-center gap-2 p-2.5 rounded-md bg-status-info/5 hover:bg-status-info/10 transition-colors"
              >
                <IconGitPullRequest className="w-4 h-4 text-status-info" />
                <span className="text-xs font-medium text-status-info">View Pull Request</span>
              </a>
            )}
          </CardBody>
        </Card>
      </div>

      {/* Bottom insight banner */}
      {isComplete && (
        <Card className="border-status-pass/30 bg-status-pass/[0.03]">
          <CardBody className="flex items-center gap-4">
            <div className="w-10 h-10 rounded-full bg-status-pass/10 flex items-center justify-center flex-shrink-0">
              <IconShieldCheck className="w-5 h-5 text-status-pass" />
            </div>
            <div>
              <p className="text-sm font-medium">Breaking change prevented</p>
              <p className="text-xs text-muted-foreground mt-0.5">
                DataHub lineage revealed {run.consumersFound} downstream {run.consumersFound === 1 ? "dependency" : "dependencies"} invisible from the repository.
                {run.validationReceiptFingerprint && " A safe migration was validated"}
                {run.writebackReceiptFingerprint && " and written back to DataHub"}.
              </p>
            </div>
          </CardBody>
        </Card>
      )}
      {isFailed && (
        <Card className="border-status-fail/30 bg-status-fail/[0.03]">
          <CardBody className="flex items-center gap-4">
            <div className="w-10 h-10 rounded-full bg-status-fail/10 flex items-center justify-center flex-shrink-0">
              <IconAlertCircle className="w-5 h-5 text-status-fail" />
            </div>
            <div>
              <p className="text-sm font-medium">Pipeline halted: {run.status.replace(/^FAILED_/, "").toLowerCase()}</p>
              <p className="text-xs text-muted-foreground mt-0.5">
                The change was blocked before reaching production. Review the pipeline step above for details.
              </p>
            </div>
          </CardBody>
        </Card>
      )}
    </div>
  );
}
