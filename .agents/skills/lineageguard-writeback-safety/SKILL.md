---
name: lineageguard-writeback-safety
description: Use for any LineageGuard implementation or review that enables DataHub metadata mutations, GitHub writes, generated patch application, or other external side effects.
---

# LineageGuard Write-Back Safety

## Invariants

- Read and mutation tools are separated.
- Mutation is disabled by default.
- Production mode requires explicit approval.
- Every side effect has a stable idempotency key.
- Every successful side effect returns and persists a receipt.
- Retries cannot duplicate tags, documents, comments, branches, or PRs.
- Generated patches are applied only in an isolated workspace.
- No arbitrary model-generated shell command is executed.

## Review workflow

1. Identify the trust boundary and credential used.
2. Verify least-privilege permissions.
3. Verify tool and command allowlists.
4. Verify input normalization and schema validation.
5. Verify approval behavior in production mode.
6. Verify idempotent retry and partial-failure recovery.
7. Verify secret redaction in logs, traces, fixtures, screenshots, and errors.
8. Verify that a failed write-back cannot mark the run fully complete.
9. Run the relevant security and threat-model skills.
10. Record observed test commands and receipts.
