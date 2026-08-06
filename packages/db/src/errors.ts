export class RunStoreError extends Error {}
export class ConfigurationError extends RunStoreError {}
export class IdempotencyConflictError extends RunStoreError {}
export class LeaseConflictError extends RunStoreError {}
export class StateConflictError extends RunStoreError {}
export class CorruptDataError extends RunStoreError {}
export class NotFoundError extends RunStoreError {}

interface PostgresErrorLike {
  code?: string;
  constraint?: string;
  message?: string;
}

export function mapPostgresError(error: unknown): Error {
  if (error instanceof RunStoreError) return error;
  const pg = error as PostgresErrorLike;
  if (pg.code === "23505") return new IdempotencyConflictError(pg.message ?? "unique conflict");
  if (pg.code === "23514" || pg.code === "23P01") {
    return new StateConflictError(pg.message ?? "database constraint rejected the operation");
  }
  return error instanceof Error ? error : new RunStoreError("unknown database error");
}
