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

async function xero(s: { tenant: string; token: string }, path: string, init: RequestInit = {}) {
  const res = await fetch(`${API}${path}`, {
    ...init,
    headers: { Authorization: `Bearer ${s.token}`, 'xero-tenant-id': s.tenant, Accept: 'application/json', 'Content-Type': 'application/json', ...(init.headers ?? {}) },
  })
  const text = await res.text()
  let body: any = null
  try { body = text ? JSON.parse(text) : null } catch { body = { raw: text } }
  if (!res.ok) {
    const why = body?.Message || body?.Detail || body?.Title || text.slice(0, 200)
    throw new Error(`Xero said ${res.status}: ${why}`)
  }
  return body
}

/** Xero dates come back as /Date(1572566400000+0000)/. */
const msDate = (v: string) => new Date(Number(/\d+/.exec(v)?.[0] ?? 0)).toISOString().slice(0, 10)

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
