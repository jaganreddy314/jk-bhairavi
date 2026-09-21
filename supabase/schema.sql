-- JK Bhairavi — Supabase schema
create extension if not exists pgcrypto;

-- Access control: only listed emails may use the app
create table app_users (
  email text primary key,
  display_name text,
  created_at timestamptz default now()
);

create or replace function is_app_user() returns boolean
language sql stable security definer set search_path = public as $$
  select exists (select 1 from app_users where lower(email) = lower(auth.jwt() ->> 'email'));
$$;

create table sales_days (
  id uuid primary key default gen_random_uuid(),
  sale_date date not null unique,
  eftpos numeric(12,2) not null default 0,
  cash numeric(12,2) not null default 0,
  uber numeric(12,2) not null default 0,
  online numeric(12,2) not null default 0,
  total_recorded numeric(12,2),            -- as written in the old sheet; null = use sum
  notes text,
  created_by uuid default auth.uid(),
  created_at timestamptz default now(),
  updated_at timestamptz default now()
);

create table expense_categories (
  code text primary key,                    -- food, labour, rent, utilities, equipment, setup, other
  label text not null,
  is_operating boolean not null default true,
  sort int not null default 0
);

create table suppliers (
  id uuid primary key default gen_random_uuid(),
  name text not null unique,
  default_category text references expense_categories(code) default 'food',
  active boolean not null default true
);

create table staff (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  hourly_rate numeric(8,2),
  active boolean not null default true
);

create type paid_via as enum ('bank','amex','cash','other');

create table expenses (
  id uuid primary key default gen_random_uuid(),
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

create type frequency as enum ('weekly','fortnightly','monthly');

create table recurring_expenses (
  id uuid primary key default gen_random_uuid(),
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

create table partners (
  id uuid primary key default gen_random_uuid(),
  name text not null unique,
  ownership_pct numeric(5,2) not null
);

create table partner_contributions (
  id uuid primary key default gen_random_uuid(),
  partner_id uuid not null references partners(id),
  contributed_on date,
  amount numeric(12,2) not null,
  description text
);

create table setup_costs (
  id uuid primary key default gen_random_uuid(),
  item text not null,
  amount numeric(12,2) not null,
  incurred_on date,
  note text
);

-- Business "today" in Brisbane (the database clock runs in UTC)
create or replace function shop_today() returns date
language sql stable as $$ select (now() at time zone 'Australia/Brisbane')::date $$;

-- Recurring expenses expanded into dated occurrences up to today.
-- Each occurrence is start_date + n*step (not step-by-step), so monthly items keep
-- their day-of-month and are clamped to month end (31 Jan -> 28 Feb -> 31 Mar).
create or replace view v_recurring_occurrences as
select r.id as recurring_id, r.name, r.category, r.supplier_id, r.amount, r.paid_via, o.expense_date
from recurring_expenses r
cross join lateral (
  select (r.start_date + n * case r.frequency when 'weekly' then interval '7 days'
                                              when 'fortnightly' then interval '14 days'
                                              else interval '1 month' end)::date as expense_date
  from generate_series(0, 1000) n
) o
where o.expense_date <= least(coalesce(r.end_date, shop_today()), shop_today());

create or replace view v_all_expenses as
select id, expense_date, category, supplier_id, staff_id, amount, paid_via, note, false as is_recurring
from expenses
union all
select recurring_id, expense_date, category, supplier_id, null, amount, paid_via, name, true
from v_recurring_occurrences;

create or replace view v_weekly_summary as
with s as (
  select date_trunc('week', sale_date)::date as week_start,
         sum(coalesce(total_recorded, eftpos+cash+uber+online)) as sales,
         count(*) as trading_days
  from sales_days group by 1
), e as (
  select date_trunc('week', expense_date)::date as week_start,
    sum(amount) filter (where category='food') as food,
    sum(amount) filter (where category='labour') as labour,
    sum(amount) filter (where category='rent') as rent,
    sum(amount) filter (where category='utilities') as utilities,
    sum(amount) filter (where category='equipment') as equipment,
    sum(amount) filter (where category='other') as other
  from v_all_expenses where category <> 'setup' group by 1
)
select coalesce(s.week_start, e.week_start) as week_start,
  coalesce(sales,0) as sales, coalesce(trading_days,0) as trading_days,
  coalesce(food,0) food, coalesce(labour,0) labour, coalesce(rent,0) rent,
  coalesce(utilities,0) utilities, coalesce(equipment,0) equipment, coalesce(other,0) other,
  coalesce(food,0)+coalesce(labour,0)+coalesce(rent,0)+coalesce(utilities,0)+coalesce(other,0) as operating_expenses,
  coalesce(sales,0)-(coalesce(food,0)+coalesce(labour,0)+coalesce(rent,0)+coalesce(utilities,0)+coalesce(other,0)) as operating_profit
from s full join e on s.week_start = e.week_start
order by 1;

alter view v_recurring_occurrences set (security_invoker = on);
alter view v_all_expenses set (security_invoker = on);
alter view v_weekly_summary set (security_invoker = on);

-- Row Level Security: allowed users get full access, everyone else nothing
do $$
declare t text;
begin
  foreach t in array array['sales_days','expense_categories','suppliers','staff','expenses',
                           'recurring_expenses','partners','partner_contributions','setup_costs']
  loop
    execute format('alter table %I enable row level security', t);
    execute format('create policy "app users all" on %I for all to authenticated using (is_app_user()) with check (is_app_user())', t);
  end loop;
end $$;
alter table app_users enable row level security;
create policy "app users read self" on app_users for select to authenticated using (is_app_user());
