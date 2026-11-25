-- Wholesale tobacco prices, shared by every store.
--
-- Unlike the rest of the app these tables don't belong to a business: Trax, Metcash and
-- One Distribution publish one price list for everyone, so it's loaded once and every
-- service station compares against it. Anyone signed in can read it; only platform admins
-- (the people who run the app) load new lists, with scripts/wholesale_prices.py.
--
--   wholesalers             Trax Distribution, Metcash, One Distribution …
--   wholesale_products      one row per product, whoever sells it (Winfield Original Blue 20s)
--   wholesale_price_lists   one file from one wholesaler, and the dates it's good for
--   wholesale_prices        a line of that file: what the wholesaler calls it, how many
--                           retail units come in what they sell (a carton = 10 packs, an
--                           outer = 5 pouches) and the price, ex and inc GST
--
-- Products from different wholesalers are matched by barcode, then by match_key, a
-- normalised name the import script works out ("cigarettes:BOND CLASSIC ORIGINAL STREET").
-- Everything is compared per retail unit, inc GST: a pack, a pouch, a box of filters.
begin;

create table wholesalers (
  id uuid primary key default gen_random_uuid(),
  name text not null unique check (trim(name) <> ''),
  website text,
  notes text,
  created_at timestamptz not null default now()
);

create table wholesale_products (
  id uuid primary key default gen_random_uuid(),
  name text not null check (trim(name) <> ''),
  category text not null check (category in ('cigarettes', 'tobacco', 'cigars', 'filters', 'papers', 'lighters')),
  size text,                                  -- '20s', '30g'; null when the name already says it
  unit text not null default 'pack',          -- what one retail unit is: pack, pouch, box, booklet, lighter
  gtins text[] not null default '{}',         -- every barcode a wholesaler has listed it under
  match_key text not null unique,
  created_at timestamptz not null default now()
);
create index on wholesale_products using gin (gtins);

create table wholesale_price_lists (
  id uuid primary key default gen_random_uuid(),
  wholesaler_id uuid not null references wholesalers(id) on delete cascade,
  effective_from date not null,
  effective_to date,                          -- Metcash lists run for a set period; others until replaced
  source text,                                -- the file(s) it came from
  imported_at timestamptz not null default now(),
  imported_by text default (auth.jwt() ->> 'email'),
  check (effective_to is null or effective_to >= effective_from)
);
create index on wholesale_price_lists (wholesaler_id, effective_from desc);

create table wholesale_prices (
  id uuid primary key default gen_random_uuid(),
  price_list_id uuid not null references wholesale_price_lists(id) on delete cascade,
  product_id uuid not null references wholesale_products(id) on delete cascade,
  supplier_code text,                         -- their item number, for ordering
  gtin text,
  description text not null,                  -- as the wholesaler writes it
  units int not null check (units > 0),       -- retail units in what they sell
  price_ex_gst numeric(12,2) not null check (price_ex_gst >= 0),
  price_inc_gst numeric(12,2) not null check (price_inc_gst >= 0),
  unit_price_inc_gst numeric(12,4) generated always as (price_inc_gst / units) stored,
  unique (price_list_id, product_id, units)
);
create index on wholesale_prices (product_id);

-- ---------- who can see and change it ----------
alter table wholesalers enable row level security;
alter table wholesale_products enable row level security;
alter table wholesale_price_lists enable row level security;
alter table wholesale_prices enable row level security;

create policy "anyone signed in reads" on wholesalers for select to authenticated using (true);
create policy "anyone signed in reads" on wholesale_products for select to authenticated using (true);
create policy "anyone signed in reads" on wholesale_price_lists for select to authenticated using (true);
create policy "anyone signed in reads" on wholesale_prices for select to authenticated using (true);

create policy "platform admins write" on wholesalers for all to authenticated
  using (is_platform_admin()) with check (is_platform_admin());
create policy "platform admins write" on wholesale_products for all to authenticated
  using (is_platform_admin()) with check (is_platform_admin());
create policy "platform admins write" on wholesale_price_lists for all to authenticated
  using (is_platform_admin()) with check (is_platform_admin());
create policy "platform admins write" on wholesale_prices for all to authenticated
  using (is_platform_admin()) with check (is_platform_admin());

-- ---------- today's prices ----------
-- Each wholesaler's newest list that has started and hasn't run out. A list that has run
-- out still counts when there's nothing newer, so a late Metcash file doesn't empty the
-- page; price_list_to says how old it is.
create view v_wholesale_current_prices as
select p.id, p.product_id, w.id as wholesaler_id, w.name as wholesaler,
       p.supplier_code, p.gtin, p.description, p.units, p.price_ex_gst, p.price_inc_gst, p.unit_price_inc_gst,
       l.id as price_list_id, l.effective_from as price_list_from, l.effective_to as price_list_to
from wholesalers w
join lateral (
  select * from wholesale_price_lists l
  where l.wholesaler_id = w.id and l.effective_from <= current_date
  order by (l.effective_to is null or l.effective_to >= current_date) desc, l.effective_from desc, l.imported_at desc
  limit 1
) l on true
join wholesale_prices p on p.price_list_id = l.id;
alter view v_wholesale_current_prices set (security_invoker = on);

commit;
