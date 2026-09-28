-- Creating a business from the app.
--
-- A direct insert can't work: the row is only visible to its members, but the
-- membership can't exist until the row does, so INSERT ... RETURNING is rejected
-- by row-level security. One function does both steps and returns the new row.
begin;

drop policy if exists "members create business" on businesses;
drop trigger if exists businesses_add_creator on businesses;
drop function if exists add_creator_as_member();

create or replace function create_business(p_name text) returns businesses
language plpgsql security definer set search_path = public as $$
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
  insert into business_users(email, business_id) values (e, b.id) on conflict do nothing;
  return b;
end $$;

revoke all on function create_business(text) from public;
grant execute on function create_business(text) to authenticated;

commit;
