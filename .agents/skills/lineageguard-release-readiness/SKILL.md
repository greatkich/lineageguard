---
name: lineageguard-release-readiness
description: Use during LineageGuard feature freeze, deployment, README/examples polish, walkthrough walkthrough, and release checklist release preparation.
---

# LineageGuard Release Readiness

## Product proof

Verify that the release visibly proves:

- repository-only baseline is safe/low risk;
- DataHub reveals hidden organizational consumers;
- the deterministic decision changes to block;
- the agent generates real migration artifacts;
- validators pass;
- a review artifact exists;
- the decision is written back to DataHub.

## Repository proof

- Public repository.
- Apache 2.0 license visible.
- Complete setup instructions.
- Architecture and walkthrough documents current.
- `examples/` contains before/after output.
- No secrets, private URLs, or personal data.
- Clean-start verification observed.

## Walkthrough proof

- Under the walkthrough window.
- Functioning product footage, not slides only.
- Captions readable.
- Key transition appears early.
- Every number shown is generated from run state.
- Hosted app and repository URLs work in a logged-out browser.
- Replay is labeled honestly if used.

## Final report

Return blocking issues first, then warnings, then evidence paths. Do not make new feature suggestions after feature freeze unless they fix a review or reliability blocker.
