-- Fridge temperatures: the daily food-safety log.
--
-- Each business lists its own fridges, freezers and display units, each with the range it
-- should hold (a fridge 0–5 °C, a freezer -25 to -15 °C). Staff read the thermometer and log
-- it, once or several times a day. A reading outside the range asks what was done about it,
-- and that note stays with the reading. Readings are a record: a fridge that has any is
-- retired, never deleted, and who logged each reading is written down when it's saved.
--
-- A new "temps" area opens the page. Owners, Managers and Staff all get it.
begin;

-- ---------- the new area ----------
alter table security_groups drop constraint security_groups_perms_known;
alter table security_groups add constraint security_groups_perms_known
  check (perms <@ array['finance','sales','purchasing','stock','catalogue','temps','people','roster','payroll','sensitive','admin']);

create or replace function seed_security_groups(b uuid) returns uuid
language plpgsql security definer set search_path = public as $$
declare owner_id uuid;
begin
  insert into security_groups (business_id, name, description, perms, is_owner, sort)
  values (b, 'Owner', 'Everything, including tax, bank and super details, and who can sign in.',
          array['finance','sales','purchasing','stock','catalogue','temps','people','roster','payroll','sensitive','admin'], true, 10)
  on conflict (business_id, name) do update set is_owner = true
  returning id into owner_id;
  insert into security_groups (business_id, name, description, perms, sort) values
    (b, 'Manager', 'Runs the shop: money, ordering, stock, the catalogue, the team and the roster. No tax, bank or super details.',
        array['finance','sales','purchasing','stock','catalogue','temps','people','roster','payroll'], 20),
    (b, 'Staff', 'Enters the day''s sales, counts stock and logs fridge temperatures.', array['sales','stock','temps'], 30)
  on conflict (business_id, name) do nothing;
  return owner_id;
end $$;
revoke execute on function seed_security_groups(uuid) from public, anon, authenticated;

create or replace function protect_owner_group() returns trigger
language plpgsql as $$
begin
  if tg_op = 'DELETE' and old.is_owner and exists (select 1 from businesses where id = old.business_id) then
    raise exception 'The Owner group can''t be removed';
  end if;
  if tg_op = 'UPDATE' and old.is_owner then
    new.is_owner := true;
    new.perms := array['finance','sales','purchasing','stock','catalogue','temps','people','roster','payroll','sensitive','admin'];
  end if;
  if tg_op = 'UPDATE' and not old.is_owner then
    new.is_owner := false;
  end if;
  return coalesce(new, old);
end $$;

update security_groups set perms = perms || array['temps'] where is_owner;
update security_groups set perms = perms || array['temps']
where name in ('Manager', 'Staff') and not 'temps' = any(perms);

-- ---------- fridges ----------

create table fridges (
  id uuid primary key default gen_random_uuid(),
  business_id uuid not null references businesses(id),
  name text not null check (trim(name) <> ''),
  kind text not null default 'fridge' check (kind in ('fridge', 'freezer', 'hot')),
  min_temp numeric(4,1),            -- null = no lower limit
  max_temp numeric(4,1),            -- null = no upper limit
  active boolean not null default true,
  sort int not null default 0,
  created_at timestamptz not null default now(),
  check (min_temp is null or max_temp is null or min_temp <= max_temp)
);
create index on fridges (business_id, sort);
create unique index fridges_name on fridges (business_id, lower(trim(name)));

alter table fridges enable row level security;
create policy "area read" on fridges for select to authenticated using (is_member(business_id));
create policy "area insert" on fridges for insert to authenticated with check (has_perm(business_id, 'temps'));
create policy "area update" on fridges for update to authenticated
  using (has_perm(business_id, 'temps')) with check (has_perm(business_id, 'temps'));
create policy "area delete" on fridges for delete to authenticated using (has_perm(business_id, 'temps'));

-- ---------- readings ----------

create table fridge_readings (
  id uuid primary key default gen_random_uuid(),
  business_id uuid not null references businesses(id),     -- copied from the fridge, for row-level security
  fridge_id uuid not null references fridges(id),          -- no cascade: a fridge with readings is retired, not deleted
  reading_date date not null default shop_today(),
  recorded_at timestamptz not null default now(),
  temp numeric(4,1) not null check (temp between -50 and 120),
  note text,                                               -- what was done when it was out of range
  recorded_by text,                                        -- their name in this business, else their email
  created_at timestamptz not null default now()
);
create index on fridge_readings (business_id, reading_date);
create index on fridge_readings (fridge_id, reading_date);

-- The business comes from the fridge, never the client. Who logged it comes from the sign-in.
create or replace function fridge_reading_defaults() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  select business_id into new.business_id from fridges where id = new.fridge_id;
  if new.business_id is null then
    raise exception 'Fridge not found';
  end if;
  if tg_op = 'INSERT' then
    new.recorded_at := now();
    select coalesce(nullif(trim(u.display_name), ''), u.email) into new.recorded_by
    from business_users u
    where u.business_id = new.business_id and lower(u.email) = lower(auth.jwt() ->> 'email');
    new.recorded_by := coalesce(new.recorded_by, lower(auth.jwt() ->> 'email'));
  else
    new.recorded_at := old.recorded_at;
    new.recorded_by := old.recorded_by;
  end if;
  new.note := nullif(trim(new.note), '');
  return new;
end $$;

create trigger fridge_readings_defaults before insert or update on fridge_readings
  for each row execute function fridge_reading_defaults();

alter table fridge_readings enable row level security;
create policy "area read" on fridge_readings for select to authenticated using (is_member(business_id));
create policy "area insert" on fridge_readings for insert to authenticated with check (has_perm(business_id, 'temps'));
create policy "area update" on fridge_readings for update to authenticated
  using (has_perm(business_id, 'temps')) with check (has_perm(business_id, 'temps'));
create policy "area delete" on fridge_readings for delete to authenticated using (has_perm(business_id, 'temps'));

commit;
