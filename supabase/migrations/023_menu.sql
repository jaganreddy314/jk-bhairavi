-- The menu: what the shop sells, as opposed to the catalogue, which is what it buys and counts.
--
-- A menu item has a price, or comes in sizes that each have their own (a coffee is Small,
-- Regular or Large; the size replaces the price rather than adding to it). Option groups are
-- the questions asked when it's ordered: how the fish is cooked, salt or lemon, which salad.
-- One group is shared by every item that asks it, and an item can ask it differently: a pack
-- of six fish asks "Cook option" six times, so its link says choose exactly 6, repeats allowed.
--
-- The till reads the whole menu in one call (menu_snapshot) and keeps it on the device, so it
-- carries on taking orders when the connection drops. Menus are loaded and refreshed with
-- import_menu, which matches on names and till codes, so running it again updates prices
-- instead of adding a second copy.
--
-- Everyone in the business can read the menu; the Catalogue area edits it.
begin;

-- ---------- categories and items ----------

create table menu_categories (
  id uuid primary key default gen_random_uuid(),
  business_id uuid not null references businesses(id),
  name text not null check (trim(name) <> ''),
  sort int not null default 0,
  active boolean not null default true,
  created_at timestamptz not null default now()
);
create index on menu_categories (business_id, sort);
create unique index menu_categories_name on menu_categories (business_id, lower(trim(name)));

create table menu_items (
  id uuid primary key default gen_random_uuid(),
  business_id uuid not null references businesses(id),
  category_id uuid not null references menu_categories(id),
  name text not null check (trim(name) <> ''),
  description text,
  plu text check (trim(plu) <> ''),          -- the code the till and online ordering know it by (FF01)
  price numeric(10,2) check (price >= 0),    -- GST included; null when it comes in sizes
  -- Fresh, uncooked food is GST-free; anything cooked or served is not.
  gst_free boolean not null default false,
  image_url text,
  -- What it is in the catalogue, when it's sold as bought (a can of Coke), so sales can be
  -- counted against stock. Cooked food is made from several products and isn't linked here.
  stock_item_id uuid references stock_items(id) on delete set null,
  active boolean not null default true,
  sort int not null default 0,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index on menu_items (business_id, category_id, sort);
create unique index menu_items_plu on menu_items (business_id, plu) where plu is not null;
create unique index menu_items_name on menu_items (category_id, lower(trim(name)));

create table menu_item_sizes (
  id uuid primary key default gen_random_uuid(),
  business_id uuid not null references businesses(id),
  item_id uuid not null references menu_items(id) on delete cascade,
  name text not null check (trim(name) <> ''),
  price numeric(10,2) not null check (price >= 0),
  plu text check (trim(plu) <> ''),
  stock_item_id uuid references stock_items(id) on delete set null,
  sort int not null default 0,
  active boolean not null default true
);
create index on menu_item_sizes (item_id, sort);
create unique index menu_item_sizes_name on menu_item_sizes (item_id, lower(trim(name)));

-- ---------- option groups ----------

create table modifier_groups (
  id uuid primary key default gen_random_uuid(),
  business_id uuid not null references businesses(id),
  name text not null check (trim(name) <> ''),
  -- How many to choose, unless an item says otherwise. min 0 = optional.
  min_choices int not null default 0 check (min_choices >= 0),
  max_choices int not null default 1 check (max_choices >= 1),
  -- May the same option be chosen more than once? (Cod ×2, Snapper ×1 in a pack of three.)
  repeat boolean not null default false,
  created_at timestamptz not null default now(),
  check (min_choices <= max_choices)
);
create unique index modifier_groups_name on modifier_groups (business_id, lower(trim(name)));

create table modifier_options (
  id uuid primary key default gen_random_uuid(),
  business_id uuid not null references businesses(id),
  group_id uuid not null references modifier_groups(id) on delete cascade,
  name text not null check (trim(name) <> ''),
  price numeric(10,2) not null default 0 check (price >= 0),   -- added to the item's price
  sort int not null default 0,
  active boolean not null default true
);
create index on modifier_options (group_id, sort);
create unique index modifier_options_name on modifier_options (group_id, lower(trim(name)));

-- Which groups an item asks, in order. Null limits mean the group's own.
create table menu_item_modifiers (
  business_id uuid not null references businesses(id),
  item_id uuid not null references menu_items(id) on delete cascade,
  group_id uuid not null references modifier_groups(id) on delete cascade,
  min_choices int check (min_choices >= 0),
  max_choices int check (max_choices >= 1),
  repeat boolean,
  sort int not null default 0,
  primary key (item_id, group_id),
  check (min_choices is null or max_choices is null or min_choices <= max_choices)
);
create index on menu_item_modifiers (group_id);

-- Child rows take their business from their parent, never from the browser, and an item can
-- only ask a group from its own business.
create or replace function menu_business_from_parent() returns trigger
language plpgsql security definer set search_path = public as $$
declare b uuid;
begin
  if tg_table_name = 'menu_items' then
    select business_id into b from menu_categories where id = new.category_id;
  elsif tg_table_name = 'menu_item_sizes' then
    select business_id into b from menu_items where id = new.item_id;
  elsif tg_table_name = 'modifier_options' then
    select business_id into b from modifier_groups where id = new.group_id;
  else
    select business_id into b from menu_items where id = new.item_id;
    if not exists (select 1 from modifier_groups where id = new.group_id and business_id = b) then
      raise exception 'Option group not found';
    end if;
  end if;
  if b is null then
    raise exception 'Parent row not found';
  end if;
  new.business_id := b;
  return new;
end $$;

create trigger menu_items_business before insert or update of category_id, business_id on menu_items
  for each row execute function menu_business_from_parent();
create trigger menu_item_sizes_business before insert or update of item_id, business_id on menu_item_sizes
  for each row execute function menu_business_from_parent();
create trigger modifier_options_business before insert or update of group_id, business_id on modifier_options
  for each row execute function menu_business_from_parent();
create trigger menu_item_modifiers_business before insert or update on menu_item_modifiers
  for each row execute function menu_business_from_parent();

create or replace function menu_item_touch() returns trigger
language plpgsql as $$
begin
  new.updated_at := now();
  return new;
end $$;
create trigger menu_items_touch before update on menu_items
  for each row execute function menu_item_touch();

-- ---------- access ----------

do $$
declare t text;
begin
  foreach t in array array['menu_categories', 'menu_items', 'menu_item_sizes', 'modifier_groups', 'modifier_options', 'menu_item_modifiers'] loop
    execute format('alter table %I enable row level security', t);
    execute format('create policy "members read" on %I for select to authenticated using (is_member(business_id))', t);
    execute format('create policy "catalogue insert" on %I for insert to authenticated with check (has_perm(business_id, ''catalogue''))', t);
    execute format('create policy "catalogue update" on %I for update to authenticated
      using (has_perm(business_id, ''catalogue'')) with check (has_perm(business_id, ''catalogue''))', t);
    execute format('create policy "catalogue delete" on %I for delete to authenticated using (has_perm(business_id, ''catalogue''))', t);
  end loop;
end $$;

-- ---------- the whole menu in one read ----------

-- What the till keeps on the device: active categories, items, sizes and option groups, in
-- order, with each item's own limits already worked out. Runs as the caller.
create or replace function menu_snapshot(p_business uuid) returns jsonb
language sql stable set search_path = public as $$
  select jsonb_build_object(
    'business_id', p_business,
    'taken_at', now(),
    'categories', coalesce((
      select jsonb_agg(jsonb_build_object(
        'id', c.id, 'name', c.name,
        'items', coalesce((
          select jsonb_agg(jsonb_build_object(
            'id', i.id, 'name', i.name, 'description', i.description, 'plu', i.plu,
            'price', i.price, 'gst_free', i.gst_free, 'image_url', i.image_url,
            'sizes', coalesce((
              select jsonb_agg(jsonb_build_object('id', s.id, 'name', s.name, 'price', s.price, 'plu', s.plu) order by s.sort, s.name)
              from menu_item_sizes s where s.item_id = i.id and s.active), '[]'),
            'groups', coalesce((
              select jsonb_agg(jsonb_build_object(
                'id', g.id, 'name', g.name,
                'min', coalesce(m.min_choices, g.min_choices),
                'max', coalesce(m.max_choices, g.max_choices),
                'repeat', coalesce(m.repeat, g.repeat),
                'options', coalesce((
                  select jsonb_agg(jsonb_build_object('id', o.id, 'name', o.name, 'price', o.price) order by o.sort, o.name)
                  from modifier_options o where o.group_id = g.id and o.active), '[]')
              ) order by m.sort, g.name)
              from menu_item_modifiers m join modifier_groups g on g.id = m.group_id
              where m.item_id = i.id), '[]')
          ) order by i.sort, i.name)
          from menu_items i
          where i.category_id = c.id and i.active
            and (i.price is not null or exists (select 1 from menu_item_sizes s where s.item_id = i.id and s.active))
        ), '[]')
      ) order by c.sort, c.name)
      from menu_categories c where c.business_id = p_business and c.active
    ), '[]')
  )
$$;
grant execute on function menu_snapshot(uuid) to authenticated;

-- ---------- loading a menu ----------

-- Loads or refreshes a menu from one JSON document:
--   { "categories": [{ "name" }],
--     "groups":     [{ "name", "min", "max", "repeat", "options": [{ "name", "price" }] }],
--     "items":      [{ "category", "name", "plu", "description", "price", "gst_free", "image_url",
--                      "sizes":  [{ "name", "price", "plu" }],
--                      "groups": [{ "name", "min", "max", "repeat" }] }] }
-- Matches what's already there by name (items by till code first), updates it, and adds what's
-- new. Nothing is deleted or hidden, so a hand-made change to something the import doesn't
-- mention is left alone. Order follows the document. Runs as the caller.
create or replace function import_menu(p_business uuid, p_menu jsonb) returns jsonb
language plpgsql set search_path = public as $$
declare
  r jsonb; s jsonb; k int; j int;
  v_cat uuid; v_item uuid; v_group uuid;
  n_items int := 0; n_new int := 0;
begin
  -- The app calls this as the signed-in person; an admin loading a menu with psql is postgres.
  if not has_perm(p_business, 'catalogue') and current_user <> 'postgres' then
    raise exception 'Needs the Catalogue area in this business';
  end if;
  if not exists (select 1 from businesses where id = p_business) then
    raise exception 'Business not found';
  end if;

  k := 0;
  for r in select * from jsonb_array_elements(coalesce(p_menu->'categories', '[]')) loop
    k := k + 1;
    insert into menu_categories (business_id, name, sort) values (p_business, trim(r->>'name'), k * 10)
    on conflict (business_id, lower(trim(name))) do update set sort = excluded.sort;
  end loop;

  for r in select * from jsonb_array_elements(coalesce(p_menu->'groups', '[]')) loop
    insert into modifier_groups (business_id, name, min_choices, max_choices, repeat)
    values (p_business, trim(r->>'name'), coalesce((r->>'min')::int, 0), coalesce((r->>'max')::int, 1), coalesce((r->>'repeat')::boolean, false))
    on conflict (business_id, lower(trim(name))) do update
      set min_choices = excluded.min_choices, max_choices = excluded.max_choices, repeat = excluded.repeat
    returning id into v_group;
    j := 0;
    for s in select * from jsonb_array_elements(coalesce(r->'options', '[]')) loop
      j := j + 1;
      insert into modifier_options (business_id, group_id, name, price, sort)
      values (p_business, v_group, trim(s->>'name'), coalesce((s->>'price')::numeric, 0), j * 10)
      on conflict (group_id, lower(trim(name))) do update set price = excluded.price, sort = excluded.sort;
    end loop;
  end loop;

  k := 0;
  for r in select * from jsonb_array_elements(coalesce(p_menu->'items', '[]')) loop
    k := k + 1;
    select id into v_cat from menu_categories
    where business_id = p_business and lower(trim(name)) = lower(trim(r->>'category'));
    if v_cat is null then
      insert into menu_categories (business_id, name, sort)
      values (p_business, trim(r->>'category'), (select coalesce(max(sort), 0) + 10 from menu_categories where business_id = p_business))
      returning id into v_cat;
    end if;

    v_item := null;
    if nullif(trim(r->>'plu'), '') is not null then
      select id into v_item from menu_items where business_id = p_business and plu = trim(r->>'plu');
    end if;
    if v_item is null then
      select id into v_item from menu_items where category_id = v_cat and lower(trim(name)) = lower(trim(r->>'name'));
    end if;

    if v_item is null then
      insert into menu_items (business_id, category_id, name, description, plu, price, gst_free, image_url, sort)
      values (p_business, v_cat, trim(r->>'name'), nullif(trim(r->>'description'), ''), nullif(trim(r->>'plu'), ''),
              (r->>'price')::numeric, coalesce((r->>'gst_free')::boolean, false), nullif(r->>'image_url', ''), k * 10)
      returning id into v_item;
      n_new := n_new + 1;
    else
      update menu_items set
        category_id = v_cat, name = trim(r->>'name'),
        description = coalesce(nullif(trim(r->>'description'), ''), description),
        plu = coalesce(nullif(trim(r->>'plu'), ''), plu),
        price = (r->>'price')::numeric,
        gst_free = coalesce((r->>'gst_free')::boolean, gst_free),
        image_url = coalesce(nullif(r->>'image_url', ''), image_url),
        sort = k * 10
      where id = v_item;
    end if;
    n_items := n_items + 1;

    j := 0;
    for s in select * from jsonb_array_elements(coalesce(r->'sizes', '[]')) loop
      j := j + 1;
      insert into menu_item_sizes (business_id, item_id, name, price, plu, sort)
      values (p_business, v_item, trim(s->>'name'), (s->>'price')::numeric, nullif(trim(s->>'plu'), ''), j * 10)
      on conflict (item_id, lower(trim(name))) do update
        set price = excluded.price, plu = coalesce(excluded.plu, menu_item_sizes.plu), sort = excluded.sort;
    end loop;

    j := 0;
    for s in select * from jsonb_array_elements(coalesce(r->'groups', '[]')) loop
      j := j + 1;
      select id into v_group from modifier_groups
      where business_id = p_business and lower(trim(name)) = lower(trim(s->>'name'));
      if v_group is null then
        raise exception 'Option group "%" (on %) isn''t in the menu''s groups', s->>'name', r->>'name';
      end if;
      insert into menu_item_modifiers (business_id, item_id, group_id, min_choices, max_choices, repeat, sort)
      values (p_business, v_item, v_group, (s->>'min')::int, (s->>'max')::int, (s->>'repeat')::boolean, j * 10)
      on conflict (item_id, group_id) do update
        set min_choices = excluded.min_choices, max_choices = excluded.max_choices, repeat = excluded.repeat, sort = excluded.sort;
    end loop;
  end loop;

  return jsonb_build_object('items', n_items, 'new', n_new);
end $$;
grant execute on function import_menu(uuid, jsonb) to authenticated;

commit;
