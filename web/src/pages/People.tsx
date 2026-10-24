import { useState } from 'react'
import { useNavigate, useSearchParams } from 'react-router-dom'
import { useAwards, usePayrollSettings, useSave, useStaff, useStaffReadiness } from '../lib/api'
import { usePerms } from '../lib/access'
import { todayStr } from '../lib/dates'
import { aud, audRound, cents, parseMoney } from '../lib/format'
import { classificationOptions, EMPLOYMENT, employmentLabel, payRates, rateOn, ruleSetOn } from '../lib/payroll'
import type { EmploymentType, Staff } from '../lib/types'
import { PersonAvatar, readinessOf, startsLater, usePayLookup } from '../components/people'
import { PayrollSetup } from '../components/PayrollSetup'
import { AccessTab } from '../components/AccessTab'
import { Drawer, ErrorBox, Field, Kpi, KPI_GRID, Loading, Pill, SearchBox, Segmented } from '../components/ui'

type Tab = 'team' | 'setup' | 'access'

export default function People() {
  const { can } = usePerms()
  const [params, setParams] = useSearchParams()
  const tabs = ([['team', 'Team', can('people', 'payroll')], ['setup', 'Payroll setup', can('payroll')], ['access', 'Access', can('admin')]] as const)
    .filter(([, , ok]) => ok)
  const raw = params.get('tab') as Tab | null
  const tab: Tab = tabs.some(([k]) => k === raw) ? raw! : tabs[0]?.[0] ?? 'team'
  const [adding, setAdding] = useState(false)

  return (
    <div>
      <div className="flex flex-wrap items-end justify-between gap-4">
        <div>
          <h1 className="text-2xl font-semibold tracking-[-0.02em]">People</h1>
          <p className="mt-1 text-sm text-muted">Everyone who works here, and what you need to pay them correctly.</p>
        </div>
        {tab === 'team' && can('payroll') && (
          <button type="button" className="btn btn-primary" onClick={() => setAdding(true)}>
            <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" aria-hidden><path d="M5 12h14M12 5v14" /></svg>
            Add person
          </button>
        )}
      </div>
      {tabs.length > 1 && (
        <nav aria-label="People" className="mt-4 flex gap-6 overflow-x-auto border-b border-line [scrollbar-width:none]">
          {tabs.map(([k, label]) => (
            <button key={k} type="button" aria-current={tab === k ? 'page' : undefined}
              onClick={() => setParams(k === 'team' ? {} : { tab: k }, { replace: true })}
              className={`-mb-px shrink-0 border-b-2 px-1 pb-2.5 pt-1 text-sm font-medium ${tab === k ? 'border-accent text-accent' : 'border-transparent text-muted hover:text-ink-2'}`}>
              {label}
            </button>
          ))}
        </nav>
      )}
      <div className="mt-4">
        {tab === 'team' && <Team />}
        {tab === 'setup' && <PayrollSetup />}
        {tab === 'access' && <AccessTab />}
      </div>
      {adding && <AddPerson onClose={() => setAdding(false)} />}
    </div>
  )
}

type Filter = 'current' | 'attention' | 'ready' | 'former'
const TEAM_COLS = 'desk:grid-cols-[minmax(160px,1.6fr)_84px_92px_52px_minmax(130px,1.2fr)_16px]'

function Team() {
  const nav = useNavigate()
  const staff = useStaff()
  const readiness = useStaffReadiness()
  const settings = usePayrollSettings()
  const pay = usePayLookup()
  const [filter, setFilter] = useState<Filter>('current')
  const [q, setQ] = useState('')

  if (staff.isLoading || !pay.ready) return <Loading />
  const people = (staff.data ?? []).filter((p) => p.kind === 'employee')
  const payees = (staff.data ?? []).filter((p) => p.kind === 'payee')
  const rows = people.map((p) => {
    const rates = pay.ratesFor(p)
    return { p, rates, ready: readinessOf(p, readiness.data?.find((r) => r.staff_id === p.id), rates), cls: pay.classOf(p) }
  })
  const current = rows.filter((r) => r.p.status === 'active')
  const working = current.filter((r) => !startsLater(r.p))
  const readyN = current.filter((r) => r.ready.ok).length
  const weekly = cents(working.reduce((s, r) => s + (r.rates?.weekday ?? 0) * (r.p.ordinary_hours ?? 0), 0))
  const superRate = (settings.data?.super_rate ?? 12) / 100
  const needle = q.trim().toLowerCase()
  const shown = rows
    .filter((r) => filter === 'former' ? r.p.status === 'former' : r.p.status === 'active' && (filter === 'current' || (filter === 'ready') === r.ready.ok))
    .filter((r) => !needle || r.p.name.toLowerCase().includes(needle))
    .sort((a, b) => a.p.name.localeCompare(b.p.name))

  return (
    <div className="grid gap-4">
      <ErrorBox error={staff.error || readiness.error} />
      <div className={KPI_GRID}>
        <Kpi label="Team" value={String(current.length)} note={`${working.length} working · ${current.length - working.length} starting soon`} />
        <Kpi label="Ready for payroll" value={`${readyN} of ${current.length}`} tone={readyN < current.length ? undefined : 'good'}
          note="TFN, super, bank and statements in place" />
        <Kpi label="Wages a week" value={audRound(weekly)} note="Estimate at weekday rates for usual hours" />
        <Kpi label="Super a week" value={audRound(cents(weekly * superRate))}
          note={`${settings.data?.super_rate ?? 12}% of ordinary earnings, due within 7 business days of payday`} />
      </div>

      <section className="card overflow-hidden">
        <div className="flex flex-wrap items-center gap-2.5 border-b border-line px-3.5 py-3 desk:px-5">
          <Segmented ariaLabel="Show" value={filter} onChange={setFilter} options={[
            { value: 'current', label: 'Current' }, { value: 'attention', label: 'Needs attention' },
            { value: 'ready', label: 'Ready' }, { value: 'former', label: 'Former' },
          ]} />
          <SearchBox value={q} onChange={setQ} placeholder="Search people" />
        </div>
        <div className={`hidden gap-3 border-b border-line bg-hover px-5 py-2.5 text-xs font-medium text-muted desk:grid ${TEAM_COLS}`}>
          <span>Person</span><span>Type</span><span>Base rate</span><span>Hrs / wk</span><span>Payroll setup</span><span />
        </div>
        {shown.map(({ p, rates, ready, cls }) => (
          <button key={p.id} type="button" onClick={() => nav(`/people/${p.id}`)}
            className={`grid w-full grid-cols-[minmax(0,1fr)_auto] items-center gap-3 border-b border-line-2 px-3.5 py-3 text-left hover:bg-hover desk:px-5 ${TEAM_COLS} ${p.status === 'former' ? 'opacity-60' : ''}`}>
            <span className="flex min-w-0 items-center gap-3">
              <PersonAvatar person={p} />
              <span className="min-w-0">
                <span className="block truncate font-semibold">{p.name}</span>
                <span className="block truncate text-xs text-muted">
                  {[p.role_title, cls?.code, rates?.junior ? 'junior' : null, startsLater(p) ? 'starts later' : null].filter(Boolean).join(' · ') || employmentLabel(p.employment_type)}
                </span>
                <span className="mt-1 inline-flex desk:hidden"><Pill tone={ready.tone}>{ready.label}</Pill></span>
              </span>
            </span>
            <span className="hidden text-[13px] text-ink-2 desk:block">{employmentLabel(p.employment_type)}</span>
            <span className="num text-right font-semibold desk:text-left desk:font-normal">{rates ? `${aud(rates.weekday)}/hr` : <span className="text-faint">—</span>}</span>
            <span className="num hidden text-ink-2 desk:block">{p.ordinary_hours ?? '—'}</span>
            <span className="hidden min-w-0 desk:block">
              <Pill tone={ready.tone}>{ready.label}</Pill>
              <span className="mt-1 block truncate text-xs text-muted">{ready.note}</span>
            </span>
            <span className="hidden text-faint desk:block" aria-hidden>›</span>
          </button>
        ))}
        {shown.length === 0 && <p className="py-10 text-center text-muted">{people.length ? 'No one matches.' : 'No one on the team yet. Add the first person.'}</p>}
      </section>

      {payees.length > 0 && (
        <p className="text-xs text-muted">
          Not shown: {payees.map((p) => p.name).join(', ')} — names labour expenses were booked against, kept so those expenses
          still read right. They aren't people on the team.
        </p>
      )}
    </div>
  )
}

/** Start someone's record with the basics; tax, super and bank details come next. */
function AddPerson({ onClose }: { onClose: () => void }) {
  const nav = useNavigate()
  const save = useSave('staff')
  const settings = usePayrollSettings()
  const awards = useAwards()
  const pay = usePayLookup()
  const [award, setAward] = useState<string | null>(null)
  const awardCode = award ?? settings.data?.default_award_code ?? awards.data?.[0]?.code ?? null
  const options = classificationOptions(pay.classes, awardCode)
  const [v, setV] = useState({ first: '', last: '', email: '', mobile: '', dob: '', type: 'casual' as EmploymentType, cls: '', start: todayStr(), hours: '' })
  const set = (k: keyof typeof v, val: string) => setV({ ...v, [k]: val })
  const cls = v.cls || options[0]?.id || ''
  const preview = payRates({ employment_type: v.type, date_of_birth: v.dob || null, above_award: 0 },
    rateOn(pay.rates, cls), ruleSetOn(pay.rules, awardCode, options.find((o) => o.id === cls)?.rule_set_key))
  const ok = v.first.trim() && v.last.trim()

  async function submit() {
    if (!ok) return
    const rows = await save.mutateAsync({
      first_name: v.first.trim(), last_name: v.last.trim(), name: `${v.first.trim()} ${v.last.trim()}`,
      email: v.email.trim() || null, mobile: v.mobile.trim() || null, date_of_birth: v.dob || null,
      employment_type: v.type, award_code: awardCode, classification_id: cls || null, start_date: v.start || null,
      ordinary_hours: v.hours ? parseMoney(v.hours) : null, hourly_rate: preview?.weekday ?? null, status: 'active', kind: 'employee',
    }) as Staff[] | null
    onClose()
    if (rows?.[0]) nav(`/people/${rows[0].id}`)
  }

  return (
    <Drawer title="Add person" sub="Start with the basics. Tax, super and bank details can be added next." onClose={onClose} onSubmit={submit}
      footer={<>
        <button type="button" className="btn" onClick={onClose}>Cancel</button>
        <button className="btn btn-primary" disabled={!ok || save.isPending}>{save.isPending ? 'Adding…' : 'Add person'}</button>
      </>}>
      <ErrorBox error={save.error} />
      <div className="grid grid-cols-2 gap-3">
        <Field label="First name"><input className="field" value={v.first} onChange={(e) => set('first', e.target.value)} required autoFocus /></Field>
        <Field label="Last name"><input className="field" value={v.last} onChange={(e) => set('last', e.target.value)} required /></Field>
      </div>
      <Field label="Email"><input type="email" className="field" value={v.email} onChange={(e) => set('email', e.target.value)} placeholder="For payslips" /></Field>
      <div className="grid grid-cols-2 gap-3">
        <Field label="Mobile"><input inputMode="tel" className="field" value={v.mobile} onChange={(e) => set('mobile', e.target.value)} placeholder="04xx xxx xxx" /></Field>
        <Field label="Date of birth"><input type="date" className="field" value={v.dob} onChange={(e) => set('dob', e.target.value)} /></Field>
      </div>
      <span className="-mt-2 text-xs text-muted">Date of birth sets junior rates for anyone under 21.</span>
      <div>
        <span className="label">Employment type</span>
        <Segmented ariaLabel="Employment type" value={v.type} onChange={(t) => set('type', t)} options={EMPLOYMENT} />
      </div>
      <Field label="Award">
        <select className="field" value={awardCode ?? ''} onChange={(e) => { setAward(e.target.value); set('cls', '') }}>
          {(awards.data ?? []).map((a) => <option key={a.code} value={a.code}>{a.name} [{a.code}]</option>)}
        </select>
      </Field>
      <div className="grid grid-cols-2 gap-3">
        <Field label="Classification">
          <select className="field" value={cls} onChange={(e) => set('cls', e.target.value)}>
            {options.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
          </select>
        </Field>
        <Field label="Start date"><input type="date" className="field" value={v.start} onChange={(e) => set('start', e.target.value)} /></Field>
      </div>
      <Field label={v.type === 'casual' ? 'Usual hours a week (for estimates)' : v.type === 'part_time' ? 'Agreed hours a week' : 'Ordinary hours a week'}>
        <input inputMode="decimal" className="field" value={v.hours} onChange={(e) => set('hours', e.target.value)} placeholder={v.type === 'full_time' ? '38' : ''} />
      </Field>
      <div className="num flex items-center justify-between rounded-[10px] bg-surface-2 px-3.5 py-3 text-sm">
        <span className="text-ink-2">{v.type === 'casual' ? 'Weekday rate' : 'Base hourly rate'}</span>
        <strong className="font-semibold">{preview ? `${aud(preview.weekday)}/hr${preview.junior ? ' · junior' : ''}` : '—'}</strong>
      </div>
    </Drawer>
  )
}
