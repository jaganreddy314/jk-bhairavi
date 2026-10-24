import { useState } from 'react'
import { Link, useNavigate, useParams, useSearchParams } from 'react-router-dom'
import { useAllExpenses, useExpense, useExpenses, usePurchaseOrders, useRemove, useSave, useStaffNames, useSuppliers } from '../lib/api'
import { CAT_COLOR, CAT_LABEL, ENTRY_CATEGORIES, PAID_VIA } from '../lib/categories'
import { addDays, fmtShort, toDate, todayStr, weekStart } from '../lib/dates'
import { aud, cents, parseMoney } from '../lib/format'
import type { CategoryCode, Expense, PaidVia } from '../lib/types'
import { DeleteButton, ErrorBox, Loading, MoneyInput, PageHeader, Segmented } from '../components/ui'

/** One line under each category card, and the letter on its tile. */
const CAT_INFO: Partial<Record<CategoryCode, { sub: string; glyph: string }>> = {
  food: { sub: 'Stock not on a PO', glyph: 'F' },
  labour: { sub: 'Weekly wages', glyph: 'L' },
  rent: { sub: 'Lease payments', glyph: 'R' },
  utilities: { sub: 'Power, water, internet', glyph: 'U' },
  equipment: { sub: 'One-off, not in profit', glyph: 'E' },
  other: { sub: 'Anything else', glyph: 'O' },
}

/** A category's colour, faded onto the card behind it. */
const tint = (c: CategoryCode) => `color-mix(in srgb, ${CAT_COLOR[c]} 14%, var(--surface))`

function Glyph({ code, size }: { code: CategoryCode; size: number }) {
  return (
    <span className="grid shrink-0 place-items-center rounded-lg text-[13px] font-bold"
      style={{ width: size, height: size, background: tint(code), color: CAT_COLOR[code] }}>
      {CAT_INFO[code]?.glyph ?? '·'}
    </span>
  )
}

const fRecent = new Intl.DateTimeFormat('en-AU', { timeZone: 'UTC', weekday: 'short', day: 'numeric', month: 'short' })
const viaLabel = (v: PaidVia) => PAID_VIA.find((p) => p.value === v)?.label ?? v

/** Wages are entered per week: dated that Sunday, or today while the week is still running. */
const wageDate = (week: string) => [addDays(week, 6), todayStr()].sort()[0]
const WAGE_WEEKS = 12

export default function ExpenseForm() {
  const { id } = useParams()
  const { data, isLoading, error } = useExpense(id)
  const [savedCount, setSavedCount] = useState(0)
  const [toast, setToast] = useState('')
  // Links can preselect a category and date, e.g. the dashboard's "Add wages" for a week.
  const [params] = useSearchParams()
  const [prefill, setPrefill] = useState<Partial<Expense>>(() => {
    const category = params.get('category') as CategoryCode | null
    const date = params.get('date')
    return {
      ...(category && ENTRY_CATEGORIES.includes(category) ? { category } : {}),
      ...(date && /^\d{4}-\d{2}-\d{2}$/.test(date) ? { expense_date: date } : {}),
    }
  })

  if (id && isLoading) return <Loading />
  return (
    <div className="mx-auto max-w-[1180px]">
      <PageHeader
        title={id ? 'Edit expense' : 'Add expense'}
        subtitle="Supplier orders are recorded for you when they're received. Add everything else here."
        action={<Link to="/expenses" className="btn btn-sm h-9 font-medium">All expenses →</Link>}
      />
      <ErrorBox error={error} />
      {toast && (
        <div role="status" className="mb-4 flex items-center gap-2.5 rounded-[10px] border border-[#ABEFC6] bg-[#ECFDF3] px-3.5 py-2.5 text-sm text-[#067647] dark:border-[#085D3A] dark:bg-[#053321] dark:text-[#75E0A7]">
          <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" aria-hidden><path d="M20 6 9 17l-5-5" /></svg>
          <span className="flex-1">{toast}</span>
        </div>
      )}
      <div className="flex flex-wrap items-start gap-4">
        <Form
          key={id ?? `new-${savedCount}`}
          existing={data}
          prefill={prefill}
          onAdded={(p, message) => {
            setPrefill(p)
            setSavedCount((n) => n + 1)
            setToast(message)
          }}
          onEdit={() => setToast('')}
        />
        <Sidebar />
      </div>
    </div>
  )
}

function Form({
  existing, prefill, onAdded, onEdit,
}: { existing?: Expense; prefill: Partial<Expense>; onAdded: (p: Partial<Expense>, message: string) => void; onEdit: () => void }) {
  const nav = useNavigate()
  const suppliers = useSuppliers()
  const staff = useStaffNames()
  const orders = usePurchaseOrders()
  const save = useSave('expenses')
  const remove = useRemove('expenses')
  const src = existing ?? prefill
  const today = todayStr()
  const thisWeek = weekStart(today)
  const wages = useAllExpenses(addDays(thisWeek, -7 * (WAGE_WEEKS - 1)), addDays(thisWeek, 6))

  const [category, setCategoryState] = useState<CategoryCode>(src.category ?? 'food')
  const [date, setDate] = useState(src.expense_date ?? today)
  const [supplierId, setSupplierId] = useState(src.supplier_id ?? '')
  const [staffId, setStaffId] = useState(src.staff_id ?? '')
  const [hours, setHours] = useState(existing?.hours ? String(existing.hours) : '')
  const [amount, setAmount] = useState(existing ? String(existing.amount) : '')
  const [amountTouched, setAmountTouched] = useState(!!existing)
  const [paidVia, setPaidVia] = useState<PaidVia>(src.paid_via ?? 'bank')
  const [note, setNote] = useState(existing?.note ?? '')
  const edit = <T,>(set: (v: T) => void) => (v: T) => { set(v); onEdit() }
  const setCategory = (c: CategoryCode) => {
    setCategoryState(c)
    // Wages belong to a week, so move the date onto that week's pay day.
    if (c === 'labour') setDate(wageDate(weekStart(date)))
    onEdit()
  }

  const rate = staff.data?.find((s) => s.id === staffId)?.hourly_rate ?? null
  // Labour: amount follows hours × rate until the user types their own amount.
  const suggested = category === 'labour' && rate && hours ? cents(parseMoney(hours) * rate) : null
  const shownAmount = !amountTouched && suggested != null ? String(suggested) : amount
  const amountNum = parseMoney(shownAmount)

  const supplierList = (suppliers.data ?? [])
    .filter((s) => s.active || s.id === supplierId)
    .sort((a, b) => Number(b.default_category === category) - Number(a.default_category === category) || a.name.localeCompare(b.name))
  const supplierName = new Map((suppliers.data ?? []).map((s) => [s.id, s.name]))
  // Suppliers ordered through Purchase orders, whose deliveries record themselves.
  const ordered = [...new Set((orders.data ?? []).map((o) => o.supplier_id))].map((sid) => supplierName.get(sid)).filter(Boolean).slice(0, 2)

  // Weeks with any wages, counting this expense's own week only if it's saved there.
  const wageWeeks = new Set((wages.data ?? []).filter((e) => e.category === 'labour' && e.id !== existing?.id).map((e) => weekStart(e.expense_date)))
  const weeks = Array.from({ length: WAGE_WEEKS }, (_, i) => addDays(thisWeek, -7 * i))
  if (!weeks.includes(weekStart(date))) weeks.push(weekStart(date))

  const valid = date && amountNum > 0 && (category !== 'food' || supplierId)
  const payeeLabel = category === 'food' ? 'Supplier' : category === 'rent' ? 'Landlord / agent' : 'Paid to'

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
    if (existing) return nav('/expenses')
    // Both buttons stay here for the next one. "Add another" also keeps who was paid,
    // except for food, where each delivery is usually a different supplier.
    const keep: Partial<Expense> = { category, expense_date: date, paid_via: paidVia }
    if (addAnother) Object.assign(keep, category === 'labour' ? { staff_id: staffId || null } : category === 'food' ? {} : { supplier_id: supplierId || null })
    onAdded(keep, `${aud(amountNum)} ${CAT_LABEL[category].toLowerCase()} saved.`)
  }

  return (
    <form className="card min-w-0 flex-[999_1_440px] p-4 desk:p-5" onSubmit={(e) => { e.preventDefault(); submit(false) }}>
      <ErrorBox error={save.error || remove.error} />

      <span className="text-[13px] font-medium text-ink-2">Category</span>
      <div className="mt-2 grid grid-cols-2 gap-2 desk:grid-cols-3" role="group" aria-label="Category">
        {ENTRY_CATEGORIES.map((c) => {
          const on = category === c
          return (
            <button key={c} type="button" aria-pressed={on} onClick={() => setCategory(c)}
              className="flex min-w-0 items-center gap-2.5 rounded-[10px] border px-3 py-2.5 text-left"
              style={on ? { borderColor: CAT_COLOR[c], background: tint(c), boxShadow: `0 0 0 1px ${CAT_COLOR[c]}` } : { borderColor: 'var(--line)', background: 'var(--surface)' }}>
              <Glyph code={c} size={32} />
              <span className="min-w-0">
                <span className="block text-sm font-semibold">{CAT_LABEL[c]}</span>
                <span className="block truncate text-xs text-muted">{CAT_INFO[c]?.sub}</span>
              </span>
            </button>
          )
        })}
      </div>

      {category === 'food' && (
        <div className="mt-3.5 flex items-start gap-2.5 rounded-[10px] bg-[#F0F9FF] px-3 py-2.5 text-[13px] text-[#026AA2] dark:bg-[#0B2A3F] dark:text-[#7CD4FD]">
          <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="mt-px shrink-0" aria-hidden>
            <circle cx="12" cy="12" r="10" /><path d="M12 16v-4M12 8h.01" />
          </svg>
          <span className="flex-1">
            {ordered.length ? `Buying from ${ordered.join(' or ')}? ` : 'Ordering through Purchase orders? '}
            Receiving the <Link to="/orders" className="font-medium underline">purchase order</Link> records it, so you don't enter it twice.
          </span>
        </div>
      )}

      <div className="mt-5 grid grid-cols-[repeat(auto-fit,minmax(200px,1fr))] gap-4">
        <div className="flex flex-col gap-1.5">
          <label className="text-[13px] font-medium text-ink-2" htmlFor="amount">Amount (AUD)</label>
          <MoneyInput id="amount" value={shownAmount} onChange={(v) => { setAmount(v); setAmountTouched(true); onEdit() }} />
          {category === 'labour' && suggested != null && (
            <p className="text-xs text-muted">
              {parseMoney(hours)} h × {aud(rate!)} = {aud(suggested)}
              {amountTouched && amountNum !== suggested && (
                <button type="button" className="ml-2 font-semibold text-accent" onClick={() => setAmountTouched(false)}>Use this</button>
              )}
            </p>
          )}
        </div>
        {category === 'labour' ? (
          <div className="flex flex-col gap-1.5">
            <label className="text-[13px] font-medium text-ink-2" htmlFor="week">For the week of</label>
            <select id="week" className="field !h-14" value={weekStart(date)} onChange={(e) => edit(setDate)(wageDate(e.target.value))}>
              {weeks.map((w) => (
                <option key={w} value={w}>
                  Week of {fmtShort(w)} – {fmtShort(addDays(w, 6))}{wageWeeks.has(w) ? '' : ' · no wages yet'}
                </option>
              ))}
            </select>
            {wages.data && !wageWeeks.has(weekStart(date)) && <span className="text-xs text-warn-ink">No wages are entered for this week yet.</span>}
          </div>
        ) : (
          <div className="flex flex-col gap-1.5">
            <label className="text-[13px] font-medium text-ink-2" htmlFor="date">Date</label>
            <input id="date" type="date" className="field num !h-14" value={date} onChange={(e) => edit(setDate)(e.target.value)} required />
          </div>
        )}
      </div>

      {category === 'labour' ? (
        <div className="mt-4 grid grid-cols-[1fr_7rem] gap-3">
          <div>
            <label className="label" htmlFor="staff">Paid to</label>
            <select id="staff" className="field" value={staffId} onChange={(e) => edit(setStaffId)(e.target.value)}>
              <option value="">All staff / not recorded</option>
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
            <input id="hours" className="field" inputMode="decimal" value={hours} onChange={(e) => edit(setHours)(e.target.value)} placeholder="0" />
          </div>
        </div>
      ) : (
        <div className="mt-4">
          <label className="label" htmlFor="supplier">{payeeLabel} {category !== 'food' && <span className="font-normal text-faint">(optional)</span>}</label>
          <select id="supplier" className="field" value={supplierId} onChange={(e) => edit(setSupplierId)(e.target.value)} required={category === 'food'}>
            <option value="">{category === 'food' ? 'Choose a supplier' : '— None —'}</option>
            {supplierList.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
          </select>
        </div>
      )}

      <div className="mt-4">
        <span className="label">Paid via</span>
        <Segmented ariaLabel="Paid via" value={paidVia} onChange={edit(setPaidVia)} options={PAID_VIA} />
      </div>

      <div className="mt-4">
        <label className="label" htmlFor="note">Note <span className="font-normal text-faint">(optional)</span></label>
        <input id="note" className="field" value={note} onChange={(e) => edit(setNote)(e.target.value)} placeholder="Invoice #, what it was for" />
      </div>

      {existing ? (
        <div className="mt-5 flex flex-wrap items-center gap-2">
          <DeleteButton busy={remove.isPending} onConfirm={async () => { await remove.mutateAsync(existing.id); nav('/expenses') }} label="Delete expense" />
          <button className="btn btn-primary ml-auto h-11 min-w-40" disabled={!valid || save.isPending}>{save.isPending ? 'Saving…' : 'Save changes'}</button>
        </div>
      ) : (
        <div className="mt-5 flex flex-wrap gap-2">
          <button type="button" className="btn h-11 min-w-[150px] flex-1" disabled={!valid || save.isPending} onClick={() => submit(true)}>Save and add another</button>
          <button className="btn btn-primary h-11 min-w-[150px] flex-1" disabled={!valid || save.isPending}>
            {save.isPending ? 'Saving…' : amountNum > 0 ? `Save ${aud(amountNum)}` : 'Save'}
          </button>
        </div>
      )}
    </form>
  )
}

/** This week's spend by category, and the latest entries, received orders included. */
function Sidebar() {
  const today = todayStr()
  const week = useAllExpenses(weekStart(today), today)
  const recent = useExpenses({ from: addDays(today, -60), to: today })
  const suppliers = useSuppliers()
  const staff = useStaffNames()
  const name = new Map([...(suppliers.data ?? []), ...(staff.data ?? [])].map((s) => [s.id, s.name]))
  const rows = (week.data ?? []).filter((e) => e.category !== 'setup')
  const total = cents(rows.reduce((s, e) => s + e.amount, 0))
  const mix = ENTRY_CATEGORIES.map((c) => ({ c, v: rows.filter((e) => e.category === c).reduce((s, e) => s + e.amount, 0) })).filter((m) => m.v > 0)

  return (
    <aside className="card min-w-0 flex-[1_1_280px] overflow-hidden">
      <div className="px-4 pb-2.5 pt-4">
        <div className="text-[13px] font-medium text-muted">This week's expenses</div>
        <div className="num mt-1 text-[28px] font-semibold tracking-[-0.02em]">{aud(total)}</div>
        <div className="mt-2.5 flex h-1.5 overflow-hidden rounded-[3px] bg-surface-2">
          {mix.map((m) => <span key={m.c} className="h-1.5" style={{ width: `${(m.v / total) * 100}%`, background: CAT_COLOR[m.c] }} title={`${CAT_LABEL[m.c]}: ${aud(m.v)}`} />)}
        </div>
      </div>
      <div className="border-t border-line-2 px-4 pb-1 pt-2.5 text-[11px] font-medium uppercase tracking-[0.04em] text-faint">Recent</div>
      {recent.isLoading ? <Loading /> : (recent.data ?? []).slice(0, 6).map((e) => (
        <Link key={e.id} to={`/expenses/${e.id}`} className="flex items-center gap-2.5 border-t border-line-2 px-4 py-2.5 hover:bg-hover">
          <Glyph code={e.category} size={30} />
          <div className="min-w-0 flex-1">
            <div className="truncate text-[13px] font-medium">{name.get(e.supplier_id ?? e.staff_id ?? '') ?? e.note ?? CAT_LABEL[e.category]}</div>
            <div className="text-xs text-muted">{fRecent.format(toDate(e.expense_date))} · {viaLabel(e.paid_via)}</div>
          </div>
          <span className="num text-[13px] font-semibold">{aud(e.amount)}</span>
        </Link>
      ))}
      {recent.data?.length === 0 && <p className="border-t border-line-2 px-4 py-4 text-[13px] text-muted">Nothing entered in the last two months.</p>}
    </aside>
  )
}
