-- Two ways to record a trading day, chosen per business:
--   'channels' - EFTPOS / cash / Uber / online, added up to the day's takings (JK Bhairavi)
--   'simple'   - one sales figure, plus cash collected that day (Caltex kedron)
--
-- cash_collected is NOT part of sales: at a service station the till also takes
-- fuel money, which isn't tracked here. It is only ever reported on its own.
begin;

alter table businesses add column sales_mode text not null default 'channels'
  check (sales_mode in ('channels', 'simple'));

alter table sales_days add column cash_collected numeric(12,2);

update businesses set sales_mode = 'simple' where name = 'Caltex kedron';

-- Weekly roll-up gains the cash figure, kept separate from sales.
-- Dropped first: CREATE OR REPLACE can't insert a column into an existing view.
drop view if exists v_weekly_summary;
create view v_weekly_summary as
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

alter view v_weekly_summary set (security_invoker = on);

commit;
