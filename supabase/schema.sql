-- JK Bhairavi — Supabase schema
--
-- Multi-company: every record belongs to a business, and people are given access
-- per business through business_users. Run this on a new project, then seed.sql.
-- An existing single-company database is upgraded with migrations/001_multi_company.sql.
create extension if not exists pgcrypto;

create table businesses (
  id uuid primary key default gen_random_uuid(),
  name text not null unique,
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
