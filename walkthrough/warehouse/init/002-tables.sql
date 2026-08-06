CREATE TABLE IF NOT EXISTS commerce.orders (
    order_id uuid PRIMARY KEY,
    customer_id uuid NOT NULL,
    order_total numeric(12, 2) NOT NULL CHECK (order_total >= 0),
    ordered_at timestamptz NOT NULL
);

COMMENT ON TABLE commerce.orders IS
    'Orders Data Product (Commerce Warehouse). Analytical warehouse table derived from the '
    'Orders Service via CDC/event ingestion. This is NOT the Orders Service operational (OLTP) '
    'database; the OLTP database is out of scope for LineageGuard. Domain: Commerce Analytics.';
