SELECT
    order_id,
    customer_id,
    order_total,
    ordered_at
FROM {{ source('commerce', 'orders') }}
