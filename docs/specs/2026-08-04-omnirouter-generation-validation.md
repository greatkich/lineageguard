# OmniRouter Generation and Executable Validation

Status: approved for P0 implementation

## Outcome

Given the accepted canonical change, DataHub impact context, and deterministic `BLOCK` decision,
LineageGuard asks OmniRouter for one bounded expand–migrate–contract candidate, materializes only
schema-valid artifacts inside an isolated checkout, and independently proves compatibility with an
executable validation receipt. The model generates engineering artifacts; it never decides risk or
declares its own output safe.

## Generation contract

- `@lineageguard/agent` uses the OpenAI Agents SDK for TypeScript with an OpenAI-compatible provider.
- Runtime configuration is explicit: `OPENAI_BASE_URL`, `OPENAI_API_KEY`, and `OPENAI_MODEL`.
- OmniRouter is the primary and only live generator. Missing configuration, transport failure,
  refusal, timeout, or invalid structured output produces a typed generation failure; there is no
  silent deterministic-template fallback.
- One bounded model invocation returns Zod-validated structured output. The agent has no shell,
  filesystem, GitHub, DataHub, network, or policy tools.
- The request contains only the normalized proposed change, deterministic assessment, cited
  evidence, allowed artifact paths/kinds, and explicit compatibility requirements. Metadata,
  SQL, diffs, descriptions, and query text are untrusted quoted data, never instructions.
- The application binds the response to the exact change fingerprint, patch fingerprint,
  deterministic decision, and evidence-ID set before materialization.
- Logs and errors contain provider/request fingerprints and bounded diagnostics, never keys,
  authorization headers, full prompts, or untrusted raw payloads.
- Replay may load only a committed response previously accepted by the same schema and validation
  gates. Replay is explicit and performs no provider call.

## Materialization contract

- `@lineageguard/validation` creates a disposable checkout/worktree below a configured sandbox root.
- Every artifact path, kind, operation, expected base SHA, size, and UTF-8 content is checked before
  a file is created or changed.
- Paths must match the domain allowlist, remain below the checkout after realpath resolution, and
  may not traverse symlinks. Existing files require a matching expected base SHA.
- Patches must be ordinary Git-compatible unified patches and apply with Git's own parser.
- Generated shell command strings are never executed. Validator commands are fixed argument arrays
  selected by application code and run without a shell, with bounded time/output/environment.
- Cleanup affects only the exact disposable checkout created for the run.

## Required validation checks

One receipt covers the exact generated artifact set and records all of these checks:

1. `SQL_MIGRATION` — migration applies to a clean canonical PostgreSQL schema.
2. `BACKFILL_EQUALITY` — old and new columns agree for existing and newly written rows.
3. `DBT_PARSE` — project structure and macros parse.
4. `DBT_COMPILE` — generated models compile against the canonical target.
5. `DBT_TEST` — canonical dbt tests pass.
6. `OLD_CONSUMER_COMPATIBILITY` — the old `customer_id` read path still works.
7. `NEW_CONSUMER_COMPATIBILITY` — the new `buyer_id` read path works and matches.
8. `ROLLBACK` — the explicit rollback artifact executes from the migrated state.

`PASS` requires every check to pass. Any timeout, missing tool, missing artifact, unexpected output,
or incomplete check set fails closed and preserves a bounded diagnostic.

## Required artifacts

- additive SQL migration;
- bounded backfill/compatibility SQL;
- dbt model or migration adjustment;
- dbt tests for old/new compatibility;
- executable rollback SQL;
- migration review document with rollout and contract-removal conditions.

The accepted domain schema remains authoritative for exact paths, kinds, and phases.

## Verification gates

- Unit tests cover provider configuration, request construction, injection-shaped evidence,
  malformed/refused/truncated model output, binding mismatch, log redaction, and explicit replay.
- Materializer tests cover traversal, absolute paths, symlinks, duplicate targets, wrong base SHA,
  oversized output, invalid patch syntax, command injection strings, timeout, and cleanup scope.
- Integration tests validate the canonical generated fixture against disposable PostgreSQL/dbt and
  prove that intentionally broken migration, consumer, and rollback artifacts fail usefully.
- Format, lint, typecheck, unit tests, builds, boundary checks, and focused integration tests pass.

## Integration constraint

Implementation starts only from the accepted `@lineageguard/domain` migration and validation
schemas. It must not weaken, fork, or duplicate those schemas to accommodate provider output.
