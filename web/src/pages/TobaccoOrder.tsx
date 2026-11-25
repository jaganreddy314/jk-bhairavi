import { useEffect, useMemo, useRef, useState } from 'react'
import { Link, useNavigate } from 'react-router-dom'
import {
  useAutoLinkWholesale, useBusinessWholesalers, useCreateWholesaleOrders, useItemWholesaleProducts, useLinkWholesaleItem,
  useStockGroups, useStockItems, useSuppliers, useWholesalePrices, useWholesaleProducts, type WholesaleOrderLine,
} from '../lib/api'
import { useBusinessId } from '../lib/business'
import { aud } from '../lib/format'
import type { StockItem, WholesalePrice, WholesaleProduct } from '../lib/types'
import { CATEGORIES, orderStep, plan, qtyLabel, unitPrices, type SupplierOrder } from '../lib/wholesale'
import { Drawer, Empty, ErrorBox, Loading, PageHeader, SaveBar, SearchBox, Segmented } from '../components/ui'
import { Stepper } from '../components/wholesale'

const qtyKey = (biz: string) => `tobacco-order:${biz}`
/** Catalogue categories worth offering to link, when an item isn't linked yet. */
const SMOKES = /tobacco|cigar|smok|lighter|paper|filter/i

function load(key: string): Record<string, number> {
  try { return (JSON.parse(localStorage.getItem(key) ?? 'null') as Record<string, number> | null) ?? {} } catch { return {} }
}

/**
 * Tobacco order: pick what the store needs from its own catalogue, and the app makes one
 * draft purchase order per wholesaler, each product from whoever is cheapest right now.
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
  const [cat, setCat] = useState<string>('all')
  const [qty, setQtys] = useState<Record<string, number>>(() => load(qtyKey(biz)))
  const [linking, setLinking] = useState<StockItem | null>(null)

  useEffect(() => { try { localStorage.setItem(qtyKey(biz), JSON.stringify(qty)) } catch { /* storage unavailable */ } }, [biz, qty])

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

  const supplierName = (id: string) => suppliers.data?.find((s) => s.id === id)?.name
  /** What the store calls a wholesaler: its own supplier name when it has one. */
  const sellerName = (wholesalerId: string, fallback: string) => {
    const sid = mapped.data?.find((m) => m.wholesaler_id === wholesalerId)?.supplier_id
    return (sid && supplierName(sid)) || suppliers.data?.find((s) => s.name.toLowerCase() === fallback.toLowerCase())?.name || fallback
  }
  const isNewSupplier = (wholesalerId: string, name: string) =>
    !mapped.data?.some((m) => m.wholesaler_id === wholesalerId) && !suppliers.data?.some((s) => s.name.toLowerCase() === name.toLowerCase())

  const active = (items.data ?? []).filter((i) => i.active)
  const orderable = active.filter((i) => productOf.get(i.id)).sort((a, b) => a.name.localeCompare(b.name))
  const groupName = new Map((groups.data ?? []).map((g) => [g.id, g.name]))
  const unlinked = active.filter((i) => !productOf.get(i.id) && SMOKES.test(groupName.get(i.group_id ?? '') ?? ''))
  const cats = CATEGORIES.filter((c) => orderable.some((i) => productOf.get(i.id)!.category === c.value))

  const words = q.toLowerCase().split(/\s+/).filter(Boolean)
  const shown = orderable.filter((i) => (cat === 'all' || productOf.get(i.id)!.category === cat)
    && words.every((w) => i.name.toLowerCase().includes(w) || productOf.get(i.id)!.name.toLowerCase().includes(w)))

  const setQty = (itemId: string, n: number) => setQtys((m) => {
    const next = { ...m }
    if (n > 0) next[itemId] = n
    else delete next[itemId]
    return next
  })

  const wanted = Object.entries(qty).filter(([id]) => productOf.get(id))
    .map(([id, n]) => ({ key: id, productId: productOf.get(id)!.id, qty: n }))
  const result = plan(wanted, productById, byProduct, () => true)
  const itemName = (id: string) => active.find((i) => i.id === id)?.name ?? ''

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
        setQtys({})
        nav(made.length === 1 ? `/orders/${made[0]!.po_id}` : '/orders')
      },
    })
  }

  return (
    <div>
      <PageHeader
        title="Tobacco order"
        subtitle="Pick what you need. Each product goes to the wholesaler with the lowest price, and you get one draft order per wholesaler."
        action={<Link to="/prices" className="btn">Compare prices</Link>}
      />
      <ErrorBox error={items.error ?? links.error ?? prices.error ?? create.error} />

      <div className="grid items-start gap-4 desk:grid-cols-[minmax(0,1fr)_minmax(0,1fr)]">
        <section className="card overflow-hidden">
          <div className="flex flex-col gap-3 border-b border-line px-3.5 py-3 desk:px-5">
            <SearchBox value={q} onChange={setQ} placeholder="Search your products" />
            {cats.length > 1 && (
              <Segmented ariaLabel="Category" value={cat} onChange={setCat} options={[{ value: 'all', label: 'All' }, ...cats]} />
            )}
          </div>
          {!orderable.length ? (
            <p className="px-5 py-8 text-center text-sm text-muted">
              None of your products are linked to wholesale prices yet. Link them below.
            </p>
          ) : !shown.length ? (
            <p className="px-5 py-8 text-center text-sm text-muted">Nothing matches “{q}”.</p>
          ) : (
            <ul className="divide-y divide-line-2">
              {shown.map((i) => {
                const product = productOf.get(i.id)!
                const ps = byProduct.get(product.id) ?? []
                const best = unitPrices(ps)[0]
                const n = qty[i.id] ?? 0
                const step = orderStep(product, ps)
                return (
                  <li key={i.id} className="flex flex-wrap items-center gap-x-3 gap-y-2 px-3.5 py-3 desk:px-5">
                    <div className="min-w-0 flex-1">
                      <div className="truncate text-sm font-medium">{i.name}</div>
                      <div className="mt-0.5 truncate text-xs text-muted">
                        {best ? <>{sellerName(best.wholesaler_id, best.wholesaler)} · <span className="num">{aud(best.unit_price_inc_gst)}</span> a {product.unit}</>
                          : 'No current wholesale price'}
                        <button type="button" className="ml-2 text-faint underline-offset-2 hover:underline" onClick={() => setLinking(i)}>
                          {product.name}{product.size ? ` ${product.size}` : ''}
                        </button>
                      </div>
                    </div>
                    {n > 0 ? <Stepper product={product} qty={n} step={step} onQty={(v) => setQty(i.id, v)} />
                      : <button type="button" className="btn btn-sm" disabled={!best} onClick={() => setQty(i.id, step)}>Add</button>}
                  </li>
                )
              })}
            </ul>
          )}
          {unlinked.length > 0 && <Unlinked items={unlinked} onLink={setLinking} />}
        </section>

        <div className="grid gap-4">
          {!result.orders.length ? (
            <Empty>Add products and they'll be split here into one order per wholesaler.</Empty>
          ) : result.orders.map((o) => (
            <SupplierCard key={o.wholesalerId} order={o} name={sellerName(o.wholesalerId, o.wholesaler)}
              isNew={isNewSupplier(o.wholesalerId, o.wholesaler)} itemName={itemName}
              qtyOf={(id) => qty[id] ?? 0} setQty={setQty} pricesFor={(pid) => byProduct.get(pid) ?? []} />
          ))}
        </div>
      </div>

      {result.orders.length > 0 && (
        <SaveBar dirty message={<>
          <span className="num font-semibold">{aud(result.total)}</span> inc GST ·{' '}
          {result.orders.map((o) => sellerName(o.wholesalerId, o.wholesaler)).join(', ')}
        </>}>
          <button type="button" className="btn btn-sm" onClick={() => setQtys({})}>Clear</button>
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

function SupplierCard({ order, name, isNew, itemName, qtyOf, setQty, pricesFor }: {
  order: SupplierOrder; name: string; isNew: boolean; itemName: (id: string) => string
  qtyOf: (id: string) => number; setQty: (id: string, n: number) => void; pricesFor: (productId: string) => WholesalePrice[]
}) {
  return (
    <section className="card overflow-hidden">
      <div className="flex flex-wrap items-center gap-x-2 gap-y-1 border-b border-line px-3.5 py-3 desk:px-5">
        <h2 className="text-sm font-semibold">{name}</h2>
        {name !== order.wholesaler && <span className="text-xs text-muted">{order.wholesaler} prices</span>}
        {isNew && <span className="text-xs text-muted">· added as a new supplier</span>}
        <span className="num ml-auto text-sm font-semibold">{aud(order.total)}</span>
      </div>
      <ul className="divide-y divide-line-2">
        {order.lines.map((l) => (
          <li key={l.key} className="flex flex-wrap items-center gap-x-3 gap-y-2 px-3.5 py-2.5 desk:px-5">
            <div className="min-w-0 flex-1">
              <div className="truncate text-sm">{itemName(l.key)}</div>
              <div className="num mt-0.5 text-xs text-muted">
                {l.pick.lots} × {aud(l.pick.price.price_inc_gst)} = {aud(l.pick.cost)}
                {l.pick.units > l.want && <span className="text-[color:var(--warn-ink)]"> · sold in {l.pick.price.units}s, buys {qtyLabel(l.product, l.pick.units)}</span>}
              </div>
            </div>
            <Stepper product={l.product} qty={qtyOf(l.key)} step={orderStep(l.product, pricesFor(l.product.id))} onQty={(n) => setQty(l.key, n)} />
          </li>
        ))}
      </ul>
    </section>
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
