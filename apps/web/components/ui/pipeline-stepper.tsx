import { cn } from "@/lib/utils";
import type { ReactNode } from "react";

export interface StepDef {
  key: string;
  label: string;
  icon: ReactNode;
}

export function PipelineStepper({ steps, currentStatus, failed }: {
  steps: StepDef[];
  currentStatus: string;
  failed?: boolean;
}) {
  const currentIdx = steps.findIndex((s) => s.key === currentStatus);
  const activeIdx = currentIdx >= 0 ? currentIdx : steps.length - 1;

  return (
    <div className="flex items-start gap-0">
      {steps.map((step, i) => {
        const isPast = i < activeIdx;
        const isCurrent = i === activeIdx;
        const isFailed = isCurrent && failed;

        return (
          <div key={step.key} className="flex items-start flex-1 min-w-0">
            <div className="flex flex-col items-center w-full">
              {/* Node */}
              <div className={cn(
                "w-9 h-9 rounded-full flex items-center justify-center border-2 transition-all",
                isFailed ? "border-status-fail bg-status-fail/10 text-status-fail" :
                isCurrent ? "border-status-info bg-status-info/10 text-status-info ring-[3px] ring-status-info/15" :
                isPast ? "border-status-pass bg-status-pass/10 text-status-pass" :
                "border-border bg-card text-muted-foreground/40",
              )}>
                <span className="w-4 h-4">{step.icon}</span>
              </div>
              {/* Label */}
              <span className={cn(
                "text-[11px] mt-2 text-center leading-tight",
                isCurrent ? "font-semibold text-foreground" :
                isPast ? "text-muted-foreground" :
                "text-muted-foreground/40",
              )}>
                {step.label}
              </span>
            </div>
            {/* Connector */}
            {i < steps.length - 1 && (
              <div className="flex-1 min-w-3 max-w-12 mt-[18px]">
                <div className={cn(
                  "h-[2px] w-full",
                  i < activeIdx ? "bg-status-pass" :
                  i === activeIdx && isFailed ? "bg-status-fail" :
                  "bg-border",
                )} />
              </div>
            )}
          </div>
        );
      })}
    </div>
  );
}
