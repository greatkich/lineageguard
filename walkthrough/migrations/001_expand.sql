alter table commerce.orders add column buyer_id uuid;
update commerce.orders set buyer_id = customer_id;
create function commerce.sync_order_customer_buyer() returns trigger language plpgsql as $$
begin
  if tg_op = 'INSERT' then
    if new.buyer_id is null and new.customer_id is not null then
      new.buyer_id := new.customer_id;
    elsif new.customer_id is null and new.buyer_id is not null then
      new.customer_id := new.buyer_id;
    elsif new.customer_id is null and new.buyer_id is null then
      raise exception 'at least one identifier must be provided';
    elsif new.customer_id is distinct from new.buyer_id then
      raise exception 'customer_id and buyer_id must match during compatibility window';
    end if;
  elsif tg_op = 'UPDATE' then
    if new.customer_id is distinct from old.customer_id and new.buyer_id is not distinct from old.buyer_id then
      new.buyer_id := new.customer_id;
    elsif new.buyer_id is distinct from old.buyer_id and new.customer_id is not distinct from old.customer_id then
      new.customer_id := new.buyer_id;
    elsif new.customer_id is distinct from old.customer_id and new.buyer_id is distinct from old.buyer_id then
      if new.customer_id is distinct from new.buyer_id then
        raise exception 'customer_id and buyer_id must match during compatibility window';
      end if;
    end if;
  end if;
  return new;
end $$;
create trigger orders_customer_buyer_compat
  before insert or update on commerce.orders
  for each row execute function commerce.sync_order_customer_buyer();
alter table commerce.orders alter column buyer_id set not null;