import { cn } from "@/lib/utils";
import type { ReactNode } from "react";

export function Card({ className, children }: { className?: string; children: ReactNode }) {
  return (
    <div className={cn("rounded-lg border border-border bg-card shadow-sm", className)}>
      {children}
    </div>
  );
}

export function CardHeader({ className, children }: { className?: string; children: ReactNode }) {
  return <div className={cn("px-5 py-4 border-b border-border", className)}>{children}</div>;
}

export function CardBody({ className, children }: { className?: string; children: ReactNode }) {
  return <div className={cn("px-5 py-4", className)}>{children}</div>;
}

export function StatCard({
  label,
  value,
  icon,
  accent,
}: {
  label: string;
  value: string | number;
  icon: ReactNode;
  accent?: "success" | "danger" | "warning" | "info";
}) {
  const accentStyles = {
    success: "text-status-pass bg-status-pass/8",
    danger: "text-status-block bg-status-block/8",
    warning: "text-status-review bg-status-review/8",
    info: "text-status-info bg-status-info/8",
  };
  const iconStyle = accent ? accentStyles[accent] : "text-muted-foreground bg-muted";

  return (
    <Card>
      <CardBody className="flex items-center gap-4">
        <div className={cn("w-11 h-11 rounded-lg flex items-center justify-center", iconStyle)}>
          {icon}
        </div>
        <div>
          <p className="text-xs text-muted-foreground font-medium uppercase tracking-wide">
            {label}
          </p>
          <p className="text-2xl font-semibold tracking-tight mt-0.5">{value}</p>
        </div>
      </CardBody>
    </Card>
  );
}
