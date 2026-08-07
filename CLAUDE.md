# LineageGuard — CLAUDE.md

## Project context
- Monorepo: pnpm 11.20+, Node 24+, TypeScript
- DataHub OSS via official MCP adapter (stdio)
- One canonical scenario: `customer_id → buyer_id` rename

## Rules
- If something doesn't work — it's our problem, regardless of whether it's a code bug or configuration issue. Fix it end-to-end.
- Never dismiss a problem as "tool-specific configuration" or "infrastructure issue". Achieve a working result.
- Do NOT add Co-Authored-By: Claude to commits.
- Push all changes to main directly (unless told otherwise).
- Fail-closed: demo must exit 0 only on full COMPLETED.

## CRITICAL — Code size and reuse

Full rules live in `AGENTS.md`. Summary:

- **No class exceeds 300 lines.** Scoped to classes, not files. Markdown, plans, specs, fixtures, generated output, migrations, and schema-only modules are exempt.
- **No function exceeds 50 lines.** Max 5 positional parameters; max 4 nesting levels.
- **Grandfathered:** `LiveGitHubPort` (702) and `InternalValidationSecurityBoundary` (370) may be modified but must not grow. No new class joins that list.
- **Never hand-roll** what a library provides: Zod for validation, `node:crypto` for hashing, `AbortController` for cancellation, `fetch`/`URL` for HTTP. Search the repo, then installed deps, before writing a utility.
- New dependencies: exact pinned version, recorded in `docs/SOURCES.md`, justified in the task report.

## DataHub bootstrap chain
Full sequence to populate the graph:
1. `warehouse-seed --execute` — creates schemas, tables, roles, scenario_registry
2. `dbt-build --execute` — runs dbt build, generates manifest + catalog
3. `ingest --execute` — postgres + dbt ingestion into DataHub
4. `metadata-seed --execute` — glossary, owners, dashboards, ML models, queries, lineage

Each step requires a receipt from the previous one. If verify breaks — fix verify, don't bypass.

Env for bootstrap: `LINEAGEGUARD_WALKTHROUGH_ENV=canonical LINEAGEGUARD_SKIP_SERVER_IDENTITY=1 LINEAGEGUARD_POSTGRES_MODE=local`

## Current blocker (2026-08-06)
`verify_dbt_relations` in `tools/datahub/src/lineageguard_datahub/warehouse.py:303` — array comparison failed due to element ordering in `array_agg`. dbt models are actually created in DB but verify returned false. Fixed with DISTINCT + subquery ORDER BY.
