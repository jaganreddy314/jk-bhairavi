import { useEffect, useMemo, useState } from 'react'
import { useWholesalePrices, useWholesaleProducts } from '../lib/api'
import { useBusinessId } from '../lib/business'
import { fmtShort } from '../lib/dates'
import { aud, cents } from '../lib/format'
import type { WholesaleCategory, WholesalePrice, WholesaleProduct } from '../lib/types'
import {
  CATEGORIES, orderStep, orderText, plan, qtyLabel, unitPrices, type PlanLine, type SupplierOrder, type WantedItem,
} from '../lib/wholesale'
import { Empty, ErrorBox, Loading, PageHeader, Pill, SearchBox, Segmented } from '../components/ui'
import { Stepper } from '../components/wholesale'

const OFF_KEY = 'wholesale-off'
const listKey = (biz: string) => `wholesale-list:${biz}`

function load<T>(key: string, fallback: T): T {
  try { return (JSON.parse(localStorage.getItem(key) ?? 'null') as T | null) ?? fallback } catch { return fallback }
}
function keep(key: string, value: unknown) {
  try { localStorage.setItem(key, JSON.stringify(value)) } catch { /* storage unavailable */ }
}

/** Words in any order, or a barcode scanned into the search box. */
function matches(p: WholesaleProduct, q: string) {
  const words = q.toLowerCase().split(/\s+/).filter(Boolean)
  if (!words.length) return true
  if (/^\d{8,}$/.test(q.trim())) return p.gtins.some((g) => g.endsWith(q.trim()) || q.trim().endsWith(g))
  const name = `${p.name} ${p.size ?? ''}`.toLowerCase()
  return words.every((w) => name.includes(w))
}

const SHOWN = 60

/**
 * Tobacco prices from every wholesaler, side by side. Pick what the store needs and the
 * list splits itself by whichever wholesaler is cheapest for each product.
 */
export default function TobaccoPrices() {
  const biz = useBusinessId()
  // Each store keeps its own list: a fresh page per store, so one's list never lands in another's.
  return <PricesPage key={biz} biz={biz} />
}

function PricesPage({ biz }: { biz: string }) {
  const products = useWholesaleProducts()
  const prices = useWholesalePrices()
  const [q, setQ] = useState('')
  const [cat, setCat] = useState<WholesaleCategory | 'all'>('all')
  const [list, setList] = useState<WantedItem[]>(() => load(listKey(biz), []))
  const [off, setOff] = useState<string[]>(() => load(OFF_KEY, []))

  useEffect(() => { keep(listKey(biz), list) }, [biz, list])
  useEffect(() => { keep(OFF_KEY, off) }, [off])

  const byId = useMemo(() => new Map((products.data ?? []).map((p) => [p.id, p])), [products.data])
  const byProduct = useMemo(() => {
    const m = new Map<string, WholesalePrice[]>()
    for (const p of prices.data ?? []) m.set(p.product_id, [...(m.get(p.product_id) ?? []), p])
    return m
  }, [prices.data])
  const wholesalers = useMemo(() => {
    const m = new Map<string, { id: string; name: string; from: string; to: string | null }>()
    for (const p of prices.data ?? []) m.set(p.wholesaler_id, { id: p.wholesaler_id, name: p.wholesaler, from: p.price_list_from, to: p.price_list_to })
    return [...m.values()].sort((a, b) => a.name.localeCompare(b.name))
  }, [prices.data])

  if (products.isLoading || prices.isLoading) return <Loading />

  const allowed = (id: string) => !off.includes(id)
  const priced = (id: string) => (byProduct.get(id) ?? []).filter((p) => allowed(p.wholesaler_id))
  const qtyOf = (id: string) => list.find((i) => i.productId === id)?.qty ?? 0
  const setQty = (id: string, qty: number) =>
    setList((l) => qty <= 0 ? l.filter((i) => i.productId !== id)
      : l.some((i) => i.productId === id) ? l.map((i) => (i.productId === id ? { ...i, qty } : i)) : [...l, { productId: id, qty }])

  const found = (products.data ?? []).filter((p) => (cat === 'all' || p.category === cat) && matches(p, q))
  const result = plan(list, byId, byProduct, allowed)

  return (
    <div>
      <PageHeader
        title="Tobacco prices"
        subtitle="Every wholesaler's price per pack, inc GST. Add what you need and the order splits itself by whoever is cheapest."
      />
      <ErrorBox error={products.error ?? prices.error} />

      <div className="mb-4 flex flex-wrap items-center gap-2">
        <span className="text-[13px] text-muted">Compare</span>
        {wholesalers.map((w) => (
          <button key={w.id} type="button" className="chip" aria-pressed={allowed(w.id)}
            title={`Prices from ${fmtShort(w.from)}${w.to ? ` to ${fmtShort(w.to)}` : ''}`}
            onClick={() => setOff((o) => (o.includes(w.id) ? o.filter((x) => x !== w.id) : [...o, w.id]))}>
            {w.name} <span className="text-faint">· {fmtShort(w.from)}</span>
          </button>
        ))}
      </div>

      <div className="grid items-start gap-4 desk:grid-cols-[minmax(0,1fr)_minmax(0,1fr)]">
        <section className="card overflow-hidden">
          <div className="flex flex-col gap-3 border-b border-line px-3.5 py-3 desk:px-5">
            <SearchBox value={q} onChange={setQ} placeholder="Search or scan a barcode" />
            <Segmented ariaLabel="Category" value={cat} onChange={setCat}
              options={[{ value: 'all', label: 'All' }, ...CATEGORIES]} />
          </div>
          {!found.length ? (
            <p className="px-5 py-8 text-center text-sm text-muted">Nothing matches “{q}”.</p>
          ) : (
            <ul className="divide-y divide-line-2">
              {found.slice(0, SHOWN).map((p) => (
                <ProductRow key={p.id} product={p} prices={priced(p.id)} qty={qtyOf(p.id)} onQty={(n) => setQty(p.id, n)} />
              ))}
            </ul>
          )}
          {found.length > SHOWN && (
            <p className="border-t border-line px-5 py-3 text-xs text-muted">
              Showing {SHOWN} of {found.length}. Type more of the name to narrow it down.
            </p>
          )}
        </section>

        <OrderPanel
          result={result}
          qtyOf={qtyOf}
          setQty={setQty}
          pricesFor={priced}
          onClear={() => setList([])}
        />
      </div>
    </div>
  )
}

function ProductRow({ product, prices, qty, onQty }: {
  product: WholesaleProduct; prices: WholesalePrice[]; qty: number; onQty: (n: number) => void
}) {
  const per = unitPrices(prices)
  const step = orderStep(product, prices)
  return (
    <li className="flex flex-wrap items-center gap-x-3 gap-y-2 px-3.5 py-3 desk:px-5">
      <div className="min-w-0 flex-1">
        <div className="truncate text-sm font-medium">
          {product.name}
          {product.size && <span className="ml-1.5 font-normal text-muted">{product.size}</span>}
        </div>
        <div className="mt-1 flex flex-wrap gap-x-3 gap-y-0.5 text-xs text-muted">
          {per.length ? per.map((p, i) => (
            <span key={p.id} className={i === 0 && per.length > 1 ? 'font-semibold text-good' : ''}>
              {p.wholesaler.split(' ')[0]} <span className="num">{aud(p.unit_price_inc_gst)}</span>
            </span>
          )) : <span>No price from the wholesalers you compare</span>}
          {per.length > 0 && <span className="text-faint">per {product.unit}</span>}
        </div>
      </div>
      {qty > 0 ? <Stepper product={product} qty={qty} step={step} onQty={onQty} />
        : <button type="button" className="btn btn-sm" disabled={!per.length} onClick={() => onQty(step)}>Add</button>}
    </li>
  )
}

function OrderPanel({ result, qtyOf, setQty, pricesFor, onClear }: {
  result: ReturnType<typeof plan>; qtyOf: (id: string) => number; setQty: (id: string, n: number) => void
  pricesFor: (id: string) => WholesalePrice[]; onClear: () => void
}) {
  if (!result.orders.length && !result.missing.length)
    return <Empty>Add products from the list and they'll be grouped here by the wholesaler that's cheapest for each one.</Empty>

  const best = result.single[0]
  const saving = best ? cents(best.total - result.total) : 0
  const vsNext = cents(result.nextTotal - result.total)
  return (
    <div className="grid gap-4">
      <section className="card p-3.5 desk:p-5">
        <div className="flex flex-wrap items-baseline justify-between gap-2">
          <div>
            <div className="text-[13px] font-medium text-muted">Cheapest split, inc GST</div>
            <div className="num mt-1 text-2xl font-semibold tracking-[-0.02em]">{aud(result.total)}</div>
          </div>
          <button type="button" className="btn btn-sm" onClick={onClear}>Clear list</button>
        </div>
        <p className="mt-2 text-[13px] text-ink-2">
          {best && saving > 0 && <>Saves <strong className="num text-good">{aud(saving)}</strong> on buying it all from {best.wholesaler} ({aud(best.total)}).</>}
          {best && saving <= 0 && <>{best.wholesaler} is cheapest for everything on the list.</>}
          {!best && vsNext > 0 && <>Saves <strong className="num text-good">{aud(vsNext)}</strong> on the next cheapest wholesaler for each product. No one wholesaler sells everything on the list.</>}
        </p>
      </section>

      {result.orders.map((o) => (
        <SupplierCard key={o.wholesalerId} order={o} qtyOf={qtyOf} setQty={setQty} pricesFor={pricesFor} />
      ))}

      {result.missing.length > 0 && (
        <section className="card overflow-hidden">
          <div className="border-b border-line px-3.5 py-3 text-sm font-semibold desk:px-5">Not sold by the wholesalers you compare</div>
          <ul className="divide-y divide-line-2">
            {result.missing.map((p) => (
              <li key={p.id} className="flex items-center gap-3 px-3.5 py-2.5 text-sm desk:px-5">
                <span className="min-w-0 flex-1 truncate">{p.name} {p.size && <span className="text-muted">{p.size}</span>}</span>
                <button type="button" className="btn btn-sm btn-danger" onClick={() => setQty(p.id, 0)}>Remove</button>
              </li>
            ))}
          </ul>
        </section>
      )}
    </div>
  )
}

function SupplierCard({ order, qtyOf, setQty, pricesFor }: {
  order: SupplierOrder; qtyOf: (id: string) => number; setQty: (id: string, n: number) => void; pricesFor: (id: string) => WholesalePrice[]
}) {
  const [copied, setCopied] = useState(false)
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(orderText(order))
      setCopied(true)
      setTimeout(() => setCopied(false), 2000)
    } catch { /* clipboard blocked: nothing to do */ }
  }
  return (
    <section className="card overflow-hidden">
      <div className="flex items-center gap-2 border-b border-line px-3.5 py-3 desk:px-5">
        <h2 className="text-sm font-semibold">{order.wholesaler}</h2>
        <span className="num text-xs text-muted">{order.lines.length} {order.lines.length === 1 ? 'product' : 'products'}</span>
        <span className="num ml-auto text-sm font-semibold">{aud(order.total)}</span>
        <button type="button" className="btn btn-sm" onClick={copy}>{copied ? 'Copied' : 'Copy order'}</button>
      </div>
      <ul className="divide-y divide-line-2">
        {order.lines.map((l) => (
          <OrderLine key={l.key} line={l} qty={qtyOf(l.product.id)} step={orderStep(l.product, pricesFor(l.product.id))}
            onQty={(n) => setQty(l.product.id, n)} />
        ))}
      </ul>
    </section>
  )
}

function OrderLine({ line: l, qty, step, onQty }: { line: PlanLine; qty: number; step: number; onQty: (n: number) => void }) {
  const extra = l.pick.units - l.want
  const saves = l.next ? cents(l.next.cost - l.pick.cost) : 0
  return (
    <li className="flex flex-wrap items-center gap-x-3 gap-y-2 px-3.5 py-3 desk:px-5">
      <div className="min-w-0 flex-1">
        <div className="truncate text-sm font-medium">
          {l.product.name}
          {l.product.size && <span className="ml-1.5 font-normal text-muted">{l.product.size}</span>}
        </div>
        <div className="mt-0.5 flex flex-wrap items-center gap-x-2 gap-y-1 text-xs text-muted">
          <span className="num">{l.pick.lots} × {aud(l.pick.price.price_inc_gst)} = {aud(l.pick.cost)}</span>
          {l.pick.price.supplier_code && <span className="num text-faint">#{l.pick.price.supplier_code}</span>}
          {extra > 0 && <Pill tone="warn">Sold in {l.pick.price.units}s: {qtyLabel(l.product, l.pick.units)}</Pill>}
          {saves > 0 && <span className="text-good">saves {aud(saves)} on {l.next!.price.wholesaler.split(' ')[0]}</span>}
          {l.next && saves === 0 && <span>same as {l.next.price.wholesaler.split(' ')[0]}</span>}
        </div>
      </div>
      <Stepper product={l.product} qty={qty} step={step} onQty={onQty} />
    </li>
  )
}
