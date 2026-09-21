import { useState } from 'react'
import { Link, useNavigate, useParams } from 'react-router-dom'
import { useExpense, useRemove, useSave, useStaff, useSuppliers } from '../lib/api'
import { CAT_COLOR, CAT_LABEL, ENTRY_CATEGORIES, PAID_VIA } from '../lib/categories'
import { todayStr } from '../lib/dates'
import { aud, cents, parseMoney } from '../lib/format'
import type { CategoryCode, Expense, PaidVia } from '../lib/types'
import { DeleteButton, ErrorBox, Flash, Loading, PageHeader, Segmented } from '../components/ui'

export default function ExpenseForm() {
  const { id } = useParams()
  const { data, isLoading, error } = useExpense(id)
  const [savedCount, setSavedCount] = useState(0)
  const [lastSaved, setLastSaved] = useState(0)
  const [prefill, setPrefill] = useState<Partial<Expense>>({})

  if (id && isLoading) return <Loading />
  return (
    <div className="mx-auto max-w-md">
      <PageHeader
        title={id ? 'Edit expense' : 'Add expense'}
        subtitle={!id && savedCount > 0 ? `${savedCount} saved this session` : undefined}
        action={<Link to="/expenses" className="text-sm font-medium text-accent">All expenses →</Link>}
      />
      <ErrorBox error={error} />
      <Form
        key={id ?? `new-${savedCount}`}
        existing={data}
        prefill={prefill}
        onAddAnother={(p) => {
          setPrefill(p)
          setSavedCount((n) => n + 1)
          setLastSaved(Date.now())
        }}
      />
      <div className="mt-2 h-5 text-center"><Flash signal={lastSaved}>Saved — add the next one</Flash></div>
    </div>
  )
}

function Form({
  existing, prefill, onAddAnother,
}: { existing?: Expense; prefill: Partial<Expense>; onAddAnother: (p: Partial<Expense>) => void }) {
  const nav = useNavigate()
  const suppliers = useSuppliers()
  const staff = useStaff()
  const save = useSave('expenses')
  const remove = useRemove('expenses')
  const src = existing ?? prefill

  const [category, setCategory] = useState<CategoryCode | null>(src.category ?? null)
  const [date, setDate] = useState(src.expense_date ?? todayStr())
  const [supplierId, setSupplierId] = useState(src.supplier_id ?? '')
  const [staffId, setStaffId] = useState(existing?.staff_id ?? '')
  const [hours, setHours] = useState(existing?.hours ? String(existing.hours) : '')
  const [amount, setAmount] = useState(existing ? String(existing.amount) : '')
  const [amountTouched, setAmountTouched] = useState(!!existing)
  const [paidVia, setPaidVia] = useState<PaidVia>(src.paid_via ?? 'bank')
  const [note, setNote] = useState(existing?.note ?? '')

  const rate = staff.data?.find((s) => s.id === staffId)?.hourly_rate ?? null
  // Labour: amount follows hours × rate until the user types their own amount.
  const suggested = category === 'labour' && rate && hours ? cents(parseMoney(hours) * rate) : null
  const shownAmount = !amountTouched && suggested != null ? String(suggested) : amount
  const amountNum = parseMoney(shownAmount)

  const supplierList = (suppliers.data ?? [])
    .filter((s) => s.active || s.id === supplierId)
    .sort((a, b) => Number(b.default_category === category) - Number(a.default_category === category) || a.name.localeCompare(b.name))

  const valid = category && date && amountNum > 0 && (category !== 'food' || supplierId)

  async function submit(addAnother: boolean) {
    if (!valid) return
    await save.mutateAsync({
      id: existing?.id,
      expense_date: date,
      category,
      supplier_id: category === 'labour' ? null : supplierId || null,
      staff_id: category === 'labour' ? staffId || null : null,
      hours: category === 'labour' && hours ? parseMoney(hours) : null,
      amount: amountNum,
      paid_via: paidVia,
      note: note.trim() || null,
    })
    if (addAnother) onAddAnother({ category: category!, expense_date: date, paid_via: paidVia, supplier_id: category === 'food' ? null : supplierId || null })
    else nav('/expenses')
  }

  return (
    <form className="card p-4" onSubmit={(e) => { e.preventDefault(); submit(false) }}>
      <ErrorBox error={save.error || remove.error} />

      <span className="label">Category</span>
      <div className="grid grid-cols-2 gap-2" role="group" aria-label="Category">
        {ENTRY_CATEGORIES.map((c) => (
          <button key={c} type="button" aria-pressed={category === c} onClick={() => setCategory(c)}
            className={`flex items-center gap-2 rounded-xl border px-3 py-3 text-left text-sm font-semibold ${category === c ? 'border-ink bg-surface-2' : 'border-line'}`}>
            <span className="h-3 w-3 rounded-full" style={{ background: CAT_COLOR[c] }} />
            {CAT_LABEL[c]}
          </button>
        ))}
      </div>

      {category && (
        <div className="mt-5 space-y-4">
          <div>
            <label className="label" htmlFor="date">Date</label>
            <input id="date" type="date" className="field" value={date} onChange={(e) => setDate(e.target.value)} required />
          </div>

          {category === 'labour' ? (
            <div className="grid grid-cols-[1fr_7rem] gap-3">
              <div>
                <label className="label" htmlFor="staff">Staff member</label>
                <select id="staff" className="field" value={staffId} onChange={(e) => setStaffId(e.target.value)}>
                  <option value="">— Choose —</option>
                  {(staff.data ?? []).filter((s) => s.active || s.id === staffId).map((s) => (
                    <option key={s.id} value={s.id}>{s.name}{s.hourly_rate ? ` · ${aud(s.hourly_rate)}/h` : ''}</option>
                  ))}
                </select>
                {staff.data?.length === 0 && (
                  <p className="mt-1 text-xs text-muted">No staff yet — add them in <Link className="text-accent" to="/settings">Settings</Link>.</p>
                )}
              </div>
              <div>
                <label className="label" htmlFor="hours">Hours</label>
                <input id="hours" className="field" inputMode="decimal" value={hours} onChange={(e) => setHours(e.target.value)} placeholder="0" />
              </div>
            </div>
          ) : (
            <div>
              <label className="label" htmlFor="supplier">Supplier {category !== 'food' && <span className="font-normal text-muted">(optional)</span>}</label>
              <select id="supplier" className="field" value={supplierId} onChange={(e) => setSupplierId(e.target.value)} required={category === 'food'}>
                <option value="">— {category === 'food' ? 'Choose' : 'None'} —</option>
                {supplierList.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
              </select>
            </div>
          )}

          <div>
            <label className="label" htmlFor="amount">Amount (AUD)</label>
            <input id="amount" className="field field-lg" inputMode="decimal" placeholder="0.00" autoComplete="off" value={shownAmount}
              onChange={(e) => { setAmount(e.target.value); setAmountTouched(true) }} />
            {category === 'labour' && suggested != null && (
              <p className="mt-1 text-xs text-muted">
                {parseMoney(hours)} h × {aud(rate!)} = {aud(suggested)}
                {amountTouched && amountNum !== suggested && (
                  <button type="button" className="ml-2 font-semibold text-accent" onClick={() => setAmountTouched(false)}>Use this</button>
                )}
              </p>
            )}
          </div>

          <div>
            <span className="label">Paid via</span>
            <Segmented ariaLabel="Paid via" value={paidVia} onChange={setPaidVia} options={PAID_VIA} />
          </div>

          <div>
            <label className="label" htmlFor="note">Note <span className="font-normal text-muted">(optional)</span></label>
            <input id="note" className="field" value={note} onChange={(e) => setNote(e.target.value)} placeholder="Invoice #, what it was for…" />
          </div>

          <div className="flex flex-wrap gap-2 pt-1">
            <button className="btn btn-primary flex-1" disabled={!valid || save.isPending}>{save.isPending ? 'Saving…' : 'Save'}</button>
            {!existing && (
              <button type="button" className="btn flex-1" disabled={!valid || save.isPending} onClick={() => submit(true)}>Save + add another</button>
            )}
          </div>
          {existing && (
            <div className="flex justify-end border-t border-line pt-3">
              <DeleteButton busy={remove.isPending} onConfirm={async () => { await remove.mutateAsync(existing.id); nav('/expenses') }} label="Delete expense" />
            </div>
          )}
        </div>
      )}
    </form>
  )
}
