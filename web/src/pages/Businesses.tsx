import { useState, type ReactNode } from 'react'
import { Link, useNavigate } from 'react-router-dom'
import { useAdminBusinesses, useCreateBusiness, useIsPlatformAdmin, useSetupOwnerLogin } from '../lib/api'
import { useOptionalBusiness } from '../lib/business'
import { diffDays, todayStr } from '../lib/dates'
import type { Business } from '../lib/types'
import { DetailsFields, draftProblems, draftToRow, emailOk, emptyDraft, SalesFields, type BusinessDraft } from '../components/BusinessForm'
import { fmtDate } from '../components/people'
import { Empty, ErrorBox, Field, Loading, PageHeader, Pill } from '../components/ui'

/** Where owners sign in: this build's own address. */
const APP_URL = window.location.origin + import.meta.env.BASE_URL

/** Shows the page only to platform admins; the database refuses everyone else anyway. */
export function PlatformOnly({ children }: { children: ReactNode }) {
  const admin = useIsPlatformAdmin()
  if (admin.isLoading) return <Loading />
  if (admin.data) return <>{children}</>
  return (
    <div className="card mx-auto mt-10 max-w-md p-6 text-center">
      <h1 className="text-lg font-semibold">Not available</h1>
      <p className="mt-1 text-sm text-muted">Only the people who run this app can set up businesses.</p>
      <Link to="/" className="btn mt-4">Back to the app</Link>
    </div>
  )
}

// ---------- the list ----------

export default function Businesses() {
  const list = useAdminBusinesses()
  const ctx = useOptionalBusiness()
  const navigate = useNavigate()
  const [login, setLogin] = useState<{ business: string; owner: string } | null>(null)

  return (
    <div>
      <PageHeader title="Businesses" subtitle="Every business using the app. Only platform admins see this page."
        action={<Link to="/admin/businesses/new" className="btn btn-primary">+ New business</Link>} />
      <ErrorBox error={list.error} />
      {list.isLoading ? <Loading /> : !list.data?.length ? (
        <Empty>No businesses yet. <Link className="font-semibold text-accent" to="/admin/businesses/new">Set up the first one</Link>.</Empty>
      ) : (
        <div className="card overflow-hidden">
          <ul className="divide-y divide-line">
            {list.data.map((b) => (
              <li key={b.id} className="flex flex-wrap items-center gap-x-4 gap-y-2 px-4 py-3.5 desk:px-5">
                <div className="min-w-0 flex-[1_1_220px]">
                  <div className="flex flex-wrap items-center gap-2">
                    <span className="truncate font-semibold">{b.name}</span>
                    <Activity last={b.last_sales} />
                  </div>
                  <div className="mt-0.5 truncate text-[13px] text-muted">
                    {[b.legal_name, b.abn && `ABN ${b.abn}`].filter(Boolean).join(' · ') || 'No legal details yet'}
                  </div>
                </div>
                <div className="min-w-0 flex-[1_1_220px] text-[13px]">
                  <div className="truncate text-ink-2">{b.owners.join(', ') || 'No owner'}</div>
                  <div className="text-muted">
                    {b.members} {b.members === 1 ? 'person' : 'people'} · set up {fmtDate(b.created_at.slice(0, 10))}
                  </div>
                </div>
                <div className="flex gap-2">
                  {b.owners.length > 0 && (
                    <button type="button" className="btn btn-sm" onClick={() => setLogin({ business: b.id, owner: b.owners[0] })}>Owner login</button>
                  )}
                  {b.i_am_member && ctx && (
                    <button type="button" className="btn btn-sm" onClick={() => { ctx.setBusinessId(b.id); navigate('/') }}>Open</button>
                  )}
                </div>
                {login?.business === b.id && (
                  <div className="basis-full">
                    <OwnerLogin businessId={b.id} businessName={b.name} owner={login.owner} onClose={() => setLogin(null)} />
                  </div>
                )}
              </li>
            ))}
          </ul>
        </div>
      )}
      <p className="mt-3 text-xs text-muted">
        You only see a business’s figures if you’re one of its people. Ask the owner to add you in People → Access, or tick “Also add me” when setting one up.
      </p>
    </div>
  )
}

function Activity({ last }: { last: string | null }) {
  if (!last) return <Pill tone="neutral">No sales yet</Pill>
  const days = diffDays(last, todayStr())
  return days <= 7 ? <Pill tone="success">Active</Pill> : <Pill tone="warn">Quiet · {days} days</Pill>
}

/** Make (or re-issue) the owner's login, and show what to send them. */
function OwnerLogin({ businessId, businessName, owner, onClose }: { businessId: string; businessName: string; owner: string; onClose: () => void }) {
  const setup = useSetupOwnerLogin()
  return (
    <div className="rounded-xl border border-line bg-surface-2 p-4">
      {setup.data ? (
        <LoginResult result={setup.data} businessName={businessName} />
      ) : (
        <>
          <p className="text-sm text-ink-2">
            Make a sign-in for <b>{owner}</b>. If they haven’t signed in yet, this gives them a new temporary password and the old one stops working.
            If they already use the app, nothing changes.
          </p>
          <ErrorBox error={setup.error} />
          <button type="button" className="btn btn-primary btn-sm mt-3" disabled={setup.isPending}
            onClick={() => setup.mutate({ business_id: businessId, email: owner })}>
            {setup.isPending ? 'Working…' : 'Make sign-in'}
          </button>
        </>
      )}
      <button type="button" className="btn btn-sm mt-3 ml-2" onClick={onClose}>Close</button>
    </div>
  )
}

// ---------- the setup wizard ----------

const STEPS = [
  { key: 'details', title: 'Business', sub: 'Name, legal entity and contact details' },
  { key: 'sales', title: 'Sales', sub: 'How the day’s takings are entered' },
  { key: 'owner', title: 'Owner', sub: 'Who runs it and signs in first' },
  { key: 'review', title: 'Review', sub: 'Check and create' },
] as const

interface Owner { name: string; email: string; join: boolean }

export function NewBusiness() {
  const create = useCreateBusiness()
  const setup = useSetupOwnerLogin()
  const [step, setStep] = useState(0)
  const [d, setD] = useState<BusinessDraft>(emptyDraft)
  const [owner, setOwner] = useState<Owner>({ name: '', email: '', join: false })
  const [created, setCreated] = useState<Business | null>(null)
  const set = (patch: Partial<BusinessDraft>) => setD((v) => ({ ...v, ...patch }))

  const p = draftProblems(d)
  const ownerEmailOk = !!owner.email.trim() && emailOk(owner.email)
  const stepOk = [!p.name && !p.abn && !p.email, true, ownerEmailOk, true]

  async function finish() {
    const { name, ...details } = draftToRow(d)
    const b = created ?? await create.mutateAsync({
      name, owner_email: owner.email, join: owner.join,
      details: { ...details, owner_name: owner.name.trim() || null },
    })
    setCreated(b)
    await setup.mutateAsync({ business_id: b.id, email: owner.email.trim().toLowerCase() })
  }

  if (created && setup.data) return <Done business={created} owner={owner} result={setup.data} />

  const busy = create.isPending || setup.isPending
  return (
    <div className="mx-auto max-w-3xl">
      <Link to="/admin/businesses" className="text-[13px] font-medium text-ink-2 hover:text-ink">‹ Businesses</Link>
      <PageHeader title="Set up a business" subtitle="Takes about two minutes. Everything except the name and owner can be changed later in Settings." />

      <Stepper step={step} onPick={(i) => i < step && !created && setStep(i)} />

      <form className="card mt-4 p-5 desk:p-6" onSubmit={(e) => {
        e.preventDefault()
        if (!stepOk[step]) return
        if (step < STEPS.length - 1) setStep(step + 1)
        else finish().catch(() => { /* shown below */ })
      }}>
        <h2 className="text-base font-semibold">{STEPS[step].title}</h2>
        <p className="mb-4 mt-0.5 text-[13px] text-muted">{STEPS[step].sub}</p>

        {step === 0 && <DetailsFields d={d} set={set} />}
        {step === 1 && <SalesFields d={d} set={set} />}
        {step === 2 && <OwnerFields owner={owner} setOwner={setOwner} emailBad={!!owner.email.trim() && !ownerEmailOk} />}
        {step === 3 && <Review d={d} owner={owner} goTo={created ? undefined : setStep} />}

        <ErrorBox error={create.error || setup.error} />
        {created && setup.error && (
          <p className="mt-2 text-sm text-ink-2"><b>{created.name}</b> was created, but the owner’s sign-in wasn’t. Try again, or do it later from Businesses → Owner login.</p>
        )}

        <div className="mt-6 flex flex-wrap items-center justify-between gap-2 border-t border-line pt-4">
          <span className="text-xs text-muted">Step {step + 1} of {STEPS.length}</span>
          <div className="flex gap-2">
            {step > 0 && !created && <button type="button" className="btn" onClick={() => setStep(step - 1)}>Back</button>}
            <button className="btn btn-primary" disabled={!stepOk[step] || busy}>
              {step < STEPS.length - 1 ? 'Continue' : busy ? 'Creating…' : created ? 'Try sign-in again' : 'Create business'}
            </button>
          </div>
        </div>
      </form>
    </div>
  )
}

function Stepper({ step, onPick }: { step: number; onPick: (i: number) => void }) {
  return (
    <ol className="flex gap-1.5 desk:gap-2" aria-label="Steps">
      {STEPS.map((s, i) => {
        const state = i < step ? 'done' : i === step ? 'current' : 'todo'
        return (
          <li key={s.key} className="min-w-0 flex-1">
            <button type="button" onClick={() => onPick(i)} disabled={state !== 'done'} aria-current={state === 'current' ? 'step' : undefined}
              className="w-full text-left disabled:cursor-default">
              <span className={`block h-1 rounded-full ${state === 'todo' ? 'bg-line' : 'bg-accent'}`} />
              <span className={`mt-2 flex items-center gap-1.5 text-[13px] font-medium ${state === 'todo' ? 'text-muted' : 'text-ink'}`}>
                <span className={`grid h-5 w-5 shrink-0 place-items-center rounded-full text-[11px] ${
                  state === 'todo' ? 'bg-surface-2 text-muted' : 'bg-accent text-accent-ink'}`}>{state === 'done' ? '✓' : i + 1}</span>
                <span className="hidden truncate sm:inline">{s.title}</span>
              </span>
            </button>
          </li>
        )
      })}
    </ol>
  )
}

function OwnerFields({ owner, setOwner, emailBad }: { owner: Owner; setOwner: (o: Owner) => void; emailBad: boolean }) {
  return (
    <div className="grid gap-4">
      <div className="grid gap-4 sm:grid-cols-2">
        <Field label="Owner’s name">
          <input className="field" value={owner.name} onChange={(e) => setOwner({ ...owner, name: e.target.value })} placeholder="Alex Citizen" autoComplete="off" />
        </Field>
        <Field label={<span>Owner’s email <span className="text-bad" aria-hidden>*</span></span>}
          hint={emailBad ? <span className="text-bad">That doesn’t look like an email address.</span> : 'They sign in with this.'}>
          <input className="field" type="email" value={owner.email} onChange={(e) => setOwner({ ...owner, email: e.target.value })} placeholder="alex@example.com" autoComplete="off" />
        </Field>
      </div>
      <p className="rounded-lg bg-surface-2 px-3 py-2.5 text-[13px] text-ink-2">
        The owner gets full access, including tax, bank and super details and who else can sign in. They add their managers and staff themselves in People → Access.
      </p>
      <label className="flex cursor-pointer items-start gap-3 text-sm">
        <input type="checkbox" className="mt-0.5 h-4 w-4 accent-[var(--accent)]" checked={owner.join} onChange={(e) => setOwner({ ...owner, join: e.target.checked })} />
        <span>
          <span className="font-medium">Also add me as an owner</span>
          <span className="block text-[13px] text-muted">To help them set up the catalogue and staff. The owner can remove you later.</span>
        </span>
      </label>
    </div>
  )
}

function Review({ d, owner, goTo }: { d: BusinessDraft; owner: Owner; goTo?: (step: number) => void }) {
  const r = draftToRow(d)
  const sections: [number, string, [string, ReactNode][]][] = [
    [0, 'Business', [
      ['Trading name', r.name], ['Legal entity', r.legal_name], ['ABN', r.abn], ['GST', r.gst_registered ? 'Registered' : 'Not registered'],
      ['Address', r.address], ['Phone', r.phone], ['Email', r.email],
    ]],
    [1, 'Sales', [
      ['Daily sales', r.sales_mode === 'simple' ? 'Total sales and cash collected' : 'Card, cash, Uber and online'], ['Till', r.till_system],
    ]],
    [2, 'Owner', [
      ['Name', owner.name.trim() || null], ['Email', owner.email.trim().toLowerCase()], ['You', owner.join ? 'Added as an owner too' : 'Not added'],
    ]],
  ]
  return (
    <div className="grid gap-4">
      {sections.map(([step, title, rows]) => (
        <section key={title} className="rounded-xl border border-line">
          <div className="flex items-center justify-between border-b border-line px-4 py-2.5">
            <h3 className="text-sm font-semibold">{title}</h3>
            {goTo && <button type="button" className="text-[13px] font-medium text-accent" onClick={() => goTo(step)}>Edit</button>}
          </div>
          <dl className="grid grid-cols-[minmax(110px,auto)_1fr] gap-x-4 gap-y-1.5 px-4 py-3 text-sm">
            {rows.map(([k, v]) => (
              <div key={k} className="contents">
                <dt className="text-muted">{k}</dt>
                <dd className={v ? 'min-w-0 break-words' : 'text-faint'}>{v || 'Not added'}</dd>
              </div>
            ))}
          </dl>
        </section>
      ))}
    </div>
  )
}

function Done({ business, owner, result }: { business: Business; owner: Owner; result: { existing: boolean; email: string; password?: string } }) {
  const ctx = useOptionalBusiness()
  const navigate = useNavigate()
  return (
    <div className="mx-auto max-w-xl">
      <div className="card p-6">
        <div className="grid h-11 w-11 place-items-center rounded-full bg-accent-tint text-xl text-accent">✓</div>
        <h1 className="mt-3 text-xl font-semibold">{business.name} is ready</h1>
        <p className="mt-1 text-sm text-muted">Its security groups (Owner, Manager, Staff) and payroll settings are set up.</p>
        <div className="mt-5">
          <LoginResult result={result} businessName={business.name} ownerName={owner.name} />
        </div>
        <div className="mt-6 flex flex-wrap gap-2 border-t border-line pt-4">
          {owner.join && ctx && <button type="button" className="btn btn-primary" onClick={() => { ctx.setBusinessId(business.id); navigate('/') }}>Open {business.name}</button>}
          <Link to="/admin/businesses" className="btn">All businesses</Link>
          <Link to="/admin/businesses/new" reloadDocument className="btn">Set up another</Link>
        </div>
      </div>
    </div>
  )
}

/** What to send the owner: the app's address, their email and the temporary password. */
function LoginResult({ result, businessName, ownerName }: { result: { existing: boolean; email: string; password?: string }; businessName: string; ownerName?: string }) {
  const [copied, setCopied] = useState(false)
  if (result.existing || !result.password)
    return (
      <p className="rounded-lg bg-surface-2 px-3 py-2.5 text-sm text-ink-2">
        <b>{result.email}</b> already signs in to the app with their own password. {businessName} will be in their list of businesses next time they open it.
      </p>
    )

  const message = [
    `Hi${ownerName?.trim() ? ` ${ownerName.trim().split(/\s+/)[0]}` : ''}, ${businessName} is set up and ready for you.`,
    '',
    `Open: ${APP_URL}`,
    `Email: ${result.email}`,
    `Temporary password: ${result.password}`,
    '',
    'You’ll be asked to choose your own password the first time you sign in.',
  ].join('\n')

  return (
    <div>
      <h2 className="text-sm font-semibold">Send the owner their sign-in</h2>
      <dl className="mt-2 grid grid-cols-[auto_1fr] gap-x-4 gap-y-1.5 rounded-xl border border-line px-4 py-3 text-sm">
        <dt className="text-muted">App</dt><dd className="min-w-0 break-all">{APP_URL}</dd>
        <dt className="text-muted">Email</dt><dd className="min-w-0 break-all">{result.email}</dd>
        <dt className="text-muted">Password</dt><dd className="num font-semibold tracking-wide">{result.password}</dd>
      </dl>
      <button type="button" className={`btn mt-3 ${copied ? 'btn-saved' : 'btn-primary'}`}
        onClick={() => navigator.clipboard.writeText(message).then(() => setCopied(true), () => setCopied(false))}>
        {copied ? 'Copied' : 'Copy message to send'}
      </button>
      <p className="mt-2 text-xs text-muted">
        This password is only shown now. Send it by text or WhatsApp; if it’s lost, use Owner login on the Businesses page to make a new one.
      </p>
    </div>
  )
}
