-- Paying people, emailing payslips, and sending hours to Xero.
--
-- 1. Bank payment (ABA) file: the business's own bank details live with the payroll settings;
--    the employees' account numbers are decrypted only by pay_run_payments(), for someone
--    with the sensitive area, to build the file.
-- 2. Payslip emails are sent by the send-payslips edge function; each line records when.
-- 3. Xero: one connected Xero organisation per business. Its tokens are encrypted with the
--    payroll key and only the xero edge function (service role) can read them. Each pay line
--    label (Ordinary hours, Saturday…) maps to a Xero earnings rate, and each person to a
--    Xero employee, so a pay period's hours can be sent as Xero timesheets.
begin;

-- ---------- bank payment file ----------
alter table payroll_settings
  add column aba_bank_code text check (aba_bank_code ~ '^[A-Z]{3}$'),       -- e.g. CBA, WBC, ANZ, NAB
  add column aba_apca_id text check (aba_apca_id ~ '^[0-9]{6}$'),           -- the user ID number the bank gave you
  add column aba_user_name text check (length(aba_user_name) <= 26),        -- your name as the bank has it
  add column aba_bsb text check (aba_bsb ~ '^[0-9]{3}-[0-9]{3}$'),          -- the account wages are paid from
  add column aba_account text check (aba_account ~ '^[0-9]{5,9}$'),
  add column aba_balancing boolean not null default false,                  -- some banks want a balancing debit line
  add column payslip_reply_to text;

-- Who to pay and how much, for a finalised pay run: decrypted account numbers, so only the
-- sensitive area can ask.
create or replace function pay_run_payments(p_id uuid)
returns table (staff_id uuid, name text, account_name text, bsb text, account text, net numeric)
language plpgsql stable security definer set search_path = public, extensions as $$
declare b uuid; st text;
begin
  select business_id, status into b, st from pay_runs where id = p_id;
  if b is null or not has_perm(b, 'sensitive') then raise exception 'Not allowed'; end if;
  if st <> 'finalised' then raise exception 'Finalise the pay run first'; end if;
  return query
    select l.staff_id, s.name, k.account_name, k.bsb,
           case when k.account_cipher is null then null else pgp_sym_decrypt(k.account_cipher, payroll_key()) end,
           l.net
    from pay_run_lines l
    join staff s on s.id = l.staff_id
    left join staff_bank k on k.staff_id = l.staff_id
    where l.pay_run_id = p_id and coalesce(l.net, 0) > 0
    order by s.name;
end $$;

-- ---------- payslip emails ----------
alter table pay_run_lines add column emailed_at timestamptz;

-- ---------- Xero ----------
create table xero_connections (
  business_id uuid primary key references businesses(id) on delete cascade,
  tenant_id text not null,
  tenant_name text,
  token_cipher bytea not null,          -- {"access_token","refresh_token"} encrypted
  expires_at timestamptz not null,
  connected_by text,
  connected_at timestamptz not null default now()
);
alter table xero_connections enable row level security;
create policy "payroll sees the connection" on xero_connections for select to authenticated using (has_perm(business_id, 'payroll'));
create policy "payroll disconnects" on xero_connections for delete to authenticated using (has_perm(business_id, 'payroll'));
revoke select on xero_connections from anon, authenticated;
grant select (business_id, tenant_id, tenant_name, expires_at, connected_by, connected_at) on xero_connections to authenticated;
revoke insert, update on xero_connections from anon, authenticated;

-- One-time values that tie Xero's redirect back to who started connecting.
create table xero_oauth_states (
  state text primary key,
  business_id uuid not null references businesses(id) on delete cascade,
  email text not null,
  return_to text not null,
  created_at timestamptz not null default now()
);
alter table xero_oauth_states enable row level security;   -- no policies: edge function only

create table xero_rate_map (
  business_id uuid not null references businesses(id) on delete cascade,
  pay_label text not null,              -- e.g. 'Saturday', 'Ordinary hours (casual)'
  earnings_rate_id text not null,
  earnings_rate_name text,
  primary key (business_id, pay_label)
);
alter table xero_rate_map enable row level security;
create policy "payroll maps rates" on xero_rate_map for all to authenticated
  using (has_perm(business_id, 'payroll')) with check (has_perm(business_id, 'payroll'));

alter table staff add column xero_employee_id text;
alter table pay_runs add column xero_sent_at timestamptz, add column xero_result jsonb;

-- Token storage for the edge function. Only the service role may call these.
create or replace function xero_save_tokens(p_business uuid, p_tenant_id text, p_tenant_name text, p_tokens jsonb, p_expires_at timestamptz, p_email text)
returns void language sql security definer set search_path = public, extensions as $$
  insert into xero_connections (business_id, tenant_id, tenant_name, token_cipher, expires_at, connected_by)
  values (p_business, p_tenant_id, p_tenant_name, pgp_sym_encrypt(p_tokens::text, payroll_key()), p_expires_at, p_email)
  on conflict (business_id) do update set tenant_id = excluded.tenant_id, tenant_name = excluded.tenant_name,
    token_cipher = excluded.token_cipher, expires_at = excluded.expires_at,
    connected_by = coalesce(excluded.connected_by, xero_connections.connected_by)
$$;

create or replace function xero_load_tokens(p_business uuid)
returns table (tenant_id text, tokens jsonb, expires_at timestamptz)
language sql stable security definer set search_path = public, extensions as $$
  select c.tenant_id, pgp_sym_decrypt(c.token_cipher, payroll_key())::jsonb, c.expires_at
  from xero_connections c where c.business_id = p_business
$$;

revoke execute on function xero_save_tokens(uuid, text, text, jsonb, timestamptz, text) from public, anon, authenticated;
revoke execute on function xero_load_tokens(uuid) from public, anon, authenticated;
grant execute on function xero_save_tokens(uuid, text, text, jsonb, timestamptz, text) to service_role;
grant execute on function xero_load_tokens(uuid) to service_role;

commit;
