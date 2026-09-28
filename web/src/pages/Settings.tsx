import { useState, type ReactNode } from 'react'
import {
  useCreateBusiness, useAddPerson, useBusinessUsers, useContributions, usePartners, useRemovePerson,
  useSaveBusiness, useSetupCosts, useStaff, useSuppliers,
} from '../lib/api'
import { useBusiness } from '../lib/business'
import { CAT_LABEL, ENTRY_CATEGORIES } from '../lib/categories'
import { aud, cents } from '../lib/format'
import { TableEditor } from '../components/TableEditor'
import { DeleteButton, ErrorBox, Loading, PageHeader } from '../components/ui'

function Section({ title, hint, children, id }: { title: string; hint?: ReactNode; children: ReactNode; id: string }) {
  return (
    <section id={id} className="card scroll-mt-20 p-4">
      <h2 className="text-lg font-semibold">{title}</h2>
      {hint && <p className="mb-2 text-sm text-muted">{hint}</p>}
      {children}
    </section>
  )
}

const CATEGORY_OPTIONS = ENTRY_CATEGORIES.map((c) => ({ value: c, label: CAT_LABEL[c] }))

export default function Settings() {
  const suppliers = useSuppliers()
  const staff = useStaff()
  const partners = usePartners()
  const contributions = useContributions()
  const setup = useSetupCosts()
  const partnerOptions = (partners.data ?? []).map((p) => ({ value: p.id, label: p.name }))

  return (
    <div>
      <PageHeader title="Settings" />
      <nav aria-label="Settings sections" className="mb-4 flex flex-wrap gap-1.5">
        {[['business', 'Business'], ['suppliers', 'Suppliers'], ['staff', 'Staff'], ['partners', 'Partners'], ['setup', 'Setup costs'], ['contributions', 'Contributions']].map(([id, label]) => (
          <a key={id} href={`#${id}`} className="chip">{label}</a>
        ))}
      </nav>

      <div className="grid gap-4">
        <BusinessSection />
        <PartnerSummary />

        <Section id="suppliers" title="Suppliers" hint="Untick “Active” to hide a supplier from the pickers without losing its history.">
          {suppliers.isLoading ? <Loading /> : (
            <TableEditor table="suppliers" rows={suppliers.data ?? []} addLabel="Add supplier" canDelete={false}
              defaults={{ default_category: 'food', active: true }}
              fields={[
                { key: 'name', label: 'Name', type: 'text', required: true },
                { key: 'default_category', label: 'Usually', type: 'select', options: CATEGORY_OPTIONS, width: 'md:w-40' },
                { key: 'active', label: 'Active', type: 'bool', width: 'md:w-16' },
              ]} />
          )}
        </Section>

        <Section id="staff" title="Staff" hint="The hourly rate fills in wages automatically (hours × rate) when you add a labour expense.">
          {staff.isLoading ? <Loading /> : (
            <TableEditor table="staff" rows={staff.data ?? []} addLabel="Add staff member" canDelete={false}
              defaults={{ active: true }}
              fields={[
                { key: 'name', label: 'Name', type: 'text', required: true },
                { key: 'hourly_rate', label: 'Hourly rate', type: 'money', width: 'md:w-28 md:text-right' },
                { key: 'active', label: 'Active', type: 'bool', width: 'md:w-16' },
              ]} />
          )}
        </Section>

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
          Each business keeps its own suppliers, staff, partners and costs. People only see the businesses they’re added to.
        </p>
      </div>
    </div>
  )
}

/** Rename this business, manage who can open it, and start another one. */
function BusinessSection() {
  // Remount on switch so the name box and half-typed forms belong to the business on screen.
  const { business } = useBusiness()
  return <BusinessFields key={business?.id} />
}

function BusinessFields() {
  const { business, businesses, setBusinessId } = useBusiness()
  const people = useBusinessUsers()
  const saveBusiness = useSaveBusiness()
  const createBusiness = useCreateBusiness()
  const addPerson = useAddPerson()
  const removePerson = useRemovePerson()
  const [name, setName] = useState(business?.name ?? '')
  const [email, setEmail] = useState('')
  const [personName, setPersonName] = useState('')
  const [newBiz, setNewBiz] = useState('')
  const [adding, setAdding] = useState(false)
  const [error, setError] = useState<unknown>(null)
  async function addBusiness(e: React.FormEvent) {
    e.preventDefault()
    setError(null)
    try {
      const created = await createBusiness.mutateAsync(newBiz)
      setNewBiz('')
      setAdding(false)
      setBusinessId(created.id)
    } catch (err) {
      setError(err)
    }
  }

  return (
    <Section id="business" title="Business" hint="Everything on the other pages belongs to the business shown in the header.">
      <ErrorBox error={error || saveBusiness.error || addPerson.error || removePerson.error} />

      <form
        className="flex flex-wrap items-end gap-2"
        onSubmit={(e) => { e.preventDefault(); if (business && name.trim()) saveBusiness.mutate({ id: business.id, name: name.trim() }) }}
      >
        <div className="min-w-48 flex-1">
          <label className="label" htmlFor="biz-name">Name</label>
          <input id="biz-name" className="field" value={name} onChange={(e) => setName(e.target.value)} />
        </div>
        <button className="btn" disabled={!name.trim() || name.trim() === business?.name || saveBusiness.isPending}>Rename</button>
      </form>

      <h3 className="mt-5 font-semibold">Who can sign in</h3>
      <p className="mb-2 text-sm text-muted">Only these addresses can open <b>{business?.name}</b>. Adding someone doesn’t email them — they sign in themselves.</p>
      {people.isLoading ? <Loading /> : (
        <ul className="divide-y divide-line">
          {(people.data ?? []).map((p) => (
            <li key={p.email} className="flex flex-wrap items-center gap-2 py-2.5">
              <span className="min-w-0 flex-1 truncate font-medium">{p.email}</span>
              {p.display_name && <span className="text-sm text-muted">{p.display_name}</span>}
              <DeleteButton label="Remove" busy={removePerson.isPending} onConfirm={() => removePerson.mutate(p.email)} />
            </li>
          ))}
        </ul>
      )}
      <form
        className="mt-2 flex flex-wrap items-end gap-2"
        onSubmit={(e) => {
          e.preventDefault()
          if (!email.trim()) return
          addPerson.mutate({ email, display_name: personName.trim() || null }, { onSuccess: () => { setEmail(''); setPersonName('') } })
        }}
      >
        <div className="min-w-48 flex-1">
          <label className="label" htmlFor="p-email">Email</label>
          <input id="p-email" type="email" className="field" value={email} onChange={(e) => setEmail(e.target.value)} placeholder="them@example.com" />
        </div>
        <div className="w-36">
          <label className="label" htmlFor="p-name">Name <span className="font-normal text-muted">(optional)</span></label>
          <input id="p-name" className="field" value={personName} onChange={(e) => setPersonName(e.target.value)} />
        </div>
        <button className="btn" disabled={!email.trim() || addPerson.isPending}>Add person</button>
      </form>

      <h3 className="mt-5 font-semibold">Other businesses</h3>
      <p className="mb-2 text-sm text-muted">
        You can open {businesses.length === 1 ? 'one business' : `${businesses.length} businesses`}: {businesses.map((b) => b.name).join(', ')}.
      </p>
      {adding ? (
        <form className="flex flex-wrap items-end gap-2" onSubmit={addBusiness}>
          <div className="min-w-48 flex-1">
            <label className="label" htmlFor="new-biz">New business name</label>
            <input id="new-biz" className="field" value={newBiz} onChange={(e) => setNewBiz(e.target.value)} placeholder="Second shop" autoFocus />
          </div>
          <button className="btn btn-primary" disabled={!newBiz.trim() || createBusiness.isPending}>{createBusiness.isPending ? 'Creating…' : 'Create'}</button>
          <button type="button" className="btn" onClick={() => { setAdding(false); setNewBiz('') }}>Cancel</button>
        </form>
      ) : (
        <button type="button" className="btn btn-sm" onClick={() => setAdding(true)}>+ Add another business</button>
      )}
      <p className="mt-2 text-xs text-muted">A new business starts empty, with you as its only member. Switch between businesses in the header.</p>
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
