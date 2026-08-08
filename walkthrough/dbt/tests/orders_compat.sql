-- Compatibility test: customer_id and buyer_id must always match
select *
from {{ ref('stg_orders') }}
where customer_id is distinct from buyer_id