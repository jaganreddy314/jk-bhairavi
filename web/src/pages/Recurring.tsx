import { useState } from 'react'
import { useRecurring, useRemove, useSave, useSuppliers } from '../lib/api'
import { CAT_COLOR, CAT_LABEL, ENTRY_CATEGORIES, PAID_VIA } from '../lib/categories'
import { addDays, fmtLong, fmtShort, todayStr } from '../lib/dates'
import { aud, parseMoney } from '../lib/format'
import { nextDue, perWeek, recurringStatus } from '../lib/logic'
import type { CategoryCode, Frequency, PaidVia, RecurringExpense } from '../lib/types'
import { CatName, DeleteButton, Empty, ErrorBox, Loading, PageHeader, Segmented } from '../components/ui'

const FREQS: { value: Frequency; label: string }[] = [
  { value: 'weekly', label: 'Weekly' },
  { value: 'fortnightly', label: 'Fortnightly' },
  { value: 'monthly', label: 'Monthly' },
]
const freqLabel = (f: Frequency) => FREQS.find((x) => x.value === f)!.label

export default function Recurring() {
  const { data, isLoading, error } = useRecurring()
  const save = useSave('recurring_expenses')
  const remove = useRemove('recurring_expenses')
  const [editing, setEditing] = useState<RecurringExpense | 'new' | null>(null)
  const today = todayStr()
  const rows = data ?? []
  const activeWeekly = rows.filter((r) => recurringStatus(r) === 'active').reduce((s, r) => s + perWeek(r), 0)

  return (
    <div>
      <PageHeader
        title="Standard expenses"
        subtitle="Set once, counted automatically every period (rent, insurance, subscriptions…)."
        action={editing ? undefined : <button className="btn btn-primary" onClick={() => setEditing('new')}>+ Add</button>}
      />
      <ErrorBox error={error || save.error || remove.error} />

      {editing && (
        <RecurringForm
          key={editing === 'new' ? 'new' : editing.id}
          existing={editing === 'new' ? undefined : editing}
          onDone={() => setEditing(null)}
        />
      )}

      {isLoading ? <Loading /> : rows.length === 0 ? (
        !editing && <Empty>No standard expenses yet. Add rent here so it’s counted every period without re-entering it.</Empty>
      ) : (
        <>
          <p className="mb-2 text-sm text-ink-2">
            Active items cost about <b className="num">{aud(activeWeekly)}</b> a week.
          </p>
          <ul className="grid gap-3 md:grid-cols-2">
            {rows.map((r) => {
              const status = recurringStatus(r)
              const due = nextDue(r)
              return (
                <li key={r.id} className={`card p-4 ${status === 'paused' ? 'opacity-70' : ''}`}>
                  <div className="flex items-start justify-between gap-3">
                    <div className="min-w-0">
                      <div className="font-semibold">{r.name}</div>
                      <div className="text-xs text-muted"><CatName code={r.category} /></div>
                    </div>
                    <div className="text-right">
                      <div className="num text-lg font-bold">{aud(r.amount)}</div>
                      <div className="text-xs text-muted">{freqLabel(r.frequency)}</div>
                    </div>
                  </div>
                  <div className="mt-3 text-sm text-ink-2">
                    {status === 'paused' ? (
                      <span>Paused since {fmtShort(r.end_date!)}</span>
                    ) : due ? (
                      <span>Next due <b>{due === today ? 'today' : fmtLong(due)}</b></span>
                    ) : (
                      <span>Ends {fmtShort(r.end_date!)}</span>
                    )}
                    <span className="text-muted"> · since {fmtShort(r.start_date)}</span>
                  </div>
                  <div className="mt-3 flex flex-wrap gap-1.5">
                    <button className="btn btn-sm" onClick={() => setEditing(r)}>Edit</button>
                    {status === 'paused' || r.end_date ? (
                      <button className="btn btn-sm" disabled={save.isPending} onClick={() => save.mutate({ id: r.id, end_date: null })}>Resume</button>
                    ) : (
                      // Pausing = ending yesterday, so nothing more is counted from today on.
                      <button className="btn btn-sm" disabled={save.isPending} onClick={() => save.mutate({ id: r.id, end_date: addDays(today, -1) })}>Pause</button>
                    )}
                    <DeleteButton busy={remove.isPending} onConfirm={() => remove.mutate(r.id)} />
                  </div>
                </li>
              )
            })}
          </ul>
          <p className="mt-4 text-xs text-muted">
            Deleting removes every past occurrence from the numbers too. To stop an item but keep its history, use Pause.
          </p>
        </>
      )}
    </div>
  )
}

function RecurringForm({ existing, onDone }: { existing?: RecurringExpense; onDone: () => void }) {
  const save = useSave('recurring_expenses')
  const suppliers = useSuppliers().data ?? []
  const [name, setName] = useState(existing?.name ?? '')
  const [category, setCategory] = useState<CategoryCode>(existing?.category ?? 'rent')
  const [amount, setAmount] = useState(existing ? String(existing.amount) : '')
  const [frequency, setFrequency] = useState<Frequency>(existing?.frequency ?? 'monthly')
  const [startDate, setStartDate] = useState(existing?.start_date ?? todayStr())
  const [endDate, setEndDate] = useState(existing?.end_date ?? '')
  const [supplierId, setSupplierId] = useState(existing?.supplier_id ?? '')
  const [paidVia, setPaidVia] = useState<PaidVia>(existing?.paid_via ?? 'bank')
  const [note, setNote] = useState(existing?.note ?? '')
  const amt = parseMoney(amount)
  const valid = name.trim() && amt > 0 && startDate && (!endDate || endDate >= startDate)

  async function submit(e: React.FormEvent) {
    e.preventDefault()
    if (!valid) return
    await save.mutateAsync({
      id: existing?.id, name: name.trim(), category, amount: amt, frequency, start_date: startDate,
      end_date: endDate || null, supplier_id: supplierId || null, paid_via: paidVia, note: note.trim() || null,
    })
    onDone()
  }

  return (
    <form onSubmit={submit} className="card mb-5 p-4">
      <h2 className="mb-3 font-semibold">{existing ? `Edit “${existing.name}”` : 'New standard expense'}</h2>
      <ErrorBox error={save.error} />
      <div className="grid gap-4 sm:grid-cols-2">
        <div>
          <label className="label" htmlFor="r-name">Name</label>
          <input id="r-name" className="field" value={name} onChange={(e) => setName(e.target.value)} placeholder="Shop rent" required />
        </div>
        <div>
          <label className="label" htmlFor="r-cat">Category</label>
          <div className="flex items-center gap-2">
            <span className="h-3 w-3 shrink-0 rounded-full" style={{ background: CAT_COLOR[category] }} />
            <select id="r-cat" className="field" value={category} onChange={(e) => setCategory(e.target.value as CategoryCode)}>
              {ENTRY_CATEGORIES.map((c) => <option key={c} value={c}>{CAT_LABEL[c]}</option>)}
            </select>
          </div>
        </div>
        <div>
          <label className="label" htmlFor="r-amt">Amount each time (AUD)</label>
          <input id="r-amt" className="field field-lg" inputMode="decimal" value={amount} onChange={(e) => setAmount(e.target.value)} placeholder="0.00" />
        </div>
        <div>
          <span className="label">How often</span>
          <Segmented ariaLabel="Frequency" value={frequency} onChange={setFrequency} options={FREQS} />
          {amt > 0 && <p className="mt-1.5 text-xs text-muted">≈ {aud(perWeek({ amount: amt, frequency }))} a week</p>}
        </div>
        <div>
          <label className="label" htmlFor="r-start">First payment date</label>
          <input id="r-start" type="date" className="field" value={startDate} onChange={(e) => setStartDate(e.target.value)} required />
          {frequency === 'monthly' && <p className="mt-1 text-xs text-muted">Repeats on this day each month (or the last day of shorter months).</p>}
        </div>
        <div>
          <label className="label" htmlFor="r-end">End date <span className="font-normal text-muted">(optional)</span></label>
          <input id="r-end" type="date" className="field" value={endDate} min={startDate} onChange={(e) => setEndDate(e.target.value)} />
        </div>
        <div>
          <label className="label" htmlFor="r-sup">Supplier / payee <span className="font-normal text-muted">(optional)</span></label>
          <select id="r-sup" className="field" value={supplierId} onChange={(e) => setSupplierId(e.target.value)}>
            <option value="">— None —</option>
            {suppliers.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
          </select>
        </div>
        <div>
          <span className="label">Paid via</span>
          <Segmented ariaLabel="Paid via" value={paidVia} onChange={setPaidVia} options={PAID_VIA} />
        </div>
        <div className="sm:col-span-2">
          <label className="label" htmlFor="r-note">Note <span className="font-normal text-muted">(optional)</span></label>
          <input id="r-note" className="field" value={note} onChange={(e) => setNote(e.target.value)} />
        </div>
      </div>
      <div className="mt-4 flex gap-2">
        <button className="btn btn-primary" disabled={!valid || save.isPending}>{save.isPending ? 'Saving…' : 'Save'}</button>
        <button type="button" className="btn" onClick={onDone}>Cancel</button>
      </div>
    </form>
  )
}
