# Canonical Worker Runtime

Status: approved for P0 implementation

## Outcome

One durable worker run turns the canonical repository change into an organization-aware,
validated migration record. The worker is the only component that advances workflow state. The web
application submits commands and renders persisted snapshots; it never invents progress or owns
policy.

The canonical path is:

```text
parse → baseline → collect DataHub context → decide → generate → validate →
publish GitHub review → write back to DataHub
```

## Runtime boundary

- `apps/worker` is a long-running Node.js 24 process. It claims work through the accepted PostgreSQL
  lease protocol and performs no workflow inside a web request handler.
- Every run has an immutable execution mode: `LIVE` or `VERIFIED_REPLAY`.
- Startup validates all configuration required by the selected mode before claiming a run. Missing,
  ambiguous, or contradictory configuration fails closed with redacted diagnostics.
- Adapters are injected behind the accepted domain ports. The worker does not import Next.js UI
  code or raw DataHub MCP response types.
- One claimed lease and generation fence authorizes one step. All persisted events, artifacts,
  receipts, retries, and transitions are bound to that fence.

## Canonical live sequence

1. Parse the exact checked-in rename change and persist the accepted change plus fingerprint.
2. Compute and persist the repository-only deterministic baseline. The canonical baseline is
   `ALLOW` / `LOW`.
3. Create a read-only DataHub MCP session, collect the complete normalized impact context, persist
   typed evidence, and close the session. Mutation tools must never be discoverable in this phase.
4. Recompute the authoritative grounded assessment from the persisted change and complete context.
   The canonical result is `BLOCK` with exact evidence-bound LG001–LG004 reasons.
5. Invoke OmniRouter once for a bounded migration candidate. Persist only a schema-valid candidate
   bound to the exact change, context, assessment, patch, and evidence set.
6. Materialize the candidate in an isolated checkout and execute the exact eight validators. Accept
   `VALIDATED` only from an authenticated execution receipt bound to the run, worktree, artifacts,
   lease generation, command allowlist, and validator outputs.
7. Persist and claim a GitHub effect intent. With explicit policy approval, create or reconcile the
   deterministic branch and draft pull request, then persist the normalized immutable receipt.
8. Persist and claim a separate DataHub mutation intent. With explicit policy approval, save the
   migration decision document and namespaced review-status tag, prove them by read-after-write, and
   persist the normalized immutable receipt.
9. Reach `COMPLETED` only when the accepted validation, GitHub, and DataHub receipts all bind the same
   candidate and run identity.

Each step writes its output and event in one database transaction before the next transition becomes
claimable. A worker crash may repeat reconciliation, but it may not repeat an already proven external
mutation.

## Failure and retry behavior

- Context, generation, validation, GitHub, and DataHub failures map to their exact domain failure
  states; no generic success or silent fallback exists.
- Only domain-authorized transient operations use the exact bounded retry schedule. Policy,
  validation, binding, approval, target, and credential-capability failures are not retried.
- A stale, expired, released, or superseded lease cannot write data or advance state.
- Ambiguous external effects enter `RECONCILIATION_REQUIRED`; they are reconciled against the remote
  deterministic marker before another invocation is allowed.
- Cancellation is persisted and prevents further claims. Terminal runs are immutable.

## Verified replay

- Replay consumes one committed run envelope exported from a successful live run. The envelope
  contains normalized domain records, immutable events, artifact content and fingerprints,
  authenticated validation provenance, and normalized external receipts.
- The envelope manifest binds its schema version, source run ID, source commit, exporter version,
  complete content fingerprint, redaction method, and signature/attestation verification data.
- Import verifies the full envelope before creating a replay run. A partial, unsigned, mismatched,
  synthetic, or structurally valid but unauthenticated envelope is rejected.
- Replay performs zero OmniRouter, DataHub, GitHub, or validator calls. Its UI provenance is always
  distinguishable from live execution while preserving the original verified facts.
- Without an accepted live envelope the product may show the candidate contract and pending state,
  but may not show `SAFE WITH MIGRATION`, successful external receipts, or `COMPLETED`.

## Web command and query boundary

- The launcher accepts only the canonical scenario ID and explicit execution mode. Unknown fields,
  run IDs, modes, and state overrides fail closed.
- A run-create command is idempotent by canonical request fingerprint and returns the persisted run
  ID; it never executes the workflow inline.
- Run queries return one domain-validated snapshot containing current status, immutable event stream,
  normalized evidence, decisions, candidate, validation provenance, effect intents, and receipts.
- Polling is sufficient for P0. The UI derives status, elapsed time, completed steps, counts, and
  visible receipts only from the returned snapshot.
- Production external mutations require a separately persisted, expiring human approval scoped to
  the exact run, effect kind, target, and input fingerprint. Approval cannot be inferred from route
  state or replayed for changed input.

## Configuration and observability

- Live credentials are separate and least privilege: DataHub read, DataHub mutation, GitHub, and
  OmniRouter credentials are never interchangeable.
- Secret values are never persisted in run input, events, receipts, logs, traces, fixtures, or HTTP
  responses.
- Logs contain run ID, step, lease generation, safe error code, retryability, duration, and semantic
  fingerprints. Bounded untrusted content is never logged verbatim.
- Readiness reports dependency availability without exposing configuration values. A dependency
  becoming unavailable fails the affected step without changing prior evidence.

## Verification gates

- Unit tests cover orchestration order, authoritative bindings, forbidden shortcuts, stale fencing,
  failure mapping, retry classification, redaction, cancellation, and terminal immutability.
- Integration tests use real PostgreSQL and contract adapters to prove crash recovery, concurrent
  workers, event/snapshot reconstruction, effect ambiguity, and exactly-once completion semantics.
- Replay tests prove full envelope verification and zero provider, validator, GitHub, and DataHub
  calls; synthetic PASS data cannot create a safe state.
- Web route tests prove create/query idempotency, malformed-input rejection, approval scoping, and
  that direct URL parameters cannot advance a run.
- A focused live gate proves the canonical sequence against the disposable PostgreSQL/DataHub graph,
  OmniRouter, executable validators, a configured GitHub repository, and controlled DataHub
  write-back.
- Format, lint, typecheck, unit/integration tests, builds, browser tests, package boundaries, and the
  one-command walkthrough verification pass before merge.

## Integration constraint

The worker consumes accepted domain, database, DataHub, agent, validation, GitHub, and write-back
contracts. It does not weaken or duplicate their policies. If a required accepted receipt or adapter
is unavailable, the run remains in its last proven state.
