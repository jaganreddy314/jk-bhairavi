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

alter table stock_items
  add column location_id uuid references stock_locations(id) on delete set null,
  add column location_sort int not null default 0;   -- 0 = not arranged yet
create index on stock_items (location_id);

alter table stock_locations enable row level security;
create policy "members read write" on stock_locations for all to authenticated
  using (is_member(business_id)) with check (is_member(business_id));
alter table stock_location_groups enable row level security;
create policy "members read write" on stock_location_groups for all to authenticated
  using (is_member(business_id)) with check (is_member(business_id));

-- Put products in a location in the order given: one round trip for a whole shelf.
create or replace function set_location_order(p_location uuid, p_items uuid[])
returns void
language plpgsql security definer set search_path = public as $$
declare b uuid;
begin
  select business_id into b from stock_locations where id = p_location;
  if b is null or not is_member(b) then
    raise exception 'Not allowed';
  end if;
  update stock_items i set location_id = p_location, location_sort = x.n * 10
  from unnest(p_items) with ordinality as x(id, n)
  where i.id = x.id and i.business_id = b;
end $$;

revoke all on function set_location_order(uuid, uuid[]) from public;
grant execute on function set_location_order(uuid, uuid[]) to authenticated;
