import { useState } from 'react'
import { Link, useNavigate, useParams } from 'react-router-dom'
import {
  useAllLeave, useFinalisePayRun, usePaidThisYear, usePayrollSettings, usePayRun, usePayRunPayments, usePayRuns, usePublicHolidays, useRemove, useReopenPayRun,
  useSave, useSavePayLine, useSendPayslips, useShifts, useStaff, useStaffReadiness, useStaffTaxProfile, useXeroAction, useXeroConnection,
} from '../lib/api'
import { addDays, fmtShort, todayStr, weekStart } from '../lib/dates'
import { aud, audRound, cents, parseMoney } from '../lib/format'
import { employmentLabel, payRates, rateOn, ruleSetOn } from '../lib/payroll'
import { financialYearStart, payLine, superDueDate, type ExtraItem, type PayInputs, type PayLine } from '../lib/payrun'
import { WITHHOLDING_SOURCE, type Frequency } from '../lib/withholding'
import type { PayRun, Staff, XeroPushResult } from '../lib/types'
import { abaFile, bsbOk } from '../lib/aba'
import { usePerms } from '../lib/access'
import { useBusiness } from '../lib/business'
import { fmtDate, PersonAvatar, usePayLookup } from '../components/people'
import { DeleteButton, Empty, ErrorBox, Field, Kpi, KPI_GRID, Loading, PageHeader, Pill } from '../components/ui'

const periodLabel = (r: Pick<PayRun, 'period_start' | 'period_end'>) => `${fmtShort(r.period_start)} – ${fmtShort(r.period_end)} ${r.period_end.slice(0, 4)}`
const sum = (xs: (number | null | undefined)[]) => cents(xs.reduce<number>((s, x) => s + (x ?? 0), 0))

// ---------------- list ----------------

export default function PayRuns() {
  const nav = useNavigate()
  const runs = usePayRuns()
  const settings = usePayrollSettings()
  const start = useSave('pay_runs')
  if (runs.isLoading || settings.isLoading) return <Loading />
  const list = runs.data ?? []
  // The next period to pay: the week after the latest run, or the week just finished.
  const latest = list[0]
  // The latest week that has ended by today (a week ending today counts).
  const lastWeek = weekStart(addDays(todayStr(), -6))
  const nextStart = latest ? addDays(latest.period_end, 1) : lastWeek
  const nextEnd = addDays(nextStart, (settings.data?.pay_frequency === 'fortnightly' ? 14 : 7) - 1)
  const payDate = addDays(nextEnd, settings.data?.pay_day_offset ?? 2)

  return (
    <div>
      <PageHeader title="Pay runs" subtitle="Each pay period's wages, tax and super, worked out from the roster and award rates."
        action={
          <button type="button" className="btn btn-primary" disabled={start.isPending || settings.data?.pay_frequency === 'monthly'}
            onClick={async () => {
              const rows = await start.mutateAsync({ period_start: nextStart, period_end: nextEnd, pay_date: payDate }) as PayRun[] | null
              if (rows?.[0]) nav(`/pay-runs/${rows[0].id}`)
            }}>
            Start pay run · {fmtShort(nextStart)} – {fmtShort(nextEnd)}
          </button>
        } />
      <ErrorBox error={runs.error || start.error} />
      {list.length === 0 ? (
        <Empty>
          No pay runs yet. Start the first one: it takes everyone's shifts from the Schedule for that week and works out
          their pay at award rates.
        </Empty>
      ) : (
        <section className="card overflow-hidden">
          <div className="hidden grid-cols-[minmax(0,1.4fr)_110px_90px_repeat(4,100px)] gap-3 border-b border-line bg-hover px-5 py-2.5 text-xs font-medium text-muted desk:grid">
            <span>Pay period</span><span>Pay day</span><span>People</span><span className="text-right">Gross</span><span className="text-right">Tax</span><span className="text-right">Super</span><span className="text-right">Net</span>
          </div>
          {list.map((r) => {
            const lines = r.pay_run_lines ?? []
            return (
              <Link key={r.id} to={`/pay-runs/${r.id}`}
                className="num grid grid-cols-[minmax(0,1fr)_auto] items-center gap-3 border-b border-line-2 px-3.5 py-3 hover:bg-hover desk:grid-cols-[minmax(0,1.4fr)_110px_90px_repeat(4,100px)] desk:px-5">
                <span className="min-w-0">
                  <span className="block font-semibold">{periodLabel(r)}</span>
                  <span className="mt-0.5 inline-flex"><Pill tone={r.status === 'finalised' ? 'success' : 'neutral'}>{r.status === 'finalised' ? 'Paid' : 'Draft'}</Pill></span>
                </span>
                <span className="hidden text-ink-2 desk:block">{fmtDate(r.pay_date)}</span>
                <span className="hidden text-ink-2 desk:block">{r.status === 'finalised' ? lines.length : '—'}</span>
                <span className="text-right font-semibold desk:font-normal">{r.status === 'finalised' ? aud(sum(lines.map((l) => l.gross))) : 'Draft'}</span>
                <span className="hidden text-right text-ink-2 desk:block">{r.status === 'finalised' ? aud(sum(lines.map((l) => l.tax))) : ''}</span>
                <span className="hidden text-right text-ink-2 desk:block">{r.status === 'finalised' ? aud(sum(lines.map((l) => l.super))) : ''}</span>
                <span className="hidden text-right font-semibold desk:block">{r.status === 'finalised' ? aud(sum(lines.map((l) => l.net))) : ''}</span>
              </Link>
            )
          })}
        </section>
      )}
      <p className="mt-3 text-xs text-muted">Tax is worked out with the {WITHHOLDING_SOURCE}. Award rates are from the Fair Work Ombudsman pay guides.</p>
    </div>
  )
}

// ---------------- one pay run ----------------

export function PayRunPage() {
  const { id } = useParams()
  const run = usePayRun(id)
  if (run.isLoading) return <Loading />
  if (!run.data) return <div className="card mx-auto mt-10 max-w-md p-6 text-center text-muted">Can't find that pay run. <Link className="text-accent" to="/pay-runs">All pay runs</Link></div>
  return <RunView key={run.data.id + run.data.status} run={run.data} />
}

interface Row { person: Staff; line: PayLine; inputs: PayInputs }

function RunView({ run }: { run: PayRun }) {
  const nav = useNavigate()
  const staff = useStaff()
  const shifts = useShifts(run.period_start, run.period_end)
  const settings = usePayrollSettings()
  const holidays = usePublicHolidays()
  const profiles = useStaffTaxProfile()
  const readiness = useStaffReadiness()
  const leave = useAllLeave()
  const ytd = usePaidThisYear(financialYearStart(run.pay_date), run.pay_date)
  const pay = usePayLookup()
  const finalise = useFinalisePayRun()
  const reopen = useReopenPayRun()
  const save = useSave('pay_runs')
  const remove = useRemove('pay_runs')
  const [open, setOpen] = useState<string | null>(null)
  const draft = run.status === 'draft'
  const { can } = usePerms()
  const payments = usePayRunPayments()
  const sendSlips = useSendPayslips()
  const xeroConn = useXeroConnection()
  const xeroAct = useXeroAction()
  const [notice, setNotice] = useState<{ tone: 'good' | 'warn'; text: string; list?: string[] } | null>(null)

  if (staff.isLoading || shifts.isLoading || !pay.ready || settings.isLoading || profiles.isLoading || leave.isLoading || ytd.isLoading) return <Loading />
  const region = settings.data?.holiday_region ?? 'QLD-BNE'
  const hols = (holidays.data ?? []).filter((h) => h.region === 'QLD' || h.region === region)
  const holidayOn = (d: string) => hols.find((h) => h.holiday_date === d) ?? null
  const freq: Frequency = settings.data?.pay_frequency ?? 'weekly'
  const saved = new Map((run.pay_run_lines ?? []).map((l) => [l.staff_id, l]))

  // Who's paid: anyone with a shift in the period, full- and part-timers employed through
  // it, and anyone already on the run.
  const all = (staff.data ?? []).filter((p) => p.kind === 'employee')
  const inRun = draft
    ? all.filter((p) => saved.has(p.id) || (shifts.data ?? []).some((s) => s.staff_id === p.id)
      || (p.employment_type !== 'casual' && p.status === 'active' && (!p.start_date || p.start_date <= run.period_end) && (!p.end_date || p.end_date >= run.period_start)))
    : all.filter((p) => saved.has(p.id))

  const rows: Row[] = inRun.map((p) => {
    const inputs = saved.get(p.id)?.inputs ?? {}
    if (!draft && saved.get(p.id)?.result) return { person: p, inputs, line: { staffId: p.id, ...saved.get(p.id)!.result! } as PayLine }
    const c = pay.classes.find((x) => x.id === p.classification_id)
    const rates = c ? payRates(p, rateOn(pay.rates, c.id, run.period_start), ruleSetOn(pay.rules, c.award_code, c.rule_set_key, run.period_start), run.period_start) : null
    const bal = (t: string) => leave.data?.find((l) => l.staff_id === p.id && l.leave_type === t)?.hours ?? 0
    const line = payLine({
      person: p, rates, shifts: (shifts.data ?? []).filter((s) => s.staff_id === p.id), holidayOn, inputs,
      profile: profiles.data?.find((x) => x.staff_id === p.id), frequency: freq, superRate: settings.data?.super_rate ?? 12,
      periodStart: run.period_start, periodEnd: run.period_end, paidThisYear: ytd.data?.get(p.id)?.gross ?? 0,
      hasBank: !!readiness.data?.find((r) => r.staff_id === p.id)?.has_bank, leaveBalance: { annual: bal('annual'), personal: bal('personal') },
    })
    return { person: p, inputs, line }
  }).sort((a, b) => a.person.name.localeCompare(b.person.name))

  const tot = (k: 'gross' | 'super' | 'net') => sum(rows.map((r) => r.line[k]))
  const totTax = sum(rows.map((r) => r.line.tax.amount))
  const warnings = rows.flatMap((r) => r.line.warnings.map((w) => ({ who: r.person.name, w })))
  const due = superDueDate(run.pay_date, hols)

  async function doFinalise() {
    const lines = rows.filter((r) => r.line.gross > 0 || r.line.reimbursements > 0).map((r) => {
      const c = pay.classes.find((x) => x.id === r.person.classification_id)
      const before = ytd.data?.get(r.person.id) ?? { gross: 0, tax: 0, super: 0 }
      const { staffId: _, ...result } = r.line
      void _
      return {
        staff_id: r.person.id, gross: r.line.gross, tax: r.line.tax.amount, super: r.line.super, net: r.line.net, inputs: r.inputs,
        leave: { annual: cents(r.line.accrued.annual - r.line.taken.annual), personal: cents(r.line.accrued.personal - r.line.taken.personal) },
        result: {
          ...result,
          person: { name: r.person.name, employment_type: r.person.employment_type, classification: c?.name ?? null, award: c?.award_code ?? null },
          ytd: { gross: cents(before.gross + r.line.gross), tax: cents(before.tax + r.line.tax.amount), super: cents(before.super + r.line.super) },
        },
      }
    })
    await finalise.mutateAsync({ id: run.id, lines })
  }

  async function emailSlips() {
    setNotice(null)
    const r = await sendSlips.mutateAsync({ payRunId: run.id })
    setNotice({ tone: r.skipped.length ? 'warn' : 'good', text: `Payslips emailed to ${r.sent.length} ${r.sent.length === 1 ? 'person' : 'people'}.`,
      list: r.skipped.map((x) => `${x.name}: ${x.reason}`) })
  }

  async function bankFile() {
    setNotice(null)
    const s = settings.data
    if (!s?.aba_bank_code || !s.aba_apca_id || !s.aba_user_name || !s.aba_bsb || !s.aba_account) {
      setNotice({ tone: 'warn', text: 'Add your bank details for direct entry in People → Payroll setup → Bank payments first.' })
      return
    }
    const list = await payments.mutateAsync(run.id)
    const missing = list.filter((p) => !p.bsb || !bsbOk(p.bsb) || !p.account)
    if (missing.length) {
      setNotice({ tone: 'warn', text: 'These people have no bank account on file, so the file wasn’t made:', list: missing.map((p) => p.name) })
      return
    }
    const ref = `Wages ${fmtShort(run.period_start)}-${fmtShort(run.period_end)}`
    const text = abaFile({
      bankCode: s.aba_bank_code, userName: s.aba_user_name, apcaId: s.aba_apca_id, description: 'WAGES', processDate: run.pay_date,
      fromBsb: s.aba_bsb, fromAccount: s.aba_account, remitter: s.aba_user_name.slice(0, 16), balancing: s.aba_balancing,
      payments: list.map((p) => ({ bsb: p.bsb!, account: p.account!, name: p.account_name || p.name, cents: Math.round(p.net * 100), reference: ref })),
    })
    const a = document.createElement('a')
    a.href = URL.createObjectURL(new Blob([text], { type: 'text/plain' }))
    a.download = `wages-${run.pay_date}.aba`
    a.click()
    URL.revokeObjectURL(a.href)
    setNotice({ tone: 'good', text: `Bank file downloaded: ${list.length} payments, ${aud(sum(list.map((p) => p.net)))}. Upload it in your bank's bulk payments.` })
  }

  async function sendToXero() {
    setNotice(null)
    const r = await xeroAct.mutateAsync({
      action: 'push', pay_run_id: run.id, period_start: run.period_start, period_end: run.period_end,
      timesheets: rows.filter((x) => (x.line.days ?? []).length).map((x) => ({ staff_id: x.person.id, lines: x.line.days })),
    })
    const res = r.results ?? []
    const leaveOrExtras = rows.some((x) => x.line.taken.annual || x.line.taken.personal || x.line.items.some((i) => ['allowance', 'overtime', 'adjustment', 'reimbursement'].includes(i.kind)))
    setNotice({
      tone: res.some((x) => x.status === 'skipped') ? 'warn' : 'good',
      text: `Xero: ${xeroSummary(res)}.${leaveOrExtras ? ' Leave and extra items aren’t sent — add those in Xero’s pay run.' : ''}`,
      list: res.filter((x) => x.status === 'skipped').map((x) => `${x.name}: ${x.note}`),
    })
  }

  return (
    <div>
      <Link to="/pay-runs" className="text-[13px] font-medium text-ink-2 hover:text-ink">‹ Pay runs</Link>
      <div className="mt-2 flex flex-wrap items-end justify-between gap-4">
        <div>
          <div className="flex flex-wrap items-center gap-2.5">
            <h1 className="text-2xl font-semibold tracking-[-0.02em]">Pay run · {periodLabel(run)}</h1>
            <Pill tone={draft ? 'neutral' : 'success'}>{draft ? 'Draft' : `Paid · finalised ${fmtDate(run.finalised_at?.slice(0, 10))}`}</Pill>
          </div>
          <div className="mt-1 flex flex-wrap items-center gap-2 text-sm text-muted">
            Pay day
            {draft
              ? <input type="date" className="field !h-8 !w-auto !py-0 !text-[13px]" value={run.pay_date} onChange={(e) => e.target.value && save.mutate({ id: run.id, pay_date: e.target.value })} />
              : <span className="font-medium text-ink">{fmtDate(run.pay_date)}</span>}
            · super due by {fmtDate(due)} (Payday Super)
          </div>
        </div>
        <div className="flex flex-wrap gap-2">
          {xeroConn.data && (
            <button type="button" className="btn" disabled={xeroAct.isPending} onClick={sendToXero}>{xeroAct.isPending ? 'Sending…' : 'Send hours to Xero'}</button>
          )}
          {draft ? (
            <>
              <DeleteButton label="Delete draft" busy={remove.isPending} onConfirm={async () => { await remove.mutateAsync(run.id); nav('/pay-runs') }} />
              <Confirm label="Finalise pay run" confirm={`Finalise · book ${audRound(tot('gross') + tot('super'))} to Labour`} busy={finalise.isPending}
                disabled={!rows.some((r) => r.line.gross > 0)} onConfirm={doFinalise} />
            </>
          ) : (
            <>
              <Link to={`/pay-runs/${run.id}/payslips`} className="btn">Payslips</Link>
              <button type="button" className="btn" disabled={sendSlips.isPending} onClick={emailSlips}>{sendSlips.isPending ? 'Sending…' : 'Email payslips'}</button>
              {can('sensitive') && <button type="button" className="btn" disabled={payments.isPending} onClick={bankFile}>Bank file (ABA)</button>}
              <Confirm label="Reopen" confirm="Reopen · remove its expenses and leave" busy={reopen.isPending} onConfirm={() => reopen.mutateAsync(run.id)} />
            </>
          )}
        </div>
      </div>
      <div className="mt-3"><ErrorBox error={finalise.error || reopen.error || save.error || remove.error || payments.error || sendSlips.error || xeroAct.error} /></div>
      {notice && (
        <div role="status" className={`mt-2 rounded-[10px] border px-3.5 py-2.5 text-sm ${notice.tone === 'good' ? 'border-[#ABEFC6] bg-[#ECFDF3] text-[#067647] dark:border-[#085D3A] dark:bg-[#053321] dark:text-[#75E0A7]' : 'border-warn-line bg-warn-bg text-warn-ink'}`}>
          {notice.text}
          {notice.list && <ul className="mt-1 list-disc pl-5 text-[13px]">{notice.list.map((x) => <li key={x}>{x}</li>)}</ul>}
        </div>
      )}
      {run.xero_result && !notice && (
        <p className="mt-2 text-xs text-muted">Hours last sent to Xero {new Date(run.xero_sent_at!).toLocaleString('en-AU')}: {xeroSummary(run.xero_result)}.</p>
      )}

      <div className={`${KPI_GRID} mt-2`}>
        <Kpi label="Gross wages" value={aud(tot('gross'))} note={`${rows.filter((r) => r.line.gross > 0).length} people · ${sum(rows.map((r) => r.line.workedHours))}h worked`} />
        <Kpi label="Tax withheld" value={aud(totTax)} note="PAYG, paid to the ATO" />
        <Kpi label="Super" value={aud(tot('super'))} note={`${settings.data?.super_rate ?? 12}% · due by ${fmtDate(due)}`} />
        <Kpi label="Net pay" value={aud(tot('net'))} note="Paid into their accounts" />
      </div>

      {warnings.length > 0 && (
        <div className="mt-4 rounded-xl border border-warn-line bg-warn-bg px-4 py-3 text-warn-ink">
          <div className="text-sm font-semibold">{warnings.length} thing{warnings.length === 1 ? '' : 's'} to check{draft ? ' before finalising' : ''}</div>
          <ul className="mt-2 grid gap-1.5 text-[13px]">
            {warnings.map((x, i) => <li key={i} className="flex gap-2"><span className="mt-1.5 h-1.5 w-1.5 shrink-0 rounded-full bg-[#F79009]" /><span><strong className="font-semibold">{x.who}</strong> — {x.w}</span></li>)}
          </ul>
        </div>
      )}

      <section className="card mt-4 overflow-hidden">
        <div className="hidden grid-cols-[minmax(0,1.5fr)_70px_repeat(4,100px)_16px] gap-3 border-b border-line bg-hover px-5 py-2.5 text-xs font-medium text-muted desk:grid">
          <span>Person</span><span className="text-right">Hours</span><span className="text-right">Gross</span><span className="text-right">Tax</span><span className="text-right">Super</span><span className="text-right">Net</span><span />
        </div>
        {rows.map((r) => (
          <div key={r.person.id} className="border-b border-line-2">
            <button type="button" aria-expanded={open === r.person.id} onClick={() => setOpen(open === r.person.id ? null : r.person.id)}
              className="num grid w-full grid-cols-[minmax(0,1fr)_auto] items-center gap-3 px-3.5 py-3 text-left hover:bg-hover desk:grid-cols-[minmax(0,1.5fr)_70px_repeat(4,100px)_16px] desk:px-5">
              <span className="flex min-w-0 items-center gap-3">
                <PersonAvatar person={r.person} size={32} />
                <span className="min-w-0">
                  <span className="block truncate font-semibold">{r.person.name}</span>
                  <span className="block truncate text-xs text-muted">{employmentLabel(r.person.employment_type)} · {r.line.tax.basis}{r.line.warnings.length ? ` · ${r.line.warnings.length} to check` : ''}{saved.get(r.person.id)?.emailed_at ? ' · payslip emailed' : ''}</span>
                </span>
              </span>
              <span className="hidden text-right text-ink-2 desk:block">{r.line.workedHours}</span>
              <span className="text-right font-semibold desk:font-normal">{aud(r.line.gross)}</span>
              <span className="hidden text-right text-ink-2 desk:block">{aud(r.line.tax.amount)}</span>
              <span className="hidden text-right text-ink-2 desk:block">{aud(r.line.super)}</span>
              <span className="hidden text-right font-semibold desk:block">{aud(r.line.net)}</span>
              <span className="hidden text-faint desk:block" aria-hidden>{open === r.person.id ? '▾' : '▸'}</span>
            </button>
            {open === r.person.id && <LineDetail run={run} row={r} draft={draft} />}
          </div>
        ))}
        {rows.length === 0 && <p className="py-10 text-center text-muted">No one worked this period. Add shifts in the Schedule first.</p>}
      </section>
      <p className="mt-3 text-xs text-muted">
        Hours come from the Schedule — if someone worked different hours, change their shift there first. Tax: {WITHHOLDING_SOURCE}.
        Check the first few pay runs against the Fair Work pay calculator.
      </p>
    </div>
  )
}

/** Two taps to do something that books money: the second shows exactly what will happen. */
function Confirm({ label, confirm, busy, disabled, onConfirm }: { label: string; confirm: string; busy: boolean; disabled?: boolean; onConfirm: () => Promise<unknown> | void }) {
  const [armed, setArmed] = useState(false)
  if (!armed) return <button type="button" className="btn btn-primary" disabled={disabled} onClick={() => setArmed(true)}>{label}</button>
  return (
    <span className="inline-flex gap-1.5">
      <button type="button" className="btn btn-primary" disabled={busy} onClick={async () => { await onConfirm(); setArmed(false) }}>{busy ? 'Working…' : confirm}</button>
      <button type="button" className="btn" onClick={() => setArmed(false)}>Cancel</button>
    </span>
  )
}

const KIND_LABEL: Record<ExtraItem['kind'], string> = { allowance: 'Allowance', overtime: 'Overtime', adjustment: 'Adjustment', reimbursement: 'Reimbursement (not taxed)' }

function LineDetail({ run, row, draft }: { run: PayRun; row: Row; draft: boolean }) {
  const savePay = useSavePayLine()
  const [inputs, setInputs] = useState<PayInputs>(row.inputs)
  const { line } = row
  const dirty = JSON.stringify(inputs) !== JSON.stringify(row.inputs)
  const setItem = (i: number, patch: Partial<ExtraItem>) => setInputs({ ...inputs, items: (inputs.items ?? []).map((x, j) => (j === i ? { ...x, ...patch } : x)) })
  return (
    <div className="grid gap-4 bg-hover px-3.5 pb-4 pt-1 desk:grid-cols-[minmax(0,1.3fr)_minmax(0,1fr)] desk:px-5">
      <div>
        <table className="num w-full text-sm">
          <thead className="text-xs text-muted"><tr><th className="py-1.5 text-left font-medium">Earnings</th><th className="py-1.5 text-right font-medium">Hours</th><th className="py-1.5 text-right font-medium">Rate</th><th className="py-1.5 text-right font-medium">Amount</th></tr></thead>
          <tbody className="divide-y divide-line">
            {line.items.map((i, k) => (
              <tr key={k}><td className="py-1.5">{i.label}</td><td className="py-1.5 text-right">{i.hours ?? ''}</td><td className="py-1.5 text-right">{i.rate != null ? aud(i.rate) : ''}</td><td className="py-1.5 text-right">{aud(i.amount)}</td></tr>
            ))}
            <tr className="font-semibold"><td className="py-1.5">Gross</td><td /><td /><td className="py-1.5 text-right">{aud(line.gross)}</td></tr>
            <tr><td className="py-1.5">Tax withheld <span className="text-xs text-muted">({line.tax.basis})</span></td><td /><td /><td className="py-1.5 text-right">−{aud(line.tax.amount)}</td></tr>
            {line.reimbursements > 0 && <tr><td className="py-1.5">Reimbursements</td><td /><td /><td className="py-1.5 text-right">{aud(line.reimbursements)}</td></tr>}
            <tr className="font-semibold"><td className="py-1.5">Net pay</td><td /><td /><td className="py-1.5 text-right">{aud(line.net)}</td></tr>
            <tr className="text-muted"><td className="py-1.5">Super ({line.superRate}% of {aud(line.ote)} ordinary time earnings)</td><td /><td /><td className="py-1.5 text-right">{aud(line.super)}</td></tr>
          </tbody>
        </table>
        {line.superNote && <p className="mt-1 text-xs text-muted">{line.superNote}</p>}
        {(line.accrued.annual > 0 || line.accrued.personal > 0) && (
          <p className="mt-1 text-xs text-muted">Leave accrued: {line.accrued.annual.toFixed(2)}h annual, {line.accrued.personal.toFixed(2)}h personal.</p>
        )}
        {!draft && <Link to={`/pay-runs/${run.id}/payslips?staff=${row.person.id}`} className="mt-2 inline-block text-[13px] font-medium text-accent">View payslip →</Link>}
      </div>
      {draft && (
        <div className="grid content-start gap-3">
          {row.person.employment_type !== 'casual' && (
            <div className="grid grid-cols-2 gap-3">
              <Field label="Annual leave taken (h)"><input inputMode="decimal" className="field" value={inputs.annualHours ?? ''} onChange={(e) => setInputs({ ...inputs, annualHours: e.target.value ? parseMoney(e.target.value) : undefined })} /></Field>
              <Field label="Personal leave taken (h)"><input inputMode="decimal" className="field" value={inputs.personalHours ?? ''} onChange={(e) => setInputs({ ...inputs, personalHours: e.target.value ? parseMoney(e.target.value) : undefined })} /></Field>
            </div>
          )}
          <div>
            <span className="label">Other items</span>
            {(inputs.items ?? []).map((x, i) => (
              <div key={i} className="mb-2 grid grid-cols-[minmax(0,1fr)_120px] gap-2">
                <input className="field" aria-label="What for" value={x.label} onChange={(e) => setItem(i, { label: e.target.value })} placeholder="e.g. Saturday overtime" />
                <input className="field num text-right" aria-label="Amount" inputMode="decimal" value={String(x.amount || '')} onChange={(e) => setItem(i, { amount: parseMoney(e.target.value) || 0 })} placeholder="0.00" />
                <select className="field col-span-2" aria-label="Kind" value={x.kind} onChange={(e) => setItem(i, { kind: e.target.value as ExtraItem['kind'] })}>
                  {Object.entries(KIND_LABEL).map(([k, l]) => <option key={k} value={k}>{l}</option>)}
                </select>
              </div>
            ))}
            <button type="button" className="btn btn-sm" onClick={() => setInputs({ ...inputs, items: [...(inputs.items ?? []), { label: '', amount: 0, kind: 'allowance' }] })}>+ Add item</button>
          </div>
          <ErrorBox error={savePay.error} />
          <button type="button" className={`btn ${dirty ? 'btn-primary' : 'btn-saved'}`} disabled={!dirty || savePay.isPending}
            onClick={() => savePay.mutate({ pay_run_id: run.id, staff_id: row.person.id, inputs: { ...inputs, items: (inputs.items ?? []).filter((x) => x.amount) } })}>
            {savePay.isPending ? 'Saving…' : dirty ? 'Save changes' : 'Saved'}
          </button>
        </div>
      )}
    </div>
  )
}

// ---------------- payslips ----------------

export function Payslips() {
  const { id } = useParams()
  const run = usePayRun(id)
  const { business } = useBusiness()
  const leave = useAllLeave()
  const only = new URLSearchParams(location.search).get('staff')
  if (run.isLoading) return <Loading />
  const r = run.data
  if (!r || r.status !== 'finalised') return <div className="card mx-auto mt-10 max-w-md p-6 text-center text-muted">Payslips are made when a pay run is finalised.</div>
  const lines = (r.pay_run_lines ?? []).filter((l) => !only || l.staff_id === only)
  const s = business
  return (
    <div>
      <div className="flex flex-wrap items-center justify-between gap-3 print:hidden">
        <Link to={`/pay-runs/${r.id}`} className="text-[13px] font-medium text-ink-2 hover:text-ink">‹ Pay run · {periodLabel(r)}</Link>
        <button type="button" className="btn btn-primary" onClick={() => window.print()}>Print or save as PDF</button>
      </div>
      {(!s?.legal_name || !s?.abn) && <p className="mt-3 rounded-[10px] bg-warn-bg px-3 py-2 text-sm text-warn-ink print:hidden">Payslips must show your business’s legal name and ABN — add them in Settings → Business.</p>}
      {lines.map((l) => {
        const res = l.result!
        const bal = (t: string) => leave.data?.find((x) => x.staff_id === l.staff_id && x.leave_type === t)?.hours
        return (
          <article key={l.id} className="card mx-auto mt-4 max-w-2xl break-after-page p-6 print:mt-0 print:border-0 print:shadow-none">
            <header className="flex flex-wrap justify-between gap-3 border-b border-line pb-3">
              <div>
                <div className="text-lg font-semibold">{s?.legal_name ?? 'Employer name not set'}</div>
                <div className="text-xs text-muted">ABN {s?.abn ?? '—'}{s?.address ? ` · ${s.address}` : ''}</div>
              </div>
              <div className="text-right">
                <div className="text-sm font-semibold">Payslip</div>
                <div className="text-xs text-muted">Pay period {periodLabel(r)}<br />Paid {fmtDate(r.pay_date)}</div>
              </div>
            </header>
            <div className="mt-3 text-sm">
              <div className="font-semibold">{String(res.person?.name ?? '')}</div>
              <div className="text-xs text-muted">
                {employmentLabel((res.person?.employment_type as Staff['employment_type']) ?? 'casual')}
                {res.person?.classification ? ` · ${String(res.person.classification)}` : ''}{res.person?.award ? ` · ${String(res.person.award)}` : ''}
              </div>
            </div>
            <table className="num mt-4 w-full text-sm">
              <thead className="text-xs text-muted"><tr className="border-b border-line"><th className="py-1.5 text-left font-medium">Earnings</th><th className="py-1.5 text-right font-medium">Hours</th><th className="py-1.5 text-right font-medium">Rate</th><th className="py-1.5 text-right font-medium">Amount</th></tr></thead>
              <tbody className="divide-y divide-line-2">
                {res.items.map((i, k) => <tr key={k}><td className="py-1.5">{i.label}</td><td className="py-1.5 text-right">{i.hours ?? ''}</td><td className="py-1.5 text-right">{i.rate != null ? aud(i.rate) : ''}</td><td className="py-1.5 text-right">{aud(i.amount)}</td></tr>)}
                <tr className="font-semibold"><td className="py-1.5">Gross pay</td><td /><td /><td className="py-1.5 text-right">{aud(res.gross)}</td></tr>
                <tr><td className="py-1.5">PAYG tax withheld</td><td /><td /><td className="py-1.5 text-right">−{aud(res.tax.amount)}</td></tr>
                {res.reimbursements > 0 && <tr><td className="py-1.5">Reimbursements</td><td /><td /><td className="py-1.5 text-right">{aud(res.reimbursements)}</td></tr>}
                <tr className="text-base font-semibold"><td className="py-2">Net pay</td><td /><td /><td className="py-2 text-right">{aud(res.net)}</td></tr>
              </tbody>
            </table>
            <div className="mt-4 grid gap-3 text-sm desk:grid-cols-2 print:grid-cols-2">
              <div className="rounded-[10px] border border-line p-3">
                <div className="text-xs font-medium text-muted">Superannuation</div>
                <div className="num mt-1">{aud(res.super)} <span className="text-xs text-muted">({res.superRate}% of {aud(res.ote)})</span></div>
                <div className="text-xs text-muted">{res.super_fund ? `Paid to ${res.super_fund}` : 'Fund not recorded'}{res.superNote ? ` · ${res.superNote}` : ''}</div>
              </div>
              <div className="rounded-[10px] border border-line p-3">
                <div className="text-xs font-medium text-muted">Year to date</div>
                <div className="num mt-1 text-xs">Gross {aud(res.ytd?.gross ?? 0)} · Tax {aud(res.ytd?.tax ?? 0)} · Super {aud(res.ytd?.super ?? 0)}</div>
                {res.person?.employment_type !== 'casual' && (bal('annual') != null || bal('personal') != null) && (
                  <div className="num mt-1 text-xs text-muted">Leave now: {bal('annual')?.toFixed(1) ?? '0'}h annual · {bal('personal')?.toFixed(1) ?? '0'}h personal</div>
                )}
              </div>
            </div>
          </article>
        )
      })}
    </div>
  )
}

const xeroSummary = (res: XeroPushResult[]) => {
  const n = (s: XeroPushResult['status']) => res.filter((x) => x.status === s).length
  return [n('sent') && `${n('sent')} sent`, n('updated') && `${n('updated')} updated`, n('skipped') && `${n('skipped')} skipped`].filter(Boolean).join(', ') || 'nothing to send'
}
