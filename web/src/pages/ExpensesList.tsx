import { useState } from 'react'
import { Link } from 'react-router-dom'
import { useEarliestSale, useExpenses, useRemove, useStaff, useSuppliers } from '../lib/api'
import { CAT_LABEL, ENTRY_CATEGORIES, PAID_VIA } from '../lib/categories'
import { fmtDay } from '../lib/dates'
import { aud, cents } from '../lib/format'
import { RangeFilter, useRange } from '../components/RangeFilter'
import { CatDot, DeleteButton, Empty, ErrorBox, Loading, PageHeader } from '../components/ui'

export default function ExpensesList() {
  const earliest = useEarliestSale().data ?? null
  const [range, setRange] = useRange('range:expenses', '4weeks', earliest)
  const [category, setCategory] = useState('')
  const [supplierId, setSupplierId] = useState('')
  const suppliers = useSuppliers().data ?? []
  const staff = useStaff().data ?? []
  const { data, isLoading, error } = useExpenses({ from: range.from, to: range.to, category, supplierId })
  const remove = useRemove('expenses')

  const supplierName = new Map(suppliers.map((s) => [s.id, s.name]))
  const staffName = new Map(staff.map((s) => [s.id, s.name]))
  const rows = data ?? []
  const total = cents(rows.reduce((s, r) => s + r.amount, 0))
  const paidLabel = Object.fromEntries(PAID_VIA.map((p) => [p.value, p.label]))

  return (
    <div>
      <PageHeader
        title="Expenses"
        subtitle={<>One-off expenses. Rent and other repeating costs live in <Link to="/recurring" className="text-accent">Standard expenses</Link>.</>}
        action={<Link to="/expenses/new" className="btn btn-primary">+ Add</Link>}
      />

      <div className="mb-3"><RangeFilter range={range} onChange={setRange} earliest={earliest} /></div>
      <div className="mb-4 flex flex-wrap gap-2">
        <select aria-label="Category" className="field !w-auto !py-1.5 !text-sm" value={category} onChange={(e) => setCategory(e.target.value)}>
          <option value="">All categories</option>
          {ENTRY_CATEGORIES.map((c) => <option key={c} value={c}>{CAT_LABEL[c]}</option>)}
        </select>
        <select aria-label="Supplier" className="field !w-auto !py-1.5 !text-sm" value={supplierId} onChange={(e) => setSupplierId(e.target.value)}>
          <option value="">All suppliers</option>
          {suppliers.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
        </select>
      </div>

      <ErrorBox error={error || remove.error} />
      {isLoading ? <Loading /> : rows.length === 0 ? (
        <Empty>No expenses in this range.</Empty>
      ) : (
        <div className="card overflow-hidden">
          <div className="flex items-baseline justify-between border-b border-line px-4 py-3">
            <span className="text-sm text-ink-2">{rows.length} item{rows.length > 1 ? 's' : ''}</span>
            <span className="num font-bold">{aud(total)}</span>
          </div>
          <ul className="divide-y divide-line">
            {rows.map((r) => {
              const who = r.category === 'labour' ? staffName.get(r.staff_id ?? '') : supplierName.get(r.supplier_id ?? '')
              return (
                <li key={r.id} className="flex flex-wrap items-center gap-x-3 gap-y-1 px-4 py-3">
                  <CatDot code={r.category} />
                  <div className="min-w-0 flex-1">
                    <div className="flex items-baseline gap-2">
                      <span className="font-semibold">{who ?? CAT_LABEL[r.category]}</span>
                      {who && <span className="text-xs text-muted">{CAT_LABEL[r.category]}</span>}
                    </div>
                    <div className="truncate text-xs text-muted">
                      {fmtDay(r.expense_date)} · {paidLabel[r.paid_via]}
                      {r.hours ? ` · ${r.hours} h` : ''}
                      {r.note ? ` · ${r.note}` : ''}
                    </div>
                  </div>
                  <span className="num font-semibold">{aud(r.amount)}</span>
                  <span className="flex gap-1">
                    <Link to={`/expenses/${r.id}`} className="btn btn-sm">Edit</Link>
                    <DeleteButton busy={remove.isPending} onConfirm={() => remove.mutate(r.id)} />
                  </span>
                </li>
              )
            })}
          </ul>
        </div>
      )}
    </div>
  )
}
