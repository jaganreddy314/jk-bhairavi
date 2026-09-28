-- Multi-company migration.
--
-- Before: one shop, one allowed-email list (app_users).
-- After:  many businesses; every record belongs to one; people are added per business
--         (business_users). All existing data moves to a business called 'JK Bhairavi'.
--
-- Safe to run once on a database created from the original schema.sql.
begin;

create table businesses (
  id uuid primary key default gen_random_uuid(),
  name text not null unique,
  created_at timestamptz default now()
);

-- Who may use which business. Replaces app_users.
create table business_users (
  email text not null,
  business_id uuid not null references businesses(id) on delete cascade,
  display_name text,
  created_at timestamptz default now(),
  primary key (email, business_id)
);
create index on business_users (business_id);

-- Move the existing shop and its people across.
insert into businesses(name) values ('JK Bhairavi');
insert into business_users(email, business_id, display_name)
select a.email, b.id, a.display_name from app_users a cross join businesses b where b.name = 'JK Bhairavi';

-- Every table gains a business. Existing rows belong to JK Bhairavi.
do $$
declare t text; b uuid := (select id from businesses where name = 'JK Bhairavi');
begin
  foreach t in array array['sales_days','suppliers','staff','expenses','recurring_expenses',
                           'partners','partner_contributions','setup_costs']
  loop
    execute format('alter table %I add column business_id uuid references businesses(id)', t);
    execute format('update %I set business_id = %L', t, b);
    execute format('alter table %I alter column business_id set not null', t);
    execute format('create index on %I (business_id)', t);
  end loop;
end $$;

-- Names and trading days are unique per business, not globally.
alter table sales_days drop constraint sales_days_sale_date_key;
alter table sales_days add constraint sales_days_business_date_key unique (business_id, sale_date);
alter table suppliers drop constraint suppliers_name_key;
alter table suppliers add constraint suppliers_business_name_key unique (business_id, name);
alter table partners drop constraint partners_name_key;
alter table partners add constraint partners_business_name_key unique (business_id, name);

-- ---------- access rules ----------

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

-- A new business always keeps its creator as a member, so nobody creates one they can't open.
create or replace function add_creator_as_member() returns trigger
language plpgsql security definer set search_path = public as $$
declare e text := lower(auth.jwt() ->> 'email');
begin
  -- No signed-in user (e.g. created from the SQL editor): nothing to add.
  if e is not null then
    insert into business_users(email, business_id) values (e, new.id) on conflict do nothing;
  end if;
  return new;
end $$;
create trigger businesses_add_creator after insert on businesses
  for each row execute function add_creator_as_member();

-- A business must keep at least one member, or it becomes unreachable.
create or replace function keep_one_member() returns trigger
language plpgsql as $$
begin
  if not exists (select 1 from business_users where business_id = old.business_id and email <> old.email) then
    raise exception 'Cannot remove the last person from a business';
  end if;
  return old;
end $$;
create trigger business_users_keep_one before delete on business_users
  for each row execute function keep_one_member();

do $$
declare t text;
begin
  foreach t in array array['sales_days','suppliers','staff','expenses','recurring_expenses',
                           'partners','partner_contributions','setup_costs']
  loop
    execute format('drop policy if exists "app users all" on %I', t);
    execute format('create policy "members read write" on %I for all to authenticated using (is_member(business_id)) with check (is_member(business_id))', t);
  end loop;
end $$;

-- The category list is the same everywhere; any signed-in member may read it.
drop policy if exists "app users all" on expense_categories;
create policy "members read categories" on expense_categories for select to authenticated using (is_any_member());

-- The old single-list gate is no longer referenced by any policy.
drop table app_users;  -- its own policy goes with it
drop function if exists is_app_user();

alter table businesses enable row level security;
create policy "members read business" on businesses for select to authenticated using (is_member(id));
create policy "members rename business" on businesses for update to authenticated using (is_member(id)) with check (is_member(id));
-- Anyone who already belongs somewhere may start another business (the trigger makes them a member).
create policy "members create business" on businesses for insert to authenticated with check (is_any_member());

alter table business_users enable row level security;
create policy "see people in my businesses" on business_users for select to authenticated
  using (is_member(business_id) or lower(email) = lower(auth.jwt() ->> 'email'));
create policy "add people to my businesses" on business_users for insert to authenticated with check (is_member(business_id));
create policy "remove people from my businesses" on business_users for delete to authenticated using (is_member(business_id));

-- ---------- views ----------

-- Recreated from scratch: they gain a business_id column, which CREATE OR REPLACE can't add.
drop view if exists v_weekly_summary;
drop view if exists v_all_expenses;
drop view if exists v_recurring_occurrences;

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

commit;
