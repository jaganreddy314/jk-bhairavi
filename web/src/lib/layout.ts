import type { StockGroup, StockItem, StockLocation, StockLocationGroup } from './types'

/** Locations in the order you walk them. */
export const walkOrder = (a: StockLocation, b: StockLocation) => a.sort - b.sort || a.name.localeCompare(b.name)

/**
 * Where each product is counted: the location it was put in by hand, else the first location
 * (in walk order) that keeps its category, else nowhere yet.
 */
export function homes(items: StockItem[], locations: StockLocation[], links: StockLocationGroup[]) {
  const known = new Set(locations.map((l) => l.id))
  const rank = new Map([...locations].sort(walkOrder).map((l, n) => [l.id, n]))
  const byGroup = new Map<string, string>()
  for (const link of [...links].filter((l) => known.has(l.location_id)).sort((a, b) => rank.get(a.location_id)! - rank.get(b.location_id)!))
    if (!byGroup.has(link.group_id)) byGroup.set(link.group_id, link.location_id)
  const out = new Map<string, string | null>()
  for (const i of items)
    out.set(i.id, (i.location_id && known.has(i.location_id) ? i.location_id : null) ?? (i.group_id ? byGroup.get(i.group_id) ?? null : null))
  return out
}

/**
 * The order products sit within one location: as arranged first, then anything not arranged yet
 * by the location's categories (in the order they were added), then by name.
 */
export function shelfOrder(locationId: string, links: StockLocationGroup[], groups: StockGroup[]) {
  const here = new Map(links.filter((l) => l.location_id === locationId).map((l) => [l.group_id, l.sort]))
  const groupSort = new Map(groups.map((g) => [g.id, g.sort]))
  const catRank = (i: StockItem) => {
    if (i.group_id && here.has(i.group_id)) return here.get(i.group_id)!
    return 1e6 + (i.group_id ? groupSort.get(i.group_id) ?? 1e6 : 2e6)
  }
  return (a: StockItem, b: StockItem) =>
    (a.location_sort || Infinity) - (b.location_sort || Infinity) || catRank(a) - catRank(b) || a.name.localeCompare(b.name)
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
 * a section per category. `pick` returns the count line for an item, or nothing to leave it out.
 */
export function walkSections<T>(
  items: StockItem[],
  groups: StockGroup[],
  locations: StockLocation[],
  links: StockLocationGroup[],
  pick: (item: StockItem) => T | undefined,
): WalkSection<T>[] {
  const home = homes(items, locations, links)
  const out: WalkSection<T>[] = []
  for (const loc of [...locations].sort(walkOrder)) {
    const order = shelfOrder(loc.id, links, groups)
    const rows = items.filter((i) => home.get(i.id) === loc.id).sort(order)
      .flatMap((item) => { const row = pick(item); return row === undefined ? [] : [{ item, row }] })
    if (rows.length) out.push({ key: loc.id, name: loc.name, locationId: loc.id, rows })
  }
  const loose = items.filter((i) => !home.get(i.id))
  const sortedGroups = [...groups].sort((a, b) => a.sort - b.sort || a.name.localeCompare(b.name))
  const known = new Set(groups.map((g) => g.id))
  const prefix = locations.length ? 'Not placed · ' : ''
  for (const g of [...sortedGroups, null]) {
    const rows = loose
      .filter((i) => (g ? i.group_id === g.id : !i.group_id || !known.has(i.group_id)))
      .sort((a, b) => a.name.localeCompare(b.name))
      .flatMap((item) => { const row = pick(item); return row === undefined ? [] : [{ item, row }] })
    if (rows.length)
      out.push({ key: g?.id ?? 'loose', name: prefix + (g ? g.name : groups.length ? 'No category' : 'All items'), locationId: null, rows })
  }
  return out
}
