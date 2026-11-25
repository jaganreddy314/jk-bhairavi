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

// ---------- the tobacco order: fewer deliveries, minimum orders, the person's own picks ----------

export interface OrderRules {
  /** Keep a line with a wholesaler already on the order when it's at most this much dearer per pack. */
  tolerance: number
  /** Least the wholesaler delivers, inc GST; 0 for none. */
  minimum: (wholesalerId: string) => number
  /** A wholesaler picked by hand for this line, if any. */
  choice: (key: string) => string | undefined
}

/** Why a line went where it did. */
export type Why = 'cheapest' | 'grouped' | 'minimum' | 'chosen'

export interface OrderLine extends PlanLine {
  why: Why
  /** Every wholesaler's way to supply it, cheapest first. */
  options: Option[]
  /** What going here costs over the cheapest. */
  extra: number
}

export interface WholesaleOrder { wholesalerId: string; wholesaler: string; lines: OrderLine[]; total: number; minimum: number }

export interface OrderPlan {
  orders: WholesaleOrder[]
  total: number
  /** The same list with every line at its cheapest, wherever that is. */
  cheapest: number
  missing: WholesaleProduct[]
}

/**
 * Split the list so it costs least without a delivery for the sake of a few cents:
 *  1. lines picked by hand go where they were picked;
 *  2. each other line may go to any wholesaler within `tolerance` a pack of its cheapest, and
 *     the wholesaler that can take the most such lines takes them, then the next…;
 *  3. every line then goes to the cheapest of the wholesalers left on the order that it may use;
 *  4. a wholesaler whose share is under its minimum hands its lines to the next best, when they
 *     can all go somewhere else.
 */
export function planOrder(items: WantedItem[], products: Map<string, WholesaleProduct>, byProduct: Map<string, WholesalePrice[]>, rules: OrderRules): OrderPlan {
  const missing: WholesaleProduct[] = []
  type L = { key: string; product: WholesaleProduct; want: number; opts: Option[]; pick?: Option; why?: Why }
  const lines: L[] = []
  for (const it of items) {
    const product = products.get(it.productId)
    if (!product || it.qty <= 0) continue
    const opts = options(byProduct.get(product.id) ?? [], it.qty)
    if (opts.length) lines.push({ key: it.key ?? product.id, product, want: it.qty, opts })
    else missing.push(product)
  }
  const near = (l: L) => l.opts.filter((o) => (o.cost - l.opts[0]!.cost) / l.want <= rules.tolerance + 1e-9)
  const at = (l: L, w: string) => l.opts.find((o) => o.price.wholesaler_id === w)

  for (const l of lines) {
    const w = rules.choice(l.key)
    const o = w ? at(l, w) : undefined
    if (o) { l.pick = o; l.why = 'chosen' }
  }
  const used = new Set(lines.filter((l) => l.pick).map((l) => l.pick!.price.wholesaler_id))

  // 2. Fewest wholesalers: greedily, the one that can take the most open lines (already on the order first).
  let open = lines.filter((l) => !l.pick)
  const chosen = new Set(used)
  while (open.length) {
    const can = new Map<string, { n: number; cost: number }>()
    for (const l of open)
      for (const o of near(l)) {
        const c = can.get(o.price.wholesaler_id) ?? { n: 0, cost: 0 }
        c.n++; c.cost += o.cost
        can.set(o.price.wholesaler_id, c)
      }
    const [w] = [...can.entries()].sort(([a, x], [b, y]) =>
      Number(chosen.has(b)) - Number(chosen.has(a)) || y.n - x.n || x.cost - y.cost)[0]!
    chosen.add(w)
    open = open.filter((l) => !near(l).some((o) => o.price.wholesaler_id === w))
  }

  // 3. Each line to its cheapest wholesaler among those on the order.
  const settle = (l: L, allowed: (w: string) => boolean) => {
    const o = near(l).find((o) => allowed(o.price.wholesaler_id))
      ?? l.opts.find((o) => allowed(o.price.wholesaler_id))
    if (!o) return false
    l.pick = o
    l.why = o === l.opts[0] || o.cost === l.opts[0]!.cost ? 'cheapest' : 'grouped'
    return true
  }
  for (const l of lines) if (l.why !== 'chosen') settle(l, (w) => chosen.has(w))

  // 4. Minimum orders: the smallest order under its minimum gives its lines away, if it can.
  const dropped = new Set<string>()
  const totalOf = (w: string) => lines.filter((l) => l.pick!.price.wholesaler_id === w).reduce((s, l) => s + l.pick!.cost, 0)
  for (;;) {
    const short = [...new Set(lines.map((l) => l.pick!.price.wholesaler_id))]
      .filter((w) => !dropped.has(w) && rules.minimum(w) > 0 && totalOf(w) < rules.minimum(w))
      .sort((a, b) => totalOf(a) - totalOf(b))
    const w = short[0]
    if (!w) break
    dropped.add(w)
    const mine = lines.filter((l) => l.pick!.price.wholesaler_id === w)
    if (mine.some((l) => l.why === 'chosen')) continue
    const onOrder = new Set(lines.filter((l) => l.pick!.price.wholesaler_id !== w).map((l) => l.pick!.price.wholesaler_id))
    const ok = (x: string) => x !== w && !dropped.has(x)
    if (!mine.every((l) => l.opts.some((o) => ok(o.price.wholesaler_id)))) continue
    for (const l of mine) {
      if (!settle(l, (x) => ok(x) && onOrder.has(x))) settle(l, ok)
      l.why = 'minimum'
    }
  }

  const orders = new Map<string, WholesaleOrder>()
  for (const l of lines) {
    const pick = l.pick!
    const id = pick.price.wholesaler_id
    const o = orders.get(id) ?? { wholesalerId: id, wholesaler: pick.price.wholesaler, lines: [], total: 0, minimum: rules.minimum(id) }
    o.lines.push({ key: l.key, product: l.product, want: l.want, pick, next: l.opts.find((x) => x !== pick) ?? null,
      why: l.why!, options: l.opts, extra: cents(pick.cost - l.opts[0]!.cost) })
    o.total = cents(o.total + pick.cost)
    orders.set(id, o)
  }
  const list = [...orders.values()].sort((a, b) => b.total - a.total)
  for (const o of list) o.lines.sort((a, b) => a.product.name.localeCompare(b.product.name))
  return {
    orders: list,
    total: cents(list.reduce((s, o) => s + o.total, 0)),
    cheapest: cents(lines.reduce((s, l) => s + l.opts[0]!.cost, 0)),
    missing,
  }
}

// ---------- browsing the list ----------

/** What one retail unit is called in each category, for "$44.70 a pack". */
export const UNIT_OF: Record<WholesaleCategory, string> = {
  cigarettes: 'pack', tobacco: 'pouch', cigars: 'pack', filters: 'box', papers: 'booklet', lighters: 'lighter',
}

export type PriceSort = 'name' | 'low' | 'high'

/** How many rows a product list shows at first, and how many more each "Show more" adds. */
export const PAGE = 50

/**
 * A product list by price: only those at or under `max` a unit (when given), sorted by name or
 * by price. Rows without a price sort last and drop out once a maximum is set.
 */
export function byPrice<T>(rows: T[], price: (r: T) => number | undefined, name: (r: T) => string, sort: PriceSort, max: number | null) {
  const kept = max == null ? rows : rows.filter((r) => { const p = price(r); return p != null && p <= max + 1e-9 })
  if (sort === 'name') return [...kept].sort((a, b) => name(a).localeCompare(name(b)))
  const dir = sort === 'low' ? 1 : -1
  return [...kept].sort((a, b) => {
    const pa = price(a), pb = price(b)
    if (pa == null || pb == null) return pa == null && pb == null ? name(a).localeCompare(name(b)) : pa == null ? 1 : -1
    return (pa - pb) * dir || name(a).localeCompare(name(b))
  })
}
