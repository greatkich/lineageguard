SELECT
    customer_id,
    COUNT(*) AS order_count,
    MAX(order_total) AS max_order_total
FROM {{ ref('stg_orders') }}
GROUP BY customer_id
