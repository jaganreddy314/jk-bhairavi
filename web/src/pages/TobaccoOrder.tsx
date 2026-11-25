import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { Link, useNavigate } from 'react-router-dom'
import {
  useAutoLinkWholesale, useBusinessWholesalers, useCreateWholesaleOrders, useItemWholesaleProducts, useLinkWholesaleItem,
  useSave, useStockGroups, useStockItems, useSuppliers, useWholesalePrices, useWholesaleProducts, type WholesaleOrderLine,
} from '../lib/api'
import { useBusinessId } from '../lib/business'
import { aud, cents, parseMoney } from '../lib/format'
import type { StockItem, Supplier, WholesaleCategory, WholesalePrice, WholesaleProduct } from '../lib/types'
import {
  byPrice, CATEGORIES, options, orderStep, PAGE, planOrder, qtyLabel, unitPrices, UNIT_OF, type OrderLine, type PriceSort, type WholesaleOrder,
} from '../lib/wholesale'
import { Drawer, Empty, ErrorBox, Loading, PageHeader, Pill, SaveBar, SearchBox, Segmented } from '../components/ui'
import { PriceFilters, ShowMore, Stepper } from '../components/wholesale'

/** What's being ordered, kept on this device until the orders are made. */
interface Draft {
  qty: Record<string, number>
  /** Wholesaler picked by hand, per catalogue item. */
  pick: Record<string, string>
}
const draftKey = (biz: string) => `tobacco-order:${biz}`
const TOLERANCE_KEY = 'tobacco-order-tolerance'
/** Catalogue categories worth offering to link, when an item isn't linked yet. */
const SMOKES = /tobacco|cigar|smok|lighter|paper|filter/i

function loadDraft(biz: string): Draft {
  try {
    const raw = JSON.parse(localStorage.getItem(draftKey(biz)) ?? 'null') as Draft | Record<string, number> | null
    if (!raw) return { qty: {}, pick: {} }
    if ('qty' in raw && typeof raw.qty === 'object') return { qty: raw.qty, pick: (raw as Draft).pick ?? {} }
    return { qty: raw as Record<string, number>, pick: {} }  // the first version kept quantities only
  } catch { return { qty: {}, pick: {} } }
}
function loadTolerance() {
  try { const n = Number(localStorage.getItem(TOLERANCE_KEY)); return Number.isFinite(n) && localStorage.getItem(TOLERANCE_KEY) !== null ? n : 0.2 } catch { return 0.2 }
}

const WHY: Record<OrderLine['why'], string> = {
  cheapest: 'Cheapest',
  grouped: 'Kept with this order',
  minimum: 'Moved: a minimum order',
  chosen: 'Your pick',
}

/**
 * Tobacco order: pick what the store needs from its own catalogue, and the app makes one
 * draft purchase order per wholesaler. Each product goes to the cheapest, unless another
 * wholesaler already on the order is within a few cents a pack, or the cheapest's share
 * wouldn't reach its minimum order. Any line can be sent elsewhere by hand.
 */
export default function TobaccoOrder() {
  const biz = useBusinessId()
  return <OrderPage key={biz} biz={biz} />
}

function OrderPage({ biz }: { biz: string }) {
  const nav = useNavigate()
  const items = useStockItems()
  const groups = useStockGroups()
  const links = useItemWholesaleProducts()
  const products = useWholesaleProducts()
  const prices = useWholesalePrices()
  const suppliers = useSuppliers()
  const mapped = useBusinessWholesalers()
  const autoLink = useAutoLinkWholesale()
  const create = useCreateWholesaleOrders()
  const [q, setQ] = useState('')
  const [cat, setCat] = useState<WholesaleCategory | 'all'>('all')
  const [sort, setSort] = useState<PriceSort>('name')
  const [max, setMax] = useState<number | null>(null)
  const [limit, setLimit] = useState(PAGE)
  const [draft, setDraft] = useState<Draft>(() => loadDraft(biz))
  const [tolerance, setTolerance] = useState(loadTolerance)
  const [linking, setLinking] = useState<StockItem | null>(null)

  useEffect(() => { try { localStorage.setItem(draftKey(biz), JSON.stringify(draft)) } catch { /* storage unavailable */ } }, [biz, draft])
  useEffect(() => { try { localStorage.setItem(TOLERANCE_KEY, String(tolerance)) } catch { /* storage unavailable */ } }, [tolerance])

  // New products and new stores link themselves by their Metcash codes and barcodes.
  const linked = useRef(false)
  useEffect(() => {
    if (linked.current || !links.data) return
    linked.current = true
    autoLink.mutate()
  }, [links.data, autoLink])

  const productById = useMemo(() => new Map((products.data ?? []).map((p) => [p.id, p])), [products.data])
  const productOf = useMemo(() => new Map((links.data ?? []).map((l) => [l.item_id, productById.get(l.product_id)])), [links.data, productById])
  const byProduct = useMemo(() => {
    const m = new Map<string, WholesalePrice[]>()
    for (const p of prices.data ?? []) m.set(p.product_id, [...(m.get(p.product_id) ?? []), p])
    return m
  }, [prices.data])

  if (items.isLoading || links.isLoading || products.isLoading || prices.isLoading || suppliers.isLoading || mapped.isLoading) return <Loading />

  /** The store's own supplier for a wholesaler, if it has one. */
  const supplierOf = (wholesalerId: string, name: string): Supplier | undefined => {
    const sid = mapped.data?.find((m) => m.wholesaler_id === wholesalerId)?.supplier_id
    return suppliers.data?.find((s) => s.id === sid) ?? suppliers.data?.find((s) => s.name.toLowerCase() === name.toLowerCase())
  }
  const sellerName = (wholesalerId: string, name: string) => supplierOf(wholesalerId, name)?.name ?? name

  const active = (items.data ?? []).filter((i) => i.active)
  const orderable = active.filter((i) => productOf.get(i.id)).sort((a, b) => a.name.localeCompare(b.name))
  const groupName = new Map((groups.data ?? []).map((g) => [g.id, g.name]))
  const unlinked = active.filter((i) => !productOf.get(i.id) && SMOKES.test(groupName.get(i.group_id ?? '') ?? ''))
  const cats = CATEGORIES.filter((c) => orderable.some((i) => productOf.get(i.id)!.category === c.value))

  const words = q.toLowerCase().split(/\s+/).filter(Boolean)
  const one = cat !== 'all'
  const shown = byPrice(orderable.filter((i) => (!one || productOf.get(i.id)!.category === cat)
    && words.every((w) => i.name.toLowerCase().includes(w) || productOf.get(i.id)!.name.toLowerCase().includes(w))),
  (i) => unitPrices(byProduct.get(productOf.get(i.id)!.id) ?? [])[0]?.unit_price_inc_gst, (i) => i.name, one ? sort : 'name', one ? max : null)

  const setQty = (itemId: string, n: number) => setDraft((d) => {
    const qty = { ...d.qty }
    const pick = { ...d.pick }
    if (n > 0) qty[itemId] = n
    else { delete qty[itemId]; delete pick[itemId] }
    return { qty, pick }
  })
  const setPick = (itemId: string, wholesalerId: string | null) => setDraft((d) => {
    const pick = { ...d.pick }
    if (wholesalerId) pick[itemId] = wholesalerId
    else delete pick[itemId]
    return { ...d, pick }
  })

  const wanted = Object.entries(draft.qty).filter(([id]) => productOf.get(id))
    .map(([id, n]) => ({ key: id, productId: productOf.get(id)!.id, qty: n }))
  const result = planOrder(wanted, productById, byProduct, {
    tolerance,
    minimum: (w) => {
      const name = prices.data?.find((p) => p.wholesaler_id === w)?.wholesaler ?? ''
      return supplierOf(w, name)?.min_order ?? 0
    },
    choice: (key) => draft.pick[key],
  })
  const lineOf = new Map(result.orders.flatMap((o) => o.lines.map((l) => [l.key, l] as const)))
  const itemName = (id: string) => active.find((i) => i.id === id)?.name ?? ''
  const extra = cents(result.total - result.cheapest)

  const submit = () => {
    const lines: WholesaleOrderLine[] = result.orders.flatMap((o) => o.lines.map((l, i) => ({
      wholesaler_id: o.wholesalerId,
      item_id: l.key,
      qty: l.pick.units,
      unit_cost: Math.round((l.pick.cost / l.pick.units) * 10000) / 10000,
      units: l.pick.price.units,
      supplier_code: l.pick.price.supplier_code ?? l.pick.price.gtin,
      sort: (i + 1) * 10,
    })))
    create.mutate(lines, {
      onSuccess: (made) => {
        setDraft({ qty: {}, pick: {} })
        nav(made.length === 1 ? `/orders/${made[0]!.po_id}` : '/orders')
      },
    })
  }

  return (
    <div>
      <PageHeader
        title="Tobacco order"
        subtitle="Pick what you need. Each product goes to the cheapest wholesaler, and you get one draft order per wholesaler."
        action={<Link to="/prices" className="btn">Compare prices</Link>}
      />
      <ErrorBox error={items.error ?? links.error ?? prices.error ?? create.error} />

      <div className="mb-4 flex flex-wrap items-center gap-2 text-[13px] text-ink-2">
        <span>Keep a product with a wholesaler already on the order when it's no more than</span>
        <ToleranceInput value={tolerance} onChange={setTolerance} />
        <span>a pack dearer.</span>
      </div>

      <div className="grid items-start gap-4 desk:grid-cols-[minmax(0,1fr)_minmax(0,1fr)]">
        <section className="card overflow-hidden">
          <div className="flex flex-col gap-3 border-b border-line px-3.5 py-3 desk:px-5">
            <SearchBox value={q} onChange={(v) => { setQ(v); setLimit(PAGE) }} placeholder="Search your products" />
            {cats.length > 1 && (
              <Segmented ariaLabel="Category" value={cat} onChange={(c) => { setCat(c); setMax(null); setLimit(PAGE) }}
                options={[{ value: 'all', label: 'All' }, ...cats]} />
            )}
            {one && <PriceFilters key={cat} sort={sort} onSort={setSort} max={max} onMax={(n) => { setMax(n); setLimit(PAGE) }} unit={UNIT_OF[cat]} />}
          </div>
          {!orderable.length ? (
            <p className="px-5 py-8 text-center text-sm text-muted">
              None of your products are linked to wholesale prices yet. Link them below.
            </p>
          ) : !shown.length ? (
            <p className="px-5 py-8 text-center text-sm text-muted">{max != null && one ? `Nothing at or under ${aud(max)} a ${UNIT_OF[cat]}.` : `Nothing matches “${q}”.`}</p>
          ) : (
            <ul className="divide-y divide-line-2">
              {shown.slice(0, limit).map((i) => (
                <ProductRow key={i.id} item={i} product={productOf.get(i.id)!} prices={byProduct.get(productOf.get(i.id)!.id) ?? []}
                  qty={draft.qty[i.id] ?? 0} line={lineOf.get(i.id)} pick={draft.pick[i.id]} sellerName={sellerName}
                  onQty={(n) => setQty(i.id, n)} onPick={(w) => setPick(i.id, w)} onRelink={() => setLinking(i)} />
              ))}
            </ul>
          )}
          <ShowMore shown={Math.min(limit, shown.length)} total={shown.length} onMore={() => setLimit(limit + PAGE)} onAll={() => setLimit(shown.length)} />
          {unlinked.length > 0 && <Unlinked items={unlinked} onLink={setLinking} />}
        </section>

        <div className="grid gap-4">
          {!result.orders.length ? (
            <Empty>Add products and they'll be split here into one order per wholesaler.</Empty>
          ) : result.orders.map((o) => (
            <SupplierCard key={o.wholesalerId} order={o} supplier={supplierOf(o.wholesalerId, o.wholesaler)}
              itemName={itemName} qtyOf={(id) => draft.qty[id] ?? 0} setQty={setQty} pickOf={(id) => draft.pick[id]}
              setPick={setPick} sellerName={sellerName} pricesFor={(pid) => byProduct.get(pid) ?? []} />
          ))}
        </div>
      </div>

      {result.orders.length > 0 && (
        <SaveBar dirty message={<>
          <span className="num font-semibold">{aud(result.total)}</span> inc GST ·{' '}
          {result.orders.map((o) => sellerName(o.wholesalerId, o.wholesaler)).join(', ')}
          {extra > 0 && <span className="text-muted"> · {aud(extra)} over the cheapest split</span>}
        </>}>
          <button type="button" className="btn btn-sm" onClick={() => setDraft({ qty: {}, pick: {} })}>Clear</button>
          <button type="button" className="btn btn-primary" disabled={create.isPending} onClick={submit}>
            {create.isPending ? 'Creating…' : `Create ${result.orders.length} draft ${result.orders.length === 1 ? 'order' : 'orders'}`}
          </button>
        </SaveBar>
      )}

      {linking && (
        <LinkDrawer item={linking} current={productOf.get(linking.id) ?? null} products={products.data ?? []}
          byProduct={byProduct} onClose={() => setLinking(null)} />
      )}
    </div>
  )
}

/** Dollars a pack, typed as e.g. 0.20; kept as a string while typing. */
function ToleranceInput({ value, onChange }: { value: number; onChange: (n: number) => void }) {
  const [text, setText] = useState(value.toFixed(2))
  return (
    <label className="flex h-8 w-[84px] items-center gap-1 rounded-lg border border-input-line bg-surface px-2 focus-within:border-accent">
      <span className="text-faint">$</span>
      <input inputMode="decimal" aria-label="Most a pack dearer" value={text}
        onChange={(e) => setText(e.target.value)}
        onBlur={() => { const n = Math.max(0, parseMoney(text)); onChange(n); setText(n.toFixed(2)) }}
        className="num min-w-0 flex-1 bg-transparent text-sm font-semibold outline-none" />
    </label>
  )
}

function ProductRow({ item, product, prices, qty, line, pick, sellerName, onQty, onPick, onRelink }: {
  item: StockItem; product: WholesaleProduct; prices: WholesalePrice[]; qty: number; line: OrderLine | undefined; pick: string | undefined
  sellerName: (id: string, name: string) => string; onQty: (n: number) => void; onPick: (w: string | null) => void; onRelink: () => void
}) {
  const [open, setOpen] = useState(false)
  const per = unitPrices(prices)
  const best = per[0]
  const step = orderStep(product, prices)
  const goesTo = line?.pick.price ?? best
  return (
    <li className="px-3.5 py-3 desk:px-5">
      <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
        <div className="min-w-0 flex-1">
          <div className="truncate text-sm font-medium">{item.name}</div>
          <div className="mt-0.5 flex flex-wrap items-center gap-x-2 text-xs text-muted">
            {goesTo ? <span>{sellerName(goesTo.wholesaler_id, goesTo.wholesaler)} · <span className="num">{aud(goesTo.unit_price_inc_gst)}</span> a {product.unit}</span>
              : <span>No current wholesale price</span>}
            {per.length > 1 && (
              <button type="button" className="font-medium text-accent" onClick={() => setOpen(!open)}>
                {open ? 'Hide prices' : `All ${per.length} prices`}
              </button>
            )}
          </div>
        </div>
        {qty > 0 ? <Stepper product={product} qty={qty} step={step} onQty={onQty} />
          : <button type="button" className="btn btn-sm" disabled={!best} onClick={() => onQty(step)}>Add</button>}
      </div>
      {open && (
        <PriceChoices product={product} prices={prices} want={qty || step} current={line?.pick.price.wholesaler_id} pick={pick}
          sellerName={sellerName} onPick={(w) => { if (!qty) onQty(step); onPick(w) }}>
          <button type="button" className="text-faint underline-offset-2 hover:underline" onClick={onRelink}>
            Linked to {product.name}{product.size ? ` ${product.size}` : ''}
          </button>
        </PriceChoices>
      )}
    </li>
  )
}

/**
 * Every wholesaler's price for one product: per pack, and for the quantity wanted (rounded up to
 * what they sell). Tapping one sends the line there; "Let the app choose" undoes that.
 */
function PriceChoices({ product, prices, want, current, pick, sellerName, onPick, children }: {
  product: WholesaleProduct; prices: WholesalePrice[]; want: number; current: string | undefined; pick: string | undefined
  sellerName: (id: string, name: string) => string; onPick: (w: string | null) => void; children?: ReactNode
}) {
  const opts = options(prices, want)
  const cheapest = opts[0]
  return (
    <div className="mt-2.5 rounded-lg border border-line-2 bg-surface-2 p-1.5">
      <ul>
        {opts.map((o) => {
          const on = o.price.wholesaler_id === current
          const diff = cheapest ? cents(o.cost - cheapest.cost) : 0
          return (
            <li key={o.price.id}>
              <button type="button" onClick={() => onPick(o.price.wholesaler_id)} aria-pressed={on}
                className={`flex w-full flex-wrap items-center gap-x-3 gap-y-0.5 rounded-md px-2 py-1.5 text-left text-[13px] hover:bg-hover ${on ? 'bg-surface shadow-[var(--shadow-card)]' : ''}`}>
                <span className={`min-w-0 flex-1 truncate ${on ? 'font-semibold' : ''}`}>
                  {sellerName(o.price.wholesaler_id, o.price.wholesaler)}
                  {on && pick === o.price.wholesaler_id && <span className="ml-1.5 text-xs font-normal text-muted">your pick</span>}
                </span>
                <span className="num text-xs text-muted">{aud(o.price.unit_price_inc_gst)} a {product.unit}</span>
                <span className="num w-[86px] text-right">{aud(o.cost)}</span>
                <span className={`num w-[64px] text-right text-xs ${diff > 0 ? 'text-muted' : 'font-semibold text-good'}`}>
                  {diff > 0 ? `+${aud(diff)}` : 'cheapest'}
                </span>
                {o.units > want && <span className="w-full text-xs text-muted">Sold in {o.price.units}s: {qtyLabel(product, o.units)}</span>}
              </button>
            </li>
          )
        })}
      </ul>
      <div className="flex flex-wrap items-center gap-x-3 px-2 pb-1 pt-1.5 text-xs">
        {pick && <button type="button" className="font-medium text-accent" onClick={() => onPick(null)}>Let the app choose</button>}
        <span className="ml-auto">{children}</span>
      </div>
    </div>
  )
}

function SupplierCard({ order, supplier, itemName, qtyOf, setQty, pickOf, setPick, sellerName, pricesFor }: {
  order: WholesaleOrder; supplier: Supplier | undefined; itemName: (id: string) => string
  qtyOf: (id: string) => number; setQty: (id: string, n: number) => void
  pickOf: (id: string) => string | undefined; setPick: (id: string, w: string | null) => void
  sellerName: (id: string, name: string) => string; pricesFor: (productId: string) => WholesalePrice[]
}) {
  const [open, setOpen] = useState<string | null>(null)
  const name = supplier?.name ?? order.wholesaler
  const short = order.minimum > 0 && order.total < order.minimum
  return (
    <section className="card overflow-hidden">
      <div className="flex flex-wrap items-center gap-x-2 gap-y-1.5 border-b border-line px-3.5 py-3 desk:px-5">
        <h2 className="text-sm font-semibold">{name}</h2>
        {name !== order.wholesaler && <span className="text-xs text-muted">{order.wholesaler} prices</span>}
        {!supplier && <span className="text-xs text-muted">· added as a new supplier</span>}
        <span className="num ml-auto text-sm font-semibold">{aud(order.total)}</span>
        <div className="flex w-full flex-wrap items-center gap-2 text-xs text-muted">
          {supplier ? <MinOrder supplier={supplier} /> : <span>Minimum order can be set once the supplier exists.</span>}
          {short && <Pill tone="warn">{aud(cents(order.minimum - order.total))} under the minimum</Pill>}
        </div>
      </div>
      <ul className="divide-y divide-line-2">
        {order.lines.map((l) => (
          <li key={l.key} className="px-3.5 py-2.5 desk:px-5">
            <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
              <div className="min-w-0 flex-1">
                <div className="truncate text-sm">{itemName(l.key)}</div>
                <div className="mt-0.5 flex flex-wrap items-center gap-x-2 gap-y-1 text-xs text-muted">
                  <span className="num">{l.pick.lots} × {aud(l.pick.price.price_inc_gst)} = {aud(l.pick.cost)}</span>
                  {l.why !== 'cheapest' && <span className={l.why === 'chosen' ? 'text-accent' : ''}>{WHY[l.why]}{l.extra > 0 && ` (+${aud(l.extra)})`}</span>}
                  {l.pick.units > l.want && <span className="text-[color:var(--warn-ink)]">sold in {l.pick.price.units}s, buys {qtyLabel(l.product, l.pick.units)}</span>}
                  {l.options.length > 1 && (
                    <button type="button" className="font-medium text-accent" onClick={() => setOpen(open === l.key ? null : l.key)}>
                      {open === l.key ? 'Hide prices' : 'Other prices'}
                    </button>
                  )}
                </div>
              </div>
              <Stepper product={l.product} qty={qtyOf(l.key)} step={orderStep(l.product, pricesFor(l.product.id))} onQty={(n) => setQty(l.key, n)} />
            </div>
            {open === l.key && (
              <PriceChoices product={l.product} prices={pricesFor(l.product.id)} want={l.want} current={l.pick.price.wholesaler_id}
                pick={pickOf(l.key)} sellerName={sellerName} onPick={(w) => setPick(l.key, w)} />
            )}
          </li>
        ))}
      </ul>
    </section>
  )
}

/** The supplier's minimum order, saved on the supplier so every order uses it. */
function MinOrder({ supplier }: { supplier: Supplier }) {
  const save = useSave('suppliers')
  const [text, setText] = useState(supplier.min_order ? String(supplier.min_order) : '')
  const commit = () => {
    const n = text.trim() ? Math.max(0, parseMoney(text)) : null
    if (n !== (supplier.min_order ?? null)) save.mutate({ id: supplier.id, min_order: n || null })
  }
  return (
    <label className="flex items-center gap-1.5">
      Minimum order
      <span className="flex h-7 w-[92px] items-center gap-1 rounded-md border border-input-line bg-surface px-1.5 focus-within:border-accent">
        <span className="text-faint">$</span>
        <input inputMode="decimal" placeholder="none" value={text} onChange={(e) => setText(e.target.value)} onBlur={commit}
          onKeyDown={(e) => { if (e.key === 'Enter') (e.target as HTMLInputElement).blur() }}
          className="num min-w-0 flex-1 bg-transparent text-[13px] font-medium text-ink outline-none" />
      </span>
      {save.isError && <span className="text-bad">Not saved</span>}
    </label>
  )
}

function Unlinked({ items, onLink }: { items: StockItem[]; onLink: (i: StockItem) => void }) {
  const [open, setOpen] = useState(false)
  return (
    <div className="border-t border-line">
      <button type="button" className="flex w-full items-center gap-2 px-3.5 py-3 text-left text-[13px] text-ink-2 desk:px-5" onClick={() => setOpen(!open)}>
        <span className="font-medium">{items.length} {items.length === 1 ? 'product isn’t' : 'products aren’t'} linked to a wholesale price</span>
        <span className="ml-auto text-xs text-accent">{open ? 'Hide' : 'Show'}</span>
      </button>
      {open && (
        <ul className="divide-y divide-line-2 border-t border-line-2">
          {[...items].sort((a, b) => a.name.localeCompare(b.name)).map((i) => (
            <li key={i.id} className="flex items-center gap-3 px-3.5 py-2.5 desk:px-5">
              <span className="min-w-0 flex-1 truncate text-sm">{i.name}</span>
              <button type="button" className="btn btn-sm" onClick={() => onLink(i)}>Link</button>
            </li>
          ))}
        </ul>
      )}
    </div>
  )
}

/** Say which wholesale product a catalogue item is, by searching the shared list. */
function LinkDrawer({ item, current, products, byProduct, onClose }: {
  item: StockItem; current: WholesaleProduct | null; products: WholesaleProduct[]; byProduct: Map<string, WholesalePrice[]>; onClose: () => void
}) {
  const link = useLinkWholesaleItem()
  // Start from the item's own name, minus pack sizes, so the likely match is near the top.
  const [q, setQ] = useState(() => item.name.toLowerCase().replace(/\b\d+\w*\b/g, ' ').replace(/\s+/g, ' ').trim().split(' ').slice(0, 2).join(' '))
  const words = q.toLowerCase().split(/\s+/).filter(Boolean)
  const found = products.filter((p) => words.every((w) => `${p.name} ${p.size ?? ''}`.toLowerCase().includes(w))).slice(0, 40)
  const pick = (productId: string | null) => link.mutate({ item_id: item.id, product_id: productId }, { onSuccess: onClose })
  return (
    <Drawer title="Link to a wholesale price" sub={item.name} onClose={onClose}
      footer={<>
        {current && <button type="button" className="btn btn-danger" onClick={() => pick(null)}>Unlink</button>}
        <button type="button" className="btn" onClick={onClose}>Cancel</button>
      </>}>
      <ErrorBox error={link.error} />
      <SearchBox value={q} onChange={setQ} placeholder="Search wholesale products" />
      <ul className="-mx-2 divide-y divide-line-2">
        {found.map((p) => {
          const best = unitPrices(byProduct.get(p.id) ?? [])[0]
          return (
            <li key={p.id}>
              <button type="button" disabled={link.isPending} onClick={() => pick(p.id)}
                className={`flex w-full items-center gap-3 rounded-lg px-2 py-2.5 text-left hover:bg-hover ${current?.id === p.id ? 'bg-accent-tint' : ''}`}>
                <span className="min-w-0 flex-1 truncate text-sm">{p.name}{p.size && <span className="ml-1.5 text-muted">{p.size}</span>}</span>
                {best && <span className="num shrink-0 text-xs text-muted">{aud(best.unit_price_inc_gst)} a {p.unit}</span>}
              </button>
            </li>
          )
        })}
        {!found.length && <li className="px-2 py-6 text-center text-sm text-muted">No wholesale product matches.</li>}
      </ul>
    </Drawer>
  )
}
