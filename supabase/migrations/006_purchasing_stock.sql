-- Purchasing and stock counting, so a week's real food cost can be worked out.
--
--   food cost = opening stock + purchases - closing stock
--
-- Purchases are already in the books: expenses with category 'food'. Receiving a
-- purchase order writes one of those expenses and keeps a link to it, so an order
-- is never counted twice and the dashboard's figures carry on working unchanged.
-- Stock on hand comes from a count: every active item, valued at its cost that day.
begin;

-- ---------- what the business buys and counts ----------

-- Sections of the count sheet, in the order you walk the shop (Cool room, Freezer, Dry store…).
create table stock_groups (
  id uuid primary key default gen_random_uuid(),
  business_id uuid not null references businesses(id),
  name text not null,
  sort int not null default 0,
  constraint stock_groups_business_name_key unique (business_id, name)
);
create index on stock_groups (business_id);

create table stock_items (
  id uuid primary key default gen_random_uuid(),
  business_id uuid not null references businesses(id),
  name text not null,
  unit text not null default 'ea',          -- kg, box, bag, ea, L — how you order and count it
  group_id uuid references stock_groups(id) on delete set null,
  supplier_id uuid references suppliers(id),-- who you usually buy it from
  -- Fallback cost per unit. The cost actually used is the last price paid, when there is one.
  -- Four decimals: per-kg and per-each prices aren't always whole cents.
  unit_cost numeric(12,4),
  active boolean not null default true,
  constraint stock_items_business_name_key unique (business_id, name)
);
create index on stock_items (business_id);
create index on stock_items (supplier_id);

-- ---------- purchase orders ----------

create type po_status as enum ('draft', 'sent', 'received', 'cancelled');

create table purchase_orders (
  id uuid primary key default gen_random_uuid(),
  business_id uuid not null references businesses(id),
  po_number int not null,                   -- 1, 2, 3… per business, filled in on insert
  supplier_id uuid not null references suppliers(id),
  status po_status not null default 'draft',
  ordered_on date not null default shop_today(),
  expected_on date,
  received_on date,
  -- The food expense this order became when it was received. Null until then.
  expense_id uuid references expenses(id) on delete set null,
  note text,
  created_by uuid default auth.uid(),
  created_at timestamptz default now(),
  constraint purchase_orders_business_number_key unique (business_id, po_number),
  constraint purchase_orders_received_has_date check (status <> 'received' or received_on is not null)
);
create index on purchase_orders (business_id, ordered_on desc);
create index on purchase_orders (supplier_id);

create table purchase_order_lines (
  id uuid primary key default gen_random_uuid(),
  purchase_order_id uuid not null references purchase_orders(id) on delete cascade,
  business_id uuid not null references businesses(id),  -- copied from the order, for row-level security
  item_id uuid references stock_items(id),
  -- Only for something bought once that isn't worth adding to the item list.
  description text,
  qty numeric(12,3) not null check (qty > 0),
  unit_cost numeric(12,4) not null default 0 check (unit_cost >= 0),
  sort int not null default 0,
  constraint purchase_order_lines_what check (item_id is not null or coalesce(trim(description), '') <> '')
);
create index on purchase_order_lines (purchase_order_id);
create index on purchase_order_lines (business_id);
create index on purchase_order_lines (item_id);

-- ---------- stock counts ----------

create table stock_counts (
  id uuid primary key default gen_random_uuid(),
  business_id uuid not null references businesses(id),
  -- Stock on hand at close of trade on this date. One count per date.
  count_date date not null,
  -- 'open' is still being counted and is ignored by the food-cost figures; 'final' is done.
  status text not null default 'open' check (status in ('open', 'final')),
  note text,
  created_by uuid default auth.uid(),
  created_at timestamptz default now(),
  constraint stock_counts_business_date_key unique (business_id, count_date)
);
create index on stock_counts (business_id, count_date desc);

create table stock_count_lines (
  id uuid primary key default gen_random_uuid(),
  stock_count_id uuid not null references stock_counts(id) on delete cascade,
  business_id uuid not null references businesses(id),  -- copied from the count, for row-level security
  item_id uuid not null references stock_items(id),
  qty numeric(12,3) not null default 0 check (qty >= 0),
  -- The cost used for this count, frozen when the sheet was started, so a later
  -- price change never moves a week's food cost after the fact.
  unit_cost numeric(12,4) not null default 0 check (unit_cost >= 0),
  constraint stock_count_lines_item_key unique (stock_count_id, item_id)
);
create index on stock_count_lines (stock_count_id);
create index on stock_count_lines (business_id);

-- A line always belongs to the same business as its parent. Set it here rather than
-- trusting the client: a foreign key is not subject to row-level security, so without
-- this a member could otherwise attach lines to another business's order or count.
create or replace function line_business_from_parent() returns trigger
language plpgsql security definer set search_path = public as $$
declare b uuid;
begin
  if tg_table_name = 'purchase_order_lines' then
    select business_id into b from purchase_orders where id = new.purchase_order_id;
  else
    select business_id into b from stock_counts where id = new.stock_count_id;
  end if;
  if b is null then
    raise exception 'Parent row not found';
  end if;
  new.business_id := b;
  return new;
end $$;

create trigger purchase_order_lines_business before insert or update on purchase_order_lines
  for each row execute function line_business_from_parent();
create trigger stock_count_lines_business before insert or update on stock_count_lines
  for each row execute function line_business_from_parent();

-- Order numbers run 1, 2, 3… within a business. The lock makes two people ordering at
-- the same moment wait for each other instead of colliding on the unique constraint.
create or replace function set_po_number() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  if new.po_number is not null and new.po_number > 0 then
    return new;
  end if;
  perform pg_advisory_xact_lock(hashtext('po:' || new.business_id::text));
  select coalesce(max(po_number), 0) + 1 into new.po_number
  from purchase_orders where business_id = new.business_id;
  return new;
end $$;

create trigger purchase_orders_number before insert on purchase_orders
  for each row execute function set_po_number();

-- ---------- views ----------

-- What each item costs now: the last price actually paid, else the standard cost.
create or replace view v_item_cost as
select i.id as item_id, i.business_id, coalesce(paid.unit_cost, i.unit_cost, 0)::numeric(12,4) as unit_cost
from stock_items i
left join lateral (
  select l.unit_cost
  from purchase_order_lines l
  join purchase_orders o on o.id = l.purchase_order_id
  where l.item_id = i.id and o.status = 'received' and l.unit_cost > 0
  order by o.received_on desc, o.po_number desc
  limit 1
) paid on true;

create or replace view v_purchase_order_totals as
select o.id, o.business_id, o.po_number, o.supplier_id, o.status, o.ordered_on, o.expected_on,
       o.received_on, o.expense_id, o.note,
       coalesce(l.lines, 0) as line_count,
       coalesce(l.total, 0)::numeric(12,2) as total
from purchase_orders o
left join (
  select purchase_order_id, count(*) as lines, sum(qty * unit_cost) as total
  from purchase_order_lines group by 1
) l on l.purchase_order_id = o.id;

create or replace view v_stock_count_values as
select c.id, c.business_id, c.count_date, c.status, c.note,
       count(l.id) filter (where l.qty > 0) as items_counted,
       coalesce(sum(l.qty * l.unit_cost), 0)::numeric(12,2) as value
from stock_counts c
left join stock_count_lines l on l.stock_count_id = c.id
group by c.id, c.business_id, c.count_date, c.status, c.note;

-- The week's real food cost.
--
-- Opening stock is the most recent finished count before the week began — normally the
-- one taken the night the previous week ended. Closing stock must be a count taken
-- inside the week itself; a week nobody counted gets no closing figure rather than a
-- stale one, and `counted` says so, so the page can fall back to purchases and say why.
create or replace view v_weekly_food_cost as
select
  w.business_id,
  w.week_start,
  w.sales,
  w.food as purchases,
  o.count_date as opening_date,
  c.count_date as closing_date,
  coalesce(o.value, 0) as opening_value,
  coalesce(c.value, 0) as closing_value,
  (o.count_date is not null and c.count_date is not null) as counted,
  case
    when o.count_date is not null and c.count_date is not null
      then (coalesce(o.value, 0) + w.food - coalesce(c.value, 0))::numeric(12,2)
    else w.food
  end as food_cost
from v_weekly_summary w
left join lateral (
  select v.count_date, v.value from v_stock_count_values v
  where v.business_id = w.business_id and v.status = 'final' and v.count_date < w.week_start
  order by v.count_date desc limit 1
) o on true
left join lateral (
  select v.count_date, v.value from v_stock_count_values v
  where v.business_id = w.business_id and v.status = 'final'
    and v.count_date >= w.week_start and v.count_date <= w.week_start + 6
  order by v.count_date desc limit 1
) c on true;

alter view v_item_cost set (security_invoker = on);
alter view v_purchase_order_totals set (security_invoker = on);
alter view v_stock_count_values set (security_invoker = on);
alter view v_weekly_food_cost set (security_invoker = on);

-- ---------- actions that have to be all-or-nothing ----------

-- Start a count sheet: one line per active item, priced at what it costs today.
-- Called again for a date already counted it returns that count rather than a second one,
-- and adds lines for any items created since, so a half-done sheet is never lost.
create or replace function start_stock_count(p_business uuid, p_date date default null)
returns stock_counts
language plpgsql security definer set search_path = public as $$
declare
  d date := coalesce(p_date, shop_today());
  c stock_counts;
begin
  if not is_member(p_business) then
    raise exception 'Not allowed';
  end if;

  select * into c from stock_counts where business_id = p_business and count_date = d;
  if c.id is null then
    insert into stock_counts(business_id, count_date) values (p_business, d) returning * into c;
  end if;

  insert into stock_count_lines(stock_count_id, business_id, item_id, qty, unit_cost)
  select c.id, c.business_id, i.id, 0, coalesce(v.unit_cost, 0)
  from stock_items i
  left join v_item_cost v on v.item_id = i.id
  where i.business_id = c.business_id and i.active
  on conflict (stock_count_id, item_id) do nothing;

  return c;
end $$;

-- Receive an order: write the food expense it became and point the order at it.
-- p_total lets you record what was actually billed when it differs from what was ordered.
create or replace function receive_purchase_order(
  p_id uuid,
  p_received_on date default null,
  p_total numeric default null,
  p_paid_via paid_via default 'bank'
) returns purchase_orders
language plpgsql security definer set search_path = public as $$
declare
  o purchase_orders;
  amt numeric(12,2);
  e_id uuid;
begin
  select * into o from purchase_orders where id = p_id;
  if o.id is null or not is_member(o.business_id) then
    raise exception 'Order not found';
  end if;
  if o.status = 'received' then
    raise exception 'Order % is already received', o.po_number;
  end if;
  if o.status = 'cancelled' then
    raise exception 'Order % was cancelled', o.po_number;
  end if;

  amt := coalesce(p_total, (select coalesce(sum(qty * unit_cost), 0) from purchase_order_lines where purchase_order_id = o.id));
  if amt < 0 then
    raise exception 'Total cannot be negative';
  end if;

  -- Always 'food', whatever the supplier is usually used for. An order buys stock, and
  -- stock is what the weekly count values, so the two sides of
  --   food cost = opening + purchases - closing
  -- have to draw on the same category. Booking a packaging order as 'other' would leave
  -- its stock in the count with no purchase to match, quietly skewing every week after.
  insert into expenses(business_id, expense_date, category, supplier_id, amount, paid_via, note)
  values (o.business_id, coalesce(p_received_on, shop_today()), 'food', o.supplier_id,
          amt, p_paid_via, 'Order #' || o.po_number)
  returning id into e_id;

  update purchase_orders
     set status = 'received', received_on = coalesce(p_received_on, shop_today()), expense_id = e_id
   where id = o.id
  returning * into o;

  return o;
end $$;

-- Undo receiving: delete the expense it created and put the order back to sent.
-- For fixing a mistake; an expense edited by hand since is still removed, because it
-- belongs to the order and would otherwise be counted twice when the order is received again.
create or replace function reopen_purchase_order(p_id uuid) returns purchase_orders
language plpgsql security definer set search_path = public as $$
declare
  o purchase_orders;
  e_id uuid;
begin
  select * into o from purchase_orders where id = p_id;
  if o.id is null or not is_member(o.business_id) then
    raise exception 'Order not found';
  end if;
  if o.status <> 'received' then
    raise exception 'Order % has not been received', o.po_number;
  end if;

  e_id := o.expense_id;
  update purchase_orders set status = 'sent', received_on = null, expense_id = null where id = o.id
  returning * into o;
  if e_id is not null then
    delete from expenses where id = e_id;
  end if;
  return o;
end $$;

-- Order the same things again: a fresh draft copying an order's lines, repriced to today.
create or replace function duplicate_purchase_order(p_id uuid) returns purchase_orders
language plpgsql security definer set search_path = public as $$
declare
  src purchase_orders;
  o purchase_orders;
begin
  select * into src from purchase_orders where id = p_id;
  if src.id is null or not is_member(src.business_id) then
    raise exception 'Order not found';
  end if;

  insert into purchase_orders(business_id, supplier_id, status, ordered_on, note)
  values (src.business_id, src.supplier_id, 'draft', shop_today(), src.note)
  returning * into o;

  insert into purchase_order_lines(purchase_order_id, business_id, item_id, description, qty, unit_cost, sort)
  select o.id, o.business_id, l.item_id, l.description, l.qty,
         coalesce(v.unit_cost, l.unit_cost), l.sort
  from purchase_order_lines l
  left join v_item_cost v on v.item_id = l.item_id
  where l.purchase_order_id = src.id
  order by l.sort, l.id;

  return o;
end $$;

do $$
declare f text;
begin
  foreach f in array array[
    'start_stock_count(uuid, date)',
    'receive_purchase_order(uuid, date, numeric, paid_via)',
    'reopen_purchase_order(uuid)',
    'duplicate_purchase_order(uuid)'
  ]
  loop
    execute format('revoke all on function %s from public', f);
    execute format('grant execute on function %s to authenticated', f);
  end loop;
end $$;

-- An expense that came from an order can't be deleted on its own: the order would still
-- say "received" while the purchase had vanished from the food cost. "Undo receive" on the
-- order is the way, and it unlinks the expense first, so this check lets that delete through.
create or replace function block_linked_expense_delete() returns trigger
language plpgsql security definer set search_path = public as $$
declare n int;
begin
  select po_number into n from purchase_orders where expense_id = old.id;
  if n is not null then
    raise exception 'This expense belongs to order #%. Undo receiving that order instead.', n;
  end if;
  return old;
end $$;

create trigger expenses_block_linked_delete before delete on expenses
  for each row execute function block_linked_expense_delete();

-- ---------- row-level security ----------
-- Same rule as every other table: you only ever see businesses you belong to.
do $$
declare t text;
begin
  foreach t in array array['stock_groups','stock_items','purchase_orders','purchase_order_lines',
                           'stock_counts','stock_count_lines']
  loop
    execute format('alter table %I enable row level security', t);
    execute format('create policy "members read write" on %I for all to authenticated using (is_member(business_id)) with check (is_member(business_id))', t);
  end loop;
end $$;

commit;
