-- Schedule: the weekly roster.
--
-- A shift is one person, one day, a start and finish (minutes after midnight) and an unpaid
-- break. A week is a draft until it's published; changing a published week marks it as
-- having changes not yet sent. Costs are worked out in the app from the award rates, so a
-- roster always shows today's rates and nothing stored here goes stale.
--
-- A new "roster" area opens the Schedule. Owners have it; Managers get it.
begin;

-- ---------- the new area ----------
alter table security_groups drop constraint security_groups_perms_known;
alter table security_groups add constraint security_groups_perms_known
  check (perms <@ array['finance','sales','purchasing','stock','catalogue','people','roster','payroll','sensitive','admin']);

create or replace function seed_security_groups(b uuid) returns uuid
language plpgsql security definer set search_path = public as $$
declare owner_id uuid;
begin
  insert into security_groups (business_id, name, description, perms, is_owner, sort)
  values (b, 'Owner', 'Everything, including tax, bank and super details, and who can sign in.',
          array['finance','sales','purchasing','stock','catalogue','people','roster','payroll','sensitive','admin'], true, 10)
  on conflict (business_id, name) do update set is_owner = true
  returning id into owner_id;
  insert into security_groups (business_id, name, description, perms, sort) values
    (b, 'Manager', 'Runs the shop: money, ordering, stock, the catalogue, the team and the roster. No tax, bank or super details.',
        array['finance','sales','purchasing','stock','catalogue','people','roster','payroll'], 20),
    (b, 'Staff', 'Enters the day''s sales and counts stock.', array['sales','stock'], 30)
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
    new.perms := array['finance','sales','purchasing','stock','catalogue','people','roster','payroll','sensitive','admin'];
  end if;
  if tg_op = 'UPDATE' and not old.is_owner then
    new.is_owner := false;
  end if;
  return coalesce(new, old);
end $$;

update security_groups set perms = perms || array['roster'] where is_owner;
update security_groups set perms = perms || array['roster']
where name = 'Manager' and not 'roster' = any(perms);

-- ---------- public holidays ----------
-- Region 'QLD' is statewide; 'QLD-BNE' adds the Brisbane-area show day. from_minute is for
-- part-day holidays (Christmas Eve, 6pm to midnight).
create table public_holidays (
  holiday_date date not null,
  region text not null,
  name text not null,
  from_minute int not null default 0,
  primary key (holiday_date, region)
);
alter table public_holidays enable row level security;
create policy "anyone signed in reads" on public_holidays for select to authenticated using (true);
create policy "payroll edits" on public_holidays for all to authenticated
  using (has_perm_anywhere('payroll')) with check (has_perm_anywhere('payroll'));

-- Queensland Government, qld.gov.au/recreation/travel/holidays/public
insert into public_holidays (holiday_date, region, name, from_minute) values
  ('2026-01-01', 'QLD', 'New Year''s Day', 0),
  ('2026-01-26', 'QLD', 'Australia Day', 0),
  ('2026-04-03', 'QLD', 'Good Friday', 0),
  ('2026-04-04', 'QLD', 'The day after Good Friday', 0),
  ('2026-04-05', 'QLD', 'Easter Sunday', 0),
  ('2026-04-06', 'QLD', 'Easter Monday', 0),
  ('2026-04-25', 'QLD', 'Anzac Day', 0),
  ('2026-05-04', 'QLD', 'Labour Day', 0),
  ('2026-08-12', 'QLD-BNE', 'Royal Queensland Show (Brisbane area)', 0),
  ('2026-10-05', 'QLD', 'King''s Birthday', 0),
  ('2026-12-24', 'QLD', 'Christmas Eve (from 6pm)', 1080),
  ('2026-12-25', 'QLD', 'Christmas Day', 0),
  ('2026-12-26', 'QLD', 'Boxing Day', 0),
  ('2026-12-28', 'QLD', 'Boxing Day (additional day)', 0),
  ('2027-01-01', 'QLD', 'New Year''s Day', 0),
  ('2027-01-26', 'QLD', 'Australia Day', 0),
  ('2027-03-26', 'QLD', 'Good Friday', 0),
  ('2027-03-27', 'QLD', 'The day after Good Friday', 0),
  ('2027-03-28', 'QLD', 'Easter Sunday', 0),
  ('2027-03-29', 'QLD', 'Easter Monday', 0),
  ('2027-04-26', 'QLD', 'Anzac Day (observed)', 0),
  ('2027-05-03', 'QLD', 'Labour Day', 0),
  ('2027-08-11', 'QLD-BNE', 'Royal Queensland Show (Brisbane area)', 0),
  ('2027-10-04', 'QLD', 'King''s Birthday', 0),
  ('2027-12-24', 'QLD', 'Christmas Eve (from 6pm)', 1080),
  ('2027-12-25', 'QLD', 'Christmas Day', 0),
  ('2027-12-26', 'QLD', 'Boxing Day', 0),
  ('2027-12-27', 'QLD', 'Christmas Day (additional day)', 0),
  ('2027-12-28', 'QLD', 'Boxing Day (additional day)', 0);

-- ---------- roster settings ----------
alter table payroll_settings
  add column holiday_region text not null default 'QLD-BNE' check (holiday_region in ('QLD','QLD-BNE')),
  add column store_open int not null default 360 check (store_open between 0 and 1440),     -- 6am
  add column store_close int not null default 1320 check (store_close between 0 and 1440);  -- 10pm

-- Part-time employees work agreed days; 1 = Monday … 7 = Sunday.
alter table staff add column agreed_dows int[];

-- When someone can work, by weekday. No row = available all day.
create table staff_availability (
  staff_id uuid not null references staff(id) on delete cascade,
  business_id uuid not null references businesses(id),
  dow int not null check (dow between 1 and 7),
  available boolean not null default true,
  from_minute int check (from_minute between 0 and 1440),   -- only from this time (e.g. after school)
  to_minute int check (to_minute between 0 and 1440),       -- only until this time
  note text,
  primary key (staff_id, dow)
);
alter table staff_availability enable row level security;
create policy "team reads availability" on staff_availability for select to authenticated
  using (has_perm(business_id, 'roster') or has_perm(business_id, 'people') or has_perm(business_id, 'payroll'));
create policy "roster or payroll writes availability" on staff_availability for all to authenticated
  using (has_perm(business_id, 'roster') or has_perm(business_id, 'payroll'))
  with check (has_perm(business_id, 'roster') or has_perm(business_id, 'payroll'));

-- ---------- shifts and weeks ----------
create table shifts (
  id uuid primary key default gen_random_uuid(),
  business_id uuid not null references businesses(id),
  staff_id uuid not null references staff(id) on delete cascade,
  shift_date date not null,
  start_minute int not null check (start_minute between 0 and 1440),
  end_minute int not null check (end_minute between 0 and 1440),
  break_minutes int not null default 0 check (break_minutes >= 0),
  note text,
  created_at timestamptz not null default now(),
  constraint shifts_finish_after_start check (end_minute > start_minute),
  constraint shifts_break_fits check (break_minutes < end_minute - start_minute)
);
create index on shifts (business_id, shift_date);
create index on shifts (staff_id, shift_date);

create table roster_weeks (
  business_id uuid not null references businesses(id) on delete cascade,
  week_start date not null,
  published_at timestamptz,
  changed_since_publish boolean not null default false,
  primary key (business_id, week_start)
);

do $$
declare t text;
begin
  foreach t in array array['shifts','roster_weeks'] loop
    execute format('alter table %I enable row level security', t);
    execute format('create policy "team reads" on %I for select to authenticated using (has_perm(business_id, ''roster'') or has_perm(business_id, ''people'') or has_perm(business_id, ''payroll''))', t);
    execute format('create policy "roster writes" on %I for all to authenticated using (has_perm(business_id, ''roster'')) with check (has_perm(business_id, ''roster''))', t);
  end loop;
end $$;

-- Changing a published week's shifts flags it, so "Send changes" knows there's something new.
create or replace function shift_marks_week_changed() returns trigger
language plpgsql security definer set search_path = public as $$
declare d date := coalesce(new.shift_date, old.shift_date); b uuid := coalesce(new.business_id, old.business_id);
begin
  update roster_weeks set changed_since_publish = true
  where business_id = b and week_start = d - ((extract(isodow from d)::int) - 1) and published_at is not null;
  if tg_op = 'UPDATE' and old.shift_date is distinct from new.shift_date then
    update roster_weeks set changed_since_publish = true
    where business_id = old.business_id and week_start = old.shift_date - ((extract(isodow from old.shift_date)::int) - 1) and published_at is not null;
  end if;
  return coalesce(new, old);
end $$;
create trigger shifts_mark_week_changed after insert or update or delete on shifts
  for each row execute function shift_marks_week_changed();

-- What the roster needs to know about each person, for anyone who can see the roster:
-- enough to cost and check shifts, without contact details or anything sensitive.
create or replace function roster_people(p_business uuid)
returns table (
  id uuid, name text, first_name text, last_name text, kind text, status text, employment_type text,
  date_of_birth date, award_code text, classification_id uuid, above_award numeric, ordinary_hours numeric,
  agreed_dows int[], fortnight_hour_limit numeric, start_date date, end_date date, role_title text
)
language sql stable security definer set search_path = public as $$
  select s.id, s.name, s.first_name, s.last_name, s.kind, s.status, s.employment_type,
         s.date_of_birth, s.award_code, s.classification_id, s.above_award, s.ordinary_hours,
         s.agreed_dows, s.fortnight_hour_limit, s.start_date, s.end_date, s.role_title
  from staff s
  where s.business_id = p_business and s.kind = 'employee'
    and (has_perm(p_business, 'roster') or has_perm(p_business, 'people') or has_perm(p_business, 'payroll'))
  order by s.name
$$;

commit;
