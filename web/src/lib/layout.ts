import type { StockGroup, StockItem, StockItemPlace, StockLocation, StockLocationGroup } from './types'

/** Locations in the order you walk them. */
export const walkOrder = (a: StockLocation, b: StockLocation) => a.sort - b.sort || a.name.localeCompare(b.name)

/** Where products are and in what position, read from the layout. */
export interface Layout {
  /** Every location a product is counted at, in walking order. Empty: not placed anywhere yet. */
  placesOf: (itemId: string) => string[]
  /** Its position at a location; 0 when not arranged there. */
  sortAt: (itemId: string, locationId: string) => number
}

/**
 * A product counts at the places it was put by hand, else the first location (in walk order)
 * that keeps its category, else nowhere yet.
 */
export function layout(items: StockItem[], locations: StockLocation[], links: StockLocationGroup[], places: StockItemPlace[]): Layout {
  const rank = new Map([...locations].sort(walkOrder).map((l, n) => [l.id, n]))
  const byGroup = new Map<string, string>()
  for (const link of links.filter((l) => rank.has(l.location_id)).sort((a, b) => rank.get(a.location_id)! - rank.get(b.location_id)!))
    if (!byGroup.has(link.group_id)) byGroup.set(link.group_id, link.location_id)

  const explicit = new Map<string, string[]>()
  const sort = new Map<string, number>()
  for (const p of places) {
    if (!rank.has(p.location_id)) continue
    explicit.set(p.item_id, [...(explicit.get(p.item_id) ?? []), p.location_id])
    sort.set(`${p.item_id}|${p.location_id}`, p.sort)
  }
  const out = new Map<string, string[]>()
  for (const i of items) {
    const mine = explicit.get(i.id)
    const fallback = i.group_id ? byGroup.get(i.group_id) : undefined
    out.set(i.id, mine ? [...mine].sort((a, b) => rank.get(a)! - rank.get(b)!) : fallback ? [fallback] : [])
  }
  return {
    placesOf: (id) => out.get(id) ?? [],
    sortAt: (id, loc) => sort.get(`${id}|${loc}`) ?? 0,
  }
}

/**
 * The order products sit within one location: as arranged first, then anything not arranged yet
 * by the location's categories (in the order they were added), then by name.
 */
export function shelfOrder(locationId: string, lay: Layout, links: StockLocationGroup[], groups: StockGroup[]) {
  const here = new Map(links.filter((l) => l.location_id === locationId).map((l) => [l.group_id, l.sort]))
  const groupSort = new Map(groups.map((g) => [g.id, g.sort]))
  const catRank = (i: StockItem) => {
    if (i.group_id && here.has(i.group_id)) return here.get(i.group_id)!
    return 1e6 + (i.group_id ? groupSort.get(i.group_id) ?? 1e6 : 2e6)
  }
  const pos = (i: StockItem) => lay.sortAt(i.id, locationId) || Infinity
  return (a: StockItem, b: StockItem) => pos(a) - pos(b) || catRank(a) - catRank(b) || a.name.localeCompare(b.name)
}

export interface WalkSection<T> {
  key: string
  name: string
  /** The location, or null for products not placed anywhere yet (grouped by category). */
  locationId: string | null
  rows: { item: StockItem; row: T }[]
}

/**
 * The stock take in walking order: one section per location, then whatever isn't placed yet,
 * a section per category. A product kept in several places is in each of their sections.
 * `pick` returns the count line for an item, or nothing to leave it out.
 */
export function walkSections<T>(
  items: StockItem[],
  groups: StockGroup[],
  locations: StockLocation[],
  links: StockLocationGroup[],
  lay: Layout,
  pick: (item: StockItem) => T | undefined,
): WalkSection<T>[] {
  const withRow = (list: StockItem[]) =>
    list.flatMap((item) => { const row = pick(item); return row === undefined ? [] : [{ item, row }] })
  const out: WalkSection<T>[] = []
  for (const loc of [...locations].sort(walkOrder)) {
    const rows = withRow(items.filter((i) => lay.placesOf(i.id).includes(loc.id)).sort(shelfOrder(loc.id, lay, links, groups)))
    if (rows.length) out.push({ key: loc.id, name: loc.name, locationId: loc.id, rows })
  }
  const loose = items.filter((i) => lay.placesOf(i.id).length === 0)
  const known = new Set(groups.map((g) => g.id))
  const prefix = locations.length ? 'Not placed · ' : ''
  for (const g of [...[...groups].sort((a, b) => a.sort - b.sort || a.name.localeCompare(b.name)), null]) {
    const rows = withRow(loose
      .filter((i) => (g ? i.group_id === g.id : !i.group_id || !known.has(i.group_id)))
      .sort((a, b) => a.name.localeCompare(b.name)))
    if (rows.length)
      out.push({ key: g?.id ?? 'loose', name: prefix + (g ? g.name : groups.length ? 'No category' : 'All items'), locationId: null, rows })
  }
  return out
}
