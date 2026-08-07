SELECT
    customer_id,
    buyer_id,
    SUM(order_total) AS lifetime_revenue
FROM {{ ref('stg_orders') }}
GROUP BY customer_id, buyer_id