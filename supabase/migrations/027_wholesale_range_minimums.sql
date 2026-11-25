-- The whole wholesale tobacco range in a store's catalogue, and suppliers' minimum orders.
--
-- add_wholesale_range() puts every wholesale product the store doesn't stock yet into its
-- catalogue, in the category given, named the way the till names them ("WINFIELD OPTIX SKY
-- 20"), costed at the lowest current price per pack, and linked so the tobacco order offers it.
--
-- suppliers.min_order is the least a supplier will deliver, inc GST. The tobacco order moves
-- lines away from a supplier whose share would come in under it.
begin;

alter table suppliers add column min_order numeric(12,2) check (min_order is null or min_order >= 0);

create or replace function add_wholesale_range(b uuid, p_group uuid) returns int
language plpgsql set search_path = public as $$
declare n int;
begin
  if not is_member(b) then
    raise exception 'Not a member of this business';
  end if;
  with wanted as (
    select p.id as product_id,
           upper(p.name || coalesce(' ' || replace(replace(p.size, '20s', '20'), 'g', 'G'), '')) as name,
           min(v.unit_price_inc_gst) as unit_cost
    from wholesale_products p
    join v_wholesale_current_prices v on v.product_id = p.id
    where not exists (select 1 from item_wholesale_products l where l.business_id = b and l.product_id = p.id)
    group by p.id
  ),
  added as (
    insert into stock_items (business_id, name, unit, group_id, unit_cost)
    select b, w.name, 'ea', p_group, round(w.unit_cost, 4) from wanted w
    where not exists (select 1 from stock_items i where i.business_id = b and lower(i.name) = lower(w.name))
    on conflict (business_id, name) do nothing
    returning id, name
  )
  insert into item_wholesale_products (business_id, item_id, product_id)
  select b, a.id, w.product_id from added a join wanted w on w.name = a.name
  on conflict (item_id) do nothing;
  get diagnostics n = row_count;
  return n;
end $$;
revoke all on function add_wholesale_range(uuid, uuid) from public, anon;
grant execute on function add_wholesale_range(uuid, uuid) to authenticated;

commit;
