# Branch Integration Report

## Recorded: 2026-08-07T14:38:00Z

### Branch state
- main HEAD (pre-integration): 290ce411bfd5372e82063fea9f1f8ca861d36442
- Working branch HEAD (pre-integration, == main): f04bf6c98efee6cba0776d0d249b098d2734ba45
- PR #4 (fix/data-platform-boundary): ff45fe97cc7d3685061c290d12532c3558ee40b8
- PR #5 (fix/query-ownership-and-lineage-reconciliation): 8ed22063202b002333d44bd191c89484b2551739
- PR #3 (demo/canonical-customer-id-rename): 1be5ee50f14ba2d31122dc8d21e71eb516a2bf78

### Divergence from main
- PR #4: 25 (main-only) / 5 (PR #4-only) commits
- PR #5: 25 (main-only) / 9 (PR #5-only) commits

### PR #5 commits to integrate (superset of PR #4)
```
8ed2206 fix(tools): ingestion table_pattern, seed entity_exists, query hash stability
fc6108b fix(datahub): align MCP contract schemas with live DataHub v0.6.0 responses
fed7ee4 feat(datahub): deterministic UpstreamLineage reconciliation for metadata-seed
213829f fix(datahub): remove Query ownership; route review via analytics.customer_revenue owner
ff45fe9 style: apply Biome formatting to pre-existing formatting debt
663bdac feat(web): use warehouse schema change / data consumer terminology in Mission Control
567e044 fix(datahub): remove duplicate dbt source, fix sslmode config, grant query-role schema visibility
03c4ba1 feat(datahub): add Commerce Analytics domain and owner/tags for commerce.orders
44f8916 docs: add ADR-003 and clarify LineageGuard data-platform boundary
```

### Integration decisions

Cherry-picked oldest-first: `44f8916 03c4ba1 567e044 663bdac ff45fe9 213829f fed7ee4 fc6108b 8ed2206`

| Commit | New SHA | Result | Notes |
|---|---|---|---|
| `44f8916` docs: add ADR-003 and clarify LineageGuard data-platform boundary | `cac90c5` | ACCEPTED_UNCHANGED | Applied cleanly. |
| `03c4ba1` feat(datahub): add Commerce Analytics domain and owner/tags for commerce.orders | `6a309f0` | ACCEPTED_UNCHANGED | Applied cleanly. |
| `567e044` fix(datahub): remove duplicate dbt source, fix sslmode config, grant query-role schema visibility | `ce9953f` | ACCEPTED_UNCHANGED | Applied cleanly. |
| `663bdac` feat(web): use warehouse schema change / data consumer terminology in Mission Control | `39592c8` | ACCEPTED_WITH_CONFLICT_RESOLUTION | Conflicted with PR #6's `deriveImpactConsumers`/`ImpactConsumer` refactor in `apps/web/app/page.tsx` and `apps/web/app/runs/[runId]/page.tsx`. Kept PR #6's structure (shared domain-derived `deriveImpactConsumers`, `ImpactConsumer` type, `biome-ignore` array-index-key comment) and layered PR #5's terminology intent on top: "Warehouse schema change safety analysis...", "Each warehouse schema change passes through these stages", "Downstream Data Consumers (N)", "Data Consumers" stat label, and "downstream data consumer(s)" copy in the completion banner. Also updated `packages/agent/src/steps/derive-impact-cards.test.ts` (net-new test file from this commit) to match the actual `ImpactConsumer` union kinds (`DATA_MODEL`/`DASHBOARD`/`ML_CONSUMER`/`UNMANAGED_QUERY`) and the `evidenceIds` field (was `evidenceId`) exposed by `@lineageguard/domain`, since the original test targeted a shape that predated PR #6's shared-domain refactor. |
| `ff45fe9` style: apply Biome formatting to pre-existing formatting debt | (none — empty, skipped) | PARTIALLY_ACCEPTED | Formatting-only commit. Most target files (`apps/worker/src/index.ts`, `apps/worker/src/orchestration.ts`, `packages/db/src/simple-runs.ts`) had already been substantially rewritten by later PR #6 work (source-PR SourceChange handling, read/mutation token separation, source-PR metadata persistence) with equivalent-or-better Biome formatting already applied — kept `--ours` (main's version) for those. `apps/web/components/ui/icons.tsx` conflicted only on an `aria-hidden="true"` attribute already present on main; kept `--ours`. `packages/agent/src/steps/generate-patch.ts` and `tests/e2e/canonical-scenario.vitest.ts` were deleted on main by later dead-code-removal commits (`4e2fba1`, superseded by `f8fffab`); resolved as deletions (`git rm`) rather than resurrecting dead/superseded files. After resolving, the cherry-pick had no remaining diff and was skipped (`git cherry-pick --skip`) — its formatting intent is already satisfied by main. |
| `213829f` fix(datahub): remove Query ownership; route review via analytics.customer_revenue owner | `290dfdf` | ACCEPTED_UNCHANGED | Applied cleanly. |
| `fed7ee4` feat(datahub): deterministic UpstreamLineage reconciliation for metadata-seed | `b92be56` | ACCEPTED_UNCHANGED | Applied cleanly. |
| `fc6108b` fix(datahub): align MCP contract schemas with live DataHub v0.6.0 responses | `2847136` | PARTIALLY_ACCEPTED | Applied cleanly via cherry-pick, but this commit introduced `observePathBetweenOrEmpty` — a synthetic-evidence wrapper in `packages/datahub/src/canonical-reader.ts` that fabricates a fake `RawToolInvocation` (`invocationId: "synthetic_empty_path"`, `responseFingerprint` of all zeros) when the live MCP server returns `TOOL_FAILURE` for the mlModel fraud-entity lineage path. Per Task 1 instructions and the project's zero-synthetic-evidence rule, this function and its call site were removed immediately after the cherry-pick landed. The `fraudEntityPath` observation now reverts to the original truthful `observe()` call, which is expected to fail against a live mlModel entity (it doesn't support `UpstreamLineage`) until Task 3 replaces it with a `TrainingData`-aspect reader. A `// TODO: Task 3 implements truthful ML proof via TrainingData aspect reader.` comment was left at the call site. All other schema-alignment fixes in this commit (search/query page count semantics, `get_entities` `{result: [...]}` wrapper handling, canonical-normalizer UUID/glossary/type relaxations, LLM step-description truncation) were kept as-is. |
| `8ed2206` fix(tools): ingestion table_pattern, seed entity_exists, query hash stability | `e95336f` | ACCEPTED_UNCHANGED | Applied cleanly. |

### observePathBetweenOrEmpty removal
- Introduced by: `fc6108b` (new SHA `2847136`).
- Removed: yes, immediately after cherry-pick, before running the build/test verification pass.
- Call site (`fraudEntityPath` in `collectCanonicalObservations`, `packages/datahub/src/canonical-reader.ts`) reverted to the original `observe(invoker, "get_lineage_paths_between", ...)` call with a `// TODO: Task 3 implements truthful ML proof via TrainingData aspect reader.` comment.
- Confirmed no other references to `observePathBetweenOrEmpty`, `synthetic_empty_path`, or `syntheticInvocation` remain anywhere in the tree (`grep -rn` across the repo returns no matches).
- Expected consequence: `collectCanonicalObservations` will now throw when the live mlModel fraud-entity path lookup returns `TOOL_FAILURE` ("No lineage found"). This is expected per Task 1 scope; Task 3 is responsible for the truthful replacement.

### Verification
- `pnpm install`: up to date, exit 0.
- `pnpm build`: exit 0 (all 9 workspace packages + apps/worker + apps/web built successfully).
- `pnpm typecheck`: exit 0 (all packages clean).
- `pnpm test`: exit 0 — 423 tests total, 389 passed, 34 skipped, 0 failed (plus 19 passing Node-native boundary/vendoring tests and the dependency-boundary checker).
- `pnpm format:check`: exit 0 after auto-fixing 2 pre-existing formatting issues surfaced by Biome in `packages/datahub/src/canonical-normalizer.ts` and `packages/datahub/src/official-contract.ts` (both unrelated to the cherry-picked content — long-line wrapping the current Biome version now prefers).
- `pnpm lint`: exit 0 (46 warnings / 3 infos, all pre-existing in `packages/agent/src/pipeline.ts`, `build-canonical-candidate.ts`, etc. — confirmed present in `f04bf6c` prior to this integration; no new lint findings introduced by the cherry-picks).

### PR #3 verification
`git log --oneline origin/demo/canonical-customer-id-rename ^origin/main` shows exactly:
```
1be5ee5 warehouse: rename commerce.orders.customer_id to buyer_id
```
PR #3 remains untouched and unmerged.
