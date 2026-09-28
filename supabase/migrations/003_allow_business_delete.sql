-- "A business must keep at least one member" also blocked deleting a business,
-- because removing the business cascades into its people. Skip the check when the
-- business itself is on its way out.
begin;

create or replace function keep_one_member() returns trigger
language plpgsql as $$
begin
  -- The business is being deleted: its people go with it.
  if not exists (select 1 from businesses where id = old.business_id) then
    return old;
  end if;
  if not exists (select 1 from business_users where business_id = old.business_id and email <> old.email) then
    raise exception 'Cannot remove the last person from a business';
  end if;
  return old;
end $$;

commit;
