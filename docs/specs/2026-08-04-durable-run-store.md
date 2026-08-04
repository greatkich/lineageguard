# Durable Run Store

Status: approved for P0 implementation

## Outcome

Persist each LineageGuard run as an inspectable PostgreSQL state machine. A worker can claim one
available run, renew a fenced lease, append immutable events, and recover after process failure.
The web application can reconstruct the exact run from persisted facts, including evidence,
decisions, generated artifacts, validation results, and external-effect receipts.

## Scope

- `@lineageguard/db` owns migrations, connection lifecycle, transactions, and repositories.
- PostgreSQL stores runs, immutable ordered events, evidence bundles, assessments, migration
  candidates, validation receipts, and external-effect intents/receipts.
- A run transition atomically checks the expected state and active lease, updates the run, and
  appends exactly one event.
- Workers claim due non-terminal runs with `FOR UPDATE SKIP LOCKED` and a unique fencing token.
- Lease renewal and release require the current token; a stale worker cannot mutate the run.
- External writes use a unique idempotency key and persist intent before an adapter is invoked.
- JSON payloads are validated by domain schemas at the application boundary; the database also
  enforces structural, ordering, uniqueness, and timestamp constraints where practical.
- Migrations are forward-only and safe to run repeatedly through a migration ledger.

## Explicit exclusions

- No Redis, workflow engine, scheduler, ORM, or second database abstraction.
- No external GitHub or DataHub call from the database package.
- No policy evaluation, model invocation, or UI-derived progress in persistence code.
- No autonomous merge or generic multi-scenario queue.

## Required behavior

1. Creating the same scenario request with the same request key returns the existing run.
2. Two workers racing to claim work cannot both receive the same active lease.
3. An expired lease can be reclaimed with a new fencing token; the old token is rejected.
4. Event sequences are contiguous per run and events cannot be edited or deleted through the API.
5. A transition with the wrong expected state, version, or lease fails without a partial write.
6. Persisted payload reads are parsed with their domain schemas and fail closed on corrupt data.
7. External-effect intent and successful receipt are idempotent; conflicting reuse of a key fails.
8. A run snapshot includes all persisted records in deterministic order for replay/UI use.

## Verification gates

- Unit tests cover configuration, identifiers, transition validation, and error mapping.
- PostgreSQL integration tests cover migrations, concurrent claims, fencing, atomic transitions,
  immutable event ordering, idempotent receipts, corrupt payload rejection, and reconstruction.
- Format, lint, typecheck, unit tests, package build, and the repository boundary checker pass.
- Integration tests use an explicit disposable local database URL and never target a remote host.

## Integration contract

The implementation may initially land behind `@lineageguard/db` exports while the domain branch is
under review. Before integration, it must consume the accepted `@lineageguard/domain` schemas and
must not duplicate run-state or receipt policy.
