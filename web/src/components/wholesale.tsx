import { useState } from 'react'
import { parseMoney } from '../lib/format'
import { PAGE, qtyLabel, type PriceSort } from '../lib/wholesale'
import type { WholesaleProduct } from '../lib/types'
import { Segmented } from './ui'

/** − 2 cartons +: steps by the product's usual lot; stepping below one lot takes it off the list. */
export function Stepper({ product, qty, step, onQty }: { product: WholesaleProduct; qty: number; step: number; onQty: (n: number) => void }) {
  return (
    <div className="flex items-center gap-1">
      <button type="button" className="btn btn-sm w-8 px-0" aria-label="Less" onClick={() => onQty(qty - step)}>−</button>
      <span className="num min-w-[84px] text-center text-[13px] font-medium">{qtyLabel(product, qty)}</span>
      <button type="button" className="btn btn-sm w-8 px-0" aria-label="More" onClick={() => onQty(qty + step)}>+</button>
    </div>
  )
}

/**
 * Sort by price and keep only what's under a price a unit. Only offered inside one category:
 * a pack of cigarettes and a booklet of papers don't compare.
 */
export function PriceFilters({ sort, onSort, max, onMax, unit }: {
  sort: PriceSort; onSort: (s: PriceSort) => void; max: number | null; onMax: (n: number | null) => void; unit: string
}) {
  const [text, setText] = useState(max == null ? '' : String(max))
  return (
    <div className="flex flex-wrap items-center gap-2">
      <Segmented ariaLabel="Sort" value={sort} onChange={onSort}
        options={[{ value: 'name', label: 'A–Z' }, { value: 'low', label: 'Cheapest first' }, { value: 'high', label: 'Dearest first' }]} />
      <label className="flex items-center gap-1.5 text-[13px] text-ink-2">
        Up to
        <span className="flex h-8 w-[84px] items-center gap-1 rounded-lg border border-input-line bg-surface px-2 focus-within:border-accent">
          <span className="text-faint">$</span>
          <input inputMode="decimal" placeholder="any" value={text} aria-label={`Most a ${unit}`}
            onChange={(e) => {
              setText(e.target.value)
              const n = parseMoney(e.target.value)
              onMax(e.target.value.trim() && n > 0 ? n : null)
            }}
            className="num min-w-0 flex-1 bg-transparent text-sm font-semibold outline-none" />
        </span>
        a {unit}
      </label>
    </div>
  )
}

/** "Showing 50 of 221 · Show more · Show all" under a list. */
export function ShowMore({ shown, total, onMore, onAll }: { shown: number; total: number; onMore: () => void; onAll: () => void }) {
  if (shown >= total) return null
  return (
    <div className="flex flex-wrap items-center gap-2 border-t border-line px-3.5 py-3 desk:px-5">
      <span className="text-xs text-muted">Showing {shown} of {total}</span>
      <span className="ml-auto flex gap-2">
        <button type="button" className="btn btn-sm" onClick={onMore}>Show {Math.min(PAGE, total - shown)} more</button>
        <button type="button" className="btn btn-sm" onClick={onAll}>Show all</button>
      </span>
    </div>
  )
}
