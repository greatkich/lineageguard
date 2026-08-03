---
name: lineageguard-submission-readiness
description: Use during LineageGuard feature freeze, deployment, README/examples polish, demo recording, and Devpost submission preparation.
---

# LineageGuard Submission Readiness

## Product proof

Verify that the submission visibly proves:

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
- Architecture and demo documents current.
- `examples/` contains before/after output.
- No secrets, private URLs, or personal data.
- Clean-start verification observed.

## Demo proof

- Under three minutes.
- Functioning product footage, not slides only.
- Captions readable.
- Key transition appears early.
- Every number shown is generated from run state.
- Hosted app and repository URLs work in a logged-out browser.
- Replay is labeled honestly if used.

## Final report

Return blocking issues first, then warnings, then evidence paths. Do not make new feature suggestions after feature freeze unless they fix a judging or reliability blocker.
