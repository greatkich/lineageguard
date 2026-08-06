-- Canonical LineageGuard walkthrough scenario: unsafe warehouse rename.
-- Renames commerce.orders.customer_id to buyer_id. Repository-only checks pass;
-- DataHub reveals downstream data consumers (dbt marts, dashboard, ML model, ad-hoc
-- query) that make this an unsafe breaking change without a compatible migration.
ALTER TABLE commerce.orders RENAME COLUMN customer_id TO buyer_id;
