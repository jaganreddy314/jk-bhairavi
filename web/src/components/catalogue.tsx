import { useMemo, useState, type ReactNode } from 'react'
import { NavLink } from 'react-router-dom'
import { aud, parseMoney } from '../lib/format'
import { lineTotal, orderTotal } from '../lib/purchasing'
import type { ItemCost, StockGroup, StockItem, Supplier } from '../lib/types'
import { Segmented } from './ui'

/** The heading and tabs shared by the two Food pages. */
export function FoodTabs() {
  return (
    <div className="mb-4">
      <h1 className="mb-2 text-2xl font-bold tracking-tight">Food</h1>
      <nav aria-label="Food" className="flex gap-1.5">
        <NavLink to="/food" end className="chip">Food cost</NavLink>
        <NavLink to="/food/catalogue" className="chip">Catalogue</NavLink>
      </nav>
    </div>
  )
}

/** Items with no section are filed under this key. */
export const NO_SECTION = 'none'
export const sectionKey = (i: StockItem) => i.group_id ?? NO_SECTION

export interface Section { key: string; label: string; items: StockItem[] }

/** Items split by section, in count-sheet order, sorted by name inside. Empty sections are left out. */
export function bySection(items: StockItem[], groups: StockGroup[]): Section[] {
  const sorted = [...items].sort((a, b) => a.name.localeCompare(b.name))
  const out: Section[] = [...groups]
    .sort((a, b) => a.sort - b.sort || a.name.localeCompare(b.name))
    .map((g) => ({ key: g.id, label: g.name, items: sorted.filter((i) => i.group_id === g.id) }))
  const known = new Set(groups.map((g) => g.id))
  out.push({ key: NO_SECTION, label: 'Other items', items: sorted.filter((i) => !i.group_id || !known.has(i.group_id)) })
  return out.filter((s) => s.items.length > 0)
}

/** One chip per category, plus “All”. Scrolls sideways on a phone rather than wrapping into a wall. */
export function CategoryChips({
  sections, value, onChange, total, extra,
}: {
  sections: { key: string; label: string; count: number; marked?: number }[]
  value: string
  onChange: (key: string) => void
  total: number
  extra?: { key: string; label: string; count: number }
}) {
  const chip = (key: string, label: string, count: number, marked = 0) => (
    <button key={key} type="button" className="chip inline-flex shrink-0 items-center gap-1.5" aria-pressed={value === key} onClick={() => onChange(key)}>
      {label}
      <span className="num text-xs opacity-70">{count}</span>
      {marked > 0 && <span className="num rounded-full bg-accent px-1.5 text-[11px] font-semibold text-accent-ink">{marked}</span>}
    </button>
  )
  return (
    <div role="group" aria-label="Category" className="-mx-4 flex gap-1.5 overflow-x-auto px-4 pb-1">
      {chip('all', 'All', total)}
      {sections.map((s) => chip(s.key, s.label, s.count, s.marked))}
      {extra && extra.count > 0 && chip(extra.key, extra.label, extra.count)}
    </div>
  )
}

/** What has been picked so far, by item id. Strings, because they're typed. */
export type Picks = Record<string, { qty: string; cost: string }>

export const pickedLines = (picks: Picks) =>
  Object.entries(picks)
    .map(([item_id, p]) => ({ item_id, qty: parseMoney(p.qty), unit_cost: parseMoney(p.cost) }))
    .filter((l) => l.qty > 0)

/**
 * Every item, ready to take a quantity — the fast way to fill an order. Starts on the
 * supplier's own items; a chip per section narrows the list, and “Picked” shows what's on so far.
 */
export function ItemPicker({
  supplier, items, groups, costs, exclude, picks, onChange,
}: {
  supplier: Supplier | undefined
  items: StockItem[]
  groups: StockGroup[]
  costs: ItemCost[]
  exclude?: Set<string>
  picks: Picks
  onChange: (p: Picks) => void
}) {
  const active = useMemo(() => items.filter((i) => i.active && !exclude?.has(i.id)), [items, exclude])
  const theirs = active.filter((i) => i.supplier_id === supplier?.id)
  const [scope, setScope] = useState<'theirs' | 'all'>(theirs.length ? 'theirs' : 'all')
  const [cat, setCat] = useState('all')
  const [q, setQ] = useState('')

  const costOf = (i: StockItem) => costs.find((c) => c.item_id === i.id)?.unit_cost || i.unit_cost || 0
  const qtyOf = (id: string) => parseMoney(picks[id]?.qty ?? '')
  const setQty = (i: StockItem, qty: string) =>
    onChange({ ...picks, [i.id]: { qty, cost: picks[i.id]?.cost ?? String(costOf(i) || '') } })
  const setCost = (i: StockItem, cost: string) => onChange({ ...picks, [i.id]: { qty: picks[i.id]?.qty ?? '', cost } })

  const needle = q.trim().toLowerCase()
  const pool = (scope === 'theirs' ? theirs : active).filter((i) => !needle || i.name.toLowerCase().includes(needle))
  const sections = bySection(pool, groups)
  const pickedHere = pool.filter((i) => qtyOf(i.id) > 0)
  // A chip that has been emptied by the search or the scope falls back to “All”.
  const current = cat === 'picked' || sections.some((s) => s.key === cat) ? cat : 'all'
  const shown =
    current === 'all' ? sections
      : current === 'picked' ? bySection(pickedHere, groups)
        : sections.filter((s) => s.key === current)

  return (
    <div>
      <div className="mb-3 flex flex-wrap items-center gap-2">
        {supplier && (
          <Segmented
            ariaLabel="Which items"
            value={scope}
            onChange={setScope}
            options={[
              { value: 'theirs', label: `${supplier.name}’s items (${theirs.length})` },
              { value: 'all', label: `All items (${active.length})` },
            ]}
          />
        )}
        <input type="search" aria-label="Search items" className="field !w-auto min-w-40 flex-1 !py-2" placeholder="Search items…"
          value={q} onChange={(e) => setQ(e.target.value)} />
      </div>
      {supplier && scope === 'theirs' && theirs.length === 0 && (
        <p className="mb-2 text-sm text-muted">Nothing is marked as usually from {supplier.name} yet — switch to all items.</p>
      )}
      {pool.length > 0 && (
        <CategoryChips
          sections={sections.map((s) => ({ key: s.key, label: s.label, count: s.items.length, marked: s.items.filter((i) => qtyOf(i.id) > 0).length }))}
          value={current}
          onChange={setCat}
          total={pool.length}
          extra={{ key: 'picked', label: 'Picked', count: pickedHere.length }}
        />
      )}

      {pool.length === 0 && (needle || scope === 'all') && (
        <p className="py-4 text-center text-sm text-muted">{needle ? 'No items match.' : 'No items to add.'}</p>
      )}
      {shown.map((s) => (
        <div key={s.key} className="mt-3">
          {(current === 'all' || current === 'picked') && (
            <h3 className="sticky top-14 z-10 -mx-1 bg-surface px-1 py-1 text-xs font-semibold uppercase tracking-wide text-muted">{s.label}</h3>
          )}
          <ul className="divide-y divide-line">
            {s.items.map((i) => {
              const qty = qtyOf(i.id)
              const p = picks[i.id]
              return (
                <li key={i.id} className={`-mx-2 rounded-lg px-2 py-2 ${qty > 0 ? 'bg-accent/8' : ''}`}>
                  <div className="flex items-center gap-3">
                    <div className="min-w-0 flex-1">
                      <div className="truncate font-medium">{i.name}</div>
                      <div className="num text-xs text-muted">
                        {costOf(i) > 0 ? `${aud(costOf(i))} / ${i.unit}` : i.unit}
                        {supplier && i.supplier_id && i.supplier_id !== supplier.id && <span> · usually another supplier</span>}
                      </div>
                    </div>
                    <QtyStepper name={i.name} unit={i.unit} value={p?.qty ?? ''} onChange={(v) => setQty(i, v)} />
                  </div>
                  {qty > 0 && (
                    <div className="mt-1.5 flex items-center justify-end gap-2 text-sm">
                      <span className="text-muted">at</span>
                      <input aria-label={`Price per ${i.unit} of ${i.name}`} className="field num !w-24 !py-1 text-right" inputMode="decimal"
                        placeholder="0.00" value={p?.cost ?? ''} onChange={(e) => setCost(i, e.target.value)} />
                      <span className="text-muted">/ {i.unit}</span>
                      <span className="num w-20 text-right font-semibold">{aud(lineTotal({ qty, unit_cost: parseMoney(p?.cost ?? '') }))}</span>
                    </div>
                  )}
                </li>
              )
            })}
          </ul>
        </div>
      ))}
    </div>
  )
}

/** − [qty] + : one tap per unit, or type a part amount. */
function QtyStepper({ name, unit, value, onChange }: { name: string; unit: string; value: string; onChange: (v: string) => void }) {
  const n = parseMoney(value)
  const step = (d: number) => {
    const next = Math.max(0, Math.round((n + d) * 1000) / 1000)
    onChange(next ? String(next) : '')
  }
  return (
    <span className="flex shrink-0 items-center gap-1">
      <button type="button" className="btn btn-sm !h-9 !w-9 !p-0 text-lg" aria-label={`One less ${name}`} disabled={n <= 0} onClick={() => step(-1)}>−</button>
      <input aria-label={`Quantity of ${name}`} className="field num !w-16 !px-2 !py-1.5 text-center" inputMode="decimal" placeholder="0"
        value={value} onChange={(e) => onChange(e.target.value)} />
      <button type="button" className="btn btn-sm !h-9 !w-9 !p-0 text-lg" aria-label={`One more ${name}`} onClick={() => step(1)}>+</button>
      <span className="w-9 truncate text-xs text-muted">{unit}</span>
    </span>
  )
}

/** Pinned under the list while picking: how many lines, what they come to, and the button. */
export function PickSummary({ picks, children }: { picks: Picks; children: ReactNode }) {
  const lines = pickedLines(picks)
  return (
    <div className="sticky bottom-[calc(4.5rem+env(safe-area-inset-bottom))] z-10 mt-4 flex flex-wrap items-center gap-3 rounded-xl border border-line bg-surface p-3 shadow-lg md:bottom-4">
      <span className="num min-w-0 flex-1 text-sm">
        <b>{lines.length}</b> {lines.length === 1 ? 'item' : 'items'} · <b>{aud(orderTotal(lines))}</b>
      </span>
      {children}
    </div>
  )
}
