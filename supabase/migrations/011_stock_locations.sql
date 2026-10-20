-- Where things physically sit, so a stock take is one walk round the shop.
--
-- A location is a spot you count from: "Shelf 1 side 1", "Drinks fridge door 2", "Store room
-- shelf 3". Locations are walked in their own order. Categories are put into a location
-- ("Shelf 1 side 1 is Health & Beauty"), and a category can sit in more than one (Drinks across
-- three fridge doors). A product counts in its own location when it has one, otherwise in the
-- first location holding its category, so new products land in the right place on their own.
-- Within a location products follow location_sort when it's been arranged, else by category
-- then name.
begin;

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

commit;
