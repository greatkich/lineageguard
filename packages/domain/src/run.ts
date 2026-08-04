import { z } from "zod";

const isoDateTimeSchema = z.iso.datetime({ offset: true });
const eventIdSchema = z.string().regex(/^evt_[a-f0-9]{24}$/);
const runIdSchema = z.string().regex(/^run_[a-f0-9]{24}$/);
const leaseIdSchema = z.string().regex(/^lease_[a-f0-9]{24}$/);
const workerIdSchema = z.string().min(1).max(160);

export const runStatusSchema = z.enum([
  "CREATED",
  "CHANGE_PARSED",
  "BASELINE_ASSESSED",
  "CONTEXT_COLLECTING",
  "CONTEXT_COLLECTED",
  "RISK_DECIDED",
  "MIGRATION_PLANNED",
  "PATCH_GENERATED",
  "VALIDATING",
  "VALIDATED",
  "REVIEW_ARTIFACT_CREATED",
  "WRITEBACK_PENDING",
  "COMPLETED",
  "FAILED_CONTEXT",
  "FAILED_GENERATION",
  "FAILED_VALIDATION",
  "FAILED_GITHUB",
  "FAILED_WRITEBACK",
  "CANCELLED",
]);
export type RunStatus = z.infer<typeof runStatusSchema>;

const terminalStatuses = new Set<RunStatus>([
  "COMPLETED",
  "FAILED_CONTEXT",
  "FAILED_GENERATION",
  "FAILED_VALIDATION",
  "FAILED_GITHUB",
  "FAILED_WRITEBACK",
  "CANCELLED",
]);
const successTransitions: Readonly<
  Record<Exclude<RunStatus, `FAILED_${string}` | "CANCELLED" | "COMPLETED">, RunStatus>
> = {
  CREATED: "CHANGE_PARSED",
  CHANGE_PARSED: "BASELINE_ASSESSED",
  BASELINE_ASSESSED: "CONTEXT_COLLECTING",
  CONTEXT_COLLECTING: "CONTEXT_COLLECTED",
  CONTEXT_COLLECTED: "RISK_DECIDED",
  RISK_DECIDED: "MIGRATION_PLANNED",
  MIGRATION_PLANNED: "PATCH_GENERATED",
  PATCH_GENERATED: "VALIDATING",
  VALIDATING: "VALIDATED",
  VALIDATED: "REVIEW_ARTIFACT_CREATED",
  REVIEW_ARTIFACT_CREATED: "WRITEBACK_PENDING",
  WRITEBACK_PENDING: "COMPLETED",
};
const failureTransitions: Partial<Record<RunStatus, RunStatus>> = {
  CONTEXT_COLLECTING: "FAILED_CONTEXT",
  CONTEXT_COLLECTED: "FAILED_CONTEXT",
  RISK_DECIDED: "FAILED_GENERATION",
  MIGRATION_PLANNED: "FAILED_GENERATION",
  PATCH_GENERATED: "FAILED_GENERATION",
  VALIDATING: "FAILED_VALIDATION",
  VALIDATED: "FAILED_GITHUB",
  REVIEW_ARTIFACT_CREATED: "FAILED_GITHUB",
  WRITEBACK_PENDING: "FAILED_WRITEBACK",
};

function isTerminalRunStatus(status: RunStatus): boolean {
  return terminalStatuses.has(status);
}
function isAdjacentRunStatus(from: RunStatus, to: RunStatus): boolean {
  if (terminalStatuses.has(from)) return false;
  if (to === "CANCELLED") return true;
  return (
    successTransitions[from as keyof typeof successTransitions] === to ||
    failureTransitions[from] === to
  );
}

const eventBaseShape = {
  eventId: eventIdSchema,
  runId: runIdSchema,
  sequence: z.number().int().nonnegative(),
  occurredAt: isoDateTimeSchema,
};
const leaseEventShape = {
  leaseId: leaseIdSchema,
  workerId: workerIdSchema,
  generation: z.number().int().positive().max(1_000_000),
};
const runStatusEventSchema = z
  .object({
    ...eventBaseShape,
    ...leaseEventShape,
    type: z.literal("RUN_STATUS_CHANGED"),
    from: runStatusSchema,
    to: runStatusSchema,
    detail: z.string().min(1).max(500).optional(),
  })
  .strict()
  .refine((event) => isAdjacentRunStatus(event.from, event.to), {
    message: "Invalid run status transition",
    path: ["to"],
  });

const runLeaseAcquiredEventSchema = z
  .object({
    ...eventBaseShape,
    ...leaseEventShape,
    type: z.literal("RUN_LEASE_ACQUIRED"),
    expiresAt: isoDateTimeSchema,
  })
  .strict()
  .refine((event) => new Date(event.expiresAt).getTime() > new Date(event.occurredAt).getTime(), {
    message: "Lease expiry must be after acquisition",
    path: ["expiresAt"],
  });
const runLeaseRenewedEventSchema = z
  .object({
    ...eventBaseShape,
    ...leaseEventShape,
    type: z.literal("RUN_LEASE_RENEWED"),
    previousExpiresAt: isoDateTimeSchema,
    expiresAt: isoDateTimeSchema,
  })
  .strict()
  .refine(
    (event) =>
      new Date(event.expiresAt).getTime() > new Date(event.previousExpiresAt).getTime() &&
      new Date(event.occurredAt).getTime() < new Date(event.previousExpiresAt).getTime(),
    { message: "Renewal must occur before and extend the active lease", path: ["expiresAt"] },
  );
const runLeaseReleasedEventSchema = z
  .object({ ...eventBaseShape, ...leaseEventShape, type: z.literal("RUN_LEASE_RELEASED") })
  .strict();
const runLeaseExpiredEventSchema = z
  .object({
    ...eventBaseShape,
    ...leaseEventShape,
    type: z.literal("RUN_LEASE_EXPIRED"),
    expiredAt: isoDateTimeSchema,
  })
  .strict()
  .refine((event) => event.expiredAt === event.occurredAt, {
    message: "Lease expiry event time must match occurrence",
    path: ["expiredAt"],
  });

export const retryOperationSchema = z.enum([
  "DATAHUB_READ",
  "GENERATION",
  "GITHUB_WRITE",
  "DATAHUB_WRITE",
]);
const runRetryScheduledEventSchema = z
  .object({
    ...eventBaseShape,
    ...leaseEventShape,
    type: z.literal("RUN_RETRY_SCHEDULED"),
    operation: retryOperationSchema,
    attempt: z.number().int().min(1).max(3),
    retryAt: isoDateTimeSchema,
    reason: z.string().min(1).max(500),
  })
  .strict()
  .refine(
    (event) => {
      const retryDelays = [1_000, 5_000, 30_000] as const;
      return (
        new Date(event.retryAt).getTime() - new Date(event.occurredAt).getTime() ===
        retryDelays[event.attempt - 1]
      );
    },
    {
      message: "Retry must use the policy delay for its attempt",
      path: ["retryAt"],
    },
  );

const runEventSchema = z.discriminatedUnion("type", [
  runStatusEventSchema,
  runLeaseAcquiredEventSchema,
  runLeaseRenewedEventSchema,
  runLeaseReleasedEventSchema,
  runLeaseExpiredEventSchema,
  runRetryScheduledEventSchema,
]);
export type RunStatusEvent = z.infer<typeof runStatusEventSchema>;
export type RunEvent = z.infer<typeof runEventSchema>;

const retryStates: Record<z.infer<typeof retryOperationSchema>, readonly RunStatus[]> = {
  DATAHUB_READ: ["CONTEXT_COLLECTING"],
  GENERATION: ["RISK_DECIDED", "MIGRATION_PLANNED"],
  GITHUB_WRITE: ["VALIDATED"],
  DATAHUB_WRITE: ["WRITEBACK_PENDING"],
};

const runEventStreamSchema = z
  .array(runEventSchema)
  .min(1)
  .max(300)
  .superRefine((events, refinement) => {
    const runId = events[0]?.runId;
    const eventIds = new Set<string>();
    let currentStatus: RunStatus = "CREATED";
    let activeLease:
      | { id: string; workerId: string; generation: number; expiresAt: string }
      | undefined;
    const usedLeaseIds = new Set<string>();
    let highestLeaseGeneration = 0;
    const retryAttempts = new Map<string, number>();
    for (const [index, event] of events.entries()) {
      const add = (message: string, field?: string) =>
        refinement.addIssue({ code: "custom", message, path: field ? [index, field] : [index] });
      if (event.runId !== runId) add("Event stream mixes run IDs", "runId");
      if (eventIds.has(event.eventId)) add("Event IDs must be unique", "eventId");
      eventIds.add(event.eventId);
      if (event.sequence !== index) add("Sequence must be contiguous and zero-based", "sequence");
      const previous = events[index - 1];
      if (
        previous &&
        new Date(event.occurredAt).getTime() < new Date(previous.occurredAt).getTime()
      ) {
        add("Event timestamps must be monotonic", "occurredAt");
      }
      if (index > 0 && isTerminalRunStatus(currentStatus))
        add("No event is allowed after terminal state");

      if (event.type === "RUN_STATUS_CHANGED") {
        if (
          !activeLease ||
          activeLease.id !== event.leaseId ||
          activeLease.workerId !== event.workerId ||
          activeLease.generation !== event.generation ||
          new Date(event.occurredAt).getTime() >= new Date(activeLease.expiresAt).getTime()
        ) {
          add("Status transition requires the live active lease and worker");
        }
        if (event.from !== currentStatus)
          add("Status transition does not continue from current state", "from");
        currentStatus = event.to;
        if (isTerminalRunStatus(currentStatus)) activeLease = undefined;
        continue;
      }
      if (event.type === "RUN_LEASE_ACQUIRED") {
        if (activeLease) add("Cannot acquire an overlapping lease");
        if (usedLeaseIds.has(event.leaseId)) add("Lease IDs cannot be reused", "leaseId");
        if (event.generation <= highestLeaseGeneration) {
          add("Lease generation must increase strictly", "generation");
        }
        usedLeaseIds.add(event.leaseId);
        highestLeaseGeneration = Math.max(highestLeaseGeneration, event.generation);
        activeLease = {
          id: event.leaseId,
          workerId: event.workerId,
          generation: event.generation,
          expiresAt: event.expiresAt,
        };
        continue;
      }
      if (
        !activeLease ||
        activeLease.id !== event.leaseId ||
        activeLease.workerId !== event.workerId ||
        activeLease.generation !== event.generation
      ) {
        add("Operational event does not match the active lease and worker");
      }
      if (event.type === "RUN_LEASE_RENEWED") {
        if (
          !activeLease ||
          activeLease.expiresAt !== event.previousExpiresAt ||
          new Date(event.occurredAt).getTime() >= new Date(activeLease.expiresAt).getTime()
        ) {
          add("Lease renewal does not match a live active lease");
        }
        activeLease = {
          id: event.leaseId,
          workerId: event.workerId,
          generation: event.generation,
          expiresAt: event.expiresAt,
        };
      } else if (event.type === "RUN_LEASE_RELEASED") {
        if (
          activeLease &&
          new Date(event.occurredAt).getTime() >= new Date(activeLease.expiresAt).getTime()
        ) {
          add("Expired lease requires an explicit expiry event, not release");
        }
        activeLease = undefined;
      } else if (event.type === "RUN_LEASE_EXPIRED") {
        if (
          !activeLease ||
          new Date(event.expiredAt).getTime() < new Date(activeLease.expiresAt).getTime()
        ) {
          add("Lease cannot expire before its active expiry");
        }
        activeLease = undefined;
      } else {
        if (
          !activeLease ||
          new Date(event.occurredAt).getTime() >= new Date(activeLease.expiresAt).getTime()
        ) {
          add("Retry requires a live matching lease");
        }
        if (!retryStates[event.operation].includes(currentStatus)) {
          add(`Retry ${event.operation} is not valid in ${currentStatus}`, "operation");
        }
        const key = event.operation;
        const previousAttempt = retryAttempts.get(key) ?? 0;
        if (event.attempt !== previousAttempt + 1)
          add("Retry attempts must increase contiguously", "attempt");
        retryAttempts.set(key, event.attempt);
      }
    }
  });
export type RunEventStream = z.infer<typeof runEventStreamSchema>;

/**
 * The only authoritative run-event transition gate. Event shapes alone never authorize mutation.
 * The caller supplies trusted wall-clock time; it must exactly match the persisted event time.
 */
export function authorizeRunEvent(
  currentStreamInput: unknown,
  proposedEventInput: unknown,
  trustedCurrentTime: string,
): RunEventStream {
  const now = isoDateTimeSchema.parse(trustedCurrentTime);
  const structuralCurrent = z.array(runEventSchema).max(300).parse(currentStreamInput);
  const current =
    structuralCurrent.length === 0 ? [] : runEventStreamSchema.parse(structuralCurrent);
  const proposed = runEventSchema.parse(proposedEventInput);
  if (proposed.occurredAt !== now) {
    throw new Error("Proposed event occurrence must match trusted current time");
  }
  return runEventStreamSchema.parse([...current, proposed]);
}
