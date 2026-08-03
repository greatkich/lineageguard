---
name: lineageguard-impact-analysis
description: Use when implementing or reviewing DataHub entity resolution, lineage/query context collection, evidence normalization, or deterministic schema-change risk decisions for LineageGuard.
---

# LineageGuard Impact Analysis

## Required context

Read:

- `docs/PRODUCT_VISION.md`
- relevant sections of `docs/ARCHITECTURE.md`
- `AGENTS.md`

Use the official DataHub skills when interacting with a live catalog.

## Workflow

1. Identify the exact proposed dataset and field change.
2. Resolve the DataHub entity and field unambiguously.
3. Collect schema, downstream lineage, exact critical paths, query history, entity details, owners, semantic metadata, and quality/lifecycle signals.
4. Convert every external result into a typed domain evidence item.
5. Deduplicate evidence and preserve stable provenance/fingerprints.
6. Evaluate deterministic policy rules; do not ask the LLM for the final verdict.
7. Ensure every risk reason cites one or more evidence IDs.
8. Test success, empty, ambiguous, partial, timeout, and malformed-response paths.

## Review checklist

- Raw MCP shapes do not leak outside the adapter.
- Read context does not expose mutation tools.
- Empty lineage is distinguished from a failed lineage call.
- Field-level and asset-level evidence are not conflated.
- Query evidence records its source and recency when available.
- Production model/dashboard criticality is explicit.
- The canonical fixture changes `ALLOW` to `BLOCK`.
- No risk score or metric is invented by the model.
