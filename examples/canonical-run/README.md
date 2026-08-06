# Examples: Canonical Run

This directory contains the structure for a canonical LineageGuard run.
After executing a successful live run, populate these files with redacted
artifacts for submission evidence.

## Structure

```
canonical-run/
  manifest.json              — ties all fingerprints together
  source-change.sql          — the ALTER TABLE statement
  generated-artifacts/       — generated migration files (after live run)
```

## How to populate

1. Run `pnpm demo` with all services configured
2. Copy redacted ImpactContext, RiskComparison, and receipts here
3. Update `manifest.json` fingerprints from the run output
