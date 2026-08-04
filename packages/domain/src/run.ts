import { z } from "zod";

const isoDateTimeSchema = z.iso.datetime({ offset: true });
const eventIdSchema = z.string().regex(/^evt_[a-f0-9]{24}$/);
const runIdSchema = z.string().regex(/^run_[a-f0-9]{24}$/);

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
  "CANCELLED",
  "FAILED_INPUT",
  "FAILED_CONTEXT",
  "FAILED_GENERATION",
  "FAILED_VALIDATION",
  "FAILED_GITHUB",
  "FAILED_WRITEBACK",
]);

export type RunStatus = z.infer<typeof runStatusSchema>;

const terminalStatuses = new Set<RunStatus>([
  "COMPLETED",
  "CANCELLED",
  "FAILED_INPUT",
  "FAILED_CONTEXT",
  "FAILED_GENERATION",
  "FAILED_VALIDATION",
  "FAILED_GITHUB",
  "FAILED_WRITEBACK",
]);

const allowedTransitions: Readonly<Record<RunStatus, readonly RunStatus[]>> = {
  PENDING: ["PARSING_CHANGE", "FAILED_INPUT", "CANCELLED"],
  PARSING_CHANGE: ["CHANGE_PARSED", "FAILED_INPUT", "CANCELLED"],
  CHANGE_PARSED: ["ASSESSING_BASELINE", "CANCELLED"],
  ASSESSING_BASELINE: ["BASELINE_ASSESSED", "FAILED_INPUT", "CANCELLED"],
  BASELINE_ASSESSED: ["COLLECTING_CONTEXT", "CANCELLED"],
  COLLECTING_CONTEXT: ["CONTEXT_COLLECTED", "FAILED_CONTEXT", "CANCELLED"],
  CONTEXT_COLLECTED: ["ASSESSING_RISK", "FAILED_CONTEXT", "CANCELLED"],
  ASSESSING_RISK: ["RISK_ASSESSED", "FAILED_CONTEXT", "CANCELLED"],
  RISK_ASSESSED: ["GENERATING_MIGRATION", "CANCELLED"],
  GENERATING_MIGRATION: ["MIGRATION_GENERATED", "FAILED_GENERATION", "CANCELLED"],
  MIGRATION_GENERATED: ["VALIDATING", "CANCELLED"],
  VALIDATING: ["VALIDATED", "FAILED_VALIDATION", "CANCELLED"],
  VALIDATED: ["PUBLISHING_REVIEW", "CANCELLED"],
  PUBLISHING_REVIEW: ["REVIEW_PUBLISHED", "FAILED_GITHUB", "CANCELLED"],
  REVIEW_PUBLISHED: ["WRITING_BACK", "CANCELLED"],
  WRITING_BACK: ["WRITEBACK_RECORDED", "FAILED_WRITEBACK", "CANCELLED"],
  WRITEBACK_RECORDED: ["COMPLETED", "CANCELLED"],
  COMPLETED: [],
  CANCELLED: [],
  FAILED_INPUT: [],
  FAILED_CONTEXT: [],
  FAILED_GENERATION: [],
  FAILED_VALIDATION: [],
  FAILED_GITHUB: [],
  FAILED_WRITEBACK: [],
};

export function isTerminalRunStatus(status: RunStatus): boolean {
  return terminalStatuses.has(status);
}

export function canTransitionRunStatus(from: RunStatus, to: RunStatus): boolean {
  return allowedTransitions[from].includes(to);
}

const eventBaseShape = {
  eventId: eventIdSchema,
  runId: runIdSchema,
  sequence: z.number().int().nonnegative(),
  occurredAt: isoDateTimeSchema,
};

export const runStatusEventSchema = z
  .object({
    ...eventBaseShape,
    type: z.literal("RUN_STATUS_CHANGED"),
    from: runStatusSchema,
    to: runStatusSchema,
    detail: z.string().min(1).max(500).optional(),
  })
  .strict()
  .refine((event) => canTransitionRunStatus(event.from, event.to), {
    message: "Invalid run status transition",
    path: ["to"],
  });

export const runLeaseAcquiredEventSchema = z
  .object({
    ...eventBaseShape,
    type: z.literal("RUN_LEASE_ACQUIRED"),
    leaseId: z.string().regex(/^lease_[a-f0-9]{24}$/),
    workerId: z.string().min(1).max(160),
    expiresAt: isoDateTimeSchema,
  })
  .strict()
  .refine((event) => new Date(event.expiresAt).getTime() > new Date(event.occurredAt).getTime(), {
    message: "Lease expiry must be after acquisition",
    path: ["expiresAt"],
  });

export const runLeaseRenewedEventSchema = z
  .object({
    ...eventBaseShape,
    type: z.literal("RUN_LEASE_RENEWED"),
    leaseId: z.string().regex(/^lease_[a-f0-9]{24}$/),
    previousExpiresAt: isoDateTimeSchema,
    expiresAt: isoDateTimeSchema,
  })
  .strict()
  .refine(
    (event) =>
      new Date(event.expiresAt).getTime() > new Date(event.previousExpiresAt).getTime() &&
      new Date(event.expiresAt).getTime() > new Date(event.occurredAt).getTime(),
    { message: "Lease renewal must extend the active lease", path: ["expiresAt"] },
  );

export const runRetryScheduledEventSchema = z
  .object({
    ...eventBaseShape,
    type: z.literal("RUN_RETRY_SCHEDULED"),
    operation: z.enum(["DATAHUB_READ", "GENERATION", "GITHUB_WRITE", "DATAHUB_WRITE"]),
    attempt: z.number().int().min(1).max(10),
    retryAt: isoDateTimeSchema,
    reason: z.string().min(1).max(500),
  })
  .strict()
  .refine((event) => new Date(event.retryAt).getTime() >= new Date(event.occurredAt).getTime(), {
    message: "Retry cannot be scheduled in the past",
    path: ["retryAt"],
  });

export const runEventSchema = z.discriminatedUnion("type", [
  runStatusEventSchema,
  runLeaseAcquiredEventSchema,
  runLeaseRenewedEventSchema,
  runRetryScheduledEventSchema,
]);

export type RunStatusEvent = z.infer<typeof runStatusEventSchema>;
export type RunEvent = z.infer<typeof runEventSchema>;

export const runEventStreamSchema = z
  .array(runEventSchema)
  .min(1)
  .max(200)
  .superRefine((events, refinement) => {
    const runId = events[0]?.runId;
    const eventIds = new Set<string>();
    let currentStatus: RunStatus = "PENDING";
    let activeLease: { id: string; expiresAt: string } | undefined;
    const retryAttempts = new Map<string, number>();
    for (const [index, event] of events.entries()) {
      if (event.runId !== runId) {
        refinement.addIssue({
          code: "custom",
          message: "Event stream mixes run IDs",
          path: [index, "runId"],
        });
      }
      if (eventIds.has(event.eventId)) {
        refinement.addIssue({
          code: "custom",
          message: "Event IDs must be unique",
          path: [index, "eventId"],
        });
      }
      eventIds.add(event.eventId);
      if (event.sequence !== index) {
        refinement.addIssue({
          code: "custom",
          message: "Sequence must be contiguous and zero-based",
          path: [index, "sequence"],
        });
      }
      const previous = events[index - 1];
      if (
        previous &&
        new Date(event.occurredAt).getTime() < new Date(previous.occurredAt).getTime()
      ) {
        refinement.addIssue({
          code: "custom",
          message: "Event timestamps must be monotonic",
          path: [index, "occurredAt"],
        });
      }

      if (event.type === "RUN_STATUS_CHANGED") {
        if (event.from !== currentStatus) {
          refinement.addIssue({
            code: "custom",
            message: "Status transition does not continue from current state",
            path: [index, "from"],
          });
        }
        currentStatus = event.to;
      } else if (event.type === "RUN_LEASE_ACQUIRED") {
        activeLease = { id: event.leaseId, expiresAt: event.expiresAt };
      } else if (event.type === "RUN_LEASE_RENEWED") {
        if (
          !activeLease ||
          activeLease.id !== event.leaseId ||
          activeLease.expiresAt !== event.previousExpiresAt
        ) {
          refinement.addIssue({
            code: "custom",
            message: "Lease renewal does not match active lease",
            path: [index],
          });
        }
        activeLease = { id: event.leaseId, expiresAt: event.expiresAt };
      } else {
        const previousAttempt = retryAttempts.get(event.operation) ?? 0;
        if (event.attempt !== previousAttempt + 1) {
          refinement.addIssue({
            code: "custom",
            message: "Retry attempts must increase contiguously",
            path: [index, "attempt"],
          });
        }
        retryAttempts.set(event.operation, event.attempt);
      }
    }
  });

export type RunEventStream = z.infer<typeof runEventStreamSchema>;
