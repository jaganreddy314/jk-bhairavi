-- People, payroll and access.
--
-- 1. Security groups. Everyone who signs in belongs to one group per business, and the
--    group decides which areas they can open. Areas are deliberately coarse for now:
--      finance     Dashboard, expenses, standard expenses, food cost, item sales
--      sales       Enter sales
--      purchasing  Purchase orders
--      stock       Stock counts
--      catalogue   Food → Catalogue (products, suppliers, store layout)
--      people      People: the team and their employment details
--      payroll     Pay rates, awards and payroll setup; editing people
--      sensitive   Tax file numbers, bank accounts and super funds
--      admin       Settings, sign-in access and security groups
--    The Owner group always has every area and cannot be removed; a business always keeps
--    at least one owner. Existing sign-ins all start as owners, so nobody loses anything.
--
-- 2. Awards. Award classifications and their rates are shared by every business, so a rate
--    entered once (from the Fair Work pay guide) applies wherever that award is used. Rates
--    are dated, so last year's pay still works out at last year's rates.
--
-- 3. People. The staff table grows into the employee record; labour expenses keep pointing
--    at it. Tax, super and bank details live in their own tables that only the "sensitive"
--    area can see. Tax file numbers and account numbers are encrypted with a key kept in
--    Supabase Vault and are never sent back to the browser — only their last digits are.
begin;

-- ============================================================================
-- 1. Security groups
-- ============================================================================

create table security_groups (
  id uuid primary key default gen_random_uuid(),
  business_id uuid not null references businesses(id) on delete cascade,
  name text not null,
  description text,
  perms text[] not null default '{}',
  is_owner boolean not null default false,
  sort int not null default 0,
  unique (business_id, name),
  constraint security_groups_perms_known check (perms <@ array['finance','sales','purchasing','stock','catalogue','people','payroll','sensitive','admin'])
);
create index on security_groups (business_id);

-- The three groups every business starts with. Returns the Owner group.
create or replace function seed_security_groups(b uuid) returns uuid
language plpgsql security definer set search_path = public as $$
declare owner_id uuid;
begin
  insert into security_groups (business_id, name, description, perms, is_owner, sort)
  values (b, 'Owner', 'Everything, including tax, bank and super details, and who can sign in.',
          array['finance','sales','purchasing','stock','catalogue','people','payroll','sensitive','admin'], true, 10)
  on conflict (business_id, name) do update set is_owner = true
  returning id into owner_id;
  insert into security_groups (business_id, name, description, perms, sort) values
    (b, 'Manager', 'Runs the shop: money, ordering, stock, the catalogue and the team. No tax, bank or super details.',
        array['finance','sales','purchasing','stock','catalogue','people','payroll'], 20),
    (b, 'Staff', 'Enters the day''s sales and counts stock.', array['sales','stock'], 30)
  on conflict (business_id, name) do nothing;
  return owner_id;
end $$;
revoke execute on function seed_security_groups(uuid) from public, anon, authenticated;

select seed_security_groups(id) from businesses;

alter table business_users add column group_id uuid references security_groups(id);
update business_users u set group_id = g.id
from security_groups g where g.business_id = u.business_id and g.is_owner;
alter table business_users alter column group_id set not null;

-- Someone added without a group gets the least access, never more.
create or replace function default_security_group() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  if new.group_id is null then
    select id into new.group_id from security_groups
    where business_id = new.business_id and not is_owner
    order by cardinality(perms), sort limit 1;
  end if;
  return new;
end $$;
create trigger business_users_default_group before insert on business_users
  for each row execute function default_security_group();

-- Does the signed-in person have this area in this business?
create or replace function has_perm(b uuid, p text) returns boolean
language sql stable security definer set search_path = public as $$
  select exists (
    select 1 from business_users u join security_groups g on g.id = u.group_id
    where u.business_id = b and lower(u.email) = lower(auth.jwt() ->> 'email')
      and (g.is_owner or p = any(g.perms))
  )
$$;

-- …in any business they belong to (for the shared award tables).
create or replace function has_perm_anywhere(p text) returns boolean
language sql stable security definer set search_path = public as $$
  select exists (
    select 1 from business_users u join security_groups g on g.id = u.group_id
    where lower(u.email) = lower(auth.jwt() ->> 'email') and (g.is_owner or p = any(g.perms))
  )
$$;

-- A business always keeps someone in its Owner group, so it can never be locked out.
create or replace function keep_an_owner() returns trigger
language plpgsql security definer set search_path = public as $$
declare b uuid := coalesce(old.business_id, new.business_id);
begin
  if not exists (select 1 from businesses where id = b) then
    return coalesce(new, old);   -- the business itself is being deleted
  end if;
  if not exists (
    select 1 from business_users u join security_groups g on g.id = u.group_id
    where u.business_id = b and g.is_owner
  ) then
    raise exception 'A business needs at least one person in the Owner group';
  end if;
  return coalesce(new, old);
end $$;
create constraint trigger business_users_keep_an_owner after update or delete on business_users
  deferrable initially deferred for each row execute function keep_an_owner();

-- The Owner group can't be deleted or have its areas trimmed.
create or replace function protect_owner_group() returns trigger
language plpgsql as $$
begin
  if tg_op = 'DELETE' and old.is_owner and exists (select 1 from businesses where id = old.business_id) then
    raise exception 'The Owner group can''t be removed';
  end if;
  if tg_op = 'UPDATE' and old.is_owner then
    new.is_owner := true;
    new.perms := array['finance','sales','purchasing','stock','catalogue','people','payroll','sensitive','admin'];
  end if;
  if tg_op = 'UPDATE' and not old.is_owner then
    new.is_owner := false;
  end if;
  return coalesce(new, old);
end $$;
create trigger security_groups_protect_owner before update or delete on security_groups
  for each row execute function protect_owner_group();

alter table security_groups enable row level security;
create policy "members read groups" on security_groups for select to authenticated using (is_member(business_id));
create policy "admins add groups" on security_groups for insert to authenticated with check (has_perm(business_id, 'admin') and not is_owner);
create policy "admins change groups" on security_groups for update to authenticated
  using (has_perm(business_id, 'admin')) with check (has_perm(business_id, 'admin'));
create policy "admins remove groups" on security_groups for delete to authenticated using (has_perm(business_id, 'admin'));

-- Sign-in access: anyone in the business can see who else is; only admins change it.
drop policy "add people to my businesses" on business_users;
drop policy "remove people from my businesses" on business_users;
create policy "admins add people" on business_users for insert to authenticated with check (has_perm(business_id, 'admin'));
create policy "admins change people" on business_users for update to authenticated
  using (has_perm(business_id, 'admin')) with check (has_perm(business_id, 'admin'));
create policy "admins remove people" on business_users for delete to authenticated using (has_perm(business_id, 'admin'));

drop policy "members rename business" on businesses;
create policy "admins rename business" on businesses for update to authenticated
  using (has_perm(id, 'admin')) with check (has_perm(id, 'admin'));

-- Every table, by area. Reading is open to the whole business where the data is needed
-- across screens (products, suppliers, orders, counts); money, people and settings are not.
do $$
declare r record;
begin
  for r in select * from (values
    -- table                 read                                           write
    ('sales_days',           $q$has_perm(business_id,'sales') or has_perm(business_id,'finance')$q$, $q$has_perm(business_id,'sales')$q$),
    ('expenses',             $q$has_perm(business_id,'finance')$q$,                                    $q$has_perm(business_id,'finance')$q$),
    ('recurring_expenses',   $q$has_perm(business_id,'finance')$q$,                                    $q$has_perm(business_id,'finance')$q$),
    ('item_sales',           $q$has_perm(business_id,'finance') or has_perm(business_id,'catalogue')$q$, $q$has_perm(business_id,'finance')$q$),
    ('item_aliases',         $q$has_perm(business_id,'finance') or has_perm(business_id,'catalogue')$q$, $q$has_perm(business_id,'finance')$q$),
    ('partners',             $q$has_perm(business_id,'admin')$q$,                                      $q$has_perm(business_id,'admin')$q$),
    ('partner_contributions',$q$has_perm(business_id,'admin')$q$,                                      $q$has_perm(business_id,'admin')$q$),
    ('setup_costs',          $q$has_perm(business_id,'admin')$q$,                                      $q$has_perm(business_id,'admin')$q$),
    ('staff',                $q$has_perm(business_id,'people') or has_perm(business_id,'payroll')$q$,  $q$has_perm(business_id,'payroll')$q$),
    ('suppliers',            $q$is_member(business_id)$q$, $q$has_perm(business_id,'catalogue') or has_perm(business_id,'purchasing') or has_perm(business_id,'finance')$q$),
    ('stock_groups',         $q$is_member(business_id)$q$, $q$has_perm(business_id,'catalogue')$q$),
    ('stock_items',          $q$is_member(business_id)$q$, $q$has_perm(business_id,'catalogue')$q$),
    ('stock_locations',      $q$is_member(business_id)$q$, $q$has_perm(business_id,'catalogue')$q$),
    ('stock_location_groups',$q$is_member(business_id)$q$, $q$has_perm(business_id,'catalogue')$q$),
    ('stock_item_places',    $q$is_member(business_id)$q$, $q$has_perm(business_id,'catalogue')$q$),
    ('item_suppliers',       $q$is_member(business_id)$q$, $q$has_perm(business_id,'catalogue') or has_perm(business_id,'purchasing')$q$),
    ('purchase_orders',      $q$is_member(business_id)$q$, $q$has_perm(business_id,'purchasing')$q$),
    ('purchase_order_lines', $q$is_member(business_id)$q$, $q$has_perm(business_id,'purchasing')$q$),
    ('stock_counts',         $q$is_member(business_id)$q$, $q$has_perm(business_id,'stock')$q$),
    ('stock_count_lines',    $q$is_member(business_id)$q$, $q$has_perm(business_id,'stock')$q$)
  ) as t(tbl, rd, wr)
  loop
    execute format('drop policy if exists "members read write" on %I', r.tbl);
    execute format('create policy "area read" on %I for select to authenticated using (%s)', r.tbl, r.rd);
    execute format('create policy "area insert" on %I for insert to authenticated with check (%s)', r.tbl, r.wr);
    execute format('create policy "area update" on %I for update to authenticated using (%s) with check (%s)', r.tbl, r.wr, r.wr);
    execute format('create policy "area delete" on %I for delete to authenticated using (%s)', r.tbl, r.wr);
  end loop;
end $$;

-- Names and wage rates for picking who a labour expense paid, without opening up the
-- rest of a person's record to everyone who enters expenses.
create or replace function staff_names(p_business uuid)
returns table (id uuid, name text, hourly_rate numeric, active boolean)
language sql stable security definer set search_path = public as $$
  select s.id, s.name, s.hourly_rate, s.active from staff s
  where s.business_id = p_business
    and (has_perm(p_business, 'finance') or has_perm(p_business, 'people') or has_perm(p_business, 'payroll'))
  order by s.name
$$;

-- ============================================================================
-- 2. Awards: shared by every business
-- ============================================================================

create table awards (
  code text primary key,                 -- MA000089
  name text not null,
  url text
);

-- One set of rules per group of classifications and year. Multipliers apply to the
-- classification's ordinary hourly rate; junior percentages apply first (the pay guides
-- work them out the same way). sat_pm is for awards that pay Saturday afternoons differently.
create table award_rule_sets (
  id uuid primary key default gen_random_uuid(),
  award_code text not null references awards(code) on delete cascade,
  key text not null,                     -- 'standard', 'console', …
  name text not null,
  effective_from date not null,
  ftpt jsonb not null,                   -- {"weekday":1,"sat":1.5,"sat_pm":1.5,"sun":2,"ph":2.5}
  casual jsonb not null,                 -- same keys, casual loading included
  junior jsonb not null,                 -- {"ftpt":{"u17":0.475,"17":0.5,…},"casual":{…}}
  extras jsonb not null default '{}',    -- late night loadings, minimum engagement, …
  notes text,
  unique (award_code, key, effective_from)
);

create table award_classifications (
  id uuid primary key default gen_random_uuid(),
  award_code text not null references awards(code) on delete cascade,
  rule_set_key text not null,
  code text not null,                    -- short label, e.g. 'Level 4'
  name text not null,
  sort int not null default 0,
  active boolean not null default true,
  unique (award_code, name)
);

create table award_rates (
  classification_id uuid not null references award_classifications(id) on delete cascade,
  effective_from date not null,
  weekly numeric(10,2) not null,
  hourly numeric(10,4) not null,
  primary key (classification_id, effective_from)
);

do $$
declare t text;
begin
  foreach t in array array['awards','award_rule_sets','award_classifications','award_rates'] loop
    execute format('alter table %I enable row level security', t);
    execute format('create policy "anyone signed in reads" on %I for select to authenticated using (true)', t);
    execute format('create policy "payroll edits" on %I for all to authenticated using (has_perm_anywhere(''payroll'')) with check (has_perm_anywhere(''payroll''))', t);
  end loop;
end $$;

-- ============================================================================
-- 3. People
-- ============================================================================

-- Per business: who the employer is and how pay runs.
create table payroll_settings (
  business_id uuid primary key references businesses(id) on delete cascade,
  legal_name text,
  abn text,
  address text,
  pay_frequency text not null default 'weekly' check (pay_frequency in ('weekly','fortnightly','monthly')),
  period_start_dow int not null default 1 check (period_start_dow between 1 and 7),   -- 1 = Monday
  pay_day_offset int not null default 2,     -- days after the period ends (Sunday + 2 = Tuesday)
  default_award_code text references awards(code),
  state text not null default 'QLD',
  super_rate numeric(5,2) not null default 12,
  super_payment_method text,
  stp_status text not null default 'not_connected'
);
alter table payroll_settings enable row level security;
create policy "people read settings" on payroll_settings for select to authenticated
  using (has_perm(business_id, 'people') or has_perm(business_id, 'payroll'));
create policy "payroll writes settings" on payroll_settings for all to authenticated
  using (has_perm(business_id, 'payroll')) with check (has_perm(business_id, 'payroll'));

-- The employee record.
alter table staff
  add column first_name text,
  add column last_name text,
  add column preferred_name text,
  add column email text,
  add column mobile text,
  add column date_of_birth date,
  add column address text,
  add column emergency_contact text,
  add column role_title text,
  add column employment_type text not null default 'casual' check (employment_type in ('full_time','part_time','casual')),
  add column status text not null default 'active' check (status in ('active','former')),
  add column start_date date,
  add column end_date date,
  add column award_code text references awards(code),
  add column classification_id uuid references award_classifications(id),
  add column above_award numeric(8,2) not null default 0,
  add column ordinary_hours numeric(5,2),     -- a week: agreed for part-time, usual for casual
  add column agreed_days text,                -- part-time: e.g. 'Mon, Tue, Thu · 6am – 2pm'
  add column visa_type text,
  add column visa_expiry date,
  add column fortnight_hour_limit numeric(5,2),  -- e.g. 48 for student visas in term
  add column right_to_work text,              -- 'Australian citizen', 'VEVO check', …
  add column right_to_work_checked_on date,
  add column fwis_given_on date,              -- Fair Work Information Statement
  add column ceis_given_on date,              -- Casual Employment Information Statement
  add column notes text,
  -- 'payee' rows are what some labour expenses were booked against ("Super", "Tax",
  -- "All staff members"): kept for those expenses, but not people on the team.
  add column kind text not null default 'employee' check (kind in ('employee','payee'));

update staff set kind = 'payee'
where lower(trim(name)) in ('super', 'tax', 'all staff members', 'all stuff members', 'all staff');

update staff set
  first_name = split_part(trim(name), ' ', 1),
  last_name = nullif(trim(substr(trim(name), length(split_part(trim(name), ' ', 1)) + 1)), ''),
  status = case when active then 'active' else 'former' end;

-- The short name shown around the app follows the legal name (or the preferred one).
create or replace function staff_display_name() returns trigger
language plpgsql as $$
begin
  if new.first_name is not null and new.kind = 'employee' then
    new.name := trim(coalesce(nullif(trim(new.preferred_name), ''), new.first_name) || ' ' || coalesce(new.last_name, ''));
  end if;
  -- Status is the source of truth; a change to "active" alone (the old staff list) still counts.
  if tg_op = 'UPDATE' and new.active is distinct from old.active and new.status = old.status then
    new.status := case when new.active then 'active' else 'former' end;
  elsif tg_op = 'INSERT' and new.active = false then
    new.status := 'former';
  end if;
  new.active := new.status = 'active';
  return new;
end $$;
create trigger staff_display_name before insert or update on staff
  for each row execute function staff_display_name();

-- Tax: only the "sensitive" area. The tax file number itself is encrypted and is not
-- readable through the API at all; tfn_last3 is what the screens show.
create table staff_tax (
  staff_id uuid primary key references staff(id) on delete cascade,
  business_id uuid not null references businesses(id),
  tfn_cipher bytea,
  tfn_last3 text,
  tfn_status text not null default 'missing' check (tfn_status in ('missing','provided','applied','under_18','pensioner','exempt')),
  declaration_date date,
  residency text check (residency in ('resident','foreign','working_holiday')),
  tax_free_threshold boolean,
  study_loan boolean,                         -- STSL: HELP, VSL, SFSS, SSL, TSL
  medicare_variation text,
  updated_at timestamptz not null default now()
);

create table staff_super (
  staff_id uuid primary key references staff(id) on delete cascade,
  business_id uuid not null references businesses(id),
  choice text not null default 'pending' check (choice in ('pending','chosen','stapled','default','smsf')),
  fund_name text,
  usi text,
  fund_abn text,
  member_number text,
  smsf_esa text,                              -- SMSF electronic service address
  smsf_bsb text,
  smsf_account text,
  extra_percent numeric(5,2),                 -- salary sacrifice / extra contributions
  updated_at timestamptz not null default now()
);

create table staff_bank (
  staff_id uuid primary key references staff(id) on delete cascade,
  business_id uuid not null references businesses(id),
  account_name text,
  bsb text,
  account_cipher bytea,
  account_last4 text,
  updated_at timestamptz not null default now()
);

create table staff_leave (
  staff_id uuid not null references staff(id) on delete cascade,
  business_id uuid not null references businesses(id),
  leave_type text not null check (leave_type in ('annual','personal','long_service')),
  hours numeric(8,2) not null default 0,
  as_of date not null default current_date,
  primary key (staff_id, leave_type)
);

alter table staff_tax enable row level security;
alter table staff_super enable row level security;
alter table staff_bank enable row level security;
alter table staff_leave enable row level security;

-- Tax and bank change only through the functions below, which encrypt; super can be
-- written directly by anyone allowed to see it.
create policy "sensitive reads tax" on staff_tax for select to authenticated using (has_perm(business_id, 'sensitive'));
create policy "sensitive reads bank" on staff_bank for select to authenticated using (has_perm(business_id, 'sensitive'));
create policy "sensitive reads and writes super" on staff_super for all to authenticated
  using (has_perm(business_id, 'sensitive')) with check (has_perm(business_id, 'sensitive'));
create policy "people read leave" on staff_leave for select to authenticated
  using (has_perm(business_id, 'people') or has_perm(business_id, 'payroll'));
create policy "payroll writes leave" on staff_leave for all to authenticated
  using (has_perm(business_id, 'payroll')) with check (has_perm(business_id, 'payroll'));

-- The encrypted columns never leave the database.
revoke select on staff_tax, staff_bank from anon, authenticated;
grant select (staff_id, business_id, tfn_last3, tfn_status, declaration_date, residency, tax_free_threshold,
              study_loan, medicare_variation, updated_at) on staff_tax to authenticated;
grant select (staff_id, business_id, account_name, bsb, account_last4, updated_at) on staff_bank to authenticated;
revoke insert, update, delete on staff_tax, staff_bank from anon, authenticated;

-- The key for those columns, generated once and kept in Vault.
do $$
begin
  if not exists (select 1 from vault.secrets where name = 'payroll_key') then
    perform vault.create_secret(encode(extensions.gen_random_bytes(32), 'hex'), 'payroll_key',
      'Encrypts tax file numbers and bank account numbers in staff_tax and staff_bank');
  end if;
end $$;

create or replace function payroll_key() returns text
language sql stable security definer set search_path = public as $$
  select decrypted_secret from vault.decrypted_secrets where name = 'payroll_key'
$$;
revoke execute on function payroll_key() from public, anon, authenticated;

-- A tax file number is 9 digits whose weighted sum is a multiple of 11.
create or replace function tfn_valid(t text) returns boolean
language sql immutable as $$
  select t ~ '^[0-9]{9}$' and (
    substr(t,1,1)::int * 1 + substr(t,2,1)::int * 4 + substr(t,3,1)::int * 3 + substr(t,4,1)::int * 7 +
    substr(t,5,1)::int * 5 + substr(t,6,1)::int * 8 + substr(t,7,1)::int * 6 + substr(t,8,1)::int * 9 +
    substr(t,9,1)::int * 10) % 11 = 0
$$;

-- Save the tax declaration. p_tfn null keeps the number on file; '' removes it.
create or replace function save_staff_tax(
  p_staff uuid, p_tfn text, p_tfn_status text, p_declaration_date date, p_residency text,
  p_tax_free_threshold boolean, p_study_loan boolean, p_medicare_variation text
) returns void
language plpgsql security definer set search_path = public, extensions as $$
declare b uuid; clean text := regexp_replace(coalesce(p_tfn, ''), '\D', '', 'g');
begin
  select business_id into b from staff where id = p_staff;
  if b is null or not has_perm(b, 'sensitive') then raise exception 'Not allowed'; end if;
  if p_tfn is not null and clean <> '' and not tfn_valid(clean) then
    raise exception 'That isn''t a valid tax file number';
  end if;
  insert into staff_tax (staff_id, business_id, tfn_status, declaration_date, residency, tax_free_threshold, study_loan, medicare_variation)
  values (p_staff, b, coalesce(p_tfn_status, 'missing'), p_declaration_date, p_residency, p_tax_free_threshold, p_study_loan, p_medicare_variation)
  on conflict (staff_id) do update set
    tfn_status = excluded.tfn_status, declaration_date = excluded.declaration_date, residency = excluded.residency,
    tax_free_threshold = excluded.tax_free_threshold, study_loan = excluded.study_loan,
    medicare_variation = excluded.medicare_variation, updated_at = now();
  if p_tfn is not null then
    update staff_tax set
      tfn_cipher = case when clean = '' then null else pgp_sym_encrypt(clean, payroll_key()) end,
      tfn_last3 = case when clean = '' then null else right(clean, 3) end,
      tfn_status = case when clean = '' then (case when tfn_status = 'provided' then 'missing' else tfn_status end) else 'provided' end
    where staff_id = p_staff;
  end if;
end $$;

-- Save the bank account. p_account null keeps the number on file.
create or replace function save_staff_bank(p_staff uuid, p_account_name text, p_bsb text, p_account text)
returns void
language plpgsql security definer set search_path = public, extensions as $$
declare b uuid; bsb text := regexp_replace(coalesce(p_bsb, ''), '\D', '', 'g'); acc text := regexp_replace(coalesce(p_account, ''), '\D', '', 'g');
begin
  select business_id into b from staff where id = p_staff;
  if b is null or not has_perm(b, 'sensitive') then raise exception 'Not allowed'; end if;
  if bsb <> '' and length(bsb) <> 6 then raise exception 'A BSB has 6 digits'; end if;
  if p_account is not null and acc <> '' and length(acc) not between 5 and 10 then
    raise exception 'An account number has 5 to 10 digits';
  end if;
  insert into staff_bank (staff_id, business_id, account_name, bsb)
  values (p_staff, b, nullif(trim(p_account_name), ''), nullif(substr(bsb, 1, 3) || '-' || substr(bsb, 4), '-'))
  on conflict (staff_id) do update set account_name = excluded.account_name, bsb = excluded.bsb, updated_at = now();
  if p_account is not null then
    update staff_bank set
      account_cipher = case when acc = '' then null else pgp_sym_encrypt(acc, payroll_key()) end,
      account_last4 = case when acc = '' then null else right(acc, 4) end
    where staff_id = p_staff;
  end if;
end $$;

-- What's on file, without what it says: lets the People screens show "TFN received"
-- to managers who can't see the number.
create or replace function staff_readiness(p_business uuid)
returns table (staff_id uuid, has_tfn boolean, tfn_status text, has_super boolean, has_bank boolean)
language sql stable security definer set search_path = public as $$
  select s.id,
         t.tfn_cipher is not null,
         coalesce(t.tfn_status, 'missing'),
         coalesce(su.choice not in ('pending') and (su.usi is not null or su.fund_abn is not null or su.choice = 'stapled'), false),
         b.account_cipher is not null and b.bsb is not null
  from staff s
  left join staff_tax t on t.staff_id = s.id
  left join staff_super su on su.staff_id = s.id
  left join staff_bank b on b.staff_id = s.id
  where s.business_id = p_business and s.kind = 'employee'
    and (has_perm(p_business, 'people') or has_perm(p_business, 'payroll'))
$$;

-- ============================================================================
-- Award data: Fair Work Ombudsman pay guides published 24 June 2026, for the first full
-- pay period starting on or after 1 July 2026.
-- ============================================================================

insert into awards (code, name, url) values
  ('MA000089', 'Vehicle Repair, Services and Retail Award 2020', 'https://www.fairwork.gov.au/pay-and-wages/minimum-wages/pay-guides'),
  ('MA000119', 'Restaurant Industry Award 2020', 'https://www.fairwork.gov.au/pay-and-wages/minimum-wages/pay-guides');

insert into award_rule_sets (award_code, key, name, effective_from, ftpt, casual, junior, extras, notes) values
  ('MA000089', 'standard', 'Vehicle industry RS&R employees', '2026-07-01',
   '{"weekday":1,"sat":1.5,"sun":2,"ph":2.5}',
   '{"weekday":1.25,"sat":1.75,"sun":2.25,"ph":2.75}',
   '{"ftpt":{"u17":0.475,"17":0.5,"18":0.625,"19":0.75,"20":0.875},"casual":{"u17":0.475,"17":0.5,"18":0.625,"19":0.75,"20":0.875}}',
   '{}',
   'Employees under 18 can''t work unsupervised 7pm–9pm, or at all 9pm–6.30am.'),
  ('MA000089', 'console', 'Roadhouse attendant, driveway attendant or console operator', '2026-07-01',
   '{"weekday":1,"sat":1,"sat_pm":1.5,"sun":1.5,"ph":2}',
   '{"weekday":1.3175,"sat":1.7187,"sat_pm":1.7187,"sun":1.7187,"ph":1.7187}',
   '{"ftpt":{"u17":0.475,"17":0.5,"18":0.625,"19":0.75,"20":0.875},"casual":{"u17":0.475,"17":0.5,"18":0.625,"19":0.75,"20":1}}',
   '{}',
   'Casuals get these flat rates instead of the 25% casual loading. Saturday is ordinary time before 12 noon and 150% after. Employees under 18 can''t work unsupervised 7pm–9pm, or at all 9pm–6.30am.'),
  ('MA000119', 'restaurant', 'Restaurant industry employees', '2026-07-01',
   '{"weekday":1,"sat":1.25,"sun":1.5,"ph":2.25}',
   '{"weekday":1.25,"sat":1.5,"sun":1.5,"ph":2.5}',
   '{"ftpt":{"u17":0.5,"17":0.6,"18":0.7,"19":0.85,"20":1},"casual":{"u17":0.5,"17":0.6,"18":0.7,"19":0.85,"20":1}}',
   '{"late_night":{"label":"Mon–Fri 10pm–midnight","per_hour":2.95},"early_morning":{"label":"Mon–Fri midnight–6am","per_hour":4.42}}',
   'Junior employees with a trade qualification, or who serve liquor, get the adult rate.');

with c (award_code, rule_set_key, code, name, sort, weekly, hourly) as (values
  ('MA000089', 'console',  'Console operator',   'Console operator / driveway attendant operating a console', 10, 1062.90, 27.97),
  ('MA000089', 'console',  'Driveway attendant', 'Driveway attendant', 20, 978.10, 25.74),
  ('MA000089', 'console',  'Roadhouse – take away', 'Roadhouse attendant required to cook take away meals only', 30, 1004.90, 26.44),
  ('MA000089', 'console',  'Roadhouse – cook', 'Roadhouse attendant engaged primarily to cook other than take away meals', 40, 1062.90, 27.97),
  ('MA000089', 'standard', 'Level 1', 'Vehicle industry RS&R level 1', 110, 978.10, 25.74),
  ('MA000089', 'standard', 'Level 2', 'Vehicle industry RS&R level 2', 120, 1004.90, 26.44),
  ('MA000089', 'standard', 'Level 3', 'Vehicle industry RS&R level 3', 130, 1029.10, 27.08),
  ('MA000089', 'standard', 'Level 4', 'Vehicle industry RS&R level 4', 140, 1062.90, 27.97),
  ('MA000089', 'standard', 'Level 5', 'Vehicle industry RS&R level 5', 150, 1088.20, 28.64),
  ('MA000089', 'standard', 'Tradesperson 1', 'Vehicle industry RS&R tradesperson or equivalent level 1', 160, 1119.10, 29.45),
  ('MA000089', 'standard', 'Tradesperson 2', 'Vehicle industry RS&R tradesperson or equivalent level 2', 170, 1224.40, 32.22),
  ('MA000119', 'restaurant', 'Introductory', 'Introductory level', 10, 978.10, 25.74),
  ('MA000119', 'restaurant', 'Level 1', 'Level 1 - food and beverage attendant grade 1', 20, 1004.90, 26.44),
  ('MA000119', 'restaurant', 'Level 1', 'Level 1 - kitchen attendant grade 1', 21, 1004.90, 26.44),
  ('MA000119', 'restaurant', 'Level 2', 'Level 2 - food and beverage attendant grade 2', 30, 1029.10, 27.08),
  ('MA000119', 'restaurant', 'Level 2', 'Level 2 - cook grade 1', 31, 1029.10, 27.08),
  ('MA000119', 'restaurant', 'Level 2', 'Level 2 - kitchen attendant grade 2', 32, 1029.10, 27.08),
  ('MA000119', 'restaurant', 'Level 2', 'Level 2 - clerical grade 1', 33, 1029.10, 27.08),
  ('MA000119', 'restaurant', 'Level 2', 'Level 2 - storeperson grade 1', 34, 1029.10, 27.08),
  ('MA000119', 'restaurant', 'Level 2', 'Level 2 - door person/security officer grade 1', 35, 1029.10, 27.08),
  ('MA000119', 'restaurant', 'Level 3', 'Level 3 - food and beverage attendant grade 3', 40, 1062.90, 27.97),
  ('MA000119', 'restaurant', 'Level 3', 'Level 3 - cook grade 2', 41, 1062.90, 27.97),
  ('MA000119', 'restaurant', 'Level 3', 'Level 3 - kitchen attendant grade 3', 42, 1062.90, 27.97),
  ('MA000119', 'restaurant', 'Level 3', 'Level 3 - clerical grade 2', 43, 1062.90, 27.97),
  ('MA000119', 'restaurant', 'Level 3', 'Level 3 - storeperson grade 2', 44, 1062.90, 27.97),
  ('MA000119', 'restaurant', 'Level 3', 'Level 3 - timekeeper/security officer grade 2', 45, 1062.90, 27.97),
  ('MA000119', 'restaurant', 'Level 3', 'Level 3 - handyperson', 46, 1062.90, 27.97),
  ('MA000119', 'restaurant', 'Level 4', 'Level 4 - food and beverage attendant grade 4 (tradesperson)', 50, 1119.10, 29.45),
  ('MA000119', 'restaurant', 'Level 4', 'Level 4 - cook grade 3 (tradesperson)', 51, 1119.10, 29.45),
  ('MA000119', 'restaurant', 'Level 4', 'Level 4 - clerical grade 3', 52, 1119.10, 29.45),
  ('MA000119', 'restaurant', 'Level 4', 'Level 4 - storeperson grade 3', 53, 1119.10, 29.45),
  ('MA000119', 'restaurant', 'Level 5', 'Level 5 - food and beverage supervisor', 60, 1189.40, 31.30),
  ('MA000119', 'restaurant', 'Level 5', 'Level 5 - cook grade 4 (tradesperson)', 61, 1189.40, 31.30),
  ('MA000119', 'restaurant', 'Level 5', 'Level 5 - clerical supervisor', 62, 1189.40, 31.30),
  ('MA000119', 'restaurant', 'Level 6', 'Level 6 - cook grade 5 (tradesperson)', 70, 1221.10, 32.13)
), ins as (
  insert into award_classifications (award_code, rule_set_key, code, name, sort)
  select award_code, rule_set_key, code, name, sort from c
  returning id, award_code, name
)
insert into award_rates (classification_id, effective_from, weekly, hourly)
select ins.id, '2026-07-01', c.weekly, c.hourly from ins join c using (award_code, name);

-- Each business's payroll settings, on the award it uses.
insert into payroll_settings (business_id, default_award_code)
select id, case when name ilike '%caltex%' then 'MA000089' else 'MA000119' end from businesses
on conflict do nothing;

-- Everyone already on the books is on their business's award; their classification is
-- left for someone to choose, so nobody's pay is assumed.
update staff s set award_code = p.default_award_code
from payroll_settings p where p.business_id = s.business_id;

-- ============================================================================
-- Functions that write on someone's behalf check their area, not just membership.
-- ============================================================================

CREATE OR REPLACE FUNCTION public.duplicate_purchase_order(p_id uuid)
 RETURNS purchase_orders
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
  src purchase_orders;
  o purchase_orders;
begin
  select * into src from purchase_orders where id = p_id;
  if src.id is null or not has_perm(src.business_id, 'purchasing') then
    raise exception 'Order not found';
  end if;

  insert into purchase_orders(business_id, supplier_id, status, ordered_on, note)
  values (src.business_id, src.supplier_id, 'draft', shop_today(), src.note)
  returning * into o;

  insert into purchase_order_lines(purchase_order_id, business_id, item_id, description, qty, unit_cost, sort)
  select o.id, o.business_id, l.item_id, l.description, l.qty,
         coalesce(v.unit_cost, l.unit_cost), l.sort
  from purchase_order_lines l
  left join v_item_cost v on v.item_id = l.item_id
  where l.purchase_order_id = src.id
  order by l.sort, l.id;

  return o;
end $function$
;
CREATE OR REPLACE FUNCTION public.receive_purchase_order(p_id uuid, p_received_on date DEFAULT NULL::date, p_total numeric DEFAULT NULL::numeric, p_paid_via paid_via DEFAULT 'bank'::paid_via)
 RETURNS purchase_orders
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
  o purchase_orders;
  amt numeric(12,2);
  e_id uuid;
begin
  select * into o from purchase_orders where id = p_id;
  if o.id is null or not has_perm(o.business_id, 'purchasing') then
    raise exception 'Order not found';
  end if;
  if o.status = 'received' then
    raise exception 'Order % is already received', o.po_number;
  end if;
  if o.status = 'cancelled' then
    raise exception 'Order % was cancelled', o.po_number;
  end if;

  amt := coalesce(p_total, (select coalesce(sum(qty * unit_cost), 0) from purchase_order_lines where purchase_order_id = o.id));
  if amt < 0 then
    raise exception 'Total cannot be negative';
  end if;

  -- Always 'food', whatever the supplier is usually used for. An order buys stock, and
  -- stock is what the weekly count values, so the two sides of
  --   food cost = opening + purchases - closing
  -- have to draw on the same category. Booking a packaging order as 'other' would leave
  -- its stock in the count with no purchase to match, quietly skewing every week after.
  insert into expenses(business_id, expense_date, category, supplier_id, amount, paid_via, note)
  values (o.business_id, coalesce(p_received_on, shop_today()), 'food', o.supplier_id,
          amt, p_paid_via, 'Order #' || o.po_number)
  returning id into e_id;

  update purchase_orders
     set status = 'received', received_on = coalesce(p_received_on, shop_today()), expense_id = e_id
   where id = o.id
  returning * into o;

  return o;
end $function$
;
CREATE OR REPLACE FUNCTION public.reopen_purchase_order(p_id uuid)
 RETURNS purchase_orders
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
  o purchase_orders;
  e_id uuid;
begin
  select * into o from purchase_orders where id = p_id;
  if o.id is null or not has_perm(o.business_id, 'purchasing') then
    raise exception 'Order not found';
  end if;
  if o.status <> 'received' then
    raise exception 'Order % has not been received', o.po_number;
  end if;

  e_id := o.expense_id;
  update purchase_orders set status = 'sent', received_on = null, expense_id = null where id = o.id
  returning * into o;
  if e_id is not null then
    delete from expenses where id = e_id;
  end if;
  return o;
end $function$
;
CREATE OR REPLACE FUNCTION public.place_items(p_location uuid, p_items uuid[], p_from uuid DEFAULT NULL::uuid, p_only boolean DEFAULT false)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare b uuid;
begin
  select business_id into b from stock_items where id = p_items[1];
  if b is null or not has_perm(b, 'catalogue')
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
end $function$
;
CREATE OR REPLACE FUNCTION public.set_location_order(p_location uuid, p_items uuid[])
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare b uuid;
begin
  select business_id into b from stock_locations where id = p_location;
  if b is null or not has_perm(b, 'catalogue') then
    raise exception 'Not allowed';
  end if;
  insert into stock_item_places (business_id, item_id, location_id, sort)
  select b, i.id, p_location, x.n * 10
  from unnest(p_items) with ordinality as x(id, n)
  join stock_items i on i.id = x.id and i.business_id = b
  on conflict (item_id, location_id) do update set sort = excluded.sort;
end $function$
;
CREATE OR REPLACE FUNCTION public.start_stock_count(p_business uuid, p_date date DEFAULT NULL::date)
 RETURNS stock_counts
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
  d date := coalesce(p_date, shop_today());
  c stock_counts;
begin
  if not has_perm(p_business, 'stock') then
    raise exception 'Not allowed';
  end if;

  select * into c from stock_counts where business_id = p_business and count_date = d;
  if c.id is null then
    insert into stock_counts(business_id, count_date) values (p_business, d) returning * into c;
  end if;

  insert into stock_count_lines(stock_count_id, business_id, item_id, qty, unit_cost)
  select c.id, c.business_id, i.id, 0, coalesce(v.unit_cost, 0)
  from stock_items i
  left join v_item_cost v on v.item_id = i.id
  where i.business_id = c.business_id and i.active
  on conflict (stock_count_id, item_id) do nothing;

  return c;
end $function$
;
CREATE OR REPLACE FUNCTION public.replace_item_sales(p_business uuid, p_start date, p_end date, p_rows jsonb)
 RETURNS integer
 LANGUAGE plpgsql
 SET search_path TO 'public'
AS $function$
declare n int;
begin
  if not has_perm(p_business, 'finance') then
    raise exception 'Not a member of this business';
  end if;
  delete from item_sales where business_id = p_business and period_start = p_start and period_end = p_end;
  insert into item_sales (business_id, item_id, period_start, period_end, qty, amount)
  select p_business, (r->>'item_id')::uuid, p_start, p_end,
         coalesce((r->>'qty')::numeric, 0), coalesce((r->>'amount')::numeric, 0)
  from jsonb_array_elements(p_rows) r
  where coalesce((r->>'qty')::numeric, 0) <> 0 or coalesce((r->>'amount')::numeric, 0) <> 0;
  get diagnostics n = row_count;
  return n;
end $function$
;
CREATE OR REPLACE FUNCTION public.create_business(p_name text)
 RETURNS businesses
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
  e text := lower(auth.jwt() ->> 'email');
  b businesses;
begin
  if e is null then
    raise exception 'Not signed in';
  end if;
  -- Only people who already belong somewhere may start another business.
  if not is_any_member() then
    raise exception 'Not allowed';
  end if;
  if coalesce(trim(p_name), '') = '' then
    raise exception 'Name is required';
  end if;

  insert into businesses(name) values (trim(p_name)) returning * into b;
  insert into payroll_settings (business_id) values (b.id) on conflict do nothing;
  -- The person who starts a business owns it.
  insert into business_users(email, business_id, group_id) values (e, b.id, seed_security_groups(b.id)) on conflict do nothing;
  return b;
end $function$
;

commit;
