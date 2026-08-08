# Migration: customer_id → buyer_id

## Strategy: Expand-Migrate-Contract

### Phase 1: Expand
- Add `buyer_id` column with sync trigger
- Both columns remain accessible

### Phase 2: Migrate
- Update dbt models to expose both columns
- Add compatibility and not-null tests

### Phase 3: Contract
- After compatibility window (30 days), deprecate `customer_id`

## Rollback Plan
Run `walkthrough/migrations/001_rollback.sql` while `customer_id` remains the source of truth.

## Compatibility Window: 30 days

## Required Reviewers
- urn:li:corpGroup:lineageguard-canonical.finance-analytics (owner of urn:li:dashboard:(looker,lineageguard-canonical.finance-revenue-dashboard), urn:li:dataset:(urn:li:dataPlatform:postgres,lineageguard-canonical.lineageguard.analytics.customer_revenue,PROD))
- urn:li:corpGroup:lineageguard-canonical.risk-ml (owner of urn:li:mlModel:(urn:li:dataPlatform:mlflow,lineageguard-canonical.fraud-model-v3,PROD))