-- JK Bhairavi — Supabase schema
--
-- Multi-company: every record belongs to a business, and people are given access
-- per business through business_users. Run this on a new project, then seed.sql.
-- An existing single-company database is upgraded with migrations/001_multi_company.sql.
create extension if not exists pgcrypto;

create table businesses (
  id uuid primary key default gen_random_uuid(),
  name text not null unique,
  -- How a trading day is recorded:
  --   'channels' - EFTPOS / cash / Uber / online, added up to the day's takings
  --   'simple'   - one sales figure, plus cash collected that day
  sales_mode text not null default 'channels' check (sales_mode in ('channels', 'simple')),
  created_at timestamptz default now()
);

-- Access control: who may use which business
create table business_users (
  email text not null,
  business_id uuid not null references businesses(id) on delete cascade,
  display_name text,
  created_at timestamptz default now(),
  primary key (email, business_id)
);
create index on business_users (business_id);

-- Is the signed-in person a member of this business?
create or replace function is_member(b uuid) returns boolean
language sql stable security definer set search_path = public as $$
  select exists (
    select 1 from business_users
    where business_id = b and lower(email) = lower(auth.jwt() ->> 'email')
  );
$$;

-- Is the signed-in person a member of any business at all? (Gates the sign-in screen.)
create or replace function is_any_member() returns boolean
language sql stable security definer set search_path = public as $$
  select exists (select 1 from business_users where lower(email) = lower(auth.jwt() ->> 'email'));
$$;

-- Business "today" in Brisbane (the database clock runs in UTC)
create or replace function shop_today() returns date
language sql stable as $$ select (now() at time zone 'Australia/Brisbane')::date $$;

create table sales_days (
  id uuid primary key default gen_random_uuid(),
  business_id uuid not null references businesses(id),
  sale_date date not null,
  eftpos numeric(12,2) not null default 0,
  cash numeric(12,2) not null default 0,
  uber numeric(12,2) not null default 0,
  online numeric(12,2) not null default 0,
  total_recorded numeric(12,2),            -- as written in the old sheet; null = use sum
  -- Cash in hand that day. NOT part of sales: at a service station the till also
  -- takes fuel money, which isn't tracked here. Reported on its own.
  cash_collected numeric(12,2),
  notes text,
  created_by uuid default auth.uid(),
  created_at timestamptz default now(),
  updated_at timestamptz default now(),
  constraint sales_days_business_date_key unique (business_id, sale_date)
);
create index on sales_days (business_id);

-- Shared by every business
create table expense_categories (
  code text primary key,                    -- food, labour, rent, utilities, equipment, setup, other
  label text not null,
  is_operating boolean not null default true,
  sort int not null default 0
);

create table suppliers (
  id uuid primary key default gen_random_uuid(),
  business_id uuid not null references businesses(id),
  name text not null,
  default_category text references expense_categories(code) default 'food',
  active boolean not null default true,
  constraint suppliers_business_name_key unique (business_id, name)
);
create index on suppliers (business_id);

create table staff (
  id uuid primary key default gen_random_uuid(),
  business_id uuid not null references businesses(id),
  name text not null,
  hourly_rate numeric(8,2),
  active boolean not null default true
);
create index on staff (business_id);

create type paid_via as enum ('bank','amex','cash','other');

create table expenses (
  id uuid primary key default gen_random_uuid(),
  business_id uuid not null references businesses(id),
  expense_date date not null,
  category text not null references expense_categories(code),
  supplier_id uuid references suppliers(id),
  staff_id uuid references staff(id),
  hours numeric(6,2),
  amount numeric(12,2) not null check (amount >= 0),
  paid_via paid_via not null default 'bank',
  note text,
  created_by uuid default auth.uid(),
  created_at timestamptz default now()
);
create index on expenses (expense_date);
create index on expenses (category);
create index on expenses (business_id);

create type frequency as enum ('weekly','fortnightly','monthly');

create table recurring_expenses (
  id uuid primary key default gen_random_uuid(),
  business_id uuid not null references businesses(id),
  name text not null,
  category text not null references expense_categories(code),
  supplier_id uuid references suppliers(id),
  amount numeric(12,2) not null check (amount >= 0),
  frequency frequency not null,
  start_date date not null,
  end_date date,
  paid_via paid_via not null default 'bank',
  note text
);
create index on recurring_expenses (business_id);

create table partners (
  id uuid primary key default gen_random_uuid(),
  business_id uuid not null references businesses(id),
  name text not null,
  ownership_pct numeric(5,2) not null,
  constraint partners_business_name_key unique (business_id, name)
);
create index on partners (business_id);

create table partner_contributions (
  id uuid primary key default gen_random_uuid(),
  business_id uuid not null references businesses(id),
  partner_id uuid not null references partners(id),
  contributed_on date,
  amount numeric(12,2) not null,
  description text
);
create index on partner_contributions (business_id);

create table setup_costs (
  id uuid primary key default gen_random_uuid(),
  business_id uuid not null references businesses(id),
  item text not null,
  amount numeric(12,2) not null,
  incurred_on date,
  note text
);
create index on setup_costs (business_id);

-- Creating a business: a direct insert can't work, because the new row is only visible
-- to its members and the membership can't exist until the row does. This does both steps.
create or replace function create_business(p_name text) returns businesses
language plpgsql security definer set search_path = public as $$
declare
  e text := lower(auth.jwt() ->> 'email');
  b businesses;
begin
  if e is null then
    raise exception 'Not signed in';
  end if;
  -- Only people who already belong somewhere may start another business.
  if not is_any_member() then
    raise exception 'Not allowed';
  end if;
  if coalesce(trim(p_name), '') = '' then
    raise exception 'Name is required';
  end if;

  insert into businesses(name) values (trim(p_name)) returning * into b;
  insert into business_users(email, business_id) values (e, b.id) on conflict do nothing;
  return b;
end $$;

revoke all on function create_business(text) from public;
grant execute on function create_business(text) to authenticated;

-- A business must keep at least one member, or it becomes unreachable.
create or replace function keep_one_member() returns trigger
language plpgsql as $$
begin
  -- The business is being deleted: its people go with it.
  if not exists (select 1 from businesses where id = old.business_id) then
    return old;
  end if;
  if not exists (select 1 from business_users where business_id = old.business_id and email <> old.email) then
    raise exception 'Cannot remove the last person from a business';
  end if;
  return old;
end $$;
create trigger business_users_keep_one before delete on business_users
  for each row execute function keep_one_member();

-- Recurring expenses expanded into dated occurrences up to today.
-- Each occurrence is start_date + n*step (not step-by-step), so monthly items keep
-- their day-of-month and are clamped to month end (31 Jan -> 28 Feb -> 31 Mar).
create or replace view v_recurring_occurrences as
select r.id as recurring_id, r.business_id, r.name, r.category, r.supplier_id, r.amount, r.paid_via, o.expense_date
from recurring_expenses r
cross join lateral (
  select (r.start_date + n * case r.frequency when 'weekly' then interval '7 days'
                                              when 'fortnightly' then interval '14 days'
                                              else interval '1 month' end)::date as expense_date
  from generate_series(0, 1000) n
) o
where o.expense_date <= least(coalesce(r.end_date, shop_today()), shop_today());

create or replace view v_all_expenses as
select id, business_id, expense_date, category, supplier_id, staff_id, amount, paid_via, note, false as is_recurring
from expenses
union all
select recurring_id, business_id, expense_date, category, supplier_id, null, amount, paid_via, name, true
from v_recurring_occurrences;

create or replace view v_weekly_summary as
with s as (
  select business_id, date_trunc('week', sale_date)::date as week_start,
         sum(coalesce(total_recorded, eftpos+cash+uber+online)) as sales,
         sum(cash_collected) as cash_collected,
         count(*) as trading_days
  from sales_days group by 1, 2
), e as (
  select business_id, date_trunc('week', expense_date)::date as week_start,
    sum(amount) filter (where category='food') as food,
    sum(amount) filter (where category='labour') as labour,
    sum(amount) filter (where category='rent') as rent,
    sum(amount) filter (where category='utilities') as utilities,
    sum(amount) filter (where category='equipment') as equipment,
    sum(amount) filter (where category='other') as other
  from v_all_expenses where category <> 'setup' group by 1, 2
)
select coalesce(s.business_id, e.business_id) as business_id,
  coalesce(s.week_start, e.week_start) as week_start,
  coalesce(sales,0) as sales, coalesce(trading_days,0) as trading_days,
  coalesce(cash_collected,0) as cash_collected,
  coalesce(food,0) food, coalesce(labour,0) labour, coalesce(rent,0) rent,
  coalesce(utilities,0) utilities, coalesce(equipment,0) equipment, coalesce(other,0) other,
  coalesce(food,0)+coalesce(labour,0)+coalesce(rent,0)+coalesce(utilities,0)+coalesce(other,0) as operating_expenses,
  coalesce(sales,0)-(coalesce(food,0)+coalesce(labour,0)+coalesce(rent,0)+coalesce(utilities,0)+coalesce(other,0)) as operating_profit
from s full join e on s.business_id = e.business_id and s.week_start = e.week_start
order by 1, 2;

alter view v_recurring_occurrences set (security_invoker = on);
alter view v_all_expenses set (security_invoker = on);
alter view v_weekly_summary set (security_invoker = on);

-- Row Level Security: you only ever see businesses you belong to
do $$
declare t text;
begin
  foreach t in array array['sales_days','suppliers','staff','expenses','recurring_expenses',
                           'partners','partner_contributions','setup_costs']
  loop
    execute format('alter table %I enable row level security', t);
    execute format('create policy "members read write" on %I for all to authenticated using (is_member(business_id)) with check (is_member(business_id))', t);
  end loop;
end $$;

alter table expense_categories enable row level security;
create policy "members read categories" on expense_categories for select to authenticated using (is_any_member());

alter table businesses enable row level security;
create policy "members read business" on businesses for select to authenticated using (is_member(id));
create policy "members rename business" on businesses for update to authenticated using (is_member(id)) with check (is_member(id));
-- New businesses are created through create_business(), never by a direct insert.

alter table business_users enable row level security;
create policy "see people in my businesses" on business_users for select to authenticated
  using (is_member(business_id) or lower(email) = lower(auth.jwt() ->> 'email'));
create policy "add people to my businesses" on business_users for insert to authenticated with check (is_member(business_id));
create policy "remove people from my businesses" on business_users for delete to authenticated using (is_member(business_id));


-- ============================================================================
-- Purchasing and stock counting
-- ============================================================================
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
  supplier_sort int not null default 0,     -- position in its supplier's list when ordering
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

-- ---------- item sales (from the till's reports) ----------
-- A row covers one day or one Monday-to-Sunday week; see migrations/008_item_sales.sql.

create table item_sales (
  id uuid primary key default gen_random_uuid(),
  business_id uuid not null references businesses(id),
  item_id uuid not null references stock_items(id) on delete cascade,
  period_start date not null,
  period_end date not null,
  -- Negative when refunds outweigh sales that period (migration 009).
  qty numeric(12,3) not null default 0,
  amount numeric(12,2) not null default 0,
  created_at timestamptz not null default now(),
  constraint item_sales_period check (
    period_end = period_start
    or (period_end = period_start + 6 and extract(isodow from period_start) = 1)
  ),
  constraint item_sales_one_per_period unique (business_id, item_id, period_start, period_end)
);
create index on item_sales (business_id, period_start);
create index on item_sales (item_id);

-- How the till's report names each item, so the next import matches it without asking.
-- Stored lower-cased and trimmed.
create table item_aliases (
  business_id uuid not null references businesses(id),
  alias text not null,
  item_id uuid not null references stock_items(id) on delete cascade,
  primary key (business_id, alias)
);

-- One row per item per week. A week's own figure wins; a week without one adds up its days,
-- so a week entered both ways is never counted twice.
create view v_item_sales_weekly as
with weekly as (
  select business_id, item_id, period_start as week_start, qty, amount, false as from_days
  from item_sales
  where period_end = period_start + 6
),
daily as (
  select business_id, item_id, date_trunc('week', period_start)::date as week_start,
         sum(qty) as qty, sum(amount) as amount, true as from_days
  from item_sales
  where period_end = period_start
  group by 1, 2, 3
)
select * from weekly
union all
select d.* from daily d
where not exists (
  select 1 from weekly w
  where w.business_id = d.business_id and w.item_id = d.item_id and w.week_start = d.week_start
);
alter view v_item_sales_weekly set (security_invoker = on);

alter table item_sales enable row level security;
create policy "members read write" on item_sales for all to authenticated
  using (is_member(business_id)) with check (is_member(business_id));
alter table item_aliases enable row level security;
create policy "members read write" on item_aliases for all to authenticated
  using (is_member(business_id)) with check (is_member(business_id));

-- Save one period's figures in one go: whatever was there for exactly this day or week is
-- replaced, so re-importing a corrected report never leaves stale lines behind.
-- Runs as the caller, so row-level security still applies.
create or replace function replace_item_sales(p_business uuid, p_start date, p_end date, p_rows jsonb)
returns int language plpgsql set search_path = public as $$
declare n int;
begin
  if not is_member(p_business) then
    raise exception 'Not a member of this business';
  end if;
  delete from item_sales where business_id = p_business and period_start = p_start and period_end = p_end;
  insert into item_sales (business_id, item_id, period_start, period_end, qty, amount)
  select p_business, (r->>'item_id')::uuid, p_start, p_end,
         coalesce((r->>'qty')::numeric, 0), coalesce((r->>'amount')::numeric, 0)
  from jsonb_array_elements(p_rows) r
  where coalesce((r->>'qty')::numeric, 0) <> 0 or coalesce((r->>'amount')::numeric, 0) <> 0;
  get diagnostics n = row_count;
  return n;
end $$;

-- ---------- suppliers per product (migration 010) ----------
-- A product can come from several suppliers, each with its own carton and item code.

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

-- ---------- store layout, for the stock take walk ----------
-- Locations (shelves, fridge doors, store room) and the categories in each; see migrations/011_stock_locations.sql.

create table stock_locations (
  id uuid primary key default gen_random_uuid(),
  business_id uuid not null references businesses(id),
  name text not null,
  sort int not null default 0,
  constraint stock_locations_business_name_key unique (business_id, name)
);
create index on stock_locations (business_id);

create table stock_location_groups (
  business_id uuid not null references businesses(id),
  location_id uuid not null references stock_locations(id) on delete cascade,
  group_id uuid not null references stock_groups(id) on delete cascade,
  sort int not null default 0,                    -- order of categories within the location
  primary key (location_id, group_id)
);
create index on stock_location_groups (business_id);
create index on stock_location_groups (group_id);


alter table stock_locations enable row level security;
create policy "members read write" on stock_locations for all to authenticated
  using (is_member(business_id)) with check (is_member(business_id));
alter table stock_location_groups enable row level security;
create policy "members read write" on stock_location_groups for all to authenticated
  using (is_member(business_id)) with check (is_member(business_id));

-- Every place a product is counted at; see migrations/012_item_places.sql.
create table stock_item_places (
  business_id uuid not null references businesses(id),
  item_id uuid not null references stock_items(id) on delete cascade,
  location_id uuid not null references stock_locations(id) on delete cascade,
  sort int not null default 0,                     -- position on that shelf; 0 = not arranged yet
  primary key (item_id, location_id)
);
create index on stock_item_places (business_id);
create index on stock_item_places (location_id);

alter table stock_item_places enable row level security;
create policy "members read write" on stock_item_places for all to authenticated
  using (is_member(business_id)) with check (is_member(business_id));

alter table stock_count_lines add column place_qty jsonb;

-- Where a product counts when it hasn't been placed by hand: the first location on the walk
-- that keeps its category.
create or replace function category_home(p_item uuid) returns uuid
language sql stable security definer set search_path = public as $$
  select l.id from stock_items i
  join stock_location_groups g on g.group_id = i.group_id
  join stock_locations l on l.id = g.location_id
  where i.id = p_item
  order by l.sort, l.name
  limit 1
$$;

-- Put products at a location in this order — the whole shelf in one go.
create or replace function set_location_order(p_location uuid, p_items uuid[])
returns void
language plpgsql security definer set search_path = public as $$
declare b uuid;
begin
  select business_id into b from stock_locations where id = p_location;
  if b is null or not is_member(b) then
    raise exception 'Not allowed';
  end if;
  insert into stock_item_places (business_id, item_id, location_id, sort)
  select b, i.id, p_location, x.n * 10
  from unnest(p_items) with ordinality as x(id, n)
  join stock_items i on i.id = x.id and i.business_id = b
  on conflict (item_id, location_id) do update set sort = excluded.sort;
end $$;

-- Place products at a location (null = back to wherever their category is):
--   p_only  — this becomes their only place;
--   p_from  — move them from that location to this one;
--   neither — add this as another place, keeping where they already are.
create or replace function place_items(p_location uuid, p_items uuid[], p_from uuid default null, p_only boolean default false)
returns void
language plpgsql security definer set search_path = public as $$
declare b uuid;
begin
  select business_id into b from stock_items where id = p_items[1];
  if b is null or not is_member(b)
     or (p_location is not null and not exists (select 1 from stock_locations where id = p_location and business_id = b)) then
    raise exception 'Not allowed';
  end if;

  if p_only then
    delete from stock_item_places where item_id = any(p_items) and business_id = b;
  elsif p_from is null then
    -- A product counting at its category's spot is placed there for real first, or adding a
    -- second place would quietly take it off the first.
    insert into stock_item_places (business_id, item_id, location_id)
    select b, i.id, category_home(i.id) from stock_items i
    where i.id = any(p_items) and i.business_id = b and category_home(i.id) is not null
      and not exists (select 1 from stock_item_places p where p.item_id = i.id)
    on conflict do nothing;
  end if;

  if p_location is not null then
    insert into stock_item_places (business_id, item_id, location_id)
    select b, i.id, p_location from stock_items i where i.id = any(p_items) and i.business_id = b
    on conflict do nothing;
  end if;

  if p_from is not null and not p_only and p_from is distinct from p_location then
    delete from stock_item_places where item_id = any(p_items) and location_id = p_from and business_id = b;
  end if;
end $$;

revoke all on function set_location_order(uuid, uuid[]) from public;
grant execute on function set_location_order(uuid, uuid[]) to authenticated;
revoke all on function place_items(uuid, uuid[], uuid, boolean) from public;
grant execute on function place_items(uuid, uuid[], uuid, boolean) to authenticated;
revoke all on function category_home(uuid) from public;

-- ============================================================================
-- People, payroll and access — see migrations/013_people_access.sql
-- ============================================================================


-- ============================================================================
-- 1. Security groups
-- ============================================================================

create table security_groups (
  id uuid primary key default gen_random_uuid(),
  business_id uuid not null references businesses(id) on delete cascade,
  name text not null,
  description text,
  perms text[] not null default '{}',
  is_owner boolean not null default false,
  sort int not null default 0,
  unique (business_id, name),
  constraint security_groups_perms_known check (perms <@ array['finance','sales','purchasing','stock','catalogue','people','payroll','sensitive','admin'])
);
create index on security_groups (business_id);

-- The three groups every business starts with. Returns the Owner group.
create or replace function seed_security_groups(b uuid) returns uuid
language plpgsql security definer set search_path = public as $$
declare owner_id uuid;
begin
  insert into security_groups (business_id, name, description, perms, is_owner, sort)
  values (b, 'Owner', 'Everything, including tax, bank and super details, and who can sign in.',
          array['finance','sales','purchasing','stock','catalogue','people','payroll','sensitive','admin'], true, 10)
  on conflict (business_id, name) do update set is_owner = true
  returning id into owner_id;
  insert into security_groups (business_id, name, description, perms, sort) values
    (b, 'Manager', 'Runs the shop: money, ordering, stock, the catalogue and the team. No tax, bank or super details.',
        array['finance','sales','purchasing','stock','catalogue','people','payroll'], 20),
    (b, 'Staff', 'Enters the day''s sales and counts stock.', array['sales','stock'], 30)
  on conflict (business_id, name) do nothing;
  return owner_id;
end $$;
revoke execute on function seed_security_groups(uuid) from public, anon, authenticated;

select seed_security_groups(id) from businesses;

alter table business_users add column group_id uuid references security_groups(id);
update business_users u set group_id = g.id
from security_groups g where g.business_id = u.business_id and g.is_owner;
alter table business_users alter column group_id set not null;

-- Someone added without a group gets the least access, never more.
create or replace function default_security_group() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  if new.group_id is null then
    select id into new.group_id from security_groups
    where business_id = new.business_id and not is_owner
    order by cardinality(perms), sort limit 1;
  end if;
  return new;
end $$;
create trigger business_users_default_group before insert on business_users
  for each row execute function default_security_group();

-- Does the signed-in person have this area in this business?
create or replace function has_perm(b uuid, p text) returns boolean
language sql stable security definer set search_path = public as $$
  select exists (
    select 1 from business_users u join security_groups g on g.id = u.group_id
    where u.business_id = b and lower(u.email) = lower(auth.jwt() ->> 'email')
      and (g.is_owner or p = any(g.perms))
  )
$$;

-- …in any business they belong to (for the shared award tables).
create or replace function has_perm_anywhere(p text) returns boolean
language sql stable security definer set search_path = public as $$
  select exists (
    select 1 from business_users u join security_groups g on g.id = u.group_id
    where lower(u.email) = lower(auth.jwt() ->> 'email') and (g.is_owner or p = any(g.perms))
  )
$$;

-- A business always keeps someone in its Owner group, so it can never be locked out.
create or replace function keep_an_owner() returns trigger
language plpgsql security definer set search_path = public as $$
declare b uuid := coalesce(old.business_id, new.business_id);
begin
  if not exists (select 1 from businesses where id = b) then
    return coalesce(new, old);   -- the business itself is being deleted
  end if;
  if not exists (
    select 1 from business_users u join security_groups g on g.id = u.group_id
    where u.business_id = b and g.is_owner
  ) then
    raise exception 'A business needs at least one person in the Owner group';
  end if;
  return coalesce(new, old);
end $$;
create constraint trigger business_users_keep_an_owner after update or delete on business_users
  deferrable initially deferred for each row execute function keep_an_owner();

-- The Owner group can't be deleted or have its areas trimmed.
create or replace function protect_owner_group() returns trigger
language plpgsql as $$
begin
  if tg_op = 'DELETE' and old.is_owner and exists (select 1 from businesses where id = old.business_id) then
    raise exception 'The Owner group can''t be removed';
  end if;
  if tg_op = 'UPDATE' and old.is_owner then
    new.is_owner := true;
    new.perms := array['finance','sales','purchasing','stock','catalogue','people','payroll','sensitive','admin'];
  end if;
  if tg_op = 'UPDATE' and not old.is_owner then
    new.is_owner := false;
  end if;
  return coalesce(new, old);
end $$;
create trigger security_groups_protect_owner before update or delete on security_groups
  for each row execute function protect_owner_group();

alter table security_groups enable row level security;
create policy "members read groups" on security_groups for select to authenticated using (is_member(business_id));
create policy "admins add groups" on security_groups for insert to authenticated with check (has_perm(business_id, 'admin') and not is_owner);
create policy "admins change groups" on security_groups for update to authenticated
  using (has_perm(business_id, 'admin')) with check (has_perm(business_id, 'admin'));
create policy "admins remove groups" on security_groups for delete to authenticated using (has_perm(business_id, 'admin'));

-- Sign-in access: anyone in the business can see who else is; only admins change it.
drop policy "add people to my businesses" on business_users;
drop policy "remove people from my businesses" on business_users;
create policy "admins add people" on business_users for insert to authenticated with check (has_perm(business_id, 'admin'));
create policy "admins change people" on business_users for update to authenticated
  using (has_perm(business_id, 'admin')) with check (has_perm(business_id, 'admin'));
create policy "admins remove people" on business_users for delete to authenticated using (has_perm(business_id, 'admin'));

drop policy "members rename business" on businesses;
create policy "admins rename business" on businesses for update to authenticated
  using (has_perm(id, 'admin')) with check (has_perm(id, 'admin'));

-- Every table, by area. Reading is open to the whole business where the data is needed
-- across screens (products, suppliers, orders, counts); money, people and settings are not.
do $$
declare r record;
begin
  for r in select * from (values
    -- table                 read                                           write
    ('sales_days',           $q$has_perm(business_id,'sales') or has_perm(business_id,'finance')$q$, $q$has_perm(business_id,'sales')$q$),
    ('expenses',             $q$has_perm(business_id,'finance')$q$,                                    $q$has_perm(business_id,'finance')$q$),
    ('recurring_expenses',   $q$has_perm(business_id,'finance')$q$,                                    $q$has_perm(business_id,'finance')$q$),
    ('item_sales',           $q$has_perm(business_id,'finance') or has_perm(business_id,'catalogue')$q$, $q$has_perm(business_id,'finance')$q$),
    ('item_aliases',         $q$has_perm(business_id,'finance') or has_perm(business_id,'catalogue')$q$, $q$has_perm(business_id,'finance')$q$),
    ('partners',             $q$has_perm(business_id,'admin')$q$,                                      $q$has_perm(business_id,'admin')$q$),
    ('partner_contributions',$q$has_perm(business_id,'admin')$q$,                                      $q$has_perm(business_id,'admin')$q$),
    ('setup_costs',          $q$has_perm(business_id,'admin')$q$,                                      $q$has_perm(business_id,'admin')$q$),
    ('staff',                $q$has_perm(business_id,'people') or has_perm(business_id,'payroll')$q$,  $q$has_perm(business_id,'payroll')$q$),
    ('suppliers',            $q$is_member(business_id)$q$, $q$has_perm(business_id,'catalogue') or has_perm(business_id,'purchasing') or has_perm(business_id,'finance')$q$),
    ('stock_groups',         $q$is_member(business_id)$q$, $q$has_perm(business_id,'catalogue')$q$),
    ('stock_items',          $q$is_member(business_id)$q$, $q$has_perm(business_id,'catalogue')$q$),
    ('stock_locations',      $q$is_member(business_id)$q$, $q$has_perm(business_id,'catalogue')$q$),
    ('stock_location_groups',$q$is_member(business_id)$q$, $q$has_perm(business_id,'catalogue')$q$),
    ('stock_item_places',    $q$is_member(business_id)$q$, $q$has_perm(business_id,'catalogue')$q$),
    ('item_suppliers',       $q$is_member(business_id)$q$, $q$has_perm(business_id,'catalogue') or has_perm(business_id,'purchasing')$q$),
    ('purchase_orders',      $q$is_member(business_id)$q$, $q$has_perm(business_id,'purchasing')$q$),
    ('purchase_order_lines', $q$is_member(business_id)$q$, $q$has_perm(business_id,'purchasing')$q$),
    ('stock_counts',         $q$is_member(business_id)$q$, $q$has_perm(business_id,'stock')$q$),
    ('stock_count_lines',    $q$is_member(business_id)$q$, $q$has_perm(business_id,'stock')$q$)
  ) as t(tbl, rd, wr)
  loop
    execute format('drop policy if exists "members read write" on %I', r.tbl);
    execute format('create policy "area read" on %I for select to authenticated using (%s)', r.tbl, r.rd);
    execute format('create policy "area insert" on %I for insert to authenticated with check (%s)', r.tbl, r.wr);
    execute format('create policy "area update" on %I for update to authenticated using (%s) with check (%s)', r.tbl, r.wr, r.wr);
    execute format('create policy "area delete" on %I for delete to authenticated using (%s)', r.tbl, r.wr);
  end loop;
end $$;

-- Names and wage rates for picking who a labour expense paid, without opening up the
-- rest of a person's record to everyone who enters expenses.
create or replace function staff_names(p_business uuid)
returns table (id uuid, name text, hourly_rate numeric, active boolean)
language sql stable security definer set search_path = public as $$
  select s.id, s.name, s.hourly_rate, s.active from staff s
  where s.business_id = p_business
    and (has_perm(p_business, 'finance') or has_perm(p_business, 'people') or has_perm(p_business, 'payroll'))
  order by s.name
$$;

-- ============================================================================
-- 2. Awards: shared by every business
-- ============================================================================

create table awards (
  code text primary key,                 -- MA000089
  name text not null,
  url text
);

-- One set of rules per group of classifications and year. Multipliers apply to the
-- classification's ordinary hourly rate; junior percentages apply first (the pay guides
-- work them out the same way). sat_pm is for awards that pay Saturday afternoons differently.
create table award_rule_sets (
  id uuid primary key default gen_random_uuid(),
  award_code text not null references awards(code) on delete cascade,
  key text not null,                     -- 'standard', 'console', …
  name text not null,
  effective_from date not null,
  ftpt jsonb not null,                   -- {"weekday":1,"sat":1.5,"sat_pm":1.5,"sun":2,"ph":2.5}
  casual jsonb not null,                 -- same keys, casual loading included
  junior jsonb not null,                 -- {"ftpt":{"u17":0.475,"17":0.5,…},"casual":{…}}
  extras jsonb not null default '{}',    -- late night loadings, minimum engagement, …
  notes text,
  unique (award_code, key, effective_from)
);

create table award_classifications (
  id uuid primary key default gen_random_uuid(),
  award_code text not null references awards(code) on delete cascade,
  rule_set_key text not null,
  code text not null,                    -- short label, e.g. 'Level 4'
  name text not null,
  sort int not null default 0,
  active boolean not null default true,
  unique (award_code, name)
);

create table award_rates (
  classification_id uuid not null references award_classifications(id) on delete cascade,
  effective_from date not null,
  weekly numeric(10,2) not null,
  hourly numeric(10,4) not null,
  primary key (classification_id, effective_from)
);

do $$
declare t text;
begin
  foreach t in array array['awards','award_rule_sets','award_classifications','award_rates'] loop
    execute format('alter table %I enable row level security', t);
    execute format('create policy "anyone signed in reads" on %I for select to authenticated using (true)', t);
    execute format('create policy "payroll edits" on %I for all to authenticated using (has_perm_anywhere(''payroll'')) with check (has_perm_anywhere(''payroll''))', t);
  end loop;
end $$;

-- ============================================================================
-- 3. People
-- ============================================================================

-- Per business: who the employer is and how pay runs.
create table payroll_settings (
  business_id uuid primary key references businesses(id) on delete cascade,
  legal_name text,
  abn text,
  address text,
  pay_frequency text not null default 'weekly' check (pay_frequency in ('weekly','fortnightly','monthly')),
  period_start_dow int not null default 1 check (period_start_dow between 1 and 7),   -- 1 = Monday
  pay_day_offset int not null default 2,     -- days after the period ends (Sunday + 2 = Tuesday)
  default_award_code text references awards(code),
  state text not null default 'QLD',
  super_rate numeric(5,2) not null default 12,
  super_payment_method text,
  stp_status text not null default 'not_connected'
);
alter table payroll_settings enable row level security;
create policy "people read settings" on payroll_settings for select to authenticated
  using (has_perm(business_id, 'people') or has_perm(business_id, 'payroll'));
create policy "payroll writes settings" on payroll_settings for all to authenticated
  using (has_perm(business_id, 'payroll')) with check (has_perm(business_id, 'payroll'));

-- The employee record.
alter table staff
  add column first_name text,
  add column last_name text,
  add column preferred_name text,
  add column email text,
  add column mobile text,
  add column date_of_birth date,
  add column address text,
  add column emergency_contact text,
  add column role_title text,
  add column employment_type text not null default 'casual' check (employment_type in ('full_time','part_time','casual')),
  add column status text not null default 'active' check (status in ('active','former')),
  add column start_date date,
  add column end_date date,
  add column award_code text references awards(code),
  add column classification_id uuid references award_classifications(id),
  add column above_award numeric(8,2) not null default 0,
  add column ordinary_hours numeric(5,2),     -- a week: agreed for part-time, usual for casual
  add column agreed_days text,                -- part-time: e.g. 'Mon, Tue, Thu · 6am – 2pm'
  add column visa_type text,
  add column visa_expiry date,
  add column fortnight_hour_limit numeric(5,2),  -- e.g. 48 for student visas in term
  add column right_to_work text,              -- 'Australian citizen', 'VEVO check', …
  add column right_to_work_checked_on date,
  add column fwis_given_on date,              -- Fair Work Information Statement
  add column ceis_given_on date,              -- Casual Employment Information Statement
  add column notes text,
  -- 'payee' rows are what some labour expenses were booked against ("Super", "Tax",
  -- "All staff members"): kept for those expenses, but not people on the team.
  add column kind text not null default 'employee' check (kind in ('employee','payee'));

update staff set kind = 'payee'
where lower(trim(name)) in ('super', 'tax', 'all staff members', 'all stuff members', 'all staff');

update staff set
  first_name = split_part(trim(name), ' ', 1),
  last_name = nullif(trim(substr(trim(name), length(split_part(trim(name), ' ', 1)) + 1)), ''),
  status = case when active then 'active' else 'former' end;

-- The short name shown around the app follows the legal name (or the preferred one).
create or replace function staff_display_name() returns trigger
language plpgsql as $$
begin
  if new.first_name is not null and new.kind = 'employee' then
    new.name := trim(coalesce(nullif(trim(new.preferred_name), ''), new.first_name) || ' ' || coalesce(new.last_name, ''));
  end if;
  -- Status is the source of truth; a change to "active" alone (the old staff list) still counts.
  if tg_op = 'UPDATE' and new.active is distinct from old.active and new.status = old.status then
    new.status := case when new.active then 'active' else 'former' end;
  elsif tg_op = 'INSERT' and new.active = false then
    new.status := 'former';
  end if;
  new.active := new.status = 'active';
  return new;
end $$;
create trigger staff_display_name before insert or update on staff
  for each row execute function staff_display_name();

-- Tax: only the "sensitive" area. The tax file number itself is encrypted and is not
-- readable through the API at all; tfn_last3 is what the screens show.
create table staff_tax (
  staff_id uuid primary key references staff(id) on delete cascade,
  business_id uuid not null references businesses(id),
  tfn_cipher bytea,
  tfn_last3 text,
  tfn_status text not null default 'missing' check (tfn_status in ('missing','provided','applied','under_18','pensioner','exempt')),
  declaration_date date,
  residency text check (residency in ('resident','foreign','working_holiday')),
  tax_free_threshold boolean,
  study_loan boolean,                         -- STSL: HELP, VSL, SFSS, SSL, TSL
  medicare_variation text,
  updated_at timestamptz not null default now()
);

create table staff_super (
  staff_id uuid primary key references staff(id) on delete cascade,
  business_id uuid not null references businesses(id),
  choice text not null default 'pending' check (choice in ('pending','chosen','stapled','default','smsf')),
  fund_name text,
  usi text,
  fund_abn text,
  member_number text,
  smsf_esa text,                              -- SMSF electronic service address
  smsf_bsb text,
  smsf_account text,
  extra_percent numeric(5,2),                 -- salary sacrifice / extra contributions
  updated_at timestamptz not null default now()
);

create table staff_bank (
  staff_id uuid primary key references staff(id) on delete cascade,
  business_id uuid not null references businesses(id),
  account_name text,
  bsb text,
  account_cipher bytea,
  account_last4 text,
  updated_at timestamptz not null default now()
);

create table staff_leave (
  staff_id uuid not null references staff(id) on delete cascade,
  business_id uuid not null references businesses(id),
  leave_type text not null check (leave_type in ('annual','personal','long_service')),
  hours numeric(8,2) not null default 0,
  as_of date not null default current_date,
  primary key (staff_id, leave_type)
);

alter table staff_tax enable row level security;
alter table staff_super enable row level security;
alter table staff_bank enable row level security;
alter table staff_leave enable row level security;

-- Tax and bank change only through the functions below, which encrypt; super can be
-- written directly by anyone allowed to see it.
create policy "sensitive reads tax" on staff_tax for select to authenticated using (has_perm(business_id, 'sensitive'));
create policy "sensitive reads bank" on staff_bank for select to authenticated using (has_perm(business_id, 'sensitive'));
create policy "sensitive reads and writes super" on staff_super for all to authenticated
  using (has_perm(business_id, 'sensitive')) with check (has_perm(business_id, 'sensitive'));
create policy "people read leave" on staff_leave for select to authenticated
  using (has_perm(business_id, 'people') or has_perm(business_id, 'payroll'));
create policy "payroll writes leave" on staff_leave for all to authenticated
  using (has_perm(business_id, 'payroll')) with check (has_perm(business_id, 'payroll'));

-- The encrypted columns never leave the database.
revoke select on staff_tax, staff_bank from anon, authenticated;
grant select (staff_id, business_id, tfn_last3, tfn_status, declaration_date, residency, tax_free_threshold,
              study_loan, medicare_variation, updated_at) on staff_tax to authenticated;
grant select (staff_id, business_id, account_name, bsb, account_last4, updated_at) on staff_bank to authenticated;
revoke insert, update, delete on staff_tax, staff_bank from anon, authenticated;

-- The key for those columns, generated once and kept in Vault.
do $$
begin
  if not exists (select 1 from vault.secrets where name = 'payroll_key') then
    perform vault.create_secret(encode(extensions.gen_random_bytes(32), 'hex'), 'payroll_key',
      'Encrypts tax file numbers and bank account numbers in staff_tax and staff_bank');
  end if;
end $$;

create or replace function payroll_key() returns text
language sql stable security definer set search_path = public as $$
  select decrypted_secret from vault.decrypted_secrets where name = 'payroll_key'
$$;
revoke execute on function payroll_key() from public, anon, authenticated;

-- A tax file number is 9 digits whose weighted sum is a multiple of 11.
create or replace function tfn_valid(t text) returns boolean
language sql immutable as $$
  select t ~ '^[0-9]{9}$' and (
    substr(t,1,1)::int * 1 + substr(t,2,1)::int * 4 + substr(t,3,1)::int * 3 + substr(t,4,1)::int * 7 +
    substr(t,5,1)::int * 5 + substr(t,6,1)::int * 8 + substr(t,7,1)::int * 6 + substr(t,8,1)::int * 9 +
    substr(t,9,1)::int * 10) % 11 = 0
$$;

-- Save the tax declaration. p_tfn null keeps the number on file; '' removes it.
create or replace function save_staff_tax(
  p_staff uuid, p_tfn text, p_tfn_status text, p_declaration_date date, p_residency text,
  p_tax_free_threshold boolean, p_study_loan boolean, p_medicare_variation text
) returns void
language plpgsql security definer set search_path = public, extensions as $$
declare b uuid; clean text := regexp_replace(coalesce(p_tfn, ''), '\D', '', 'g');
begin
  select business_id into b from staff where id = p_staff;
  if b is null or not has_perm(b, 'sensitive') then raise exception 'Not allowed'; end if;
  if p_tfn is not null and clean <> '' and not tfn_valid(clean) then
    raise exception 'That isn''t a valid tax file number';
  end if;
  insert into staff_tax (staff_id, business_id, tfn_status, declaration_date, residency, tax_free_threshold, study_loan, medicare_variation)
  values (p_staff, b, coalesce(p_tfn_status, 'missing'), p_declaration_date, p_residency, p_tax_free_threshold, p_study_loan, p_medicare_variation)
  on conflict (staff_id) do update set
    tfn_status = excluded.tfn_status, declaration_date = excluded.declaration_date, residency = excluded.residency,
    tax_free_threshold = excluded.tax_free_threshold, study_loan = excluded.study_loan,
    medicare_variation = excluded.medicare_variation, updated_at = now();
  if p_tfn is not null then
    update staff_tax set
      tfn_cipher = case when clean = '' then null else pgp_sym_encrypt(clean, payroll_key()) end,
      tfn_last3 = case when clean = '' then null else right(clean, 3) end,
      tfn_status = case when clean = '' then (case when tfn_status = 'provided' then 'missing' else tfn_status end) else 'provided' end
    where staff_id = p_staff;
  end if;
end $$;

-- Save the bank account. p_account null keeps the number on file.
create or replace function save_staff_bank(p_staff uuid, p_account_name text, p_bsb text, p_account text)
returns void
language plpgsql security definer set search_path = public, extensions as $$
declare b uuid; bsb text := regexp_replace(coalesce(p_bsb, ''), '\D', '', 'g'); acc text := regexp_replace(coalesce(p_account, ''), '\D', '', 'g');
begin
  select business_id into b from staff where id = p_staff;
  if b is null or not has_perm(b, 'sensitive') then raise exception 'Not allowed'; end if;
  if bsb <> '' and length(bsb) <> 6 then raise exception 'A BSB has 6 digits'; end if;
  if p_account is not null and acc <> '' and length(acc) not between 5 and 10 then
    raise exception 'An account number has 5 to 10 digits';
  end if;
  insert into staff_bank (staff_id, business_id, account_name, bsb)
  values (p_staff, b, nullif(trim(p_account_name), ''), nullif(substr(bsb, 1, 3) || '-' || substr(bsb, 4), '-'))
  on conflict (staff_id) do update set account_name = excluded.account_name, bsb = excluded.bsb, updated_at = now();
  if p_account is not null then
    update staff_bank set
      account_cipher = case when acc = '' then null else pgp_sym_encrypt(acc, payroll_key()) end,
      account_last4 = case when acc = '' then null else right(acc, 4) end
    where staff_id = p_staff;
  end if;
end $$;

-- What's on file, without what it says: lets the People screens show "TFN received"
-- to managers who can't see the number.
create or replace function staff_readiness(p_business uuid)
returns table (staff_id uuid, has_tfn boolean, tfn_status text, has_super boolean, has_bank boolean)
language sql stable security definer set search_path = public as $$
  select s.id,
         t.tfn_cipher is not null,
         coalesce(t.tfn_status, 'missing'),
         coalesce(su.choice not in ('pending') and (su.usi is not null or su.fund_abn is not null or su.choice = 'stapled'), false),
         b.account_cipher is not null and b.bsb is not null
  from staff s
  left join staff_tax t on t.staff_id = s.id
  left join staff_super su on su.staff_id = s.id
  left join staff_bank b on b.staff_id = s.id
  where s.business_id = p_business and s.kind = 'employee'
    and (has_perm(p_business, 'people') or has_perm(p_business, 'payroll'))
$$;

-- ============================================================================
-- Award data: Fair Work Ombudsman pay guides published 24 June 2026, for the first full
-- pay period starting on or after 1 July 2026.
-- ============================================================================

insert into awards (code, name, url) values
  ('MA000089', 'Vehicle Repair, Services and Retail Award 2020', 'https://www.fairwork.gov.au/pay-and-wages/minimum-wages/pay-guides'),
  ('MA000119', 'Restaurant Industry Award 2020', 'https://www.fairwork.gov.au/pay-and-wages/minimum-wages/pay-guides');

insert into award_rule_sets (award_code, key, name, effective_from, ftpt, casual, junior, extras, notes) values
  ('MA000089', 'standard', 'Vehicle industry RS&R employees', '2026-07-01',
   '{"weekday":1,"sat":1.5,"sun":2,"ph":2.5}',
   '{"weekday":1.25,"sat":1.75,"sun":2.25,"ph":2.75}',
   '{"ftpt":{"u17":0.475,"17":0.5,"18":0.625,"19":0.75,"20":0.875},"casual":{"u17":0.475,"17":0.5,"18":0.625,"19":0.75,"20":0.875}}',
   '{}',
   'Employees under 18 can''t work unsupervised 7pm–9pm, or at all 9pm–6.30am.'),
  ('MA000089', 'console', 'Roadhouse attendant, driveway attendant or console operator', '2026-07-01',
   '{"weekday":1,"sat":1,"sat_pm":1.5,"sun":1.5,"ph":2}',
   '{"weekday":1.3175,"sat":1.7187,"sat_pm":1.7187,"sun":1.7187,"ph":1.7187}',
   '{"ftpt":{"u17":0.475,"17":0.5,"18":0.625,"19":0.75,"20":0.875},"casual":{"u17":0.475,"17":0.5,"18":0.625,"19":0.75,"20":1}}',
   '{}',
   'Casuals get these flat rates instead of the 25% casual loading. Saturday is ordinary time before 12 noon and 150% after. Employees under 18 can''t work unsupervised 7pm–9pm, or at all 9pm–6.30am.'),
  ('MA000119', 'restaurant', 'Restaurant industry employees', '2026-07-01',
   '{"weekday":1,"sat":1.25,"sun":1.5,"ph":2.25}',
   '{"weekday":1.25,"sat":1.5,"sun":1.5,"ph":2.5}',
   '{"ftpt":{"u17":0.5,"17":0.6,"18":0.7,"19":0.85,"20":1},"casual":{"u17":0.5,"17":0.6,"18":0.7,"19":0.85,"20":1}}',
   '{"late_night":{"label":"Mon–Fri 10pm–midnight","per_hour":2.95},"early_morning":{"label":"Mon–Fri midnight–6am","per_hour":4.42}}',
   'Junior employees with a trade qualification, or who serve liquor, get the adult rate.');

with c (award_code, rule_set_key, code, name, sort, weekly, hourly) as (values
  ('MA000089', 'console',  'Console operator',   'Console operator / driveway attendant operating a console', 10, 1062.90, 27.97),
  ('MA000089', 'console',  'Driveway attendant', 'Driveway attendant', 20, 978.10, 25.74),
  ('MA000089', 'console',  'Roadhouse – take away', 'Roadhouse attendant required to cook take away meals only', 30, 1004.90, 26.44),
  ('MA000089', 'console',  'Roadhouse – cook', 'Roadhouse attendant engaged primarily to cook other than take away meals', 40, 1062.90, 27.97),
  ('MA000089', 'standard', 'Level 1', 'Vehicle industry RS&R level 1', 110, 978.10, 25.74),
  ('MA000089', 'standard', 'Level 2', 'Vehicle industry RS&R level 2', 120, 1004.90, 26.44),
  ('MA000089', 'standard', 'Level 3', 'Vehicle industry RS&R level 3', 130, 1029.10, 27.08),
  ('MA000089', 'standard', 'Level 4', 'Vehicle industry RS&R level 4', 140, 1062.90, 27.97),
  ('MA000089', 'standard', 'Level 5', 'Vehicle industry RS&R level 5', 150, 1088.20, 28.64),
  ('MA000089', 'standard', 'Tradesperson 1', 'Vehicle industry RS&R tradesperson or equivalent level 1', 160, 1119.10, 29.45),
  ('MA000089', 'standard', 'Tradesperson 2', 'Vehicle industry RS&R tradesperson or equivalent level 2', 170, 1224.40, 32.22),
  ('MA000119', 'restaurant', 'Introductory', 'Introductory level', 10, 978.10, 25.74),
  ('MA000119', 'restaurant', 'Level 1', 'Level 1 - food and beverage attendant grade 1', 20, 1004.90, 26.44),
  ('MA000119', 'restaurant', 'Level 1', 'Level 1 - kitchen attendant grade 1', 21, 1004.90, 26.44),
  ('MA000119', 'restaurant', 'Level 2', 'Level 2 - food and beverage attendant grade 2', 30, 1029.10, 27.08),
  ('MA000119', 'restaurant', 'Level 2', 'Level 2 - cook grade 1', 31, 1029.10, 27.08),
  ('MA000119', 'restaurant', 'Level 2', 'Level 2 - kitchen attendant grade 2', 32, 1029.10, 27.08),
  ('MA000119', 'restaurant', 'Level 2', 'Level 2 - clerical grade 1', 33, 1029.10, 27.08),
  ('MA000119', 'restaurant', 'Level 2', 'Level 2 - storeperson grade 1', 34, 1029.10, 27.08),
  ('MA000119', 'restaurant', 'Level 2', 'Level 2 - door person/security officer grade 1', 35, 1029.10, 27.08),
  ('MA000119', 'restaurant', 'Level 3', 'Level 3 - food and beverage attendant grade 3', 40, 1062.90, 27.97),
  ('MA000119', 'restaurant', 'Level 3', 'Level 3 - cook grade 2', 41, 1062.90, 27.97),
  ('MA000119', 'restaurant', 'Level 3', 'Level 3 - kitchen attendant grade 3', 42, 1062.90, 27.97),
  ('MA000119', 'restaurant', 'Level 3', 'Level 3 - clerical grade 2', 43, 1062.90, 27.97),
  ('MA000119', 'restaurant', 'Level 3', 'Level 3 - storeperson grade 2', 44, 1062.90, 27.97),
  ('MA000119', 'restaurant', 'Level 3', 'Level 3 - timekeeper/security officer grade 2', 45, 1062.90, 27.97),
  ('MA000119', 'restaurant', 'Level 3', 'Level 3 - handyperson', 46, 1062.90, 27.97),
  ('MA000119', 'restaurant', 'Level 4', 'Level 4 - food and beverage attendant grade 4 (tradesperson)', 50, 1119.10, 29.45),
  ('MA000119', 'restaurant', 'Level 4', 'Level 4 - cook grade 3 (tradesperson)', 51, 1119.10, 29.45),
  ('MA000119', 'restaurant', 'Level 4', 'Level 4 - clerical grade 3', 52, 1119.10, 29.45),
  ('MA000119', 'restaurant', 'Level 4', 'Level 4 - storeperson grade 3', 53, 1119.10, 29.45),
  ('MA000119', 'restaurant', 'Level 5', 'Level 5 - food and beverage supervisor', 60, 1189.40, 31.30),
  ('MA000119', 'restaurant', 'Level 5', 'Level 5 - cook grade 4 (tradesperson)', 61, 1189.40, 31.30),
  ('MA000119', 'restaurant', 'Level 5', 'Level 5 - clerical supervisor', 62, 1189.40, 31.30),
  ('MA000119', 'restaurant', 'Level 6', 'Level 6 - cook grade 5 (tradesperson)', 70, 1221.10, 32.13)
), ins as (
  insert into award_classifications (award_code, rule_set_key, code, name, sort)
  select award_code, rule_set_key, code, name, sort from c
  returning id, award_code, name
)
insert into award_rates (classification_id, effective_from, weekly, hourly)
select ins.id, '2026-07-01', c.weekly, c.hourly from ins join c using (award_code, name);

-- Each business's payroll settings, on the award it uses.
insert into payroll_settings (business_id, default_award_code)
select id, case when name ilike '%caltex%' then 'MA000089' else 'MA000119' end from businesses
on conflict do nothing;

-- Everyone already on the books is on their business's award; their classification is
-- left for someone to choose, so nobody's pay is assumed.
update staff s set award_code = p.default_award_code
from payroll_settings p where p.business_id = s.business_id;

-- ============================================================================
-- Functions that write on someone's behalf check their area, not just membership.
-- ============================================================================

CREATE OR REPLACE FUNCTION public.duplicate_purchase_order(p_id uuid)
 RETURNS purchase_orders
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
  src purchase_orders;
  o purchase_orders;
begin
  select * into src from purchase_orders where id = p_id;
  if src.id is null or not has_perm(src.business_id, 'purchasing') then
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
end $function$
;
CREATE OR REPLACE FUNCTION public.receive_purchase_order(p_id uuid, p_received_on date DEFAULT NULL::date, p_total numeric DEFAULT NULL::numeric, p_paid_via paid_via DEFAULT 'bank'::paid_via)
 RETURNS purchase_orders
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
  o purchase_orders;
  amt numeric(12,2);
  e_id uuid;
begin
  select * into o from purchase_orders where id = p_id;
  if o.id is null or not has_perm(o.business_id, 'purchasing') then
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
end $function$
;
CREATE OR REPLACE FUNCTION public.reopen_purchase_order(p_id uuid)
 RETURNS purchase_orders
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
  o purchase_orders;
  e_id uuid;
begin
  select * into o from purchase_orders where id = p_id;
  if o.id is null or not has_perm(o.business_id, 'purchasing') then
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
end $function$
;
CREATE OR REPLACE FUNCTION public.place_items(p_location uuid, p_items uuid[], p_from uuid DEFAULT NULL::uuid, p_only boolean DEFAULT false)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare b uuid;
begin
  select business_id into b from stock_items where id = p_items[1];
  if b is null or not has_perm(b, 'catalogue')
     or (p_location is not null and not exists (select 1 from stock_locations where id = p_location and business_id = b)) then
    raise exception 'Not allowed';
  end if;

  if p_only then
    delete from stock_item_places where item_id = any(p_items) and business_id = b;
  elsif p_from is null then
    -- A product counting at its category's spot is placed there for real first, or adding a
    -- second place would quietly take it off the first.
    insert into stock_item_places (business_id, item_id, location_id)
    select b, i.id, category_home(i.id) from stock_items i
    where i.id = any(p_items) and i.business_id = b and category_home(i.id) is not null
      and not exists (select 1 from stock_item_places p where p.item_id = i.id)
    on conflict do nothing;
  end if;

  if p_location is not null then
    insert into stock_item_places (business_id, item_id, location_id)
    select b, i.id, p_location from stock_items i where i.id = any(p_items) and i.business_id = b
    on conflict do nothing;
  end if;

  if p_from is not null and not p_only and p_from is distinct from p_location then
    delete from stock_item_places where item_id = any(p_items) and location_id = p_from and business_id = b;
  end if;
end $function$
;
CREATE OR REPLACE FUNCTION public.set_location_order(p_location uuid, p_items uuid[])
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare b uuid;
begin
  select business_id into b from stock_locations where id = p_location;
  if b is null or not has_perm(b, 'catalogue') then
    raise exception 'Not allowed';
  end if;
  insert into stock_item_places (business_id, item_id, location_id, sort)
  select b, i.id, p_location, x.n * 10
  from unnest(p_items) with ordinality as x(id, n)
  join stock_items i on i.id = x.id and i.business_id = b
  on conflict (item_id, location_id) do update set sort = excluded.sort;
end $function$
;
CREATE OR REPLACE FUNCTION public.start_stock_count(p_business uuid, p_date date DEFAULT NULL::date)
 RETURNS stock_counts
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
  d date := coalesce(p_date, shop_today());
  c stock_counts;
begin
  if not has_perm(p_business, 'stock') then
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
end $function$
;
CREATE OR REPLACE FUNCTION public.replace_item_sales(p_business uuid, p_start date, p_end date, p_rows jsonb)
 RETURNS integer
 LANGUAGE plpgsql
 SET search_path TO 'public'
AS $function$
declare n int;
begin
  if not has_perm(p_business, 'finance') then
    raise exception 'Not a member of this business';
  end if;
  delete from item_sales where business_id = p_business and period_start = p_start and period_end = p_end;
  insert into item_sales (business_id, item_id, period_start, period_end, qty, amount)
  select p_business, (r->>'item_id')::uuid, p_start, p_end,
         coalesce((r->>'qty')::numeric, 0), coalesce((r->>'amount')::numeric, 0)
  from jsonb_array_elements(p_rows) r
  where coalesce((r->>'qty')::numeric, 0) <> 0 or coalesce((r->>'amount')::numeric, 0) <> 0;
  get diagnostics n = row_count;
  return n;
end $function$
;
CREATE OR REPLACE FUNCTION public.create_business(p_name text)
 RETURNS businesses
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
  e text := lower(auth.jwt() ->> 'email');
  b businesses;
begin
  if e is null then
    raise exception 'Not signed in';
  end if;
  -- Only people who already belong somewhere may start another business.
  if not is_any_member() then
    raise exception 'Not allowed';
  end if;
  if coalesce(trim(p_name), '') = '' then
    raise exception 'Name is required';
  end if;

  insert into businesses(name) values (trim(p_name)) returning * into b;
  insert into payroll_settings (business_id) values (b.id) on conflict do nothing;
  -- The person who starts a business owns it.
  insert into business_users(email, business_id, group_id) values (e, b.id, seed_security_groups(b.id)) on conflict do nothing;
  return b;
end $function$
;

-- ============================================================================
-- Stock alerts: low stock and expiry dates — see migrations/014_stock_alerts.sql
-- ============================================================================


alter table stock_groups
  add column min_stock numeric(12,3) check (min_stock >= 0),     -- default for the whole category
  add column clearance_days int check (clearance_days >= 0);      -- days before expiry to clear
alter table stock_items
  add column min_stock numeric(12,3) check (min_stock >= 0),     -- null = the category's
  add column clearance_days int check (clearance_days >= 0);      -- null = the category's

-- ---------- expiry dates ----------

-- active: on the shelf. on_clearance: marked down, still selling. cleared: all sold.
-- written_off: thrown out.
create type batch_status as enum ('active', 'on_clearance', 'cleared', 'written_off');

create table stock_batches (
  id uuid primary key default gen_random_uuid(),
  business_id uuid not null references businesses(id),  -- copied from the product, for row-level security
  item_id uuid not null references stock_items(id) on delete cascade,
  expires_on date not null,
  qty numeric(12,3) check (qty > 0),                     -- optional: the date matters more than the count
  status batch_status not null default 'active',
  checked_on date not null default shop_today(),
  checked_by uuid default auth.uid(),
  resolved_on date,                                      -- when it was cleared or written off
  note text,
  created_at timestamptz not null default now()
);
create index on stock_batches (business_id, status, expires_on);
create index on stock_batches (item_id);
-- One open batch per product and date, so noting the same date again adds to it.
create unique index stock_batches_open_date_key on stock_batches (item_id, expires_on)
  where status in ('active', 'on_clearance');

-- The business comes from the product, never the client, and closing a batch stamps the day.
create or replace function stock_batch_defaults() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  select business_id into new.business_id from stock_items where id = new.item_id;
  if new.business_id is null then
    raise exception 'Product not found';
  end if;
  if new.status in ('cleared', 'written_off') then
    new.resolved_on := coalesce(new.resolved_on, shop_today());
  else
    new.resolved_on := null;
  end if;
  return new;
end $$;

create trigger stock_batches_defaults before insert or update on stock_batches
  for each row execute function stock_batch_defaults();

alter table stock_batches enable row level security;
create policy "area read" on stock_batches for select to authenticated using (is_member(business_id));
create policy "area insert" on stock_batches for insert to authenticated with check (has_perm(business_id, 'stock'));
create policy "area update" on stock_batches for update to authenticated
  using (has_perm(business_id, 'stock')) with check (has_perm(business_id, 'stock'));
create policy "area delete" on stock_batches for delete to authenticated using (has_perm(business_id, 'stock'));

-- Note an expiry date found on a product. The same date again adds to the open batch rather
-- than starting a second one. Runs as the caller, so row-level security still applies.
create or replace function add_expiry_date(p_item uuid, p_expires date, p_qty numeric default null, p_note text default null)
returns stock_batches
language plpgsql set search_path = public as $$
declare b stock_batches;
begin
  insert into stock_batches (business_id, item_id, expires_on, qty, note)
  select i.business_id, i.id, p_expires, p_qty, nullif(trim(p_note), '')
  from stock_items i where i.id = p_item
  on conflict (item_id, expires_on) where status in ('active', 'on_clearance')
  do update set
    qty = case when stock_batches.qty is null or excluded.qty is null
               then coalesce(excluded.qty, stock_batches.qty)
               else stock_batches.qty + excluded.qty end,
    checked_on = excluded.checked_on,
    checked_by = excluded.checked_by,
    note = coalesce(excluded.note, stock_batches.note)
  returning * into b;
  if b.id is null then
    raise exception 'Product not found';
  end if;
  return b;
end $$;

-- Every open batch with when it falls due. state:
--   upcoming      not yet inside its clearance window
--   due           inside the window: put it on clearance
--   on_clearance  marked down, counting down to its date
--   expired       past its date and still open: write it off
create view v_stock_batches as
select b.id, b.business_id, b.item_id, b.expires_on, b.qty, b.status, b.checked_on, b.note,
       w.days as clearance_days,
       b.expires_on - w.days as alert_from,
       b.expires_on - shop_today() as days_left,
       case
         when b.expires_on < shop_today() then 'expired'
         when b.status = 'on_clearance' then 'on_clearance'
         when shop_today() >= b.expires_on - w.days then 'due'
         else 'upcoming'
       end as state
from stock_batches b
join stock_items i on i.id = b.item_id
left join stock_groups g on g.id = i.group_id
cross join lateral (select coalesce(i.clearance_days, g.clearance_days, 7) as days) w
where b.status in ('active', 'on_clearance');
alter view v_stock_batches set (security_invoker = on);

-- ---------- low stock ----------

-- Estimated stock on hand for every product with a minimum. A function rather than a view:
-- item sales are only readable with finance or catalogue access, and someone who just counts
-- stock should still see the same figure, not one missing every sale.
--
-- on_hand is null for a product never counted: there is nothing to start from.
-- A weekly sales figure that straddles the count is shared out by day.
create or replace function stock_levels(p_business uuid)
returns table (item_id uuid, min_stock numeric, counted_on date, on_hand numeric)
language sql stable security definer set search_path = public as $$
  select i.id,
         coalesce(i.min_stock, g.min_stock),
         c.count_date,
         case when c.count_date is not null
              then round(c.qty + coalesce(r.qty, 0) - coalesce(s.qty, 0), 3) end
  from stock_items i
  left join stock_groups g on g.id = i.group_id
  -- the last finished count of it
  left join lateral (
    select sc.count_date, l.qty
    from stock_count_lines l
    join stock_counts sc on sc.id = l.stock_count_id
    where l.item_id = i.id and sc.status = 'final'
    order by sc.count_date desc
    limit 1
  ) c on true
  -- received since (a count is close of trade, so that day's deliveries are already in it)
  left join lateral (
    select sum(l.qty) as qty
    from purchase_order_lines l
    join purchase_orders o on o.id = l.purchase_order_id
    where l.item_id = i.id and o.status = 'received' and o.received_on > c.count_date
  ) r on true
  -- sold since; days are skipped for a week that has its own weekly figure, as v_item_sales_weekly does
  left join lateral (
    select sum(x.qty * (x.period_end - greatest(x.period_start, c.count_date + 1) + 1)::numeric
                     / (x.period_end - x.period_start + 1)) as qty
    from item_sales x
    where x.item_id = i.id and x.period_end > c.count_date
      and (x.period_end > x.period_start or not exists (
        select 1 from item_sales w
        where w.item_id = x.item_id and w.period_end = w.period_start + 6
          and w.period_start = date_trunc('week', x.period_start)::date))
  ) s on true
  where i.business_id = p_business and i.active
    and coalesce(i.min_stock, g.min_stock) is not null
    and is_member(p_business)
$$;

do $$
declare f text;
begin
  foreach f in array array[
    'add_expiry_date(uuid, date, numeric, text)',
    'stock_levels(uuid)'
  ]
  loop
    execute format('revoke all on function %s from public', f);
    execute format('grant execute on function %s to authenticated', f);
  end loop;
end $$;

