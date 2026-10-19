-- More than one supplier per product, each with its own carton.
--
-- A product can be bought from several suppliers (Campbells and The Distributors both sell
-- Red Bull), and each sells it in its own carton: Up&Go comes 8 to a carton from one and 12
-- from the other. item_suppliers records who sells what, the carton size, their own item code
-- and where the product sits in that supplier's order list. stock_items.supplier_id stays as
-- the usual (preferred) supplier.
--
-- Prices aren't typed in: each supplier's price is the last one paid to them, read from orders.
begin;

create table item_suppliers (
  business_id uuid not null references businesses(id),
  item_id uuid not null references stock_items(id) on delete cascade,
  supplier_id uuid not null references suppliers(id) on delete cascade,
  pack_size int not null default 1 check (pack_size > 0),   -- units in this supplier's carton
  supplier_code text,                                       -- their item number, for matching invoices
  sort int not null default 0,                              -- position in their order list
  created_at timestamptz not null default now(),
  primary key (item_id, supplier_id)
);
create index on item_suppliers (business_id);
create index on item_suppliers (supplier_id);

alter table item_suppliers enable row level security;
create policy "members read write" on item_suppliers for all to authenticated
  using (is_member(business_id)) with check (is_member(business_id));

-- Every product's usual supplier, in the order it was arranged for them…
insert into item_suppliers (business_id, item_id, supplier_id, sort)
select business_id, id, supplier_id, supplier_sort from stock_items where supplier_id is not null;

-- …and every supplier it has already been ordered from.
insert into item_suppliers (business_id, item_id, supplier_id)
select distinct o.business_id, l.item_id, o.supplier_id
from purchase_order_lines l join purchase_orders o on o.id = l.purchase_order_id
where l.item_id is not null
on conflict do nothing;

-- Ordering a product from a supplier links the two, so the list keeps itself up to date.
create or replace function link_item_supplier() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  if new.item_id is not null then
    insert into item_suppliers (business_id, item_id, supplier_id)
    select o.business_id, new.item_id, o.supplier_id from purchase_orders o where o.id = new.purchase_order_id
    on conflict do nothing;
  end if;
  return new;
end $$;

create trigger purchase_order_lines_link_supplier after insert or update of item_id on purchase_order_lines
  for each row execute function link_item_supplier();

-- What each supplier last charged for a product, per unit and per carton.
create view v_item_supplier_price as
select s.business_id, s.item_id, s.supplier_id, s.pack_size, s.supplier_code, s.sort,
       p.unit_cost as last_unit_cost,
       (p.unit_cost * s.pack_size)::numeric(12,2) as carton_cost,
       p.bought_on as last_bought_on
from item_suppliers s
left join lateral (
  select l.unit_cost, coalesce(o.received_on, o.ordered_on) as bought_on
  from purchase_order_lines l
  join purchase_orders o on o.id = l.purchase_order_id
  where l.item_id = s.item_id and o.supplier_id = s.supplier_id and o.status <> 'cancelled'
  order by coalesce(o.received_on, o.ordered_on) desc, o.po_number desc
  limit 1
) p on true;
alter view v_item_supplier_price set (security_invoker = on);

commit;
