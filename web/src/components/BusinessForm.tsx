import type { ReactNode } from 'react'
import { abnValid, formatAbn } from '../lib/format'
import type { Business, SalesMode } from '../lib/types'
import { Field } from './ui'

/** What the details form edits: everything about a business except its id and history. */
export interface BusinessDraft {
  name: string
  legal_name: string
  abn: string
  address: string
  phone: string
  email: string
  gst_registered: boolean
  sales_mode: SalesMode
  till_system: string
}

export const emptyDraft = (): BusinessDraft => ({
  name: '', legal_name: '', abn: '', address: '', phone: '', email: '',
  gst_registered: true, sales_mode: 'channels', till_system: '',
})

export const draftOf = (b: Business): BusinessDraft => ({
  name: b.name, legal_name: b.legal_name ?? '', abn: b.abn ?? '', address: b.address ?? '', phone: b.phone ?? '',
  email: b.email ?? '', gst_registered: b.gst_registered, sales_mode: b.sales_mode, till_system: b.till_system ?? '',
})

const EMAIL = /^[^@\s]+@[^@\s]+\.[^@\s]+$/
export const emailOk = (v: string) => !v.trim() || EMAIL.test(v.trim())
const abnDigits = (v: string) => v.replace(/\D/g, '')
export const abnOk = (v: string) => !abnDigits(v) || abnValid(abnDigits(v))

/** Problems that stop the details being saved, by field. */
export function draftProblems(d: BusinessDraft) {
  return {
    name: d.name.trim() ? null : 'The business needs a name.',
    abn: abnOk(d.abn) ? null : "That isn't a valid ABN.",
    email: emailOk(d.email) ? null : "That doesn't look like an email address.",
  }
}

/** The draft as stored: blanks become null, the ABN is printed the usual way. */
export function draftToRow(d: BusinessDraft) {
  const t = (v: string) => v.trim() || null
  const abn = abnDigits(d.abn)
  return {
    name: d.name.trim(), legal_name: t(d.legal_name), abn: abn ? formatAbn(abn) : null, address: t(d.address),
    phone: t(d.phone), email: t(d.email)?.toLowerCase() ?? null, gst_registered: d.gst_registered,
    sales_mode: d.sales_mode, till_system: t(d.till_system),
  }
}

type Set = (patch: Partial<BusinessDraft>) => void

/** Trading name, legal entity, ABN and how to reach the business. */
export function DetailsFields({ d, set, disabled }: { d: BusinessDraft; set: Set; disabled?: boolean }) {
  const p = draftProblems(d)
  return (
    <div className="grid gap-4 sm:grid-cols-2">
      <Field label={<Req>Trading name</Req>} hint="What the shop is called. Shown across the app.">
        <input className="field" value={d.name} disabled={disabled} onChange={(e) => set({ name: e.target.value })} placeholder="Fish Lips Samford" />
      </Field>
      <Field label="Legal entity name" hint="The company, trust or sole trader. Shown on payslips.">
        <input className="field" value={d.legal_name} disabled={disabled} onChange={(e) => set({ legal_name: e.target.value })} placeholder="Example Holdings Pty Ltd" />
      </Field>
      <Field label="ABN" hint={p.abn ? <span className="text-bad">{p.abn}</span> : '11 digits, checked as you type.'}>
        <input className="field num" inputMode="numeric" value={d.abn} disabled={disabled} onChange={(e) => set({ abn: e.target.value })} placeholder="12 345 678 901" />
      </Field>
      <Field label="Registered for GST">
        <div role="group" aria-label="Registered for GST" className="seg">
          {([[true, 'Yes'], [false, 'No']] as const).map(([v, label]) => (
            <button key={label} type="button" disabled={disabled} aria-pressed={d.gst_registered === v} onClick={() => set({ gst_registered: v })}>{label}</button>
          ))}
        </div>
      </Field>
      <div className="sm:col-span-2">
        <Field label="Address">
          <input className="field" value={d.address} disabled={disabled} onChange={(e) => set({ address: e.target.value })} placeholder="12 Main St, Samford QLD 4520" autoComplete="street-address" />
        </Field>
      </div>
      <Field label="Phone">
        <input className="field" type="tel" value={d.phone} disabled={disabled} onChange={(e) => set({ phone: e.target.value })} placeholder="07 3000 0000" autoComplete="tel" />
      </Field>
      <Field label="Business email" hint={p.email ? <span className="text-bad">{p.email}</span> : undefined}>
        <input className="field" type="email" value={d.email} disabled={disabled} onChange={(e) => set({ email: e.target.value })} placeholder="hello@example.com.au" autoComplete="email" />
      </Field>
    </div>
  )
}

const SALES_MODES: { value: SalesMode; title: string; body: string }[] = [
  { value: 'channels', title: 'Card, cash, Uber and online', body: 'Four figures a day, added up to the day’s takings. Suits a café or takeaway.' },
  { value: 'simple', title: 'Total sales and cash collected', body: 'Two figures a day, straight off the till’s end-of-day report. Suits a service station.' },
]

/** Common tills, offered as suggestions; anything else can be typed. */
const TILLS = ['Square', 'Lightspeed', 'Abacus', 'Kounta', 'Hike', 'Shopify POS', 'Caltex / service station POS']

/** How a day's sales are entered, and which till they come from. */
export function SalesFields({ d, set, disabled }: { d: BusinessDraft; set: Set; disabled?: boolean }) {
  return (
    <div className="grid gap-4">
      <fieldset className="grid gap-2.5" disabled={disabled}>
        <legend className="mb-1.5 text-[13px] font-medium text-ink-2">How a day’s sales are entered</legend>
        <div className="grid gap-2.5 sm:grid-cols-2">
          {SALES_MODES.map((m) => (
            <OptionCard key={m.value} name="sales_mode" checked={d.sales_mode === m.value} onChange={() => set({ sales_mode: m.value })} title={m.title}>
              {m.body}
            </OptionCard>
          ))}
        </div>
      </fieldset>
      <Field label="Till or POS system" hint="Optional. Used later to import the till’s sales reports automatically.">
        <input className="field" list="till-systems" value={d.till_system} disabled={disabled} onChange={(e) => set({ till_system: e.target.value })} placeholder="Start typing, or choose one" />
        <datalist id="till-systems">{TILLS.map((t) => <option key={t} value={t} />)}</datalist>
      </Field>
    </div>
  )
}

/** A radio button drawn as a card with a title and a line of explanation. */
export function OptionCard({ name, checked, onChange, title, children }: {
  name: string; checked: boolean; onChange: () => void; title: string; children: ReactNode
}) {
  return (
    <label className={`flex cursor-pointer gap-3 rounded-xl border p-3.5 transition-colors has-[:disabled]:cursor-not-allowed has-[:disabled]:opacity-60 ${
      checked ? 'border-accent bg-accent-tint' : 'border-line bg-surface hover:bg-surface-2'}`}>
      <input type="radio" name={name} checked={checked} onChange={onChange} className="mt-0.5 h-4 w-4 shrink-0 accent-[var(--accent)]" />
      <span>
        <span className="block text-sm font-semibold">{title}</span>
        <span className="mt-0.5 block text-[13px] text-muted">{children}</span>
      </span>
    </label>
  )
}

const Req = ({ children }: { children: ReactNode }) => <span>{children} <span className="text-bad" aria-hidden>*</span></span>
