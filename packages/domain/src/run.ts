import { z } from "zod";

const isoDateTimeSchema = z.iso.datetime({ offset: true });

export const runStatusSchema = z.enum([
  "PENDING",
  "PARSING_CHANGE",
  "CHANGE_PARSED",
  "ASSESSING_BASELINE",
  "BASELINE_ASSESSED",
  "COLLECTING_CONTEXT",
  "CONTEXT_COLLECTED",
  "ASSESSING_RISK",
  "RISK_ASSESSED",
  "GENERATING_MIGRATION",
  "MIGRATION_GENERATED",
  "VALIDATING",
  "VALIDATED",
  "PUBLISHING_REVIEW",
  "REVIEW_PUBLISHED",
  "WRITING_BACK",
  "WRITEBACK_RECORDED",
  "COMPLETED",
  "FAILED_INPUT",
  "FAILED_CONTEXT",
  "FAILED_GENERATION",
  "FAILED_VALIDATION",
  "FAILED_EXTERNAL_WRITE",
]);

export type RunStatus = z.infer<typeof runStatusSchema>;

const terminalStatuses = new Set<RunStatus>([
  "COMPLETED",
  "FAILED_INPUT",
  "FAILED_CONTEXT",
  "FAILED_GENERATION",
  "FAILED_VALIDATION",
  "FAILED_EXTERNAL_WRITE",
]);

const allowedTransitions: Readonly<Record<RunStatus, readonly RunStatus[]>> = {
  PENDING: ["PARSING_CHANGE", "FAILED_INPUT"],
  PARSING_CHANGE: ["CHANGE_PARSED", "FAILED_INPUT"],
  CHANGE_PARSED: ["ASSESSING_BASELINE"],
  ASSESSING_BASELINE: ["BASELINE_ASSESSED", "FAILED_INPUT"],
  BASELINE_ASSESSED: ["COLLECTING_CONTEXT"],
  COLLECTING_CONTEXT: ["CONTEXT_COLLECTED", "FAILED_CONTEXT"],
  CONTEXT_COLLECTED: ["ASSESSING_RISK", "FAILED_CONTEXT"],
  ASSESSING_RISK: ["RISK_ASSESSED", "FAILED_CONTEXT"],
  RISK_ASSESSED: ["GENERATING_MIGRATION"],
  GENERATING_MIGRATION: ["MIGRATION_GENERATED", "FAILED_GENERATION"],
  MIGRATION_GENERATED: ["VALIDATING"],
  VALIDATING: ["VALIDATED", "FAILED_VALIDATION"],
  VALIDATED: ["PUBLISHING_REVIEW"],
  PUBLISHING_REVIEW: ["REVIEW_PUBLISHED", "FAILED_EXTERNAL_WRITE"],
  REVIEW_PUBLISHED: ["WRITING_BACK"],
  WRITING_BACK: ["WRITEBACK_RECORDED", "FAILED_EXTERNAL_WRITE"],
  WRITEBACK_RECORDED: ["COMPLETED"],
  COMPLETED: [],
  FAILED_INPUT: [],
  FAILED_CONTEXT: [],
  FAILED_GENERATION: [],
  FAILED_VALIDATION: [],
  FAILED_EXTERNAL_WRITE: [],
};

export function isTerminalRunStatus(status: RunStatus): boolean {
  return terminalStatuses.has(status);
}

export function canTransitionRunStatus(from: RunStatus, to: RunStatus): boolean {
  return allowedTransitions[from].includes(to);
}

export const runStatusEventSchema = z
  .object({
    eventId: z.string().regex(/^evt_[a-f0-9]{24}$/),
    runId: z.string().regex(/^run_[a-f0-9]{24}$/),
    sequence: z.number().int().nonnegative(),
    type: z.literal("RUN_STATUS_CHANGED"),
    from: runStatusSchema,
    to: runStatusSchema,
    occurredAt: isoDateTimeSchema,
    detail: z.string().min(1).max(500).optional(),
  })
  .strict()
  .refine((event) => canTransitionRunStatus(event.from, event.to), {
    message: "Invalid run status transition",
    path: ["to"],
  });

export type RunStatusEvent = z.infer<typeof runStatusEventSchema>;

export const runEventStreamSchema = z
  .array(runStatusEventSchema)
  .min(1)
  .max(100)
  .superRefine((events, refinement) => {
    const runId = events[0]?.runId;
    if (events[0]?.from !== "PENDING") {
      refinement.addIssue({
        code: "custom",
        message: "Event stream must start from PENDING",
        path: [0, "from"],
      });
    }
    const eventIds = new Set<string>();
    for (const [index, event] of events.entries()) {
      if (eventIds.has(event.eventId)) {
        refinement.addIssue({
          code: "custom",
          message: "Event IDs must be unique",
          path: [index, "eventId"],
        });
      }
      eventIds.add(event.eventId);
      if (event.runId !== runId) {
        refinement.addIssue({
          code: "custom",
          message: "Event stream mixes run IDs",
          path: [index, "runId"],
        });
      }
      if (event.sequence !== index) {
        refinement.addIssue({
          code: "custom",
          message: "Event sequence must be contiguous and zero-based",
          path: [index, "sequence"],
        });
      }
      const previous = events[index - 1];
      if (previous && previous.to !== event.from) {
        refinement.addIssue({
          code: "custom",
          message: "Event transition does not continue from the prior state",
          path: [index, "from"],
        });
      }
    }
  });

export type RunEventStream = z.infer<typeof runEventStreamSchema>;
