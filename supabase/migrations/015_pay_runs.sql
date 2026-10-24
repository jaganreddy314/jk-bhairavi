-- Pay runs.
--
-- A pay run covers one pay period (Monday to Sunday for a weekly cycle). While it's a draft,
-- each person's line holds only what was typed in — leave taken, allowances, adjustments —
-- and the app works the pay out from their shifts and the award rates. Finalising stores
-- the figures as they were paid (the payslip), books the wages and super as Labour expenses
-- dated pay day, and moves leave balances. Reopening undoes all three.
begin;

create table pay_runs (
  id uuid primary key default gen_random_uuid(),
  business_id uuid not null references businesses(id),
  period_start date not null,
  period_end date not null,
  pay_date date not null,
  status text not null default 'draft' check (status in ('draft','finalised')),
  finalised_at timestamptz,
  note text,
  created_at timestamptz not null default now(),
  unique (business_id, period_start, period_end),
  constraint pay_runs_period check (period_end >= period_start)
);
create index on pay_runs (business_id, period_start);

create table pay_run_lines (
  id uuid primary key default gen_random_uuid(),
  pay_run_id uuid not null references pay_runs(id) on delete cascade,
  business_id uuid not null references businesses(id),
  staff_id uuid not null references staff(id),
  inputs jsonb not null default '{}',       -- draft: leave hours, allowances, adjustments
  result jsonb,                             -- finalised: the payslip as paid
  gross numeric(12,2),
  tax numeric(12,2),
  super numeric(12,2),
  net numeric(12,2),
  unique (pay_run_id, staff_id)
);
create index on pay_run_lines (staff_id);

alter table pay_runs enable row level security;
alter table pay_run_lines enable row level security;
create policy "payroll reads runs" on pay_runs for select to authenticated using (has_perm(business_id, 'payroll'));
create policy "payroll starts runs" on pay_runs for insert to authenticated with check (has_perm(business_id, 'payroll') and status = 'draft');
create policy "payroll edits draft runs" on pay_runs for update to authenticated
  using (has_perm(business_id, 'payroll') and status = 'draft') with check (has_perm(business_id, 'payroll') and status = 'draft');
create policy "payroll removes draft runs" on pay_runs for delete to authenticated using (has_perm(business_id, 'payroll') and status = 'draft');
create policy "payroll reads lines" on pay_run_lines for select to authenticated using (has_perm(business_id, 'payroll'));
-- Lines change only while their run is a draft; finalising goes through finalise_pay_run().
create policy "payroll edits draft lines" on pay_run_lines for all to authenticated
  using (has_perm(business_id, 'payroll') and exists (select 1 from pay_runs r where r.id = pay_run_id and r.status = 'draft'))
  with check (has_perm(business_id, 'payroll') and exists (select 1 from pay_runs r where r.id = pay_run_id and r.status = 'draft'));

-- Wages and super a pay run booked; reopening the run removes them.
alter table expenses add column pay_run_id uuid references pay_runs(id);
create index on expenses (pay_run_id);

create or replace function block_linked_expense_delete() returns trigger
language plpgsql security definer set search_path = public as $$
declare n int;
begin
  select po_number into n from purchase_orders where expense_id = old.id;
  if n is not null then
    raise exception 'This expense belongs to order #%. Undo receiving that order instead.', n;
  end if;
  if old.pay_run_id is not null and exists (select 1 from pay_runs where id = old.pay_run_id and status = 'finalised') then
    raise exception 'This expense was booked by a pay run. Reopen that pay run instead.';
  end if;
  return old;
end $$;

-- Tax settings without the tax file number: what withholding needs, for payroll users who
-- can't see the sensitive tables.
create or replace function staff_tax_profile(p_business uuid)
returns table (staff_id uuid, has_tfn boolean, tfn_status text, residency text, tax_free_threshold boolean, study_loan boolean, medicare_variation text)
language sql stable security definer set search_path = public as $$
  select s.id, t.tfn_cipher is not null, coalesce(t.tfn_status, 'missing'), t.residency, t.tax_free_threshold, t.study_loan, t.medicare_variation
  from staff s left join staff_tax t on t.staff_id = s.id
  where s.business_id = p_business and s.kind = 'employee' and has_perm(p_business, 'payroll')
$$;

-- Finalise: store each line as paid, book the expenses and move leave. p_lines is a JSON
-- array of {staff_id, gross, tax, super, net, result, leave: {annual, personal}} where leave
-- holds the change in hours (accrued less taken).
create or replace function finalise_pay_run(p_id uuid, p_lines jsonb) returns void
language plpgsql security definer set search_path = public as $$
declare r pay_runs; l jsonb; label text; total_super numeric := 0; fund text;
begin
  select * into r from pay_runs where id = p_id for update;
  if r.id is null or not has_perm(r.business_id, 'payroll') then raise exception 'Not allowed'; end if;
  if r.status <> 'draft' then raise exception 'This pay run is already finalised'; end if;
  label := 'pay run ' || to_char(r.period_start, 'FMDD Mon') || ' – ' || to_char(r.period_end, 'FMDD Mon YYYY');

  for l in select * from jsonb_array_elements(p_lines) loop
    if not exists (select 1 from staff where id = (l->>'staff_id')::uuid and business_id = r.business_id) then
      raise exception 'Unknown person in this pay run';
    end if;
    select fund_name into fund from staff_super where staff_id = (l->>'staff_id')::uuid;
    insert into pay_run_lines (pay_run_id, business_id, staff_id, inputs, result, gross, tax, super, net)
    values (p_id, r.business_id, (l->>'staff_id')::uuid, coalesce(l->'inputs', '{}'),
            coalesce(l->'result', '{}') || jsonb_build_object('super_fund', fund, 'leave', coalesce(l->'leave', '{}')),
            (l->>'gross')::numeric, (l->>'tax')::numeric, (l->>'super')::numeric, (l->>'net')::numeric)
    on conflict (pay_run_id, staff_id) do update set
      inputs = excluded.inputs, result = excluded.result, gross = excluded.gross, tax = excluded.tax, super = excluded.super, net = excluded.net;

    if (l->>'gross')::numeric > 0 then
      insert into expenses (business_id, expense_date, category, staff_id, amount, paid_via, note, pay_run_id)
      values (r.business_id, r.pay_date, 'labour', (l->>'staff_id')::uuid, (l->>'gross')::numeric, 'bank', 'Wages · ' || label, p_id);
    end if;
    total_super := total_super + coalesce((l->>'super')::numeric, 0);

    -- Leave moves by what was accrued less what was taken.
    insert into staff_leave (staff_id, business_id, leave_type, hours, as_of)
    select (l->>'staff_id')::uuid, r.business_id, k, v::numeric, r.period_end
    from jsonb_each_text(coalesce(l->'leave', '{}')) as e(k, v)
    where k in ('annual', 'personal') and v::numeric <> 0
    on conflict (staff_id, leave_type) do update set hours = staff_leave.hours + excluded.hours, as_of = excluded.as_of;
  end loop;

  -- People who were in the draft but not in the final list come off it.
  delete from pay_run_lines where pay_run_id = p_id
    and staff_id not in (select (x->>'staff_id')::uuid from jsonb_array_elements(p_lines) x);

  if total_super > 0 then
    insert into expenses (business_id, expense_date, category, amount, paid_via, note, pay_run_id)
    values (r.business_id, r.pay_date, 'labour', round(total_super, 2), 'bank', 'Super guarantee · ' || label, p_id);
  end if;

  update pay_runs set status = 'finalised', finalised_at = now() where id = p_id;
end $$;

-- Reopen: take the expenses back out, put leave back, and return to a draft.
create or replace function reopen_pay_run(p_id uuid) returns void
language plpgsql security definer set search_path = public as $$
declare r pay_runs; l pay_run_lines;
begin
  select * into r from pay_runs where id = p_id for update;
  if r.id is null or not has_perm(r.business_id, 'payroll') then raise exception 'Not allowed'; end if;
  if r.status <> 'finalised' then raise exception 'This pay run is not finalised'; end if;
  for l in select * from pay_run_lines where pay_run_id = p_id loop
    update staff_leave s set hours = s.hours - e.v::numeric
    from jsonb_each_text(coalesce(l.result->'leave', '{}')) as e(k, v)
    where s.staff_id = l.staff_id and s.leave_type = e.k and e.k in ('annual', 'personal');
  end loop;
  update pay_runs set status = 'draft', finalised_at = null where id = p_id;
  delete from expenses where pay_run_id = p_id;
end $$;

commit;
