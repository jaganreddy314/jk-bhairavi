-- Sales of each catalogue item, from the till's own reports.
--
-- A row covers either one day or one Monday-to-Sunday week. Weekly is the usual case (the
-- weekly report is imported as it is); days are there for when a daily figure is all you have.
-- One row per item per period, so importing the same report twice replaces rather than doubles.
begin;

create table item_sales (
  id uuid primary key default gen_random_uuid(),
  business_id uuid not null references businesses(id),
  item_id uuid not null references stock_items(id) on delete cascade,
  period_start date not null,
  period_end date not null,
  qty numeric(12,3) not null default 0 check (qty >= 0),
  amount numeric(12,2) not null default 0 check (amount >= 0),
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
  where coalesce((r->>'qty')::numeric, 0) > 0 or coalesce((r->>'amount')::numeric, 0) > 0;
  get diagnostics n = row_count;
  return n;
end $$;

commit;
