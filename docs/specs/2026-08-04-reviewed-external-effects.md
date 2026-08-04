# Reviewed External Effects

Status: approved for P0 implementation

## Outcome

After a canonical migration has a complete passing validation receipt, LineageGuard creates one
reviewable GitHub artifact and records the verified decision back to the affected DataHub entity.
Both effects are gated, idempotent, observable, and recoverable. Neither adapter can weaken policy,
skip validation, merge code, or turn a failed run into success.

## Shared effect protocol

- The worker derives a stable idempotency key from run ID, effect kind, exact target, and input
  fingerprint.
- It persists an effect intent before invoking an adapter. A successful response is normalized and
  attached to that intent in a transaction; retries reconcile remote state before creating anything.
- Reusing a key with different input is a conflict. A persisted success is returned without another
  network mutation.
- Every request has a bounded timeout, retry classification, and redacted structured diagnostic.
- Production mutations require an explicit recorded human approval scoped to the run and effect.
- Replay adapters read committed validated receipts and make zero network calls.
- The final run cannot reach `COMPLETED` without successful GitHub and DataHub receipts matching the
  validated candidate fingerprint.

## GitHub boundary

`@lineageguard/github` exposes a narrow `GitHubPort` with live and replay implementations.

The live P0 adapter may:

1. verify repository identity, base branch, base commit, and credential capabilities;
2. create blobs/tree/commit containing only the validated artifact set;
3. create or reconcile one deterministic `lineageguard/<run-id>` branch without force push;
4. create or reconcile one draft pull request whose body links deterministic reasons, evidence IDs,
   artifact fingerprint, validation receipt, and rollout/rollback steps;
5. return a normalized receipt with repository, base/head SHAs, PR number/URL/state, and timestamps.

It may not merge, approve, dismiss reviews, modify unrelated files, delete branches, publish releases,
change repository settings, or write to a base branch. Credentials use only metadata read, contents
write, and pull-request write permissions for the one configured repository. Repository/owner/base
allowlists are mandatory and redirects to another host are rejected.

## DataHub write-back boundary

The mutation adapter is separate from the read-only context collector and starts disabled. It uses
dedicated mutation configuration and exposes only the approved document/tag operations needed by the
canonical workflow.

After validation and GitHub receipt binding, it may:

1. re-read the exact affected entity and verify the scenario marker and expected current version;
2. save a concise migration decision document containing the decision, reason/evidence IDs, validated
   artifact fingerprint, GitHub review link, and rollback reference;
3. add a namespaced LineageGuard review-status tag without removing existing metadata;
4. re-read the entity and prove both writes before returning a normalized receipt.

It may not mutate lineage, schema, ownership, glossary, lifecycle, assertions, or unrelated entities.
The target URN must equal the run's resolved canonical source URN and pass the immutable allowlist.

## Failure and recovery

- Transport ambiguity triggers remote reconciliation by deterministic branch/PR marker or DataHub
  document/tag marker before retry.
- Permission, target, policy, approval, or fingerprint mismatch fails closed and is not retried.
- Partial GitHub or DataHub work remains visible in the effect intent with a bounded recovery state.
- A GitHub failure maps to `FAILED_GITHUB`; a write-back failure maps to `FAILED_WRITEBACK`.
- Receipts never contain tokens, authorization headers, raw provider payloads, or untrusted HTML.

## Verification gates

- Contract tests cover live HTTP request shapes and normalized responses using recorded API fixtures.
- Negative tests cover wrong repository/URN, missing approval, invalid validation binding, redirect,
  permission denial, timeout-after-success reconciliation, key conflict, secret redaction, and replay
  network prohibition.
- A sandbox repository proves branch/commit/draft-PR creation without merge or base modification.
- A disposable canonical DataHub instance proves document/tag write-back and read-after-write.
- Format, lint, typecheck, unit/contract tests, builds, and boundary checks pass.

## Integration constraint

Adapters consume accepted domain contracts and the durable run-store effect protocol. They do not own
run-state transitions, validation policy, approval policy, or final completion semantics.
