// Xero Payroll (AU): connect an organisation, list its employees and earnings rates, and
// send a pay period's hours as draft timesheets. Xero then works out pay, tax, super and
// Single Touch Payroll as usual.
//
// One-off setup (by an owner):
//   1. developer.xero.com → New app → Web app. Redirect URI:
//        https://<project-ref>.supabase.co/functions/v1/xero/callback
//   2. supabase secrets set XERO_CLIENT_ID=...  XERO_CLIENT_SECRET=...
//
// Deployed with: supabase functions deploy xero --no-verify-jwt --use-api --project-ref <ref>
// (--no-verify-jwt because Xero's redirect back has no Supabase sign-in; every other call
// checks the caller's token itself below.)
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2'

const URL_ = Deno.env.get('SUPABASE_URL')!
const ANON = Deno.env.get('SUPABASE_ANON_KEY')!
const SERVICE = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!
const CLIENT_ID = Deno.env.get('XERO_CLIENT_ID')
const CLIENT_SECRET = Deno.env.get('XERO_CLIENT_SECRET')
const REDIRECT = `${URL_}/functions/v1/xero/callback`
const SCOPES = 'openid profile email offline_access payroll.employees.read payroll.timesheets payroll.settings.read'
const API = 'https://api.xero.com/payroll.xro/1.0'
// Where the app may be sent back to after connecting (no open redirects).
const APP_ORIGINS = ['https://jaganreddy314.github.io', 'http://localhost:5199', 'http://localhost:5173']

const cors = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, content-type, apikey, x-client-info',
  'Access-Control-Allow-Methods': 'POST, GET, OPTIONS',
}
const reply = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { ...cors, 'Content-Type': 'application/json' } })

const admin = createClient(URL_, SERVICE, { auth: { persistSession: false } })
const basic = () => 'Basic ' + btoa(`${CLIENT_ID}:${CLIENT_SECRET}`)

async function tokenRequest(params: Record<string, string>) {
  const res = await fetch('https://identity.xero.com/connect/token', {
    method: 'POST',
    headers: { Authorization: basic(), 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams(params),
  })
  if (!res.ok) throw new Error(`Xero sign-in failed (${res.status}): ${(await res.text()).slice(0, 200)}`)
  return await res.json() as { access_token: string; refresh_token: string; expires_in: number }
}

/** A working access token for the business's Xero organisation, refreshed when needed. */
async function session(business: string) {
  const { data, error } = await admin.rpc('xero_load_tokens', { p_business: business })
  if (error) throw new Error(error.message)
  const row = (data as { tenant_id: string; tokens: { access_token: string; refresh_token: string }; expires_at: string }[])[0]
  if (!row) throw new Error('Xero isn’t connected for this business yet.')
  if (new Date(row.expires_at).getTime() - Date.now() > 60_000) return { tenant: row.tenant_id, token: row.tokens.access_token }
  const t = await tokenRequest({ grant_type: 'refresh_token', refresh_token: row.tokens.refresh_token })
  const { data: conn } = await admin.from('xero_connections').select('tenant_name').eq('business_id', business).single()
  await admin.rpc('xero_save_tokens', {
    p_business: business, p_tenant_id: row.tenant_id, p_tenant_name: conn?.tenant_name ?? null,
    p_tokens: { access_token: t.access_token, refresh_token: t.refresh_token },
    p_expires_at: new Date(Date.now() + t.expires_in * 1000).toISOString(), p_email: null,
  })
  return { tenant: row.tenant_id, token: t.access_token }
}

async function xero(s: { tenant: string; token: string }, path: string, init: RequestInit = {}, retried = false): Promise<any> {
  const res = await fetch(`${API}${path}`, {
    ...init,
    headers: { Authorization: `Bearer ${s.token}`, 'xero-tenant-id': s.tenant, Accept: 'application/json', 'Content-Type': 'application/json', ...(init.headers ?? {}) },
  })
  // Xero allows 60 calls a minute per organisation; wait it out once.
  if (res.status === 429 && !retried) {
    await new Promise((r) => setTimeout(r, Math.min(60, Number(res.headers.get('Retry-After')) || 5) * 1000))
    return xero(s, path, init, true)
  }
  const text = await res.text()
  let body: any = null
  try { body = text ? JSON.parse(text) : null } catch { body = { raw: text } }
  if (!res.ok) {
    const why = body?.Message || body?.Detail || body?.Title || text.slice(0, 200)
    throw new Error(`Xero said ${res.status}: ${why}`)
  }
  return body
}

/** Xero dates come back as /Date(1572566400000+0000)/ (negative before 1970), or sometimes ISO. */
const msDate = (v: string) => /^\d{4}-\d\d-\d\d/.test(v) ? v.slice(0, 10) : new Date(Number(/-?\d+/.exec(v)?.[0] ?? 0)).toISOString().slice(0, 10)
const xDate = (v: unknown) => (typeof v === 'string' && v ? msDate(v) : null)

const norm = (s: unknown) => String(s ?? '').toLowerCase().replace(/[^a-z]/g, '')
const fullName = (e: any) => `${e.FirstName ?? ''} ${e.LastName ?? ''}`.replace(/\s+/g, ' ').trim()

/** Every Xero employee, 100 to a page. */
async function allEmployees(s: { tenant: string; token: string }) {
  const out: any[] = []
  for (let page = 1; page < 50; page++) {
    const r = await xero(s, `/Employees?page=${page}`)
    const batch = r?.Employees ?? []
    out.push(...batch)
    if (batch.length < 100) break
  }
  return out
}

/** Best guess at who in the app a Xero employee is: already linked, same email, then same name. */
function matchStaff(e: any, staff: any[]) {
  const linked = staff.find((p) => p.xero_employee_id === e.EmployeeID)
  if (linked) return { staff_id: linked.id, name: linked.name, by: 'xero' }
  const free = staff.filter((p) => !p.xero_employee_id)
  const email = String(e.Email ?? '').trim().toLowerCase()
  const byEmail = email && free.find((p) => String(p.email ?? '').trim().toLowerCase() === email)
  if (byEmail) return { staff_id: byEmail.id, name: byEmail.name, by: 'email' }
  const n = norm(fullName(e))
  const byName = free.filter((p) => n && (norm(`${p.first_name ?? ''}${p.last_name ?? ''}`) === n || norm(p.name) === n))
  if (byName.length === 1) return { staff_id: byName[0].id, name: byName[0].name, by: 'name' }
  return null
}

const BASIS: Record<string, string> = { FULLTIME: 'full_time', PARTTIME: 'part_time', CASUAL: 'casual' }
const TFN_EXEMPT: Record<string, string> = { PENDING: 'applied', UNDER18: 'under_18', PENSIONER: 'pensioner', NOTQUOTED: 'missing' }

function residencyOf(e: any) {
  const t = e.TaxDeclaration ?? {}
  if (t.ResidencyStatus === 'WORKINGHOLIDAYMAKER' || e.IncomeType === 'WORKINGHOLIDAYMAKER') return 'working_holiday'
  if (t.ResidencyStatus === 'FOREIGNRESIDENT' || t.AustralianResidentForTaxPurposes === false) return 'foreign'
  if (t.ResidencyStatus === 'AUSTRALIANRESIDENT' || t.AustralianResidentForTaxPurposes === true) return 'resident'
  return null
}

function addressOf(a: any) {
  if (!a) return null
  const town = [a.City, a.Region, a.PostalCode].filter(Boolean).join(' ')
  return [a.AddressLine1, a.AddressLine2, town].filter(Boolean).join(', ') || null
}

function leaveKind(name: string) {
  if (/long\s*service/i.test(name)) return 'long_service'
  if (/annual|holiday/i.test(name)) return 'annual'
  if (/personal|sick|carer/i.test(name)) return 'personal'
  return null
}

/** True when the 9-digit number passes the ATO check digit (same rule as tfn_valid() in the database). */
function tfnValid(d: string) {
  if (!/^\d{9}$/.test(d)) return false
  const w = [1, 4, 3, 7, 5, 8, 6, 9, 10]
  return [...d].reduce((s, c, i) => s + Number(c) * w[i], 0) % 11 === 0
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: cors })
  const url = new URL(req.url)

  // ---------- Xero sends the browser back here after the owner approves ----------
  if (req.method === 'GET' && url.pathname.endsWith('/callback')) {
    const state = url.searchParams.get('state') ?? ''
    const { data: st } = await admin.from('xero_oauth_states').select('*').eq('state', state).single()
    const back = (q: string) => Response.redirect(`${st?.return_to ?? APP_ORIGINS[0]}${(st?.return_to ?? '').includes('?') ? '&' : '?'}${q}`, 302)
    if (!st || Date.now() - new Date(st.created_at).getTime() > 15 * 60_000) return back('xero=expired')
    await admin.from('xero_oauth_states').delete().eq('state', state)
    if (url.searchParams.get('error')) return back('xero=cancelled')
    try {
      const t = await tokenRequest({ grant_type: 'authorization_code', code: url.searchParams.get('code') ?? '', redirect_uri: REDIRECT })
      const conns = await (await fetch('https://api.xero.com/connections', { headers: { Authorization: `Bearer ${t.access_token}` } })).json() as
        { tenantId: string; tenantName: string; tenantType: string }[]
      const org = conns.find((c) => c.tenantType === 'ORGANISATION') ?? conns[0]
      if (!org) return back('xero=no-organisation')
      const { error } = await admin.rpc('xero_save_tokens', {
        p_business: st.business_id, p_tenant_id: org.tenantId, p_tenant_name: org.tenantName,
        p_tokens: { access_token: t.access_token, refresh_token: t.refresh_token },
        p_expires_at: new Date(Date.now() + t.expires_in * 1000).toISOString(), p_email: st.email,
      })
      if (error) throw new Error(error.message)
      return back('xero=connected')
    } catch (e) {
      console.error(e)
      return back('xero=failed')
    }
  }

  if (req.method !== 'POST') return reply({ error: 'Use POST' }, 405)
  if (!CLIENT_ID || !CLIENT_SECRET) return reply({ error: 'Xero isn’t set up yet: an owner needs to add the Xero app’s client ID and secret.', setup: true }, 501)
  const auth = req.headers.get('Authorization')
  if (!auth) return reply({ error: 'Not signed in' }, 401)

  let body: any
  try { body = await req.json() } catch { return reply({ error: 'Expected JSON' }, 400) }
  const business = String(body.business_id ?? '')
  const asCaller = createClient(URL_, ANON, { global: { headers: { Authorization: auth } } })
  const { data: who } = await asCaller.auth.getUser()
  if (!who?.user) return reply({ error: 'Not signed in' }, 401)
  const { data: allowed } = await asCaller.rpc('has_perm', { b: business, p: 'payroll' })
  if (allowed !== true) return reply({ error: 'Only payroll users can use the Xero connection' }, 403)

  try {
    switch (body.action) {
      case 'start': {
        const returnTo = String(body.return_to ?? '')
        if (!APP_ORIGINS.some((o) => returnTo === o || returnTo.startsWith(o + '/'))) return reply({ error: 'Unexpected return address' }, 400)
        const state = crypto.randomUUID() + crypto.randomUUID()
        await admin.from('xero_oauth_states').insert({ state, business_id: business, email: who.user.email, return_to: returnTo })
        const auth = new URL('https://login.xero.com/identity/connect/authorize')
        auth.search = new URLSearchParams({ response_type: 'code', client_id: CLIENT_ID, redirect_uri: REDIRECT, scope: SCOPES, state }).toString()
        return reply({ url: auth.toString() })
      }

      case 'catalog': {
        const s = await session(business)
        const [emp, items, cals] = await Promise.all([xero(s, '/Employees?where=Status%3D%3D%22ACTIVE%22'), xero(s, '/PayItems'), xero(s, '/PayrollCalendars')])
        return reply({
          employees: (emp?.Employees ?? []).map((e: any) => ({ id: e.EmployeeID, name: `${e.FirstName ?? ''} ${e.LastName ?? ''}`.trim(), calendar: e.PayrollCalendarID })),
          earningsRates: (items?.PayItems?.EarningsRates ?? []).filter((r: any) => r.RateType === 'RATEPERUNIT' || r.RateType === 'MULTIPLE' || r.RateType === 'FIXEDAMOUNT' || !r.RateType)
            .map((r: any) => ({ id: r.EarningsRateID, name: r.Name, type: r.EarningsType, rateType: r.RateType })),
          calendars: (cals?.PayrollCalendars ?? []).map((c: any) => ({ id: c.PayrollCalendarID, name: c.Name, type: c.CalendarType })),
        })
      }

      case 'push': {
        // body: { pay_run_id, period_start, period_end, timesheets: [{ staff_id, lines: [{ label, units: number[] }] }] }
        const s = await session(business)
        const [{ data: staff }, { data: map }] = await Promise.all([
          admin.from('staff').select('id, name, xero_employee_id').eq('business_id', business),
          admin.from('xero_rate_map').select('*').eq('business_id', business),
        ])
        const rateOf = new Map((map ?? []).map((m: any) => [m.pay_label, m.earnings_rate_id]))
        const results: { name: string; status: 'sent' | 'updated' | 'skipped'; note?: string }[] = []
        for (const t of body.timesheets ?? []) {
          const p = (staff ?? []).find((x: any) => x.id === t.staff_id)
          if (!p) continue
          if (!p.xero_employee_id) { results.push({ name: p.name, status: 'skipped', note: 'not linked to a Xero employee' }); continue }
          const unmapped = (t.lines ?? []).filter((l: any) => !rateOf.get(l.label)).map((l: any) => l.label)
          if (unmapped.length) { results.push({ name: p.name, status: 'skipped', note: `no Xero earnings rate for: ${unmapped.join(', ')}` }); continue }
          // Lines that share an earnings rate (e.g. two loadings mapped to one rate) add up.
          const byRate = new Map<string, number[]>()
          for (const l of t.lines) {
            const id = rateOf.get(l.label)!
            const u = byRate.get(id) ?? l.units.map(() => 0)
            byRate.set(id, u.map((v: number, i: number) => Math.round((v + (l.units[i] ?? 0)) * 100) / 100))
          }
          const sheet = {
            EmployeeID: p.xero_employee_id,
            StartDate: `${body.period_start}T00:00:00`, EndDate: `${body.period_end}T00:00:00`,
            Status: 'DRAFT',
            TimesheetLines: [...byRate.entries()].map(([EarningsRateID, NumberOfUnits]) => ({ EarningsRateID, NumberOfUnits })),
          }
          const existing = await xero(s, `/Timesheets?where=${encodeURIComponent(`EmployeeID==Guid("${p.xero_employee_id}")`)}`)
          const same = (existing?.Timesheets ?? []).find((x: any) => msDate(x.StartDate) === body.period_start && msDate(x.EndDate) === body.period_end)
          try {
            if (same && same.Status !== 'DRAFT') { results.push({ name: p.name, status: 'skipped', note: `Xero already has an ${String(same.Status).toLowerCase()} timesheet for this period` }); continue }
            if (same) {
              await xero(s, `/Timesheets/${same.TimesheetID}`, { method: 'POST', body: JSON.stringify([{ ...sheet, TimesheetID: same.TimesheetID }]) })
              results.push({ name: p.name, status: 'updated' })
            } else {
              await xero(s, '/Timesheets', { method: 'POST', body: JSON.stringify([sheet]) })
              results.push({ name: p.name, status: 'sent' })
            }
          } catch (e) {
            results.push({ name: p.name, status: 'skipped', note: (e as Error).message })
          }
        }
        await admin.from('pay_runs').update({ xero_sent_at: new Date().toISOString(), xero_result: results }).eq('id', body.pay_run_id).eq('business_id', business)
        return reply({ results })
      }

      case 'import_preview': {
        // Who's in Xero, and who each one probably is in the app. No tax, bank or super here.
        const s = await session(business)
        const [list, { data: staff, error }] = await Promise.all([
          allEmployees(s),
          asCaller.from('staff').select('id, name, first_name, last_name, email, xero_employee_id').eq('business_id', business).eq('kind', 'employee'),
        ])
        if (error) throw new Error(error.message)
        return reply({
          employees: list.map((e) => ({
            id: e.EmployeeID, name: fullName(e) || '(no name)', email: e.Email ?? null,
            start: xDate(e.StartDate), status: e.Status === 'TERMINATED' ? 'former' : 'active',
            match: matchStaff(e, staff ?? []),
          })).sort((a, b) => a.name.localeCompare(b.name)),
        })
      }

      case 'import': {
        // body: { employees: [{ xero_id, staff_id | null }] }. staff_id null adds a new person;
        // otherwise only details the app doesn't have yet are filled in. Every write is made
        // as the caller, so the usual access rules decide what lands (tax, bank and super need
        // the sensitive area).
        const s = await session(business)
        const picks = (Array.isArray(body.employees) ? body.employees : []).slice(0, 300) as { xero_id: string; staff_id: string | null }[]
        const [{ data: sens }, { data: settings }, { data: staff }] = await Promise.all([
          asCaller.rpc('has_perm', { b: business, p: 'sensitive' }),
          asCaller.from('payroll_settings').select('default_award_code').eq('business_id', business).maybeSingle(),
          asCaller.from('staff').select('*').eq('business_id', business),
        ])
        const sensitive = sens === true
        const funds = new Map<string, any>()
        const results: { name: string; staff_id: string | null; status: 'created' | 'updated' | 'unchanged' | 'failed'; filled: string[]; notes: string[] }[] = []

        for (const pick of picks) {
          const filled: string[] = [], notes: string[] = []
          let name = pick.xero_id
          try {
            const e = (await xero(s, `/Employees/${encodeURIComponent(pick.xero_id)}`))?.Employees?.[0]
            if (!e) throw new Error('Xero didn’t return this employee')
            name = fullName(e) || name
            const t = e.TaxDeclaration ?? {}
            const basis = BASIS[t.EmploymentBasis]
            if (t.EmploymentBasis && !basis) notes.push(`Xero has them as ${String(t.EmploymentBasis).toLowerCase()}: check their employment type`)
            const fromXero: Record<string, unknown> = {
              first_name: e.FirstName?.trim() || null, last_name: e.LastName?.trim() || null,
              email: e.Email?.trim() || null, mobile: (e.Mobile || e.Phone)?.trim() || null,
              date_of_birth: xDate(e.DateOfBirth), address: addressOf(e.HomeAddress),
              role_title: e.JobTitle?.trim() || null, start_date: xDate(e.StartDate),
              xero_employee_id: e.EmployeeID,
            }

            // ---- the person ----
            let staffId = pick.staff_id
            let status: 'created' | 'updated' | 'unchanged' = 'unchanged'
            if (!staffId) {
              const row = {
                ...fromXero, business_id: business, kind: 'employee', name: fullName(e) || 'Unnamed',
                employment_type: basis ?? 'casual',
                status: e.Status === 'TERMINATED' ? 'former' : 'active', end_date: xDate(e.TerminationDate),
                award_code: settings?.default_award_code ?? null,
              }
              const { data, error } = await asCaller.from('staff').insert(row).select('id').single()
              if (error) throw new Error(error.message)
              staffId = data.id
              status = 'created'
            } else {
              const cur = (staff ?? []).find((p: any) => p.id === staffId)
              if (!cur) throw new Error('That person isn’t in this business')
              if (cur.xero_employee_id && cur.xero_employee_id !== e.EmployeeID) notes.push('Already linked to a different Xero employee: link left as it was')
              const patch: Record<string, unknown> = {}
              for (const [k, v] of Object.entries(fromXero)) {
                if (v == null || (cur[k] != null && cur[k] !== '')) continue
                patch[k] = v
                filled.push(k.replace(/_/g, ' ').replace('xero employee id', 'Xero link'))
              }
              if (Object.keys(patch).length) {
                const { error } = await asCaller.from('staff').update(patch).eq('id', staffId)
                if (error) throw new Error(error.message)
                status = 'updated'
              }
            }
            const row = { staff_id: staffId!, business_id: business }

            // ---- tax, bank and super ----
            if (!sensitive) {
              notes.push('Tax, bank and super skipped: you don’t have the Sensitive area')
            } else {
              const [{ data: tax }, { data: bank }, { data: sup }] = await Promise.all([
                asCaller.from('staff_tax').select('tfn_last3, tfn_status, residency').eq('staff_id', staffId).maybeSingle(),
                asCaller.from('staff_bank').select('account_last4').eq('staff_id', staffId).maybeSingle(),
                asCaller.from('staff_super').select('choice, usi, fund_abn').eq('staff_id', staffId).maybeSingle(),
              ])

              if (e.TaxDeclaration && !(tax && (tax.tfn_last3 || tax.tfn_status !== 'missing' || tax.residency))) {
                const digits = String(t.TaxFileNumber ?? '').replace(/\D/g, '')
                const tfn = tfnValid(digits) ? digits : null
                if (t.TaxFileNumber && !tfn && !TFN_EXEMPT[t.TFNExemptionType]) notes.push('Xero didn’t give a usable tax file number: add it on their page')
                const { error } = await asCaller.rpc('save_staff_tax', {
                  p_staff: staffId, p_tfn: tfn, p_tfn_status: TFN_EXEMPT[t.TFNExemptionType] ?? 'missing',
                  p_declaration_date: null, p_residency: residencyOf(e),
                  p_tax_free_threshold: typeof t.TaxFreeThresholdClaimed === 'boolean' ? t.TaxFreeThresholdClaimed : null,
                  p_study_loan: !!(t.HasHELPDebt || t.HasSFSSDebt || t.HasTradeSupportLoanDebt || t.HasLoanOrStudentDebt),
                  p_medicare_variation: null,
                })
                if (error) notes.push(`Tax details not saved: ${error.message}`)
                else filled.push(tfn ? 'tax declaration and TFN' : 'tax declaration')
              }

              const accounts = (e.BankAccounts ?? []) as any[]
              const acct = accounts.find((a) => a.Remainder) ?? accounts[0]
              if (acct && !bank?.account_last4) {
                if (accounts.length > 1) notes.push('Pay is split across accounts in Xero: only the main (remainder) account came across')
                const { error } = await asCaller.rpc('save_staff_bank', {
                  p_staff: staffId, p_account_name: acct.AccountName ?? null, p_bsb: acct.BSB ?? null, p_account: acct.AccountNumber ?? null,
                })
                if (error) notes.push(`Bank account not saved: ${error.message}`)
                else filled.push('bank account')
              }

              const m = (e.SuperMemberships ?? [])[0]
              if (m?.SuperFundID && !(sup && sup.choice !== 'pending' && (sup.usi || sup.fund_abn))) {
                if (!funds.has(m.SuperFundID)) funds.set(m.SuperFundID, (await xero(s, `/Superfunds/${m.SuperFundID}`))?.SuperFunds?.[0] ?? null)
                const f = funds.get(m.SuperFundID)
                if (f) {
                  const smsf = f.Type === 'SMSF'
                  const { error } = await asCaller.from('staff_super').upsert({
                    ...row, choice: smsf ? 'smsf' : 'chosen', fund_name: f.Name ?? null, usi: smsf ? null : (f.USI ?? null),
                    fund_abn: f.ABN ?? null, member_number: m.EmployeeNumber ?? null,
                    smsf_esa: smsf ? (f.ElectronicServiceAddress ?? null) : null, smsf_bsb: smsf ? (f.BSB ?? null) : null,
                    smsf_account: smsf ? (f.AccountNumber ?? null) : null, updated_at: new Date().toISOString(),
                  })
                  if (error) notes.push(`Super not saved: ${error.message}`)
                  else filled.push('super fund')
                }
              }
            }

            // ---- leave balances, only where the app has none yet ----
            const balances = new Map<string, number>()
            for (const b of (e.LeaveBalances ?? []) as any[]) {
              const k = leaveKind(String(b.LeaveName ?? ''))
              if (!k || (b.TypeOfUnits && !/hour/i.test(b.TypeOfUnits))) continue
              balances.set(k, (balances.get(k) ?? 0) + Number(b.NumberOfUnits ?? 0))
            }
            if (balances.size) {
              const { data: have } = await asCaller.from('staff_leave').select('leave_type').eq('staff_id', staffId)
              const missing = [...balances].filter(([k]) => !(have ?? []).some((h: any) => h.leave_type === k))
              if (missing.length) {
                const today = new Date().toISOString().slice(0, 10)
                const { error } = await asCaller.from('staff_leave').insert(missing.map(([leave_type, hours]) => ({ ...row, leave_type, hours: Math.round(hours * 100) / 100, as_of: today })))
                if (error) notes.push(`Leave balances not saved: ${error.message}`)
                else filled.push('leave balances')
              }
            }

            if (status === 'unchanged' && filled.length) status = 'updated'
            if (status === 'created') notes.unshift('Choose their award classification')
            results.push({ name, staff_id: staffId, status, filled, notes })
          } catch (err) {
            results.push({ name, staff_id: pick.staff_id, status: 'failed', filled, notes: [(err as Error).message] })
          }
        }
        return reply({ results })
      }

      case 'disconnect': {
        const { data } = await admin.rpc('xero_load_tokens', { p_business: business })
        const row = (data as { tokens: { refresh_token: string } }[] | null)?.[0]
        if (row) await fetch('https://identity.xero.com/connect/revocation', {
          method: 'POST', headers: { Authorization: basic(), 'Content-Type': 'application/x-www-form-urlencoded' },
          body: new URLSearchParams({ token: row.tokens.refresh_token }),
        }).catch(() => {})
        await admin.from('xero_connections').delete().eq('business_id', business)
        return reply({ ok: true })
      }

      default:
        return reply({ error: 'Unknown action' }, 400)
    }
  } catch (e) {
    return reply({ error: (e as Error).message }, 400)
  }
})
