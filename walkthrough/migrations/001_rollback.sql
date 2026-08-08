drop trigger orders_customer_buyer_compat on commerce.orders;
drop function commerce.sync_order_customer_buyer();
alter table commerce.orders drop column buyer_id cascade;
do $$ begin
  if not exists (select 1 from information_schema.columns
                 where table_schema = 'commerce' and table_name = 'orders'
                   and column_name = 'customer_id') then
    raise exception 'rollback removed customer_id';
  end if;
  if exists (select 1 from information_schema.columns
             where table_schema = 'commerce' and table_name = 'orders'
               and column_name = 'buyer_id') then
    raise exception 'rollback left buyer_id in place';
  end if;
end $$;