-- Roster positions: each business's own list of the jobs people do on a shift (Console,
-- Driveway, Kitchen, Front counter…), in the order the roster shows them, and where each
-- person sits in that order. Not tied to pay: the award classification still sets the rate.
--
-- Kept apart from staff so that whoever does the roster can arrange it without being able
-- to edit employee records (staff writes need the payroll area).
begin;

create table roster_positions (
  id uuid primary key default gen_random_uuid(),
  business_id uuid not null references businesses(id) on delete cascade,
  name text not null check (length(trim(name)) between 1 and 40),
  sort int not null default 0,
  created_at timestamptz not null default now()
);
create unique index roster_positions_name on roster_positions (business_id, lower(trim(name)));

create table staff_roster (
  staff_id uuid primary key references staff(id) on delete cascade,
  business_id uuid not null references businesses(id) on delete cascade,
  position_id uuid references roster_positions(id) on delete set null,
  sort int not null default 0
);
create index on staff_roster (position_id);

-- The business always comes from the person, and the position must be one of that business's.
create or replace function staff_roster_check() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  select business_id into new.business_id from staff where id = new.staff_id;
  if new.position_id is not null and not exists (
    select 1 from roster_positions where id = new.position_id and business_id = new.business_id
  ) then
    raise exception 'That position belongs to another business';
  end if;
  return new;
end $$;
create trigger staff_roster_check before insert or update on staff_roster
  for each row execute function staff_roster_check();

alter table roster_positions enable row level security;
alter table staff_roster enable row level security;
create policy "team reads" on roster_positions for select to authenticated
  using (has_perm(business_id, 'roster') or has_perm(business_id, 'people') or has_perm(business_id, 'payroll'));
create policy "roster or payroll arranges" on roster_positions for all to authenticated
  using (has_perm(business_id, 'roster') or has_perm(business_id, 'payroll'))
  with check (has_perm(business_id, 'roster') or has_perm(business_id, 'payroll'));
create policy "team reads" on staff_roster for select to authenticated
  using (has_perm(business_id, 'roster') or has_perm(business_id, 'people') or has_perm(business_id, 'payroll'));
create policy "roster or payroll arranges" on staff_roster for all to authenticated
  using (has_perm(business_id, 'roster') or has_perm(business_id, 'payroll'))
  with check (has_perm(business_id, 'roster') or has_perm(business_id, 'payroll'));

-- The roster's people now carry their position and place in the order.
drop function roster_people(uuid);
create function roster_people(p_business uuid)
returns table (
  id uuid, name text, first_name text, last_name text, kind text, status text, employment_type text,
  date_of_birth date, award_code text, classification_id uuid, above_award numeric, ordinary_hours numeric,
  agreed_dows int[], fortnight_hour_limit numeric, start_date date, end_date date, role_title text,
  position_id uuid, roster_sort int
)
language sql stable security definer set search_path = public as $$
  select s.id, s.name, s.first_name, s.last_name, s.kind, s.status, s.employment_type,
         s.date_of_birth, s.award_code, s.classification_id, s.above_award, s.ordinary_hours,
         s.agreed_dows, s.fortnight_hour_limit, s.start_date, s.end_date, s.role_title,
         r.position_id, r.sort
  from staff s
  left join staff_roster r on r.staff_id = s.id
  where s.business_id = p_business and s.kind = 'employee'
    and (has_perm(p_business, 'roster') or has_perm(p_business, 'people') or has_perm(p_business, 'payroll'))
  order by s.name
$$;

commit;
