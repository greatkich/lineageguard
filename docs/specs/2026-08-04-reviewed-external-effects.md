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

### Trusted reservation handoff

An adapter request is never its own validation or approval authority. The durable run store mints a
one-time opaque reservation token, retains only its hash, and binds it to the exact run, effect kind,
target, idempotency key, intent, input, validation-receipt, and approval fingerprints. The GitHub
adapter computes the complete canonical effect fingerprint from bounded request fields and verifies
it through an injected authority before network access. After read-only preflight proves the exact
base commit and request-bound base blob identities, it atomically consumes that same fingerprint
immediately before the first write. Consume returns a bounded `invokeBy` deadline and attempt fence.
A missing, forged, expired, reused, or differently bound reservation fails before mutation.

The raw token never enters the public GitHub request DTO. The injected trusted-authority adapter
closes over the opaque verified capability and presents the raw token to the durable store internally;
the GitHub port supplies only the non-secret reservation ID and canonical fingerprint.

The adapter strictly bounds and snapshots the request before its first await, uses only that immutable
snapshot, and recomputes the canonical fingerprint immediately before consume. Authority verify and
consume calls receive abort signals and hard deadlines; malformed verification fails before network,
while a missing or malformed consume acknowledgement is treated as ambiguous because atomic consume
may already have succeeded.

The canonical GitHub payload binds the exact `https://api.github.com` host, owner/repository, base
branch and SHA, deterministic head branch, every artifact path and `CREATE | MODIFY` operation,
expected base blob SHA for modifications, materialized SHA-256, exact pull-request title/body, and all
intent, candidate, artifact-set, validation, and approval fingerprints.

## GitHub boundary

`@lineageguard/github` exposes a narrow live `GitHubPort`. Replay remains unavailable from the
production package root until the repository contains an authenticated, verified live receipt
fixture; an internal parser may stage its bounded target-binding checks without establishing trust.

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
- A GitHub POST is sent at most once. After any POST timeout, transport error, or ambiguous response,
  the adapter performs bounded read-only reconciliation and never resends that POST. If exact
  branch/tree/commit/PR state cannot be proven, the durable outcome remains `TRANSPORT_AMBIGUOUS`.
  A resumed consumed reservation reconciles first and cannot initiate another POST.
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
