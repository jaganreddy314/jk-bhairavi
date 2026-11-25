import { aud, cents } from './format'
import type { WholesaleCategory, WholesalePrice, WholesaleProduct } from './types'

export const CATEGORIES: { value: WholesaleCategory; label: string }[] = [
  { value: 'cigarettes', label: 'Cigarettes' },
  { value: 'tobacco', label: 'Tobacco' },
  { value: 'cigars', label: 'Cigars' },
  { value: 'filters', label: 'Filters' },
  { value: 'papers', label: 'Papers' },
  { value: 'lighters', label: 'Lighters' },
]

/**
 * What a quantity is usually counted in: cigarettes by the carton, tobacco by the outer of five.
 * Everything else by the smallest lot any wholesaler sells.
 */
export function orderStep(product: WholesaleProduct, prices: WholesalePrice[]) {
  if (product.category === 'cigarettes') return 10
  if (product.category === 'tobacco' && product.size === '30g') return 5
  const smallest = Math.min(...prices.map((p) => p.units))
  return Number.isFinite(smallest) ? smallest : 1
}

const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? '' : /(x|ch)$/.test(word) ? 'es' : 's'}`

/** 20 packs of cigarettes → "2 cartons"; 7 pouches → "7 pouches". */
export function qtyLabel(product: WholesaleProduct, units: number) {
  if (product.category === 'cigarettes' && units % 10 === 0) return plural(units / 10, 'carton')
  return plural(units, product.unit)
}

/** One way of buying `want` units from a wholesaler: whole lots of `price.units`, rounded up. */
export interface Option {
  price: WholesalePrice
  lots: number
  units: number
  cost: number
}

const option = (price: WholesalePrice, want: number): Option => {
  const lots = Math.ceil(want / price.units)
  return { price, lots, units: lots * price.units, cost: cents(lots * price.price_inc_gst) }
}

/**
 * Each wholesaler's cheapest way to supply `want` units, cheapest first. A wholesaler that
 * sells both singles and boxes (One's cigars) is offered once, at its better deal.
 * Ties go to the one that leaves fewer spare units, then the lower unit price.
 */
export function options(prices: WholesalePrice[], want: number): Option[] {
  const best = new Map<string, Option>()
  for (const p of prices) {
    const o = option(p, want)
    const cur = best.get(p.wholesaler_id)
    if (!cur || o.cost < cur.cost || (o.cost === cur.cost && o.units < cur.units)) best.set(p.wholesaler_id, o)
  }
  return [...best.values()].sort((a, b) =>
    a.cost - b.cost || a.units - b.units || a.price.unit_price_inc_gst - b.price.unit_price_inc_gst || a.price.wholesaler.localeCompare(b.price.wholesaler))
}

/** Each wholesaler's lowest price per retail unit for a product, cheapest first. */
export function unitPrices(prices: WholesalePrice[]) {
  const best = new Map<string, WholesalePrice>()
  for (const p of prices) {
    const cur = best.get(p.wholesaler_id)
    if (!cur || p.unit_price_inc_gst < cur.unit_price_inc_gst) best.set(p.wholesaler_id, p)
  }
  return [...best.values()].sort((a, b) => a.unit_price_inc_gst - b.unit_price_inc_gst)
}

/** `key` tells apart two lines for the same product (two catalogue items); it defaults to the product. */
export interface WantedItem { productId: string; qty: number; key?: string }

export interface PlanLine {
  key: string
  product: WholesaleProduct
  want: number
  pick: Option
  /** What the next cheapest wholesaler would charge for the same quantity. */
  next: Option | null
}

export interface SupplierOrder { wholesalerId: string; wholesaler: string; lines: PlanLine[]; total: number }

export interface Plan {
  orders: SupplierOrder[]
  total: number
  /** What it would cost from the next cheapest wholesaler, line by line. */
  nextTotal: number
  /** Products none of the chosen wholesalers sell. */
  missing: WholesaleProduct[]
  /** The whole list from one wholesaler, for those that sell everything on it. */
  single: { wholesaler: string; total: number }[]
}

/**
 * Split the list by whichever wholesaler is cheapest for each line. When two charge the
 * same, the line goes to the one already getting more of the order: fewer deliveries.
 */
export function plan(items: WantedItem[], products: Map<string, WholesaleProduct>, byProduct: Map<string, WholesalePrice[]>, allowed: (wholesalerId: string) => boolean): Plan {
  const missing: WholesaleProduct[] = []
  const lines: { key: string; product: WholesaleProduct; want: number; opts: Option[] }[] = []
  for (const it of items) {
    const product = products.get(it.productId)
    if (!product || it.qty <= 0) continue
    const opts = options((byProduct.get(product.id) ?? []).filter((p) => allowed(p.wholesaler_id)), it.qty)
    if (opts.length) lines.push({ key: it.key ?? product.id, product, want: it.qty, opts })
    else missing.push(product)
  }

  const wins = new Map<string, number>()
  for (const l of lines) wins.set(l.opts[0]!.price.wholesaler_id, (wins.get(l.opts[0]!.price.wholesaler_id) ?? 0) + 1)
  const orders = new Map<string, SupplierOrder>()
  let nextTotal = 0
  for (const { key, product, want, opts } of lines) {
    const tied = opts.filter((o) => o.cost === opts[0]!.cost)
    const pick = tied.reduce((a, b) => ((wins.get(b.price.wholesaler_id) ?? 0) > (wins.get(a.price.wholesaler_id) ?? 0) ? b : a))
    const next = opts.find((o) => o !== pick) ?? null
    nextTotal = cents(nextTotal + (next ?? pick).cost)
    const order = orders.get(pick.price.wholesaler_id) ?? { wholesalerId: pick.price.wholesaler_id, wholesaler: pick.price.wholesaler, lines: [], total: 0 }
    order.lines.push({ key, product, want, pick, next })
    order.total = cents(order.total + pick.cost)
    orders.set(pick.price.wholesaler_id, order)
  }

  const singles = new Map<string, { wholesaler: string; total: number; count: number }>()
  for (const l of lines)
    for (const o of l.opts) {
      const s = singles.get(o.price.wholesaler_id) ?? { wholesaler: o.price.wholesaler, total: 0, count: 0 }
      s.total = cents(s.total + o.cost); s.count++
      singles.set(o.price.wholesaler_id, s)
    }

  const list = [...orders.values()].sort((a, b) => b.total - a.total)
  for (const o of list) o.lines.sort((a, b) => a.product.name.localeCompare(b.product.name))
  return {
    orders: list,
    total: cents(list.reduce((s, o) => s + o.total, 0)),
    nextTotal,
    missing,
    single: [...singles.values()].filter((s) => s.count === lines.length && lines.length > 0)
      .map(({ wholesaler, total }) => ({ wholesaler, total })).sort((a, b) => a.total - b.total),
  }
}

/** One wholesaler's share of the order as plain text, with their codes, to paste into an order. */
export function orderText(o: SupplierOrder) {
  const rows = o.lines.map((l) => {
    const code = l.pick.price.supplier_code ?? l.pick.price.gtin
    return `${l.pick.lots} × ${l.pick.price.description}${code ? ` (${code})` : ''} — ${aud(l.pick.cost)}`
  })
  return [`${o.wholesaler} order`, ...rows, `Total inc GST: ${aud(o.total)}`].join('\n')
}
