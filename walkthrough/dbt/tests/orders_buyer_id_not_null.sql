-- Not-null assertion: buyer_id must be populated for all rows
select *
from {{ ref('stg_orders') }}
where buyer_id is null