-- A product can sit in more than one place: Coke in the fridge, its spare cartons in the store room.
--
-- stock_item_places lists every location a product is counted at, with its position on that
-- shelf. A product with no rows counts wherever its category is kept (as before). On the count
-- sheet it comes up at each of its places; the figures are added up into the line's qty, and
-- place_qty keeps the split ({location id: qty}) so you can see where the stock was.
begin;

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

-- Products already placed by hand keep their place and position.
insert into stock_item_places (business_id, item_id, location_id, sort)
select business_id, id, location_id, location_sort from stock_items where location_id is not null;

drop function set_location_order(uuid, uuid[]);
alter table stock_items drop column location_id, drop column location_sort;

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

commit;
