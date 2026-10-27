-- Departments: categories inside categories.
--
-- A big shop's catalogue (a service station with 2,000+ products) reads better in two levels:
-- Drinks → Energy Drinks, Confectionery → Bags. A category can now sit inside one other
-- category, its department. Products go in the inner one; a department only groups.
-- Shops that don't use departments carry on exactly as before.
--
-- A department's min stock and clearance days apply to every product under it that sets
-- neither itself nor through its own category.
begin;

alter table stock_groups add column parent_id uuid references stock_groups(id) on delete set null;
create index on stock_groups (parent_id);

-- Two levels at most, inside one business, and never a group inside itself.
create or replace function stock_group_parent_check() returns trigger
language plpgsql security definer set search_path = public as $$
declare p stock_groups;
begin
  if new.parent_id is null then
    return new;
  end if;
  if new.parent_id = new.id then
    raise exception 'A category can''t be inside itself';
  end if;
  select * into p from stock_groups where id = new.parent_id;
  if p.id is null or p.business_id <> new.business_id then
    raise exception 'Department not found';
  end if;
  if p.parent_id is not null then
    raise exception '% is itself inside a department; departments only go one level deep', p.name;
  end if;
  if exists (select 1 from stock_groups where parent_id = new.id) then
    raise exception '% is a department with categories in it, so it can''t go inside another', new.name;
  end if;
  return new;
end $$;
create trigger stock_groups_parent before insert or update of parent_id on stock_groups
  for each row execute function stock_group_parent_check();

-- ---------- the department's defaults, where the product and its category have none ----------

CREATE OR REPLACE FUNCTION public.stock_levels(p_business uuid)
 RETURNS TABLE(item_id uuid, min_stock numeric, counted_on date, on_hand numeric)
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
  select i.id,
         coalesce(i.min_stock, g.min_stock, pg.min_stock),
         c.count_date,
         case when c.count_date is not null
              then round(c.qty + coalesce(r.qty, 0) - coalesce(s.qty, 0), 3) end
  from stock_items i
  left join stock_groups g on g.id = i.group_id
  left join stock_groups pg on pg.id = g.parent_id
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
    and coalesce(i.min_stock, g.min_stock, pg.min_stock) is not null
    and is_member(p_business)
$function$;

create or replace view v_stock_batches as
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
left join stock_groups pg on pg.id = g.parent_id
cross join lateral (select coalesce(i.clearance_days, g.clearance_days, pg.clearance_days, 7) as days) w
where b.status in ('active', 'on_clearance');
alter view v_stock_batches set (security_invoker = on);

commit;
