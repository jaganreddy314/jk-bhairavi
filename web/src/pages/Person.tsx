import { useState, type ReactNode } from 'react'
import { Link, useParams } from 'react-router-dom'
import {
  useAvailability, useAwards, usePayrollSettings, useSave, useSaveAvailability, useSaveStaffBank, useSaveStaffLeave, useSaveStaffSuper, useSaveStaffTax, useStaff,
  useStaffBank, useStaffLeave, useStaffReadiness, useStaffSuper, useStaffTax,
} from '../lib/api'
import { usePerms } from '../lib/access'
import { todayStr } from '../lib/dates'
import { aud, parseMoney } from '../lib/format'
import { ageOn, classificationOptions, DOW_SHORT, EMPLOYMENT, employmentLabel, fmtTime, payRates, rateOn, ruleSetOn } from '../lib/payroll'
import type { Staff, StaffAvailability, StaffLeave, StaffSuper, StaffTax, TfnStatus } from '../lib/types'
import { fmtDate, PersonAvatar, readinessOf, startsLater, usePayLookup } from '../components/people'
import { Drawer, ErrorBox, Field, Loading, MoneyInput, Pill, Segmented } from '../components/ui'

export default function Person() {
  const { id } = useParams()
  const staff = useStaff()
  const pay = usePayLookup()
  if (staff.isLoading || !pay.ready) return <Loading />
  const p = staff.data?.find((s) => s.id === id)
  if (!p) return <div className="card mx-auto mt-10 max-w-md p-6 text-center text-muted">Can't find that person. <Link className="text-accent" to="/people">Back to People</Link></div>
  return <Profile key={p.id} p={p} />
}

type Editing = 'personal' | 'employment' | 'availability' | 'tax' | 'super' | 'bank' | 'leave' | null
const row = (label: string, value: ReactNode, missing?: string) => ({ label, value, missing })

function Profile({ p }: { p: Staff }) {
  const { can } = usePerms()
  const pay = usePayLookup()
  const readiness = useStaffReadiness()
  const save = useSave('staff')
  const tax = useStaffTax(can('sensitive') ? p.id : undefined)
  const sup = useStaffSuper(can('sensitive') ? p.id : undefined)
  const bank = useStaffBank(can('sensitive') ? p.id : undefined)
  const leave = useStaffLeave(p.id)
  const avail = useAvailability()
  const [editing, setEditing] = useState<Editing>(null)
  const edit = can('payroll')

  const rates = pay.ratesFor(p)
  const r = readiness.data?.find((x) => x.staff_id === p.id)
  const ready = readinessOf(p, r, rates)
  const done = ready.checks.filter((c) => c.ok).length
  const age = ageOn(p.date_of_birth)
  const close = () => setEditing(null)

  /** Save pay details and keep the rate labour expenses use (hours × rate) in step. */
  const savePay = (patch: Partial<Staff>) => {
    const next = { ...p, ...patch }
    const c = pay.classes.find((x) => x.id === next.classification_id)
    const r2 = c ? payRates(next, rateOn(pay.rates, c.id), ruleSetOn(pay.rules, c.award_code, c.rule_set_key)) : null
    save.mutate({ id: p.id, ...patch, hourly_rate: r2?.weekday ?? next.hourly_rate })
  }

  return (
    <div>
      <Link to="/people" className="inline-flex items-center gap-1.5 text-[13px] font-medium text-ink-2 hover:text-ink">‹ People</Link>
      <div className="mt-3 flex flex-wrap items-center gap-4">
        <PersonAvatar person={p} size={52} />
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-2.5">
            <h1 className="text-2xl font-semibold tracking-[-0.02em]">{p.name}</h1>
            <Pill tone={ready.tone}>{ready.label}</Pill>
          </div>
          <div className="mt-1 text-sm text-muted">
            {[p.role_title, employmentLabel(p.employment_type), p.start_date && `${startsLater(p) ? 'starts' : 'started'} ${fmtDate(p.start_date)}`].filter(Boolean).join(' · ')}
          </div>
        </div>
        {edit && (p.status === 'active'
          ? <button type="button" className="btn btn-sm h-9" onClick={() => save.mutate({ id: p.id, status: 'former', end_date: p.end_date ?? todayStr() })}>Mark as left</button>
          : <button type="button" className="btn btn-sm h-9" onClick={() => save.mutate({ id: p.id, status: 'active', end_date: null })}>Re-hire</button>)}
      </div>
      <div className="mt-3"><ErrorBox error={save.error} /></div>

      <div className="mt-4 flex flex-wrap items-start gap-4">
        <div className="grid min-w-0 flex-[999_1_520px] gap-4">
          <PayCard p={p} edit={edit} onSave={savePay} />

          <Card title="Personal" onEdit={edit ? () => setEditing('personal') : undefined} rows={[
            row('Legal name', [p.first_name, p.last_name].filter(Boolean).join(' ') || p.name),
            ...(p.preferred_name ? [row('Goes by', p.preferred_name)] : []),
            row('Date of birth', p.date_of_birth ? `${fmtDate(p.date_of_birth)} · ${age}` : null, 'Missing'),
            row('Email', p.email, 'Missing'),
            row('Mobile', p.mobile, 'Missing'),
            row('Home address', p.address),
            row('Emergency contact', p.emergency_contact),
          ]} />

          <Card title="Employment" onEdit={edit ? () => setEditing('employment') : undefined}
            note={p.fortnight_hour_limit ? `Can work up to ${p.fortnight_hour_limit} hours a fortnight under their visa. Rosters over that will be flagged once rostering arrives.` : undefined}
            rows={[
              row('Role', p.role_title),
              row('Employment type', employmentLabel(p.employment_type)),
              row('Start date', fmtDate(p.start_date)),
              ...(p.status === 'former' ? [row('Finished', fmtDate(p.end_date))] : []),
              row(p.employment_type === 'part_time' ? 'Agreed hours' : 'Usual hours',
                p.ordinary_hours ? `${p.ordinary_hours} hrs a week${p.agreed_days ? ` · ${p.agreed_days}` : ''}` : null),
              row('Fair Work Information Statement', p.fwis_given_on ? `Given ${fmtDate(p.fwis_given_on)}` : null, 'Not given'),
              ...(p.employment_type === 'casual' ? [row('Casual Employment Information Statement', p.ceis_given_on ? `Given ${fmtDate(p.ceis_given_on)}` : null, 'Not given')] : []),
              row('Right to work', p.right_to_work ? `${p.right_to_work}${p.right_to_work_checked_on ? ` · checked ${fmtDate(p.right_to_work_checked_on)}` : ''}` : null, 'Not checked'),
              ...(p.visa_type ? [row('Visa', `${p.visa_type}${p.visa_expiry ? ` · until ${fmtDate(p.visa_expiry)}` : ''}`)] : []),
            ]} />

          <Card title="Availability" onEdit={can('roster', 'payroll') ? () => setEditing('availability') : undefined}
            note="The roster flags any shift outside these."
            rows={[
              ...(p.employment_type === 'part_time' ? [row('Agreed days', p.agreed_dows?.length ? p.agreed_dows.map((d) => DOW_SHORT[d - 1]).join(', ') : null, 'Not set')] : []),
              ...DOW_SHORT.map((d, i) => row(d, availText((avail.data ?? []).find((a) => a.staff_id === p.id && a.dow === i + 1)))),
            ]} />

          {can('sensitive') ? (
            <>
              <Card title="Tax" onEdit={() => setEditing('tax')} loading={tax.isLoading}
                note={tax.data?.tfn_last3 ? 'Only claim the tax-free threshold from one employer at a time.' : 'Without a TFN declaration, tax must be withheld at the no-TFN rate.'}
                rows={[
                  row('Tax file number', tax.data?.tfn_last3 ? `••• ••• ${tax.data.tfn_last3}` : TFN_STATUS[tax.data?.tfn_status ?? 'missing'] ?? null, 'Not received'),
                  row('Declaration received', fmtDate(tax.data?.declaration_date)),
                  row('Residency', RESIDENCY[tax.data?.residency ?? ''] ?? null),
                  row('Claims tax-free threshold', yesNo(tax.data?.tax_free_threshold)),
                  row('Study and training support loan', yesNo(tax.data?.study_loan)),
                  ...(tax.data?.medicare_variation ? [row('Medicare levy variation', tax.data.medicare_variation)] : []),
                ]} />
              <SuperCard sup={sup.data ?? null} loading={sup.isLoading} onEdit={() => setEditing('super')} />
              <Card title="Bank account" onEdit={() => setEditing('bank')} loading={bank.isLoading} rows={bank.data?.account_last4 ? [
                row('Account name', bank.data.account_name),
                row('BSB', bank.data.bsb),
                row('Account number', `•••• ${bank.data.account_last4}`),
              ] : [row('Account', null, 'Missing')]} />
            </>
          ) : (
            <section className="card p-4 desk:p-5">
              <h2 className="text-base font-semibold">Tax, super and bank</h2>
              <p className="mt-1 text-[13px] text-muted">Only people with the "Tax, bank and super" area can see or change these details.</p>
              <div className="mt-3 grid gap-1.5 text-sm">
                <OnFile label="TFN declaration" ok={!!r && (r.has_tfn || r.tfn_status !== 'missing')} />
                <OnFile label="Super fund" ok={!!r?.has_super} />
                <OnFile label="Bank account" ok={!!r?.has_bank} />
              </div>
            </section>
          )}

          <Card title="Leave" onEdit={edit && p.employment_type !== 'casual' ? () => setEditing('leave') : undefined}
            note={p.employment_type === 'casual' ? undefined : 'Annual leave accrues at 4 weeks a year and personal/carer’s leave at 10 days a year, pro rata for part-time. Pay runs will keep these up to date; until then, enter the balances from your current payroll.'}
            rows={p.employment_type === 'casual'
              ? [row('Paid leave', 'Casuals don’t accrue paid leave. Their casual rate includes a loading instead.')]
              : [
                  row('Annual leave', leaveRow(leave.data, 'annual')),
                  row('Personal / carer’s leave', leaveRow(leave.data, 'personal')),
                  row('Long service leave', leaveRow(leave.data, 'long_service') ?? 'Queensland · after 10 years’ continuous service'),
                ]} />
        </div>

        <aside className="card sticky top-4 min-w-0 flex-[1_1_260px] p-4 desk:p-5">
          <div className="text-[13px] font-medium text-muted">Ready for payroll</div>
          <div className="num mt-1 text-lg font-semibold">{done} of {ready.checks.length} done</div>
          <div className="mt-2 h-1.5 overflow-hidden rounded-[3px] bg-track">
            <div className="h-1.5 rounded-[3px] bg-accent" style={{ width: `${(done / ready.checks.length) * 100}%` }} />
          </div>
          <ul className="mt-4 grid gap-3">
            {ready.checks.map((c) => (
              <li key={c.key} className="flex gap-2.5">
                <span className={`mt-0.5 grid h-[18px] w-[18px] shrink-0 place-items-center rounded-full border-[1.5px] ${c.ok ? 'border-accent bg-accent text-accent-ink' : 'border-[#F79009]'}`}>
                  {c.ok && <svg viewBox="0 0 24 24" width="11" height="11" fill="none" stroke="currentColor" strokeWidth="3.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden><path d="M20 6 9 17l-5-5" /></svg>}
                </span>
                <span className="min-w-0">
                  <span className="block text-[13px] font-medium">{c.label}</span>
                  <span className={`block text-xs ${c.ok ? 'text-muted' : 'text-warn-ink'}`}>{c.sub}</span>
                </span>
              </li>
            ))}
          </ul>
        </aside>
      </div>

      {editing === 'personal' && <PersonalDrawer p={p} onClose={close} />}
      {editing === 'employment' && <EmploymentDrawer p={p} onClose={close} />}
      {editing === 'availability' && <AvailabilityDrawer p={p} rows={(avail.data ?? []).filter((a) => a.staff_id === p.id)} onClose={close} />}
      {editing === 'tax' && <TaxDrawer p={p} tax={tax.data ?? null} onClose={close} />}
      {editing === 'super' && <SuperDrawer p={p} sup={sup.data ?? null} onClose={close} />}
      {editing === 'bank' && <BankDrawer p={p} last4={bank.data?.account_last4 ?? null} name={bank.data?.account_name ?? ''} bsb={bank.data?.bsb ?? ''} onClose={close} />}
      {editing === 'leave' && <LeaveDrawer p={p} leave={leave.data ?? []} onClose={close} />}
    </div>
  )
}

const TFN_STATUS: Partial<Record<TfnStatus, string>> = {
  applied: 'Applied for a TFN (28 days to provide it)', under_18: 'Under 18 · earnings below the threshold',
  pensioner: 'Pensioner exemption', exempt: 'Exempt from quoting a TFN',
}
const RESIDENCY: Record<string, string> = { resident: 'Australian resident for tax purposes', foreign: 'Foreign resident', working_holiday: 'Working holiday maker' }
const yesNo = (b: boolean | null | undefined) => (b == null ? null : b ? 'Yes' : 'No')
const leaveRow = (rows: StaffLeave[] | undefined, t: StaffLeave['leave_type']) => {
  const l = rows?.find((x) => x.leave_type === t)
  return l ? `${l.hours.toFixed(1)} hrs · as of ${fmtDate(l.as_of)}` : null
}

function OnFile({ label, ok }: { label: string; ok: boolean }) {
  return (
    <div className="flex items-center justify-between gap-3">
      <span className="text-ink-2">{label}</span>
      {ok ? <Pill tone="success">On file</Pill> : <Pill tone="warn">Missing</Pill>}
    </div>
  )
}

/** A titled card of label / value rows; a missing value shows a warning tag instead. */
function Card({ title, rows, note, onEdit, loading }: {
  title: string; rows: { label: string; value: ReactNode; missing?: string }[]; note?: string; onEdit?: () => void; loading?: boolean
}) {
  return (
    <section className="card overflow-hidden">
      <div className="flex items-center gap-3 border-b border-line px-4 py-3 desk:px-5">
        <h2 className="flex-1 text-base font-semibold">{title}</h2>
        {onEdit && <button type="button" className="btn btn-sm" onClick={onEdit}>Edit</button>}
      </div>
      {loading ? <Loading /> : (
        <dl className="grid grid-cols-1 desk:grid-cols-[220px_minmax(0,1fr)]">
          {rows.map((r) => (
            <div key={r.label} className="contents">
              <dt className="px-4 pt-2.5 text-[13px] text-muted desk:border-b desk:border-line-2 desk:px-5 desk:py-2.5">{r.label}</dt>
              <dd className="border-b border-line-2 px-4 pb-2.5 text-sm desk:px-5 desk:pt-2.5">
                {r.value || r.value === 0 ? r.value : r.missing ? <span className="inline-flex"><Pill tone="warn">{r.missing}</Pill></span> : <span className="text-faint">—</span>}
              </dd>
            </div>
          ))}
        </dl>
      )}
      {note && <p className="px-4 py-3 text-xs text-muted desk:px-5">{note}</p>}
    </section>
  )
}

function PayCard({ p, edit, onSave }: { p: Staff; edit: boolean; onSave: (patch: Partial<Staff>) => void }) {
  const pay = usePayLookup()
  const awards = useAwards()
  const settings = usePayrollSettings()
  const awardCode = p.award_code ?? settings.data?.default_award_code ?? null
  const award = awards.data?.find((a) => a.code === awardCode)
  const options = classificationOptions(pay.classes, awardCode)
  const rates = pay.ratesFor(p)
  const cls = pay.classOf(p)
  const [above, setAbove] = useState(p.above_award ? String(p.above_award) : '')
  const rateNow = cls ? rateOn(pay.rates, cls.id) : null

  return (
    <section className="card overflow-hidden">
      <div className="border-b border-line px-4 py-3 desk:px-5">
        <h2 className="text-base font-semibold">Pay</h2>
        <p className="mt-0.5 text-[13px] text-muted">{award ? `${award.name} [${award.code}]` : 'No award chosen'} · paid {settings.data?.pay_frequency ?? 'weekly'}</p>
      </div>
      <div className="grid gap-4 p-4 desk:p-5">
        <div>
          <span className="label">Employment type</span>
          {edit
            ? <Segmented ariaLabel="Employment type" value={p.employment_type} onChange={(t) => onSave({ employment_type: t })} options={EMPLOYMENT} />
            : <span className="text-sm">{employmentLabel(p.employment_type)}</span>}
        </div>
        <div className="grid gap-3 desk:grid-cols-[minmax(0,1fr)_minmax(0,1.4fr)_160px]">
          <Field label="Award">
            <select className="field" disabled={!edit} value={awardCode ?? ''} onChange={(e) => onSave({ award_code: e.target.value, classification_id: null })}>
              {(awards.data ?? []).map((a) => <option key={a.code} value={a.code}>{a.code} · {a.name.replace(' Award 2020', '')}</option>)}
            </select>
          </Field>
          <Field label="Classification">
            <select className="field" disabled={!edit} value={p.classification_id ?? ''} onChange={(e) => onSave({ award_code: awardCode, classification_id: e.target.value || null })}>
              <option value="">Choose…</option>
              {options.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
            </select>
          </Field>
          <Field label="Above award ($ / hr)">
            <MoneyInput size="sm" value={above} disabled={!edit} onChange={setAbove} placeholder="0.00" aria-label="Above award per hour"
              onBlur={() => parseMoney(above) !== (p.above_award || 0) && onSave({ above_award: parseMoney(above) })} />
          </Field>
        </div>
        {rates ? (
          <>
            <div className="grid grid-cols-2 gap-2 desk:grid-cols-[repeat(auto-fit,minmax(120px,1fr))]">
              {rates.rows.map((r) => (
                <div key={r.label} className="rounded-[10px] border border-line px-3 py-2.5">
                  <div className="text-xs text-muted">{r.label}</div>
                  <div className="num mt-0.5 text-lg font-semibold">{aud(r.rate)}</div>
                  <div className="text-[11px] text-faint">{r.note}</div>
                </div>
              ))}
            </div>
            <p className="flex gap-2 rounded-[10px] bg-[#F0F9FF] px-3 py-2.5 text-[13px] text-[#026AA2] dark:bg-[#0B2A3F] dark:text-[#7CD4FD]">
              <span aria-hidden>ⓘ</span>
              <span>
                Award minimum from {fmtDate(rateNow?.effective_from)}: {aud(rates.adult)}/hr for {cls?.code}
                {rates.junior && `, junior rate ${rates.junior.band} · ${Math.round(rates.junior.pct * 1000) / 10}%`}
                {p.above_award ? `, plus ${aud(p.above_award)}/hr above award` : ''}.{' '}
                {rates.rule.notes} Check against the Fair Work pay guide before the first pay run.
              </span>
            </p>
          </>
        ) : (
          <p className="rounded-[10px] bg-warn-bg px-3 py-2.5 text-[13px] text-warn-ink">
            Choose a classification to see {p.first_name ?? 'their'}'s rates.
            {p.hourly_rate ? ` Labour expenses currently use ${aud(p.hourly_rate)}/hr.` : ''}
          </p>
        )}
      </div>
    </section>
  )
}

function SuperCard({ sup, loading, onEdit }: { sup: StaffSuper | null; loading: boolean; onEdit: () => void }) {
  const settings = usePayrollSettings()
  const rate = `${settings.data?.super_rate ?? 12}% super guarantee`
  const CHOICE: Record<StaffSuper['choice'], string> = {
    pending: 'Waiting on their choice', chosen: 'Their chosen fund', stapled: 'Stapled fund (from the ATO)', default: 'Your default fund', smsf: 'Self-managed fund',
  }
  return (
    <Card title="Super" onEdit={onEdit} loading={loading}
      note="Payday Super: contributions must reach the fund within 7 business days of each payday (20 business days for a new employee’s first)."
      rows={sup && sup.choice !== 'pending' ? [
        row('How it was chosen', CHOICE[sup.choice]),
        row('Fund', sup.fund_name),
        ...(sup.choice === 'smsf' ? [row('Fund ABN', sup.fund_abn), row('Electronic service address', sup.smsf_esa)] : [row('USI', sup.usi)]),
        row('Member number', sup.member_number),
        row('Contribution rate', rate + (sup.extra_percent ? ` + ${sup.extra_percent}% extra` : '')),
      ] : [row('Fund', null, 'Missing'), row('Contribution rate', rate)]} />
  )
}

// ---------- edit drawers ----------

function Footer({ onClose, busy }: { onClose: () => void; busy: boolean }) {
  return <>
    <button type="button" className="btn" onClick={onClose}>Cancel</button>
    <button className="btn btn-primary" disabled={busy}>{busy ? 'Saving…' : 'Save'}</button>
  </>
}

function PersonalDrawer({ p, onClose }: { p: Staff; onClose: () => void }) {
  const save = useSave('staff')
  const [v, setV] = useState({
    first_name: p.first_name ?? '', last_name: p.last_name ?? '', preferred_name: p.preferred_name ?? '', date_of_birth: p.date_of_birth ?? '',
    email: p.email ?? '', mobile: p.mobile ?? '', address: p.address ?? '', emergency_contact: p.emergency_contact ?? '',
  })
  const set = (k: keyof typeof v) => (e: { target: { value: string } }) => setV({ ...v, [k]: e.target.value })
  const submit = async () => {
    if (!v.first_name.trim()) return
    await save.mutateAsync({ id: p.id, ...Object.fromEntries(Object.entries(v).map(([k, x]) => [k, x.trim() || null])) })
    onClose()
  }
  return (
    <Drawer title="Personal details" onClose={onClose} onSubmit={submit} footer={<Footer onClose={onClose} busy={save.isPending} />}>
      <ErrorBox error={save.error} />
      <div className="grid grid-cols-2 gap-3">
        <Field label="First name"><input className="field" value={v.first_name} onChange={set('first_name')} required /></Field>
        <Field label="Last name"><input className="field" value={v.last_name} onChange={set('last_name')} /></Field>
      </div>
      <Field label="Goes by" hint="Shown around the app instead of their first name."><input className="field" value={v.preferred_name} onChange={set('preferred_name')} /></Field>
      <Field label="Date of birth" hint="Sets junior rates for anyone under 21."><input type="date" className="field" value={v.date_of_birth} onChange={set('date_of_birth')} /></Field>
      <Field label="Email"><input type="email" className="field" value={v.email} onChange={set('email')} /></Field>
      <Field label="Mobile"><input inputMode="tel" className="field" value={v.mobile} onChange={set('mobile')} /></Field>
      <Field label="Home address"><input className="field" value={v.address} onChange={set('address')} /></Field>
      <Field label="Emergency contact" hint="Name, relationship and phone."><input className="field" value={v.emergency_contact} onChange={set('emergency_contact')} /></Field>
    </Drawer>
  )
}

function EmploymentDrawer({ p, onClose }: { p: Staff; onClose: () => void }) {
  const save = useSave('staff')
  const [v, setV] = useState({
    role_title: p.role_title ?? '', start_date: p.start_date ?? '', end_date: p.end_date ?? '',
    ordinary_hours: p.ordinary_hours != null ? String(p.ordinary_hours) : '', agreed_days: p.agreed_days ?? '',
    fwis_given_on: p.fwis_given_on ?? '', ceis_given_on: p.ceis_given_on ?? '', right_to_work: p.right_to_work ?? '',
    right_to_work_checked_on: p.right_to_work_checked_on ?? '', visa_type: p.visa_type ?? '', visa_expiry: p.visa_expiry ?? '',
    fortnight_hour_limit: p.fortnight_hour_limit != null ? String(p.fortnight_hour_limit) : '', notes: p.notes ?? '',
  })
  const set = (k: keyof typeof v) => (e: { target: { value: string } }) => setV({ ...v, [k]: e.target.value })
  const submit = async () => {
    const out: Record<string, unknown> = Object.fromEntries(Object.entries(v).map(([k, x]) => [k, x.trim() || null]))
    out.ordinary_hours = v.ordinary_hours ? parseMoney(v.ordinary_hours) : null
    out.fortnight_hour_limit = v.fortnight_hour_limit ? parseMoney(v.fortnight_hour_limit) : null
    await save.mutateAsync({ id: p.id, ...out })
    onClose()
  }
  return (
    <Drawer title="Employment" onClose={onClose} onSubmit={submit} footer={<Footer onClose={onClose} busy={save.isPending} />}>
      <ErrorBox error={save.error} />
      <Field label="Role"><input className="field" value={v.role_title} onChange={set('role_title')} placeholder="e.g. Console operator" /></Field>
      <div className="grid grid-cols-2 gap-3">
        <Field label="Start date"><input type="date" className="field" value={v.start_date} onChange={set('start_date')} /></Field>
        {p.status === 'former' && <Field label="Finished"><input type="date" className="field" value={v.end_date} onChange={set('end_date')} /></Field>}
      </div>
      <Field label={p.employment_type === 'part_time' ? 'Agreed hours a week' : p.employment_type === 'casual' ? 'Usual hours a week' : 'Ordinary hours a week'}>
        <input inputMode="decimal" className="field" value={v.ordinary_hours} onChange={set('ordinary_hours')} />
      </Field>
      {p.employment_type === 'part_time' && (
        <Field label="Agreed days and times" hint="Part-time employees need their regular pattern agreed in writing.">
          <input className="field" value={v.agreed_days} onChange={set('agreed_days')} placeholder="Mon, Tue, Thu · 6am – 2pm" />
        </Field>
      )}
      <Field label="Fair Work Information Statement given"><input type="date" className="field" value={v.fwis_given_on} onChange={set('fwis_given_on')} /></Field>
      {p.employment_type === 'casual' && (
        <Field label="Casual Employment Information Statement given"><input type="date" className="field" value={v.ceis_given_on} onChange={set('ceis_given_on')} /></Field>
      )}
      <div className="grid grid-cols-2 gap-3">
        <Field label="Right to work"><input className="field" value={v.right_to_work} onChange={set('right_to_work')} placeholder="Australian citizen / VEVO" /></Field>
        <Field label="Checked on"><input type="date" className="field" value={v.right_to_work_checked_on} onChange={set('right_to_work_checked_on')} /></Field>
      </div>
      <div className="grid grid-cols-2 gap-3">
        <Field label="Visa"><input className="field" value={v.visa_type} onChange={set('visa_type')} placeholder="e.g. Student (500)" /></Field>
        <Field label="Visa expires"><input type="date" className="field" value={v.visa_expiry} onChange={set('visa_expiry')} /></Field>
      </div>
      <Field label="Hour limit a fortnight" hint="Student visa holders can work 48 hours a fortnight while their course is in session.">
        <input inputMode="decimal" className="field" value={v.fortnight_hour_limit} onChange={set('fortnight_hour_limit')} />
      </Field>
      <Field label="Notes"><textarea rows={2} className="field" value={v.notes} onChange={set('notes')} /></Field>
    </Drawer>
  )
}

function TaxDrawer({ p, tax, onClose }: { p: Staff; tax: StaffTax | null; onClose: () => void }) {
  const save = useSaveStaffTax()
  const [tfn, setTfn] = useState('')
  const [v, setV] = useState({
    status: (tax?.tfn_status === 'provided' ? 'missing' : tax?.tfn_status ?? 'missing') as TfnStatus,
    declared: tax?.declaration_date ?? '', residency: tax?.residency ?? 'resident',
    threshold: tax?.tax_free_threshold ?? true, studyLoan: tax?.study_loan ?? false, medicare: tax?.medicare_variation ?? '',
  })
  const submit = async () => {
    await save.mutateAsync({
      staff: p.id, tfn: tfn.trim() ? tfn : null, status: v.status, declared: v.declared || null, residency: v.residency,
      threshold: v.threshold, studyLoan: v.studyLoan, medicare: v.medicare.trim() || null,
    })
    onClose()
  }
  return (
    <Drawer title="Tax" sub="From their TFN declaration. The number is encrypted and only its last 3 digits are ever shown again."
      onClose={onClose} onSubmit={submit} footer={<Footer onClose={onClose} busy={save.isPending} />}>
      <ErrorBox error={save.error} />
      <Field label={tax?.tfn_last3 ? `Tax file number (on file: ••• ••• ${tax.tfn_last3})` : 'Tax file number'}
        hint={tax?.tfn_last3 ? 'Leave blank to keep the number on file.' : 'Nine digits, checked as you save.'}>
        <input className="field num" inputMode="numeric" autoComplete="off" value={tfn} onChange={(e) => setTfn(e.target.value)} placeholder="123 456 789" />
      </Field>
      {!tax?.tfn_last3 && !tfn.trim() && (
        <Field label="No number yet because">
          <select className="field" value={v.status} onChange={(e) => setV({ ...v, status: e.target.value as TfnStatus })}>
            <option value="missing">Not received</option>
            <option value="applied">They've applied for one</option>
            <option value="under_18">Under 18, earning under the threshold</option>
            <option value="pensioner">Receiving a pension</option>
            <option value="exempt">Exempt from quoting</option>
          </select>
        </Field>
      )}
      <Field label="Declaration received"><input type="date" className="field" value={v.declared} onChange={(e) => setV({ ...v, declared: e.target.value })} /></Field>
      <Field label="Residency for tax">
        <select className="field" value={v.residency} onChange={(e) => setV({ ...v, residency: e.target.value as 'resident' })}>
          <option value="resident">Australian resident</option>
          <option value="foreign">Foreign resident</option>
          <option value="working_holiday">Working holiday maker</option>
        </select>
      </Field>
      <label className="flex items-center gap-2.5 text-sm"><input type="checkbox" className="h-4 w-4 accent-[var(--accent)]" checked={v.threshold} onChange={(e) => setV({ ...v, threshold: e.target.checked })} />Claims the tax-free threshold</label>
      <label className="flex items-center gap-2.5 text-sm"><input type="checkbox" className="h-4 w-4 accent-[var(--accent)]" checked={v.studyLoan} onChange={(e) => setV({ ...v, studyLoan: e.target.checked })} />Has a study and training support loan (HELP, VSL, SFSS, SSL, TSL)</label>
      <Field label="Medicare levy variation" hint="Only if they lodged a variation declaration."><input className="field" value={v.medicare} onChange={(e) => setV({ ...v, medicare: e.target.value })} /></Field>
    </Drawer>
  )
}

function SuperDrawer({ p, sup, onClose }: { p: Staff; sup: StaffSuper | null; onClose: () => void }) {
  const save = useSaveStaffSuper()
  const [v, setV] = useState({
    choice: sup?.choice ?? 'chosen', fund_name: sup?.fund_name ?? '', usi: sup?.usi ?? '', fund_abn: sup?.fund_abn ?? '',
    member_number: sup?.member_number ?? '', smsf_esa: sup?.smsf_esa ?? '', smsf_bsb: sup?.smsf_bsb ?? '', smsf_account: sup?.smsf_account ?? '',
    extra_percent: sup?.extra_percent != null ? String(sup.extra_percent) : '',
  })
  const set = (k: keyof typeof v) => (e: { target: { value: string } }) => setV({ ...v, [k]: e.target.value })
  const smsf = v.choice === 'smsf'
  const submit = async () => {
    const t = (x: string) => x.trim() || null
    await save.mutateAsync({
      staff_id: p.id, choice: v.choice as StaffSuper['choice'], fund_name: t(v.fund_name), usi: smsf ? null : t(v.usi), fund_abn: t(v.fund_abn),
      member_number: t(v.member_number), smsf_esa: smsf ? t(v.smsf_esa) : null, smsf_bsb: smsf ? t(v.smsf_bsb) : null,
      smsf_account: smsf ? t(v.smsf_account) : null, extra_percent: v.extra_percent ? parseMoney(v.extra_percent) : null,
    })
    onClose()
  }
  return (
    <Drawer title="Super" sub="From their super choice form, or the stapled fund the ATO gives you." onClose={onClose} onSubmit={submit}
      footer={<Footer onClose={onClose} busy={save.isPending} />}>
      <ErrorBox error={save.error} />
      <Field label="How the fund was chosen">
        <select className="field" value={v.choice} onChange={set('choice')}>
          <option value="chosen">Their chosen fund</option>
          <option value="stapled">Stapled fund from the ATO</option>
          <option value="default">Your default fund</option>
          <option value="smsf">Self-managed super fund</option>
          <option value="pending">Still waiting on them</option>
        </select>
      </Field>
      <Field label="Fund name"><input className="field" value={v.fund_name} onChange={set('fund_name')} placeholder="e.g. AustralianSuper" /></Field>
      {smsf ? (
        <>
          <Field label="Fund ABN"><input className="field" value={v.fund_abn} onChange={set('fund_abn')} /></Field>
          <Field label="Electronic service address"><input className="field" value={v.smsf_esa} onChange={set('smsf_esa')} /></Field>
          <div className="grid grid-cols-2 gap-3">
            <Field label="Fund BSB"><input className="field" value={v.smsf_bsb} onChange={set('smsf_bsb')} /></Field>
            <Field label="Fund account"><input className="field" value={v.smsf_account} onChange={set('smsf_account')} /></Field>
          </div>
        </>
      ) : (
        <Field label="USI" hint="Unique superannuation identifier, e.g. STA0100AU."><input className="field" value={v.usi} onChange={set('usi')} /></Field>
      )}
      <Field label="Member number"><input className="field" value={v.member_number} onChange={set('member_number')} /></Field>
      <Field label="Extra contributions (% of earnings)" hint="Salary sacrifice or extra the employee asked for, on top of the super guarantee.">
        <input inputMode="decimal" className="field" value={v.extra_percent} onChange={set('extra_percent')} />
      </Field>
    </Drawer>
  )
}

function BankDrawer({ p, last4, name, bsb, onClose }: { p: Staff; last4: string | null; name: string; bsb: string; onClose: () => void }) {
  const save = useSaveStaffBank()
  const [v, setV] = useState({ name: name || p.name, bsb, account: '' })
  const submit = async () => {
    await save.mutateAsync({ staff: p.id, accountName: v.name, bsb: v.bsb, account: v.account.trim() ? v.account : null })
    onClose()
  }
  return (
    <Drawer title="Bank account" sub="Where their wages are paid. The account number is encrypted; only its last 4 digits are shown again."
      onClose={onClose} onSubmit={submit} footer={<Footer onClose={onClose} busy={save.isPending} />}>
      <ErrorBox error={save.error} />
      <Field label="Account name"><input className="field" value={v.name} onChange={(e) => setV({ ...v, name: e.target.value })} /></Field>
      <Field label="BSB"><input className="field num" inputMode="numeric" value={v.bsb} onChange={(e) => setV({ ...v, bsb: e.target.value })} placeholder="000-000" /></Field>
      <Field label={last4 ? `Account number (on file: •••• ${last4})` : 'Account number'} hint={last4 ? 'Leave blank to keep the number on file.' : undefined}>
        <input className="field num" inputMode="numeric" autoComplete="off" value={v.account} onChange={(e) => setV({ ...v, account: e.target.value })} />
      </Field>
    </Drawer>
  )
}

function LeaveDrawer({ p, leave, onClose }: { p: Staff; leave: StaffLeave[]; onClose: () => void }) {
  const save = useSaveStaffLeave()
  const hrs = (t: StaffLeave['leave_type']) => { const l = leave.find((x) => x.leave_type === t); return l ? String(l.hours) : '' }
  const [v, setV] = useState({ annual: hrs('annual'), personal: hrs('personal'), long_service: hrs('long_service'), as_of: todayStr() })
  const submit = async () => {
    const types = ['annual', 'personal', 'long_service'] as const
    await save.mutateAsync(types.filter((t) => v[t].trim() !== '').map((t) => ({ staff_id: p.id, leave_type: t, hours: parseMoney(v[t]), as_of: v.as_of })))
    onClose()
  }
  return (
    <Drawer title="Leave balances" sub="Opening balances from your current payroll, in hours." onClose={onClose} onSubmit={submit}
      footer={<Footer onClose={onClose} busy={save.isPending} />}>
      <ErrorBox error={save.error} />
      <Field label="Annual leave (hours)"><input inputMode="decimal" className="field" value={v.annual} onChange={(e) => setV({ ...v, annual: e.target.value })} /></Field>
      <Field label="Personal / carer’s leave (hours)"><input inputMode="decimal" className="field" value={v.personal} onChange={(e) => setV({ ...v, personal: e.target.value })} /></Field>
      <Field label="Long service leave (hours)"><input inputMode="decimal" className="field" value={v.long_service} onChange={(e) => setV({ ...v, long_service: e.target.value })} /></Field>
      <Field label="As of"><input type="date" className="field" value={v.as_of} onChange={(e) => setV({ ...v, as_of: e.target.value })} /></Field>
    </Drawer>
  )
}

const availText = (a: StaffAvailability | undefined) =>
  !a ? 'Any time'
    : !a.available ? `Not available${a.note ? ` · ${a.note}` : ''}`
    : [a.from_minute != null && `From ${fmtTime(a.from_minute)}`, a.to_minute != null && `until ${fmtTime(a.to_minute)}`].filter(Boolean).join(' ') + (a.note ? ` · ${a.note}` : '') || 'Any time'

type Avail = 'any' | 'off' | 'limited'

function AvailabilityDrawer({ p, rows, onClose }: { p: Staff; rows: StaffAvailability[]; onClose: () => void }) {
  const saveAvail = useSaveAvailability()
  const save = useSave('staff')
  const [agreed, setAgreed] = useState<number[]>(p.agreed_dows ?? [])
  const [days, setDays] = useState(() => DOW_SHORT.map((_, i) => {
    const a = rows.find((r) => r.dow === i + 1)
    return { kind: (!a ? 'any' : !a.available ? 'off' : 'limited') as Avail, from: a?.from_minute ?? null, to: a?.to_minute ?? null, note: a?.note ?? '' }
  }))
  const times = Array.from({ length: 39 }, (_, i) => 300 + i * 30)
  const setDay = (i: number, patch: Partial<(typeof days)[number]>) => setDays(days.map((d, j) => (j === i ? { ...d, ...patch } : d)))
  async function submit() {
    await saveAvail.mutateAsync({
      staffId: p.id,
      rows: days.flatMap((d, i) => d.kind === 'any' ? [] : [{
        dow: i + 1, available: d.kind !== 'off', from_minute: d.kind === 'limited' ? d.from : null, to_minute: d.kind === 'limited' ? d.to : null, note: d.note.trim() || null,
      }]),
    })
    if (p.employment_type === 'part_time') await save.mutateAsync({ id: p.id, agreed_dows: agreed.length ? [...agreed].sort() : null })
    onClose()
  }
  return (
    <Drawer title="Availability" sub="When they can work. Shifts outside this are flagged on the roster." onClose={onClose} onSubmit={submit}
      footer={<Footer onClose={onClose} busy={saveAvail.isPending || save.isPending} />}>
      <ErrorBox error={saveAvail.error || save.error} />
      {p.employment_type === 'part_time' && (
        <div>
          <span className="label">Agreed days</span>
          <div className="flex flex-wrap gap-1.5">
            {DOW_SHORT.map((d, i) => (
              <button key={d} type="button" className="chip" aria-pressed={agreed.includes(i + 1)}
                onClick={() => setAgreed(agreed.includes(i + 1) ? agreed.filter((x) => x !== i + 1) : [...agreed, i + 1])}>{d}</button>
            ))}
          </div>
          <p className="mt-1 text-xs text-muted">Part-time employees work the days agreed in writing; others count as a change to their hours.</p>
        </div>
      )}
      {days.map((d, i) => (
        <div key={i} className="grid gap-2 rounded-[10px] border border-line p-3">
          <div className="flex items-center justify-between gap-2">
            <span className="text-sm font-semibold">{DOW_SHORT[i]}</span>
            <Segmented ariaLabel={`${DOW_SHORT[i]} availability`} value={d.kind} onChange={(k) => setDay(i, { kind: k, from: k === 'limited' ? d.from ?? 900 : null })}
              options={[{ value: 'any', label: 'Any time' }, { value: 'limited', label: 'Some hours' }, { value: 'off', label: 'Not available' }]} />
          </div>
          {d.kind === 'limited' && (
            <div className="grid grid-cols-2 gap-2">
              <select aria-label="From" className="field" value={d.from ?? ''} onChange={(e) => setDay(i, { from: e.target.value === '' ? null : Number(e.target.value) })}>
                <option value="">From opening</option>
                {times.map((t) => <option key={t} value={t}>From {fmtTime(t)}</option>)}
              </select>
              <select aria-label="Until" className="field" value={d.to ?? ''} onChange={(e) => setDay(i, { to: e.target.value === '' ? null : Number(e.target.value) })}>
                <option value="">Until closing</option>
                {times.map((t) => <option key={t} value={t}>Until {fmtTime(t)}</option>)}
              </select>
            </div>
          )}
          {d.kind !== 'any' && <input className="field" aria-label="Why" value={d.note} onChange={(e) => setDay(i, { note: e.target.value })} placeholder="e.g. school, uni" />}
        </div>
      ))}
    </Drawer>
  )
}
