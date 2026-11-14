-- Till orders: what the counter till sold, line by line, and how it was paid.
--
-- The till keeps working when the connection drops, so it makes each order on the iPad first
-- and sends it here when it can. The order's id is made by the till, and submit_pos_order
-- is safe to call again with the same order: the lines are written once, payments are matched
-- by their own ids, and a status change only lands if it's newer than the one already here.
-- That way an order sent twice, or sent late after the iPad was offline, never counts twice.
--
-- Prices on the lines are what the till charged, frozen when the item was added, not looked
-- up again: a price changed later doesn't rewrite what was sold.
--
-- A new "pos" area works the till. Owners, Managers and Staff all get it. Orders are read by
-- the till and by anyone who looks after the money or the day's sales; they're only ever
-- written through submit_pos_order.
begin;

-- ---------- the new area ----------
alter table security_groups drop constraint security_groups_perms_known;
alter table security_groups add constraint security_groups_perms_known
  check (perms <@ array['finance','sales','purchasing','stock','catalogue','temps','pos','people','roster','payroll','sensitive','admin']);

create or replace function seed_security_groups(b uuid) returns uuid
language plpgsql security definer set search_path = public as $$
declare owner_id uuid;
begin
  insert into security_groups (business_id, name, description, perms, is_owner, sort)
  values (b, 'Owner', 'Everything, including tax, bank and super details, and who can sign in.',
          array['finance','sales','purchasing','stock','catalogue','temps','pos','people','roster','payroll','sensitive','admin'], true, 10)
  on conflict (business_id, name) do update set is_owner = true
  returning id into owner_id;
  insert into security_groups (business_id, name, description, perms, sort) values
    (b, 'Manager', 'Runs the shop: money, ordering, stock, the catalogue, the till, the team and the roster. No tax, bank or super details.',
        array['finance','sales','purchasing','stock','catalogue','temps','pos','people','roster','payroll'], 20),
    (b, 'Staff', 'Works the till, enters the day''s sales, counts stock and logs fridge temperatures.', array['sales','stock','temps','pos'], 30)
  on conflict (business_id, name) do nothing;
  return owner_id;
end $$;
revoke execute on function seed_security_groups(uuid) from public, anon, authenticated;

create or replace function protect_owner_group() returns trigger
language plpgsql as $$
begin
  if tg_op = 'DELETE' and old.is_owner and exists (select 1 from businesses where id = old.business_id) then
    raise exception 'The Owner group can''t be removed';
  end if;
  if tg_op = 'UPDATE' and old.is_owner then
    new.is_owner := true;
    new.perms := array['finance','sales','purchasing','stock','catalogue','temps','pos','people','roster','payroll','sensitive','admin'];
  end if;
  if tg_op = 'UPDATE' and not old.is_owner then
    new.is_owner := false;
  end if;
  return coalesce(new, old);
end $$;

update security_groups set perms = perms || array['pos'] where is_owner;
update security_groups set perms = perms || array['pos']
where name in ('Manager', 'Staff') and not 'pos' = any(perms);

-- ---------- orders ----------

create table pos_orders (
  id uuid primary key,                          -- made by the till
  business_id uuid not null references businesses(id),
  number int not null check (number > 0),       -- the docket number called out at the counter
  device text not null check (trim(device) <> ''),   -- which till took it
  order_type text not null check (order_type in ('takeaway', 'dine_in', 'phone')),
  reference text,                               -- the table, or the caller's name and pickup time
  -- In the kitchen: preparing → ready → collected. Whether it's paid comes from its payments.
  status text not null default 'preparing' check (status in ('preparing', 'ready', 'collected')),
  sale_date date not null,                      -- the trading day it belongs to, in Brisbane
  created_at timestamptz not null,              -- when the till took it, which can be well before it arrived
  updated_at timestamptz not null,              -- the till's time of the last change, so a late one can't undo a newer one
  taken_by text not null,                       -- who was signed in to the till
  subtotal numeric(10,2) not null,              -- the lines added up, GST included
  gst numeric(10,2) not null,
  received_at timestamptz not null default now()
);
create index on pos_orders (business_id, sale_date);

create table pos_order_lines (
  id uuid primary key default gen_random_uuid(),
  business_id uuid not null references businesses(id),
  order_id uuid not null references pos_orders(id) on delete cascade,
  line_no int not null check (line_no > 0),
  menu_item_id uuid references menu_items(id) on delete set null,
  size_id uuid references menu_item_sizes(id) on delete set null,
  -- As the menu read when it was sold, so the docket still makes sense after the menu changes.
  name text not null check (trim(name) <> ''),
  size text,
  options jsonb not null default '[]' check (jsonb_typeof(options) = 'array'),  -- [{ "group", "name", "price", "qty" }]
  note text,
  qty int not null check (qty > 0),
  unit_price numeric(10,2) not null check (unit_price >= 0),
  total numeric(10,2) not null,
  gst_free boolean not null default false,
  unique (order_id, line_no)
);
create index on pos_order_lines (business_id);
create index on pos_order_lines (menu_item_id);

create table pos_payments (
  id uuid primary key,                          -- made by the till
  business_id uuid not null references businesses(id),
  order_id uuid not null references pos_orders(id) on delete cascade,
  method text not null check (method in ('card', 'cash')),
  amount numeric(10,2) not null check (amount >= 0),  -- what it paid off the order
  surcharge numeric(10,2) not null default 0 check (surcharge >= 0),  -- card surcharge on top
  tendered numeric(10,2) check (tendered >= 0), -- cash handed over; the change is tendered − amount
  card_ref text,                                -- the terminal's reference, once it's integrated
  taken_at timestamptz not null,
  taken_by text not null
);
create index on pos_payments (order_id);
create index on pos_payments (business_id, taken_at);

do $$
declare t text;
begin
  foreach t in array array['pos_orders', 'pos_order_lines', 'pos_payments'] loop
    execute format('alter table %I enable row level security', t);
    execute format($p$create policy "area read" on %I for select to authenticated
      using (has_perm(business_id, 'pos') or has_perm(business_id, 'sales') or has_perm(business_id, 'finance'))$p$, t);
  end loop;
end $$;

-- ---------- taking an order from the till ----------

-- Saves one order as the till holds it:
--   { "id", "business_id", "number", "device", "order_type", "reference", "status", "sale_date",
--     "created_at", "updated_at",
--     "lines":    [{ "menu_item_id", "size_id", "name", "size", "options", "note", "qty", "unit_price", "gst_free" }],
--     "payments": [{ "id", "method", "amount", "surcharge", "tendered", "card_ref", "taken_at" }] }
-- The first call writes the lines; later calls only move the status on and add new payments.
-- Returns what the database now holds: { id, subtotal, paid }.
create or replace function submit_pos_order(p_order jsonb) returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  v_id uuid := (p_order->>'id')::uuid;
  v_biz uuid := (p_order->>'business_id')::uuid;
  v_who text := lower(auth.jwt() ->> 'email');
  v_owner uuid;
  r jsonb; k int := 0;
  v_qty int; v_unit numeric;
  v_sub numeric := 0; v_gst numeric := 0;
begin
  if v_id is null or v_biz is null then
    raise exception 'An order needs an id and a business';
  end if;
  if not has_perm(v_biz, 'pos') then
    raise exception 'Needs the Till area in this business';
  end if;

  select business_id into v_owner from pos_orders where id = v_id;
  if v_owner is not null and v_owner <> v_biz then
    raise exception 'Order not found';
  end if;

  if v_owner is null then
    if jsonb_array_length(coalesce(p_order->'lines', '[]')) = 0 then
      raise exception 'An order needs at least one line';
    end if;
    for r in select * from jsonb_array_elements(p_order->'lines') loop
      v_qty := (r->>'qty')::int;
      v_unit := round((r->>'unit_price')::numeric, 2);
      v_sub := v_sub + v_qty * v_unit;
      if not coalesce((r->>'gst_free')::boolean, false) then
        v_gst := v_gst + v_qty * v_unit;
      end if;
    end loop;

    insert into pos_orders (id, business_id, number, device, order_type, reference, status, sale_date,
                            created_at, updated_at, taken_by, subtotal, gst)
    values (v_id, v_biz, (p_order->>'number')::int, p_order->>'device', p_order->>'order_type',
            nullif(trim(p_order->>'reference'), ''), coalesce(p_order->>'status', 'preparing'),
            (p_order->>'sale_date')::date, (p_order->>'created_at')::timestamptz,
            (p_order->>'updated_at')::timestamptz, v_who, v_sub, round(v_gst / 11, 2));

    for r in select * from jsonb_array_elements(p_order->'lines') loop
      k := k + 1;
      v_qty := (r->>'qty')::int;
      v_unit := round((r->>'unit_price')::numeric, 2);
      insert into pos_order_lines (business_id, order_id, line_no, menu_item_id, size_id, name, size,
                                   options, note, qty, unit_price, total, gst_free)
      values (v_biz, v_id, k,
              (select id from menu_items where id = (r->>'menu_item_id')::uuid and business_id = v_biz),
              (select id from menu_item_sizes where id = (r->>'size_id')::uuid and business_id = v_biz),
              trim(r->>'name'), nullif(trim(r->>'size'), ''), coalesce(r->'options', '[]'),
              nullif(trim(r->>'note'), ''), v_qty, v_unit, v_qty * v_unit,
              coalesce((r->>'gst_free')::boolean, false));
    end loop;
  else
    update pos_orders
    set status = coalesce(p_order->>'status', status),
        reference = nullif(trim(p_order->>'reference'), ''),
        updated_at = (p_order->>'updated_at')::timestamptz
    where id = v_id and updated_at < (p_order->>'updated_at')::timestamptz;
  end if;

  insert into pos_payments (id, business_id, order_id, method, amount, surcharge, tendered, card_ref, taken_at, taken_by)
  select (p->>'id')::uuid, v_biz, v_id, p->>'method', round((p->>'amount')::numeric, 2),
         round(coalesce((p->>'surcharge')::numeric, 0), 2), round((p->>'tendered')::numeric, 2),
         nullif(trim(p->>'card_ref'), ''), (p->>'taken_at')::timestamptz, v_who
  from jsonb_array_elements(coalesce(p_order->'payments', '[]')) p
  on conflict (id) do nothing;

  return (
    select jsonb_build_object('id', o.id, 'subtotal', o.subtotal,
                              'paid', coalesce((select sum(amount) from pos_payments where order_id = o.id), 0))
    from pos_orders o where o.id = v_id
  );
end $$;
revoke execute on function submit_pos_order(jsonb) from public, anon;
grant execute on function submit_pos_order(jsonb) to authenticated;

commit;
