-- Ordering tobacco from the cheapest wholesaler.
--
-- A store picks what it needs from its own catalogue; each product goes to whichever
-- wholesaler has the lowest current price (migration 025), and one draft purchase order is
-- made per wholesaler. For that the app needs to know two things per business:
--
--   item_wholesale_products   which shared wholesale product a catalogue item is
--                             (Kedron's "WINFIELD ORIGINAL SUN 20" = Winfield Original Sun)
--   business_wholesalers      which of the store's suppliers each wholesaler is
--                             (Kedron buys Metcash's list through "Campbell")
--
-- Most items link themselves: link_wholesale_items() matches the Metcash item codes and
-- barcodes stores already keep as item aliases ("#175135"). The rest are linked by hand
-- on the order page.
begin;

create table item_wholesale_products (
  business_id uuid not null references businesses(id),
  item_id uuid primary key references stock_items(id) on delete cascade,
  product_id uuid not null references wholesale_products(id) on delete cascade,
  created_at timestamptz not null default now()
);
create index on item_wholesale_products (business_id);
create index on item_wholesale_products (product_id);

create table business_wholesalers (
  business_id uuid not null references businesses(id),
  wholesaler_id uuid not null references wholesalers(id) on delete cascade,
  supplier_id uuid not null references suppliers(id) on delete cascade,
  primary key (business_id, wholesaler_id)
);

alter table item_wholesale_products enable row level security;
alter table business_wholesalers enable row level security;
create policy "members read write" on item_wholesale_products for all to authenticated
  using (is_member(business_id)) with check (is_member(business_id));
create policy "members read write" on business_wholesalers for all to authenticated
  using (is_member(business_id)) with check (is_member(business_id));

-- Link a store's unlinked items by the Metcash codes and barcodes in their aliases.
-- Returns how many it linked. Safe to run again: linked items are left alone.
create or replace function link_wholesale_items(b uuid) returns int
language plpgsql set search_path = public as $$
declare n int;
begin
  insert into item_wholesale_products (business_id, item_id, product_id)
  select distinct on (i.id) b, i.id, p.product_id
  from stock_items i
  join item_aliases a on a.item_id = i.id
  join wholesale_prices p on (a.alias = '#' || p.supplier_code and p.supplier_code ~ '^\d+$'
                              and p.price_list_id in (select l.id from wholesale_price_lists l join wholesalers w on w.id = l.wholesaler_id where w.name = 'Metcash'))
                          or a.alias in (p.gtin, '#' || p.gtin)
  where i.business_id = b and i.active
    and not exists (select 1 from item_wholesale_products x where x.item_id = i.id)
  order by i.id, p.id
  on conflict (item_id) do nothing;
  get diagnostics n = row_count;
  return n;
end $$;
revoke all on function link_wholesale_items(uuid) from public, anon;
grant execute on function link_wholesale_items(uuid) to authenticated;

-- Make the draft orders: one per wholesaler. p_lines is what the page worked out:
--   [{wholesaler_id, item_id, qty, unit_cost, units, supplier_code, sort}]
-- qty is in the item's own unit (packs), unit_cost per pack inc GST, units the wholesaler's lot.
-- A wholesaler the store hasn't bought from becomes a supplier of that name, and every
-- product is linked to its supplier with the lot size and code, so the catalogue knows too.
create or replace function create_wholesale_orders(b uuid, p_lines jsonb) returns table (po_id uuid, po_supplier_id uuid)
language plpgsql set search_path = public as $$
declare
  w uuid;
  sup uuid;
  po uuid;
begin
  if not is_member(b) then
    raise exception 'Not a member of this business';
  end if;
  for w in select distinct (l->>'wholesaler_id')::uuid from jsonb_array_elements(p_lines) l loop
    sup := null;
    select bw.supplier_id into sup from business_wholesalers bw where bw.business_id = b and bw.wholesaler_id = w;
    if sup is null then
      select s.id into sup from suppliers s join wholesalers x on lower(x.name) = lower(s.name)
      where s.business_id = b and x.id = w;
      if sup is null then
        insert into suppliers (business_id, name) select b, x.name from wholesalers x where x.id = w returning id into sup;
      end if;
      insert into business_wholesalers (business_id, wholesaler_id, supplier_id) values (b, w, sup);
    end if;

    insert into purchase_orders (business_id, supplier_id, note)
    values (b, sup, 'Tobacco order: each product from the cheapest wholesaler')
    returning id into po;

    -- Before the lines, so the line trigger finds the link with its real carton size.
    insert into item_suppliers (business_id, item_id, supplier_id, pack_size, supplier_code)
    select b, (l->>'item_id')::uuid, sup, (l->>'units')::int, nullif(l->>'supplier_code', '')
    from jsonb_array_elements(p_lines) l where (l->>'wholesaler_id')::uuid = w
    on conflict (item_id, supplier_id) do update set supplier_code = coalesce(item_suppliers.supplier_code, excluded.supplier_code);

    insert into purchase_order_lines (purchase_order_id, business_id, item_id, qty, unit_cost, sort)
    select po, b, (l->>'item_id')::uuid, (l->>'qty')::numeric, (l->>'unit_cost')::numeric, coalesce((l->>'sort')::int, 0)
    from jsonb_array_elements(p_lines) l where (l->>'wholesaler_id')::uuid = w;

    po_id := po;
    po_supplier_id := sup;
    return next;
  end loop;
end $$;
revoke all on function create_wholesale_orders(uuid, jsonb) from public, anon;
grant execute on function create_wholesale_orders(uuid, jsonb) to authenticated;

-- Link what every store already has.
select link_wholesale_items(id) from businesses;

commit;
