-- Source change: the unsafe ALTER TABLE that triggers LineageGuard
ALTER TABLE commerce.orders RENAME COLUMN customer_id TO buyer_id;
