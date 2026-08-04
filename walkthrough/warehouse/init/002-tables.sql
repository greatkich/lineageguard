CREATE TABLE IF NOT EXISTS commerce.orders (
    order_id uuid PRIMARY KEY,
    customer_id uuid NOT NULL,
    order_total numeric(12, 2) NOT NULL CHECK (order_total >= 0),
    ordered_at timestamptz NOT NULL
);

GRANT USAGE ON SCHEMA commerce, analytics, fraud TO lineageguard_reader;
GRANT SELECT ON commerce.orders TO lineageguard_reader;
GRANT pg_read_all_stats TO lineageguard_reader;
