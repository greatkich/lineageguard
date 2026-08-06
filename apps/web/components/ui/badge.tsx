import { cva, type VariantProps } from "class-variance-authority";
import { cn } from "@/lib/utils";

const badgeVariants = cva(
  "inline-flex items-center rounded-full px-2.5 py-0.5 text-xs font-medium",
  {
    variants: {
      status: {
        allow: "bg-status-allow/15 text-status-allow",
        block: "bg-status-block/15 text-status-block",
        review: "bg-status-review/15 text-status-review",
        pass: "bg-status-pass/15 text-status-pass",
        fail: "bg-status-fail/15 text-status-fail",
        info: "bg-status-info/15 text-status-info",
        neutral: "bg-muted text-muted-foreground",
      },
    },
    defaultVariants: { status: "neutral" },
  },
);

export interface BadgeProps
  extends React.HTMLAttributes<HTMLSpanElement>,
    VariantProps<typeof badgeVariants> {}

export function Badge({ className, status, ...props }: BadgeProps) {
  return <span className={cn(badgeVariants({ status }), className)} {...props} />;
}
