import { useEffect, useState } from 'react'
import { usePayrollSettings, useSave, useSavePayrollSettings, useSaveXeroRate, useStaff, useXeroAction, useXeroCatalog, useXeroConnection, useXeroRateMap } from '../lib/api'
import { usePerms } from '../lib/access'
import type { PayrollSettings } from '../lib/types'
import { fmtDate } from './people'
import { DeleteButton, Drawer, ErrorBox, Field, Loading, Pill } from './ui'

/** Every label a pay line can carry, in payslip order: what gets mapped to a Xero earnings rate. */
export const PAY_LABELS = [
  'Ordinary hours', 'Ordinary hours (casual)', 'Saturday', 'Saturday before noon', 'Saturday after noon', 'Sunday', 'Public holiday',
  'Late night loading', 'Early morning loading',
]

function Card({ title, sub, action, children }: { title: string; sub: string; action?: React.ReactNode; children: React.ReactNode }) {
  return (
    <section className="card overflow-hidden">
      <div className="flex items-start gap-3 border-b border-line px-4 py-3 desk:px-5">
        <div className="flex-1">
          <h2 className="text-base font-semibold">{title}</h2>
          <p className="mt-0.5 text-[13px] text-muted">{sub}</p>
        </div>
        {action}
      </div>
      <div className="px-4 py-3 desk:px-5">{children}</div>
    </section>
  )
}

const Row = ({ label, value, missing }: { label: string; value: React.ReactNode; missing?: string }) => (
  <div className="flex justify-between gap-3 border-b border-line-2 py-2 text-sm last:border-0">
    <span className="text-muted">{label}</span>
    <span className={value ? '' : 'font-medium text-warn-ink'}>{value || missing || '—'}</span>
  </div>
)

// ---------- bank payment file ----------

export function BankPaymentsCard() {
  const s = usePayrollSettings().data
  const { can } = usePerms()
  const [editing, setEditing] = useState(false)
  if (!s) return null
  return (
    <Card title="Bank payments" sub="Pay everyone's net wages with one ABA file uploaded to your bank."
      action={can('payroll') ? <button type="button" className="btn btn-sm" onClick={() => setEditing(true)}>Edit</button> : undefined}>
      <Row label="Bank" value={s.aba_bank_code} missing="Not set" />
      <Row label="User ID (APCA)" value={s.aba_apca_id} missing="Not set" />
      <Row label="Name with the bank" value={s.aba_user_name} missing="Not set" />
      <Row label="Paid from" value={s.aba_bsb && s.aba_account ? `${s.aba_bsb} · ${s.aba_account}` : null} missing="Not set" />
      <p className="pt-2 text-xs text-muted">Your bank gives you the user ID when direct entry (bulk payments) is turned on for the account.</p>
      {editing && <BankDrawer s={s} onClose={() => setEditing(false)} />}
    </Card>
  )
}

function BankDrawer({ s, onClose }: { s: PayrollSettings; onClose: () => void }) {
  const save = useSavePayrollSettings()
  const [v, setV] = useState({
    aba_bank_code: s.aba_bank_code ?? '', aba_apca_id: s.aba_apca_id ?? '', aba_user_name: s.aba_user_name ?? '',
    aba_bsb: s.aba_bsb ?? '', aba_account: s.aba_account ?? '', aba_balancing: s.aba_balancing,
  })
  const bsb = v.aba_bsb.replace(/\D/g, '')
  const errors = [
    v.aba_bank_code && !/^[A-Za-z]{3}$/.test(v.aba_bank_code) && 'The bank code is 3 letters, e.g. CBA.',
    v.aba_apca_id && !/^\d{6}$/.test(v.aba_apca_id) && 'The user ID is 6 digits.',
    bsb && bsb.length !== 6 && 'A BSB has 6 digits.',
    v.aba_account && !/^\d{5,9}$/.test(v.aba_account.replace(/\D/g, '')) && 'The account number has 5 to 9 digits.',
  ].filter(Boolean) as string[]
  async function submit() {
    if (errors.length) return
    await save.mutateAsync({
      aba_bank_code: v.aba_bank_code.toUpperCase() || null, aba_apca_id: v.aba_apca_id || null, aba_user_name: v.aba_user_name.trim().slice(0, 26) || null,
      aba_bsb: bsb ? `${bsb.slice(0, 3)}-${bsb.slice(3)}` : null, aba_account: v.aba_account.replace(/\D/g, '') || null, aba_balancing: v.aba_balancing,
    })
    onClose()
  }
  return (
    <Drawer title="Bank payments" sub="From your bank's direct entry setup." onClose={onClose} onSubmit={submit}
      footer={<><button type="button" className="btn" onClick={onClose}>Cancel</button><button className="btn btn-primary" disabled={!!errors.length || save.isPending}>Save</button></>}>
      <ErrorBox error={save.error || (errors.length ? errors.join(' ') : null)} />
      <div className="grid grid-cols-2 gap-3">
        <Field label="Bank code" hint="e.g. CBA, WBC, ANZ, NAB"><input className="field uppercase" maxLength={3} value={v.aba_bank_code} onChange={(e) => setV({ ...v, aba_bank_code: e.target.value })} /></Field>
        <Field label="User ID (APCA)"><input className="field num" inputMode="numeric" maxLength={6} value={v.aba_apca_id} onChange={(e) => setV({ ...v, aba_apca_id: e.target.value })} /></Field>
      </div>
      <Field label="Your name as the bank has it" hint="Up to 26 characters."><input className="field" maxLength={26} value={v.aba_user_name} onChange={(e) => setV({ ...v, aba_user_name: e.target.value })} /></Field>
      <div className="grid grid-cols-2 gap-3">
        <Field label="Paid from BSB"><input className="field num" inputMode="numeric" value={v.aba_bsb} onChange={(e) => setV({ ...v, aba_bsb: e.target.value })} placeholder="000-000" /></Field>
        <Field label="Account number"><input className="field num" inputMode="numeric" value={v.aba_account} onChange={(e) => setV({ ...v, aba_account: e.target.value })} /></Field>
      </div>
      <label className="flex items-center gap-2.5 text-sm">
        <input type="checkbox" className="h-4 w-4 accent-[var(--accent)]" checked={v.aba_balancing} onChange={(e) => setV({ ...v, aba_balancing: e.target.checked })} />
        Add a balancing debit line (only if your bank asks for one)
      </label>
    </Drawer>
  )
}

// ---------- payslip emails ----------

export function PayslipEmailCard() {
  const s = usePayrollSettings().data
  const save = useSavePayrollSettings()
  const { can } = usePerms()
  const [replyTo, setReplyTo] = useState(s?.payslip_reply_to ?? '')
  useEffect(() => setReplyTo(s?.payslip_reply_to ?? ''), [s?.payslip_reply_to])
  if (!s) return null
  return (
    <Card title="Payslip emails" sub="Each person gets their payslip by email when you send it from a finalised pay run.">
      <ErrorBox error={save.error} />
      <Field label="Replies go to" hint="Where it goes if someone replies to their payslip email.">
        <input type="email" className="field" disabled={!can('payroll')} value={replyTo} onChange={(e) => setReplyTo(e.target.value)}
          onBlur={() => replyTo.trim() !== (s.payslip_reply_to ?? '') && save.mutate({ payslip_reply_to: replyTo.trim() || null })} placeholder="you@yourbusiness.com.au" />
      </Field>
      <p className="mt-3 text-xs text-muted">
        Sending uses Resend (resend.com). One-off setup: create a Resend account, verify your domain, then add the API key and
        From address as Supabase secrets <code>RESEND_API_KEY</code> and <code>PAYSLIP_FROM</code>. Until then, “Email payslips” explains what’s missing.
      </p>
    </Card>
  )
}

// ---------- Xero ----------

export function XeroCard() {
  const conn = useXeroConnection()
  const act = useXeroAction()
  const { can } = usePerms()
  const [setup, setSetup] = useState(false)
  const flag = new URLSearchParams(location.search).get('xero')
  if (conn.isLoading) return <Loading />
  const c = conn.data

  async function connect() {
    try {
      const r = await act.mutateAsync({ action: 'start', return_to: `${window.location.origin}${import.meta.env.BASE_URL}people?tab=setup` })
      if (r.url) window.location.href = r.url
    } catch (e) { if (/set up/i.test((e as Error).message)) setSetup(true) }
  }

  return (
    <Card title="Xero" sub="Send each pay period's hours to Xero Payroll as timesheets. Xero then pays, taxes and reports as usual."
      action={c ? <Pill tone="success">Connected</Pill> : <Pill tone="neutral">Not connected</Pill>}>
      {flag && flag !== 'connected' && <p className="mb-2 rounded-[10px] bg-warn-bg px-3 py-2 text-[13px] text-warn-ink">Connecting to Xero didn't finish ({flag.replace('-', ' ')}). Try again.</p>}
      {flag === 'connected' && c && <p className="mb-2 rounded-[10px] bg-accent-tint px-3 py-2 text-[13px] text-accent">Connected to {c.tenant_name}.</p>}
      <ErrorBox error={setup ? null : act.error} />
      {!c ? (
        <>
          <p className="text-sm text-ink-2">Connect your Xero organisation once; you'll sign in to Xero and approve access to employees, timesheets and payroll settings.</p>
          {can('payroll') && <button type="button" className="btn btn-primary mt-3" disabled={act.isPending} onClick={connect}>{act.isPending ? 'Opening Xero…' : 'Connect to Xero'}</button>}
          {setup && (
            <div className="mt-3 rounded-[10px] bg-surface-2 p-3 text-[13px] text-ink-2">
              <p className="font-semibold">One-off setup needed</p>
              <ol className="mt-1 list-decimal pl-5">
                <li>At developer.xero.com, create a new app (“Web app”).</li>
                <li>Set its redirect URI to <code className="break-all">{import.meta.env.VITE_SUPABASE_URL}/functions/v1/xero/callback</code></li>
                <li>Add its client ID and secret as Supabase secrets <code>XERO_CLIENT_ID</code> and <code>XERO_CLIENT_SECRET</code>, then come back and connect.</li>
              </ol>
            </div>
          )}
        </>
      ) : (
        <>
          <Row label="Organisation" value={c.tenant_name} />
          <Row label="Connected" value={`${fmtDate(c.connected_at.slice(0, 10))}${c.connected_by ? ` by ${c.connected_by}` : ''}`} />
          <XeroMapping />
          {can('payroll') && (
            <div className="mt-3 flex justify-end">
              <DeleteButton label="Disconnect" busy={act.isPending} onConfirm={() => act.mutate({ action: 'disconnect' })} />
            </div>
          )}
        </>
      )}
    </Card>
  )
}

/** Which Xero earnings rate each pay line becomes, and which Xero employee each person is. */
function XeroMapping() {
  const cat = useXeroCatalog(true)
  const map = useXeroRateMap()
  const staff = useStaff()
  const saveRate = useSaveXeroRate()
  const saveStaff = useSave('staff')
  if (cat.isLoading || map.isLoading) return <Loading label="Loading from Xero…" />
  if (cat.error) return <ErrorBox error={cat.error} />
  const rates = cat.data?.earningsRates ?? []
  const emps = cat.data?.employees ?? []
  const people = (staff.data ?? []).filter((p) => p.kind === 'employee' && p.status === 'active')
  const guess = (name: string) => emps.find((e) => e.name.toLowerCase() === name.toLowerCase())

  return (
    <div className="mt-3 grid gap-4">
      <ErrorBox error={saveRate.error || saveStaff.error} />
      <div>
        <div className="text-[13px] font-semibold">Earnings rates</div>
        <p className="mb-2 text-xs text-muted">Match each kind of hours to the Xero earnings rate that pays it (set up under Payroll settings → Pay items in Xero).</p>
        {PAY_LABELS.map((label) => {
          const cur = map.data?.find((m) => m.pay_label === label)
          return (
            <div key={label} className="grid grid-cols-[minmax(0,1fr)_minmax(0,1.2fr)] items-center gap-2 py-1">
              <span className="text-[13px] text-ink-2">{label}</span>
              <select className="field !h-9 !py-0 !text-[13px]" value={cur?.earnings_rate_id ?? ''}
                onChange={(e) => saveRate.mutate({ pay_label: label, earnings_rate_id: e.target.value || null, earnings_rate_name: rates.find((r) => r.id === e.target.value)?.name })}>
                <option value="">Not mapped</option>
                {rates.map((r) => <option key={r.id} value={r.id}>{r.name}</option>)}
              </select>
            </div>
          )
        })}
      </div>
      <div>
        <div className="text-[13px] font-semibold">People</div>
        <p className="mb-2 text-xs text-muted">Each person's Xero employee. Names that match exactly are suggested.</p>
        {people.map((p) => {
          const g = !p.xero_employee_id ? guess(p.name) : undefined
          return (
            <div key={p.id} className="grid grid-cols-[minmax(0,1fr)_minmax(0,1.2fr)] items-center gap-2 py-1">
              <span className="text-[13px] text-ink-2">{p.name}{g && <button type="button" className="ml-2 text-xs font-medium text-accent" onClick={() => saveStaff.mutate({ id: p.id, xero_employee_id: g.id })}>Use {g.name}</button>}</span>
              <select className="field !h-9 !py-0 !text-[13px]" value={p.xero_employee_id ?? ''} onChange={(e) => saveStaff.mutate({ id: p.id, xero_employee_id: e.target.value || null })}>
                <option value="">Not linked</option>
                {emps.map((e) => <option key={e.id} value={e.id}>{e.name}</option>)}
              </select>
            </div>
          )
        })}
      </div>
    </div>
  )
}
