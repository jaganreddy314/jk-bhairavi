-- Stock alerts: running low, and stock getting close to its expiry date.
--
-- Low stock. A category (Drinks) or a single product can have a minimum. Stock on hand is
-- estimated from the last finished count, plus what has been received on orders since, less
-- what the till says has sold since. It is only as fresh as the item sales: a week imported
-- on Monday leaves the days before it unsold, so the page always says when it was counted.
--
-- Expiry. When someone checks dates — on delivery or walking the shelves — they note each
-- expiry date found against the product: "8 expire 24 Nov, 12 expire 9 Dec". Each date is a
-- batch. A batch is due for clearance `clearance_days` before it expires (set on the product,
-- else its category, else a week) and stays on the alerts list every day after that until it
-- is marked cleared or written off. Batches don't touch counts or the food cost.
begin;

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

commit;
