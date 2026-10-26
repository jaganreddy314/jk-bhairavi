-- Setting up a business for a new customer.
--
-- Before: anyone already in a business could start another one from a single name box in
--         Settings, and the legal name and ABN lived in payroll settings.
-- After:  only platform admins (the people who run this app) create businesses, through a
--         setup wizard that records the business's details and its owner in one step. The
--         owner is given a login with a temporary password (an Edge Function does that part,
--         as it needs the service role) and chooses their own on first sign-in.
--
-- A business's details (legal name, ABN, address…) now live on the business itself, so
-- Settings, payslips and anything else read them from one place.
begin;

-- ---------- platform admins ----------

-- Not a business role: these people can create businesses for customers, and see the list
-- of every business with its owners. They don't get into a business's data by being here;
-- that still needs a place in business_users like anyone else.
create table platform_admins (
  email text primary key check (email = lower(trim(email))),
  created_at timestamptz not null default now()
);
-- No policies: only the security-definer functions below read it.
alter table platform_admins enable row level security;
insert into platform_admins (email) values ('jaganreddy314@gmail.com');

create or replace function is_platform_admin() returns boolean
language sql stable security definer set search_path = public as $$
  select exists (select 1 from platform_admins where email = lower(auth.jwt() ->> 'email'))
$$;
revoke all on function is_platform_admin() from public, anon;
grant execute on function is_platform_admin() to authenticated;

-- ---------- business details ----------

-- Two customers may well trade under the same name; and the old unique error told one of
-- them that the other existed.
alter table businesses drop constraint businesses_name_key;

alter table businesses
  add column legal_name text,
  add column abn text,
  add column address text,
  add column phone text,
  add column email text,
  add column gst_registered boolean not null default true,
  -- Which till or POS the shop uses, for importing its sales reports later.
  add column till_system text,
  add column created_by text;

update businesses b set legal_name = p.legal_name, abn = p.abn, address = p.address
from payroll_settings p where p.business_id = b.id;

alter table payroll_settings drop column legal_name, drop column abn, drop column address;

-- Editing them is already for people with Settings and access ("admins rename business", 013).

-- ---------- creating a business ----------

drop function if exists create_business(text);

-- One call does everything a new business needs: the business and its details, its
-- security groups, payroll settings, and its owner in the Owner group. The owner's login
-- is made separately (setup-owner-login), as that needs the service role.
--
-- p_details: legal_name, abn, address, phone, email, gst_registered, sales_mode,
--            till_system, owner_name. Anything missing is left blank.
-- p_join:    also put the admin creating it in the Owner group, to help set it up.
create or replace function create_business(
  p_name text,
  p_owner_email text,
  p_details jsonb default '{}',
  p_join boolean default false
) returns businesses
language plpgsql security definer set search_path = public as $$
declare
  me text := lower(auth.jwt() ->> 'email');
  owner text := lower(trim(p_owner_email));
  d jsonb := coalesce(p_details, '{}');
  b businesses;
  owner_group uuid;
  t text;
begin
  if not is_platform_admin() then
    raise exception 'Only platform admins can create businesses';
  end if;
  if coalesce(trim(p_name), '') = '' then
    raise exception 'Business name is required';
  end if;
  if owner is null or owner !~ '^[^@\s]+@[^@\s]+\.[^@\s]+$' then
    raise exception 'A valid owner email is required';
  end if;

  insert into businesses (name, legal_name, abn, address, phone, email, gst_registered, sales_mode, till_system, created_by)
  values (
    trim(p_name),
    nullif(trim(d->>'legal_name'), ''),
    nullif(trim(d->>'abn'), ''),
    nullif(trim(d->>'address'), ''),
    nullif(trim(d->>'phone'), ''),
    nullif(lower(trim(d->>'email')), ''),
    coalesce((d->>'gst_registered')::boolean, true),
    coalesce(nullif(d->>'sales_mode', ''), 'channels'),
    nullif(trim(d->>'till_system'), ''),
    me
  )
  returning * into b;

  insert into payroll_settings (business_id) values (b.id) on conflict do nothing;
  owner_group := seed_security_groups(b.id);

  foreach t in array array_remove(array[owner, case when p_join then me end], null) loop
    insert into business_users (email, business_id, group_id, display_name)
    values (t, b.id, owner_group, case when t = owner then nullif(trim(d->>'owner_name'), '') end)
    on conflict (email, business_id) do nothing;
  end loop;

  return b;
end $$;
revoke all on function create_business(text, text, jsonb, boolean) from public, anon;
grant execute on function create_business(text, text, jsonb, boolean) to authenticated;

-- Every business, for the platform admin's list: who owns it, how many people use it, and
-- the last day it had sales entered, so a customer who has stopped using it stands out.
create or replace function admin_businesses()
returns table (
  id uuid, name text, legal_name text, abn text, created_at timestamptz, created_by text,
  owners text[], members int, last_sales date, i_am_member boolean
)
language plpgsql stable security definer set search_path = public as $$
begin
  if not is_platform_admin() then
    raise exception 'Only platform admins can see every business';
  end if;
  return query
  select b.id, b.name, b.legal_name, b.abn, b.created_at, b.created_by,
         coalesce(array_agg(u.email order by u.email) filter (where g.is_owner), '{}'),
         count(u.email)::int,
         (select max(s.sale_date) from sales_days s where s.business_id = b.id),
         bool_or(u.email = lower(auth.jwt() ->> 'email')) is true
  from businesses b
  left join business_users u on u.business_id = b.id
  left join security_groups g on g.id = u.group_id
  group by b.id
  order by b.created_at desc;
end $$;
revoke all on function admin_businesses() from public, anon;
grant execute on function admin_businesses() to authenticated;

commit;
