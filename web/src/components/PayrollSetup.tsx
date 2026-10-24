import { useState, type ReactNode } from 'react'
import {
  useAwardClassifications, useAwardRates, useAwardRuleSets, useAwards, usePayrollSettings, useSaveAwardRate, useSavePayrollSettings,
  useStaff, useStaffReadiness,
} from '../lib/api'
import { usePerms } from '../lib/access'
import { addDays, todayStr, weekStart } from '../lib/dates'
import { aud, parseMoney } from '../lib/format'
import { rateOn } from '../lib/payroll'
import type { PayrollSettings } from '../lib/types'
import { fmtDate, readinessOf, usePayLookup } from './people'
import { Drawer, ErrorBox, Field, Loading, Segmented } from './ui'

const DOW = ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday', 'Sunday']

export function PayrollSetup() {
  const settings = usePayrollSettings()
  const awards = useAwards()
  const staff = useStaff()
  const readiness = useStaffReadiness()
  const pay = usePayLookup()
  const { can } = usePerms()
  const [editing, setEditing] = useState<'business' | 'cycle' | 'super' | null>(null)
  const save = useSavePayrollSettings()

  if (settings.isLoading || awards.isLoading) return <Loading />
  const s = settings.data
  const award = awards.data?.find((a) => a.code === s?.default_award_code)
  // Pay periods run Monday to Sunday; pay day is that many days after the Sunday.
  const periodEnd = addDays(weekStart(todayStr()), 6)
  const payDay = addDays(periodEnd, s?.pay_day_offset ?? 2)
  const payDayName = DOW[(7 + 6 + (s?.pay_day_offset ?? 2)) % 7]
  const current = (staff.data ?? []).filter((p) => p.kind === 'employee' && p.status === 'active')
  const readyN = current.filter((p) => readinessOf(p, readiness.data?.find((r) => r.staff_id === p.id), pay.ratesFor(p)).ok).length

  const checks: [string, boolean, string][] = [
    ['Business details and ABN', !!(s?.legal_name && s?.abn), s?.abn ? `ABN ${s.abn}` : 'Add your ABN and legal entity name'],
    ['Pay cycle', true, `${cap(s?.pay_frequency ?? 'weekly')}, Monday to Sunday, paid ${payDayName}`],
    ['Award and rates', !!award, award ? `${award.code} rates in place` : 'Choose the award this business uses'],
    ['Single Touch Payroll', s?.stp_status === 'connected', 'Report each pay to the ATO — set up with pay runs'],
    ['Super payments', !!s?.super_payment_method, s?.super_payment_method ?? 'Choose how super is paid each payday'],
    ['Staff ready', current.length > 0 && readyN === current.length, `${readyN} of ${current.length} people ready`],
  ]
  const done = checks.filter((c) => c[1]).length

  return (
    <div className="flex flex-wrap items-start gap-4">
      <div className="grid min-w-0 flex-[999_1_520px] gap-4">
        <ErrorBox error={settings.error || save.error} />
        <SetupCard title="Business" sub="Shown on payslips and reported to the ATO." onEdit={can('payroll') ? () => setEditing('business') : undefined} rows={[
          ['Legal entity name', s?.legal_name, 'Not added'],
          ['ABN', s?.abn, 'Not added'],
          ['Address', s?.address],
        ]} />
        <SetupCard title="Pay cycle" sub="Matches how the shop already runs: weeks are Monday to Sunday." onEdit={can('payroll') ? () => setEditing('cycle') : undefined} rows={[
          ['Frequency', cap(s?.pay_frequency ?? 'weekly')],
          ['Pay period', 'Monday to Sunday'],
          ['Pay day', `${payDayName} after the period ends`],
          ['Next pay day', `${fmtDate(payDay)} · for ${fmtDate(weekStart(todayStr()))} – ${fmtDate(periodEnd)}`],
        ]} />
        <section className="card overflow-hidden">
          <div className="border-b border-line px-4 py-3 desk:px-5">
            <h2 className="text-base font-semibold">Award</h2>
            <p className="mt-0.5 text-[13px] text-muted">New people start on this award. Anyone can be moved to another award on their own page.</p>
          </div>
          <div className="grid gap-3 p-4 desk:p-5">
            <Field label="This business's award">
              <select className="field" disabled={!can('payroll')} value={s?.default_award_code ?? ''}
                onChange={(e) => save.mutate({ default_award_code: e.target.value })}>
                {(awards.data ?? []).map((a) => <option key={a.code} value={a.code}>{a.name} [{a.code}]</option>)}
              </select>
            </Field>
            <p className="text-xs text-muted">Public holidays: {s?.state ?? 'QLD'}.</p>
          </div>
        </section>
        <SetupCard title="Super" sub="Payday Super applies from 1 July 2026." onEdit={can('payroll') ? () => setEditing('super') : undefined} rows={[
          ['Super guarantee', `${s?.super_rate ?? 12}% of ordinary time earnings`],
          ['When it’s due', 'In the fund within 7 business days of payday'],
          ['How it’s paid', s?.super_payment_method, 'Not set up. The ATO Small Business Superannuation Clearing House closed on 1 July 2026.'],
        ]} />
        <SetupCard title="Single Touch Payroll" sub="Each pay run is reported to the ATO on or before payday." rows={[
          ['Status', s?.stp_status === 'connected' ? 'Connected' : null, 'Not connected'],
          ['Version', 'STP Phase 2'],
        ]} note="Lodging with the ATO goes through ATO-approved software. This comes with pay runs, as an export for a sending service." />
        <AwardRates />
      </div>

      <aside className="card sticky top-4 min-w-0 flex-[1_1_260px] p-4 desk:p-5">
        <div className="text-[13px] font-medium text-muted">Before your first pay run</div>
        <div className="num mt-1 text-lg font-semibold">{done} of {checks.length} done</div>
        <div className="mt-2 h-1.5 overflow-hidden rounded-[3px] bg-track">
          <div className="h-1.5 rounded-[3px] bg-accent" style={{ width: `${(done / checks.length) * 100}%` }} />
        </div>
        <ul className="mt-4 grid gap-3">
          {checks.map(([label, ok, sub]) => (
            <li key={label} className="flex gap-2.5">
              <span className={`mt-0.5 grid h-[18px] w-[18px] shrink-0 place-items-center rounded-full border-[1.5px] ${ok ? 'border-accent bg-accent text-accent-ink' : 'border-input-line'}`}>
                {ok && <svg viewBox="0 0 24 24" width="11" height="11" fill="none" stroke="currentColor" strokeWidth="3.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden><path d="M20 6 9 17l-5-5" /></svg>}
              </span>
              <span className="min-w-0">
                <span className="block text-[13px] font-medium">{label}</span>
                <span className="block text-xs text-muted">{sub}</span>
              </span>
            </li>
          ))}
        </ul>
        <button type="button" className="btn mt-4 w-full" disabled title="Pay runs come in a later phase">Run first pay</button>
      </aside>

      {editing === 'business' && s && <BusinessDrawer s={s} onClose={() => setEditing(null)} />}
      {editing === 'cycle' && s && <CycleDrawer s={s} onClose={() => setEditing(null)} />}
      {editing === 'super' && s && <SuperDrawer s={s} onClose={() => setEditing(null)} />}
    </div>
  )
}

const cap = (s: string) => s[0].toUpperCase() + s.slice(1)

/** The pay guides' hourly rate: the weekly rate over a 38-hour week, to the cent. */
const hourlyOf = (weekly: number) => Math.round((weekly / 38) * 100 + 1e-7) / 100

function SetupCard({ title, sub, rows, onEdit, note }: {
  title: string; sub: string; rows: [string, ReactNode, string?][]; onEdit?: () => void; note?: string
}) {
  return (
    <section className="card overflow-hidden">
      <div className="flex items-start gap-3 border-b border-line px-4 py-3 desk:px-5">
        <div className="flex-1">
          <h2 className="text-base font-semibold">{title}</h2>
          <p className="mt-0.5 text-[13px] text-muted">{sub}</p>
        </div>
        {onEdit && <button type="button" className="btn btn-sm" onClick={onEdit}>Edit</button>}
      </div>
      <dl className="grid grid-cols-1 desk:grid-cols-[200px_minmax(0,1fr)]">
        {rows.map(([label, value, missing]) => (
          <div key={label} className="contents">
            <dt className="px-4 pt-2.5 text-[13px] text-muted desk:border-b desk:border-line-2 desk:px-5 desk:py-2.5">{label}</dt>
            <dd className={`border-b border-line-2 px-4 pb-2.5 text-sm desk:px-5 desk:pt-2.5 ${value ? '' : 'font-medium text-warn-ink'}`}>{value || missing || '—'}</dd>
          </div>
        ))}
      </dl>
      {note && <p className="px-4 py-3 text-xs text-muted desk:px-5">{note}</p>}
    </section>
  )
}

function BusinessDrawer({ s, onClose }: { s: PayrollSettings; onClose: () => void }) {
  const save = useSavePayrollSettings()
  const [v, setV] = useState({ legal_name: s.legal_name ?? '', abn: s.abn ?? '', address: s.address ?? '' })
  const abnDigits = v.abn.replace(/\D/g, '')
  const abnOk = !abnDigits || abnValid(abnDigits)
  return (
    <Drawer title="Business" onClose={onClose}
      onSubmit={async () => { if (!abnOk) return; await save.mutateAsync({ legal_name: v.legal_name.trim() || null, abn: abnDigits ? formatAbn(abnDigits) : null, address: v.address.trim() || null }); onClose() }}
      footer={<><button type="button" className="btn" onClick={onClose}>Cancel</button><button className="btn btn-primary" disabled={!abnOk || save.isPending}>Save</button></>}>
      <ErrorBox error={save.error} />
      <Field label="Legal entity name" hint="The company, trust or sole trader that employs the staff."><input className="field" value={v.legal_name} onChange={(e) => setV({ ...v, legal_name: e.target.value })} /></Field>
      <Field label="ABN" hint={abnOk ? '11 digits, checked as you type.' : <span className="text-bad">That isn't a valid ABN.</span>}>
        <input className="field num" inputMode="numeric" value={v.abn} onChange={(e) => setV({ ...v, abn: e.target.value })} placeholder="12 345 678 901" />
      </Field>
      <Field label="Address"><input className="field" value={v.address} onChange={(e) => setV({ ...v, address: e.target.value })} /></Field>
    </Drawer>
  )
}

/** The ATO's ABN check: subtract 1 from the first digit, weight, and the sum divides by 89. */
function abnValid(d: string) {
  if (!/^\d{11}$/.test(d)) return false
  const w = [10, 1, 3, 5, 7, 9, 11, 13, 15, 17, 19]
  return [...d].reduce((s, c, i) => s + (Number(c) - (i === 0 ? 1 : 0)) * w[i], 0) % 89 === 0
}
const formatAbn = (d: string) => `${d.slice(0, 2)} ${d.slice(2, 5)} ${d.slice(5, 8)} ${d.slice(8)}`

function CycleDrawer({ s, onClose }: { s: PayrollSettings; onClose: () => void }) {
  const save = useSavePayrollSettings()
  const [v, setV] = useState({ pay_frequency: s.pay_frequency, pay_day_offset: s.pay_day_offset })
  return (
    <Drawer title="Pay cycle" onClose={onClose} onSubmit={async () => { await save.mutateAsync(v); onClose() }}
      footer={<><button type="button" className="btn" onClick={onClose}>Cancel</button><button className="btn btn-primary" disabled={save.isPending}>Save</button></>}>
      <ErrorBox error={save.error} />
      <div>
        <span className="label">How often</span>
        <Segmented ariaLabel="Pay frequency" value={v.pay_frequency} onChange={(f) => setV({ ...v, pay_frequency: f })}
          options={[{ value: 'weekly', label: 'Weekly' }, { value: 'fortnightly', label: 'Fortnightly' }, { value: 'monthly', label: 'Monthly' }]} />
      </div>
      <Field label="Pay day" hint="Days after the pay period ends on Sunday.">
        <select className="field" value={v.pay_day_offset} onChange={(e) => setV({ ...v, pay_day_offset: Number(e.target.value) })}>
          {[1, 2, 3, 4, 5].map((n) => <option key={n} value={n}>{DOW[(6 + n) % 7]} ({n} day{n > 1 ? 's' : ''} later)</option>)}
        </select>
      </Field>
    </Drawer>
  )
}

function SuperDrawer({ s, onClose }: { s: PayrollSettings; onClose: () => void }) {
  const save = useSavePayrollSettings()
  const [v, setV] = useState({ super_rate: String(s.super_rate), super_payment_method: s.super_payment_method ?? '' })
  return (
    <Drawer title="Super" onClose={onClose}
      onSubmit={async () => { await save.mutateAsync({ super_rate: parseMoney(v.super_rate), super_payment_method: v.super_payment_method.trim() || null }); onClose() }}
      footer={<><button type="button" className="btn" onClick={onClose}>Cancel</button><button className="btn btn-primary" disabled={save.isPending}>Save</button></>}>
      <ErrorBox error={save.error} />
      <Field label="Super guarantee rate (%)" hint="12% from 1 July 2025."><input inputMode="decimal" className="field" value={v.super_rate} onChange={(e) => setV({ ...v, super_rate: e.target.value })} /></Field>
      <Field label="How super is paid" hint="e.g. your bank's super payment service, or a clearing house your payroll provider offers.">
        <input className="field" value={v.super_payment_method} onChange={(e) => setV({ ...v, super_payment_method: e.target.value })} />
      </Field>
    </Drawer>
  )
}

/** Award classifications and their rates — shared by every business, so a change applies everywhere. */
function AwardRates() {
  const awards = useAwards()
  const classes = useAwardClassifications()
  const rates = useAwardRates()
  const rules = useAwardRuleSets()
  const settings = usePayrollSettings()
  const { can } = usePerms()
  const [award, setAward] = useState<string | null>(null)
  const [adding, setAdding] = useState(false)
  if (!awards.data || !classes.data || !rates.data) return <Loading />
  const code = award ?? settings.data?.default_award_code ?? awards.data[0]?.code
  const list = classes.data.filter((c) => c.award_code === code && c.active).sort((a, b) => a.sort - b.sort)
  const groups = [...new Set(list.map((c) => c.rule_set_key))]
  const latest = rates.data.filter((r) => list.some((c) => c.id === r.classification_id)).map((r) => r.effective_from).sort().pop()

  return (
    <section className="card overflow-hidden">
      <div className="flex flex-wrap items-start gap-3 border-b border-line px-4 py-3 desk:px-5">
        <div className="min-w-0 flex-1">
          <h2 className="text-base font-semibold">Award rates</h2>
          <p className="mt-0.5 text-[13px] text-muted">From the Fair Work Ombudsman pay guide. Shared by all your businesses, so a change here applies everywhere this award is used.</p>
        </div>
        {can('payroll') && <button type="button" className="btn btn-sm" onClick={() => setAdding(true)}>Add new rates</button>}
      </div>
      <div className="flex flex-wrap items-center gap-2.5 border-b border-line px-4 py-3 desk:px-5">
        <select aria-label="Award" className="field !h-9 !w-auto !py-0 !text-[13px]" value={code} onChange={(e) => setAward(e.target.value)}>
          {awards.data.map((a) => <option key={a.code} value={a.code}>{a.code} · {a.name.replace(' Award 2020', '')}</option>)}
        </select>
        <span className="text-xs text-muted">{latest ? `Latest rates from ${fmtDate(latest)}` : 'No rates yet'}</span>
      </div>
      {groups.map((g) => {
        const rule = rules.data?.find((r) => r.award_code === code && r.key === g)
        return (
          <div key={g}>
            <div className="bg-hover px-4 py-2 text-xs font-semibold text-ink-2 desk:px-5">{rule?.name ?? g}</div>
            {list.filter((c) => c.rule_set_key === g).map((c) => {
              const r = rateOn(rates.data!, c.id)
              return (
                <div key={c.id} className="num grid grid-cols-[minmax(0,1fr)_auto] items-center gap-3 border-t border-line-2 px-4 py-2.5 text-sm desk:grid-cols-[minmax(0,1fr)_110px_100px] desk:px-5">
                  <span className="min-w-0">{c.name}</span>
                  <span className="hidden text-right text-muted desk:block">{r ? `${aud(r.weekly)}/wk` : '—'}</span>
                  <span className="text-right font-semibold">{r ? `${aud(r.hourly)}/hr` : '—'}</span>
                </div>
              )
            })}
            {rule?.notes && <p className="border-t border-line-2 px-4 py-2 text-xs text-muted desk:px-5">{rule.notes}</p>}
          </div>
        )
      })}
      {adding && code && <NewRatesDrawer code={code} onClose={() => setAdding(false)} />}
    </section>
  )
}

/** Next year's rates (or a correction): one figure per classification, from a date. */
function NewRatesDrawer({ code, onClose }: { code: string; onClose: () => void }) {
  const classes = useAwardClassifications()
  const rates = useAwardRates()
  const save = useSaveAwardRate()
  const list = (classes.data ?? []).filter((c) => c.award_code === code && c.active).sort((a, b) => a.sort - b.sort)
  const y = Number(todayStr().slice(0, 4))
  const [from, setFrom] = useState(`${todayStr() >= `${y}-07-01` ? y + 1 : y}-07-01`)
  const [v, setV] = useState<Record<string, string>>(() =>
    Object.fromEntries(list.map((c) => [c.id, String(rateOn(rates.data ?? [], c.id)?.weekly ?? '')])))
  const [error, setError] = useState<unknown>(null)
  async function submit() {
    setError(null)
    try {
      for (const c of list) {
        const w = parseMoney(v[c.id] ?? '')
        if (w > 0) await save.mutateAsync({ classification_id: c.id, effective_from: from, weekly: w, hourly: hourlyOf(w) })
      }
      onClose()
    } catch (e) { setError(e) }
  }
  return (
    <Drawer title="Add new rates" sub={`${code}. Enter the weekly rates from the pay guide; the hourly rate is the weekly rate ÷ 38, as in the guide.`}
      onClose={onClose} onSubmit={submit}
      footer={<><button type="button" className="btn" onClick={onClose}>Cancel</button><button className="btn btn-primary" disabled={save.isPending}>{save.isPending ? 'Saving…' : 'Save rates'}</button></>}>
      <ErrorBox error={error} />
      <Field label="From" hint="Usually the first full pay period on or after 1 July."><input type="date" className="field" value={from} onChange={(e) => setFrom(e.target.value)} /></Field>
      {list.map((c) => (
        <div key={c.id} className="grid grid-cols-[minmax(0,1fr)_110px_70px] items-center gap-3">
          <span className="text-[13px] text-ink-2">{c.name}</span>
          <input inputMode="decimal" aria-label={`${c.name} weekly rate`} className="field num text-right" value={v[c.id] ?? ''} onChange={(e) => setV({ ...v, [c.id]: e.target.value })} />
          <span className="num text-right text-xs text-muted">{parseMoney(v[c.id] ?? '') ? aud(hourlyOf(parseMoney(v[c.id] ?? ''))) : '—'}</span>
        </div>
      ))}
    </Drawer>
  )
}
