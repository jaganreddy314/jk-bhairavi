// Email each person their payslip from a finalised pay run.
//
// Sent through Resend (resend.com). Set these secrets once:
//   supabase secrets set RESEND_API_KEY=re_...  PAYSLIP_FROM="Caltex Kedron <payroll@yourdomain.com.au>"
// The From address must be on a domain verified in Resend.
//
// Deployed with: supabase functions deploy send-payslips --use-api --project-ref <ref>
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2'

const URL_ = Deno.env.get('SUPABASE_URL')!
const ANON = Deno.env.get('SUPABASE_ANON_KEY')!
const SERVICE = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!
const RESEND = Deno.env.get('RESEND_API_KEY')
const FROM = Deno.env.get('PAYSLIP_FROM')

const cors = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, content-type, apikey, x-client-info',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
}
const reply = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { ...cors, 'Content-Type': 'application/json' } })

const esc = (s: unknown) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]!))
const money = (n: number) => new Intl.NumberFormat('en-AU', { style: 'currency', currency: 'AUD' }).format(n ?? 0)
const day = (d: string) => new Intl.DateTimeFormat('en-AU', { timeZone: 'UTC', day: 'numeric', month: 'short', year: 'numeric' }).format(new Date(`${d}T00:00:00Z`))

interface Item { label: string; hours?: number; rate?: number; amount: number }

function payslipHtml(o: {
  employer: string; abn: string; address: string; period: string; paid: string; result: Record<string, any>
}) {
  const r = o.result
  const rows = (r.items as Item[]).map((i) =>
    `<tr><td style="padding:6px 0">${esc(i.label)}</td><td align="right">${i.hours ?? ''}</td><td align="right">${i.rate != null ? money(i.rate) : ''}</td><td align="right">${money(i.amount)}</td></tr>`).join('')
  const person = r.person ?? {}
  return `<!doctype html><html><body style="margin:0;background:#f6f7f9;font-family:system-ui,-apple-system,Segoe UI,Roboto,sans-serif;color:#101828">
<div style="max-width:640px;margin:24px auto;background:#fff;border:1px solid #e4e7ec;border-radius:12px;padding:24px">
  <table width="100%" style="border-bottom:1px solid #e4e7ec;padding-bottom:12px"><tr>
    <td><div style="font-size:18px;font-weight:600">${esc(o.employer)}</div><div style="font-size:12px;color:#667085">ABN ${esc(o.abn)}${o.address ? ' · ' + esc(o.address) : ''}</div></td>
    <td align="right"><div style="font-weight:600">Payslip</div><div style="font-size:12px;color:#667085">Pay period ${esc(o.period)}<br>Paid ${esc(o.paid)}</div></td>
  </tr></table>
  <p style="margin:12px 0 0;font-weight:600">${esc(person.name)}</p>
  <p style="margin:0;font-size:12px;color:#667085">${esc([person.employment_type?.replace('_', '-'), person.classification, person.award].filter(Boolean).join(' · '))}</p>
  <table width="100%" style="margin-top:16px;font-size:14px;border-collapse:collapse">
    <tr style="color:#667085;font-size:12px;text-align:left"><th>Earnings</th><th align="right">Hours</th><th align="right">Rate</th><th align="right">Amount</th></tr>
    ${rows}
    <tr style="font-weight:600;border-top:1px solid #e4e7ec"><td style="padding:6px 0">Gross pay</td><td></td><td></td><td align="right">${money(r.gross)}</td></tr>
    <tr><td style="padding:6px 0">PAYG tax withheld</td><td></td><td></td><td align="right">−${money(r.tax?.amount)}</td></tr>
    ${r.reimbursements > 0 ? `<tr><td style="padding:6px 0">Reimbursements</td><td></td><td></td><td align="right">${money(r.reimbursements)}</td></tr>` : ''}
    <tr style="font-weight:600;font-size:16px"><td style="padding:8px 0">Net pay</td><td></td><td></td><td align="right">${money(r.net)}</td></tr>
  </table>
  <p style="font-size:13px;margin:16px 0 0">Superannuation: ${money(r.super)} (${esc(r.superRate)}% of ${money(r.ote)})${r.super_fund ? ' paid to ' + esc(r.super_fund) : ''}${r.superNote ? ' · ' + esc(r.superNote) : ''}</p>
  <p style="font-size:12px;color:#667085;margin:6px 0 0">Year to date: gross ${money(r.ytd?.gross)} · tax ${money(r.ytd?.tax)} · super ${money(r.ytd?.super)}</p>
</div></body></html>`
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: cors })
  if (req.method !== 'POST') return reply({ error: 'Use POST' }, 405)
  if (!RESEND || !FROM) return reply({ error: 'Payslip email isn’t set up yet: an owner needs to add the Resend key and From address.' }, 501)
  const auth = req.headers.get('Authorization')
  if (!auth) return reply({ error: 'Not signed in' }, 401)

  let payRunId = '', only: string[] | null = null
  try {
    const body = await req.json()
    payRunId = String(body.pay_run_id ?? '')
    only = Array.isArray(body.staff_ids) ? body.staff_ids.map(String) : null
  } catch { return reply({ error: 'Expected JSON' }, 400) }

  const admin = createClient(URL_, SERVICE, { auth: { persistSession: false } })
  const { data: run } = await admin.from('pay_runs').select('*').eq('id', payRunId).single()
  if (!run) return reply({ error: 'No such pay run' }, 404)
  if (run.status !== 'finalised') return reply({ error: 'Finalise the pay run first' }, 400)

  // Same rule as the rest of the app, asked as the caller.
  const asCaller = createClient(URL_, ANON, { global: { headers: { Authorization: auth } } })
  const { data: allowed } = await asCaller.rpc('has_perm', { b: run.business_id, p: 'payroll' })
  if (allowed !== true) return reply({ error: 'Only payroll users can send payslips' }, 403)

  const [{ data: settings }, { data: biz }, { data: lines }] = await Promise.all([
    admin.from('payroll_settings').select('*').eq('business_id', run.business_id).single(),
    admin.from('businesses').select('name').eq('id', run.business_id).single(),
    admin.from('pay_run_lines').select('id, staff_id, result, staff(name, email)').eq('pay_run_id', payRunId),
  ])
  if (!settings?.legal_name || !settings?.abn) return reply({ error: 'Add the business’s legal name and ABN in Payroll setup first — payslips must show them.' }, 400)

  const period = `${day(run.period_start)} – ${day(run.period_end)}`
  const sent: string[] = []
  const skipped: { name: string; reason: string }[] = []
  for (const l of lines ?? []) {
    if (only && !only.includes(l.staff_id)) continue
    const s = l.staff as unknown as { name: string; email: string | null }
    if (!s?.email) { skipped.push({ name: s?.name ?? '—', reason: 'no email address' }); continue }
    const res = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: { Authorization: `Bearer ${RESEND}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        from: FROM, to: [s.email], reply_to: settings.payslip_reply_to || undefined,
        subject: `Your payslip · ${biz?.name ?? settings.legal_name} · ${period}`,
        html: payslipHtml({ employer: settings.legal_name, abn: settings.abn, address: settings.address ?? '', period, paid: day(run.pay_date), result: l.result ?? {} }),
      }),
    })
    if (!res.ok) { skipped.push({ name: s.name, reason: `email service said ${res.status}: ${(await res.text()).slice(0, 160)}` }); continue }
    await admin.from('pay_run_lines').update({ emailed_at: new Date().toISOString() }).eq('id', l.id)
    sent.push(s.name)
  }
  return reply({ sent, skipped })
})
