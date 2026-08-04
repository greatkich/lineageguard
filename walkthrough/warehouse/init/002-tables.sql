CREATE TABLE IF NOT EXISTS commerce.orders (
    order_id uuid PRIMARY KEY,
    customer_id uuid NOT NULL,
    order_total numeric(12, 2) NOT NULL CHECK (order_total >= 0),
    ordered_at timestamptz NOT NULL
);
