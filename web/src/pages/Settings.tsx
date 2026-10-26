import { useState, type ReactNode } from 'react'
import { Link } from 'react-router-dom'
import {
  useChangeMyPassword, useContributions, useIsPlatformAdmin, usePartners, useSaveBusiness, useSetupCosts,
} from '../lib/api'
import { useBusiness } from '../lib/business'
import { aud, cents } from '../lib/format'
import type { Business } from '../lib/types'
import { DetailsFields, draftOf, draftProblems, draftToRow, SalesFields, type BusinessDraft } from '../components/BusinessForm'
import { TableEditor } from '../components/TableEditor'
import { ErrorBox, Flash, Loading, PageHeader } from '../components/ui'

function Section({ title, hint, children, id }: { title: string; hint?: ReactNode; children: ReactNode; id: string }) {
  return (
    <section id={id} className="card scroll-mt-20 p-4">
      <h2 className="text-lg font-semibold">{title}</h2>
      {hint && <p className="mb-2 text-sm text-muted">{hint}</p>}
      {children}
    </section>
  )
}

export default function Settings() {
  const partners = usePartners()
  const contributions = useContributions()
  const setup = useSetupCosts()
  const partnerOptions = (partners.data ?? []).map((p) => ({ value: p.id, label: p.name }))

  return (
    <div>
      <PageHeader title="Settings" />
      <nav aria-label="Settings sections" className="mb-4 flex flex-wrap gap-1.5">
        {[['business', 'Business'], ['partners', 'Partners'], ['setup', 'Setup costs'], ['contributions', 'Contributions']].map(([id, label]) => (
          <a key={id} href={`#${id}`} className="chip">{label}</a>
        ))}
      </nav>
      <p className="mb-4 rounded-lg bg-surface-2 px-3 py-2 text-sm text-ink-2">
        Staff are in <Link className="font-semibold text-accent" to="/people">People</Link>; suppliers, products and their
        categories in <Link className="font-semibold text-accent" to="/food/catalogue">Food → Catalogue</Link>.
      </p>

      <div className="grid gap-4">
        <BusinessSection />
        <PartnerSummary />

        <Section id="partners" title="Partners" hint="Ownership percentages should add up to 100%.">
          {partners.isLoading ? <Loading /> : (
            <TableEditor table="partners" rows={partners.data ?? []} addLabel="Add partner" canDelete={false}
              fields={[
                { key: 'name', label: 'Name', type: 'text', required: true },
                { key: 'ownership_pct', label: 'Ownership %', type: 'number', required: true, width: 'md:w-28 md:text-right' },
              ]} />
          )}
        </Section>

        <Section id="setup" title="Setup costs" hint="One-off costs of starting the business. Never counted in operating profit.">
          {setup.isLoading ? <Loading /> : (
            <>
              <TableEditor table="setup_costs" rows={setup.data ?? []} addLabel="Add setup cost"
                fields={[
                  { key: 'item', label: 'Item', type: 'text', required: true },
                  { key: 'amount', label: 'Amount', type: 'money', required: true, width: 'md:w-32 md:text-right' },
                  { key: 'incurred_on', label: 'Date', type: 'date', width: 'md:w-28' },
                  { key: 'note', label: 'Note', type: 'text', width: 'md:w-64' },
                ]} />
              <p className="num mt-3 border-t border-line pt-3 text-right font-bold">
                Total {aud(cents((setup.data ?? []).reduce((s, r) => s + r.amount, 0)))}
              </p>
            </>
          )}
        </Section>

        <Section id="contributions" title="Partner contributions" hint="Money each partner has put into the business.">
          {contributions.isLoading || partners.isLoading ? <Loading /> : (
            <TableEditor table="partner_contributions" rows={contributions.data ?? []} addLabel="Add contribution"
              defaults={{ partner_id: partnerOptions[0]?.value }}
              fields={[
                { key: 'partner_id', label: 'Partner', type: 'select', options: partnerOptions, required: true },
                { key: 'amount', label: 'Amount', type: 'money', required: true, width: 'md:w-32 md:text-right' },
                { key: 'contributed_on', label: 'Date', type: 'date', width: 'md:w-28' },
                { key: 'description', label: 'Description', type: 'text', width: 'md:w-64' },
              ]} />
          )}
        </Section>

        <p className="text-xs text-muted">
          Each business keeps its own catalogue, staff, partners and costs. People only see the businesses they’re added to.
        </p>
      </div>
    </div>
  )
}

/** The business's name and details, and how its sales are entered. */
function BusinessSection() {
  // Remount on switch so the form holds the business on screen, never the last one's edits.
  const { business } = useBusiness()
  return business ? <BusinessFields key={business.id} business={business} /> : null
}

function BusinessFields({ business }: { business: Business }) {
  const { businesses } = useBusiness()
  const isAdmin = useIsPlatformAdmin().data
  const save = useSaveBusiness()
  const [d, setD] = useState<BusinessDraft>(() => draftOf(business))
  const [saved, setSaved] = useState(0)
  const set = (patch: Partial<BusinessDraft>) => setD((v) => ({ ...v, ...patch }))
  const p = draftProblems(d)
  const dirty = JSON.stringify(draftToRow(d)) !== JSON.stringify(draftToRow(draftOf(business)))
  const ok = !p.name && !p.abn && !p.email

  return (
    <Section id="business" title="Business" hint="Shown across the app, and on payslips with the ABN.">
      <form className="mt-2 grid gap-6" onSubmit={async (e) => {
        e.preventDefault()
        if (!ok || !dirty) return
        await save.mutateAsync({ id: business.id, ...draftToRow(d) })
        setSaved(Date.now())
      }}>
        <DetailsFields d={d} set={set} />
        <div className="border-t border-line pt-5">
          <SalesFields d={d} set={set} />
          <p className="mt-1.5 text-xs text-muted">Changing how sales are entered only changes the entry screen. Figures already saved stay as they are.</p>
        </div>
        <ErrorBox error={save.error} />
        <div className="flex flex-wrap items-center gap-3">
          <button className="btn btn-primary" disabled={!ok || !dirty || save.isPending}>{save.isPending ? 'Saving…' : 'Save changes'}</button>
          {dirty && <button type="button" className="btn" onClick={() => setD(draftOf(business))}>Discard</button>}
          <Flash signal={saved}>Saved</Flash>
        </div>
      </form>

      <div className="mt-6 grid gap-2 border-t border-line pt-4 text-sm text-ink-2">
        <p>
          Who can sign in, and what each person can open, is in{' '}
          <Link className="font-semibold text-accent" to="/people?tab=access">People → Access</Link>.
        </p>
        {businesses.length > 1 && (
          <p>You can open {businesses.length} businesses: {businesses.map((b) => b.name).join(', ')}. Switch between them at the top of the menu.</p>
        )}
        {isAdmin && (
          <p>New businesses are set up from <Link className="font-semibold text-accent" to="/admin/businesses">Businesses</Link>.</p>
        )}
      </div>
    </Section>
  )
}

/**
 * One person who can sign in: their address, and the two things an owner needs to do —
 * give them a password, or take their access away.
 */
export function MyPasswordSection() {
  const change = useChangeMyPassword()
  const [pw, setPw] = useState('')
  const [again, setAgain] = useState('')
  const [saved, setSaved] = useState(0)
  const tooShort = pw.length > 0 && pw.length < 8
  const mismatch = again.length > 0 && again !== pw

  return (
    <Section id="password" title="Your password" hint="Signing in keeps you signed in on this device until you sign out.">
      <ErrorBox error={change.error} />
      <form
        className="flex flex-wrap items-end gap-2"
        onSubmit={async (e) => {
          e.preventDefault()
          if (!pw || tooShort || mismatch) return
          await change.mutateAsync(pw)
          setPw('')
          setAgain('')
          setSaved(Date.now())
        }}
      >
        <div className="min-w-44 flex-1">
          <label className="label" htmlFor="my-pw">New password</label>
          <input id="my-pw" type="password" className="field" autoComplete="new-password" value={pw}
            onChange={(e) => setPw(e.target.value)} />
        </div>
        <div className="min-w-44 flex-1">
          <label className="label" htmlFor="my-pw2">Again</label>
          <input id="my-pw2" type="password" className="field" autoComplete="new-password" value={again}
            onChange={(e) => setAgain(e.target.value)} />
        </div>
        <button className="btn" disabled={!pw || tooShort || mismatch || change.isPending}>
          {change.isPending ? 'Saving…' : 'Change password'}
        </button>
        <span className="self-center"><Flash signal={saved}>Password changed</Flash></span>
      </form>
      {tooShort && <p className="mt-1 text-xs text-bad">A bit longer — 8 characters or more.</p>}
      {mismatch && <p className="mt-1 text-xs text-bad">These two don't match.</p>}
    </Section>
  )
}

/**
 * Each partner should have put in (ownership % × everything put in). The difference is what one
 * owes the other to square up; with two partners the balances are equal and opposite.
 */
function PartnerSummary() {
  const partners = usePartners().data ?? []
  const contributions = useContributions().data ?? []
  const setupTotal = cents((useSetupCosts().data ?? []).reduce((s, r) => s + r.amount, 0))
  if (!partners.length) return null

  const totalIn = cents(contributions.reduce((s, c) => s + c.amount, 0))
  const pctSum = partners.reduce((s, p) => s + p.ownership_pct, 0)
  const rows = partners.map((p) => {
    const put = cents(contributions.filter((c) => c.partner_id === p.id).reduce((s, c) => s + c.amount, 0))
    const fair = cents((totalIn * p.ownership_pct) / 100)
    return { ...p, put, fair, balance: cents(put - fair) }
  })
  const over = rows.filter((r) => r.balance > 0.005).sort((a, b) => b.balance - a.balance)
  const under = rows.filter((r) => r.balance < -0.005).sort((a, b) => a.balance - b.balance)

  return (
    <section className="card p-4">
      <h2 className="text-lg font-semibold">Partner balance</h2>
      <div className="mt-3 grid gap-3 sm:grid-cols-3">
        <Stat label="Setup costs" value={aud(setupTotal)} />
        <Stat label="Total put in by partners" value={aud(totalIn)} />
        <Stat label="Put in minus setup costs" value={aud(cents(totalIn - setupTotal))} />
      </div>
      <div className="-mx-4 mt-4 overflow-x-auto px-4">
        <table className="num w-full min-w-[480px] text-sm">
          <thead className="text-left text-xs text-muted">
            <tr>
              <th className="py-1 font-semibold">Partner</th>
              <th className="py-1 text-right font-semibold">Share</th>
              <th className="py-1 text-right font-semibold">Put in</th>
              <th className="py-1 text-right font-semibold">Should have put in</th>
              <th className="py-1 text-right font-semibold">Balance</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-line">
            {rows.map((r) => (
              <tr key={r.id}>
                <td className="py-2 font-medium">{r.name}</td>
                <td className="py-2 text-right">{r.ownership_pct}%</td>
                <td className="py-2 text-right">{aud(r.put)}</td>
                <td className="py-2 text-right">{aud(r.fair)}</td>
                <td className={`py-2 text-right font-semibold ${r.balance > 0 ? 'text-good' : r.balance < 0 ? 'text-bad' : ''}`}>
                  {r.balance > 0 ? '+' : ''}{aud(r.balance)}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {Math.abs(pctSum - 100) > 0.01 && <p className="mt-3 text-sm text-bad">Ownership adds up to {pctSum}%, not 100%.</p>}
      {over.length === 1 && under.length === 1 ? (
        <p className="mt-3 rounded-lg bg-surface-2 px-3 py-2 text-sm">
          <b>{under[0].name}</b> owes <b>{over[0].name}</b> <b className="num">{aud(over[0].balance)}</b> to match the {under[0].ownership_pct}/{over[0].ownership_pct} split.
        </p>
      ) : over.length === 0 && under.length === 0 ? (
        <p className="mt-3 text-sm text-good">Contributions match the ownership split.</p>
      ) : null}
    </section>
  )
}

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-xl bg-surface-2 px-3 py-2.5">
      <div className="text-xs text-muted">{label}</div>
      <div className="num text-lg font-bold">{value}</div>
    </div>
  )
}
