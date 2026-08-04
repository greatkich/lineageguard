-- lineageguard:finance-monthly-close
SELECT
    customer_id,
    lifetime_revenue
FROM analytics.customer_revenue
WHERE lifetime_revenue >= 100
ORDER BY lifetime_revenue DESC;
