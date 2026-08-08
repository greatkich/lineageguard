# Test-fixture renders — not golden evidence

Screenshots here come from `tests/e2e/mission-control.spec.ts`, which seeds a deterministic fixture
run so the UI can be exercised without live DataHub, GitHub, Docker, or LLM infrastructure. They
exist for UI regression review in CI.

They are **not** submission evidence and must not be presented as demo readiness: the run they
render (`run_e2efixture000000000000001`) is a fixture, not a live execution.

Golden recording evidence is captured by `tests/e2e/golden-recording.spec.ts` from a real LIVE run,
driven by `pnpm demo:golden -- --runId <live-run-id>`, and written to
`artifacts/demo-readiness/screenshots/` together with a `manifest.json` naming that exact run.
