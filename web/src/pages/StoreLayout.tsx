import { useState } from 'react'
import {
  useItemPlaces, usePlaceItems, useRemove, useRemoveLocationGroup, useRemovePlaces, useSave, useSetLocationOrder,
  useStockGroups, useStockItems, useStockLocationGroups, useStockLocations,
} from '../lib/api'
import { layout, shelfOrder, walkOrder, type Layout } from '../lib/layout'
import type { StockGroup, StockItem, StockLocation, StockLocationGroup } from '../lib/types'
import { categoryLabel } from '../components/catalogue'
import { DeleteButton, ErrorBox, Loading } from '../components/ui'

/** A long list of ids in one request would overflow the URL, so big moves go in batches. */
const BATCH = 100

async function inBatches(ids: string[], fn: (chunk: string[]) => Promise<unknown>) {
  for (let n = 0; n < ids.length; n += BATCH) await fn(ids.slice(n, n + BATCH))
}

/**
 * The store as you walk it for a stock take: shelves, fridge doors, store room. Each location
 * keeps some categories, and its products can be put in the order they sit on the shelf.
 * The count sheet follows this layout.
 */
export default function StoreLayout() {
  const items = useStockItems()
  const groups = useStockGroups()
  const locations = useStockLocations()
  const links = useStockLocationGroups()
  const places = useItemPlaces()
  const [openId, setOpenId] = useState<string | null>(null)

  if (items.isLoading || groups.isLoading || locations.isLoading || links.isLoading || places.isLoading) return <Loading />

  const active = (items.data ?? []).filter((i) => i.active)
  const groupList = groups.data ?? []
  const locs = [...(locations.data ?? [])].sort(walkOrder)
  const linkList = links.data ?? []
  const lay = layout(active, locs, linkList, places.data ?? [])
  const open = locs.find((l) => l.id === openId)

  if (open)
    return (
      <LocationEditor key={open.id} location={open} locations={locs} items={active} groups={groupList} links={linkList}
        lay={lay} onClose={() => setOpenId(null)} />
    )

  return (
    <LocationList locations={locs} items={active} groups={groupList} links={linkList} lay={lay} onOpen={setOpenId}
      error={items.error || groups.error || locations.error || links.error || places.error} />
  )
}

interface Shared {
  locations: StockLocation[]
  items: StockItem[]
  groups: StockGroup[]
  links: StockLocationGroup[]
  lay: Layout
}

function LocationList({ locations, items, groups, links, lay, onOpen, error }: Shared & { onOpen: (id: string) => void; error: unknown }) {
  const save = useSave('stock_locations')
  const [name, setName] = useState('')
  const [busy, setBusy] = useState(false)
  const groupName = new Map(groups.map((g) => [g.id, categoryLabel(g)]))
  const countAt = (id: string) => items.filter((i) => lay.placesOf(i.id).includes(id)).length
  const unplaced = items.filter((i) => lay.placesOf(i.id).length === 0)
  const unplacedByGroup = [...groups, null]
    .map((g) => ({ name: g ? categoryLabel(g) : 'No category', n: unplaced.filter((i) => (g ? i.group_id === g.id : !i.group_id)).length }))
    .filter((x) => x.n > 0)

  async function add() {
    // "Fridge door 1, Fridge door 2, Fridge door 3" adds three.
    const names = name.split(/[,\n]/).map((n) => n.trim()).filter(Boolean)
      .filter((n) => !locations.some((l) => l.name.toLowerCase() === n.toLowerCase()))
    if (!names.length) return
    setBusy(true)
    try {
      let sort = locations.reduce((m, l) => Math.max(m, l.sort), 0)
      for (const n of names) await save.mutateAsync({ name: n, sort: (sort += 10) })
      setName('')
    } finally {
      setBusy(false)
    }
  }

  async function move(from: number, to: number) {
    if (to < 0 || to >= locations.length) return
    const next = [...locations]
    next.splice(to, 0, next.splice(from, 1)[0])
    await Promise.all(next.map((l, n) => (l.sort === (n + 1) * 10 ? null : save.mutateAsync({ id: l.id, sort: (n + 1) * 10 }))))
  }

  return (
    <section className="card p-4">
      <ErrorBox error={error || save.error} />
      <p className="mb-3 text-sm text-muted">
        Set up the store the way you walk it for a stock take — shelves, fridge doors, the store room — top to bottom in the
        order you go. Put categories in each spot, then open it to fine-tune which products sit there and in what order. The
        count sheet follows this.
      </p>

      {locations.length === 0 ? (
        <p className="rounded-lg border border-dashed border-line px-3 py-6 text-center text-sm text-muted">
          No locations yet. Add your first below — for example “Shelf 1 side 1”.
        </p>
      ) : (
        <ol className="divide-y divide-line">
          {locations.map((l, n) => {
            const cats = links.filter((x) => x.location_id === l.id).sort((a, b) => a.sort - b.sort)
            return (
              <li key={l.id} className="flex items-center gap-2 py-2.5">
                <span className="num w-6 shrink-0 text-right text-sm text-muted">{n + 1}</span>
                <button type="button" className="min-w-0 flex-1 text-left" onClick={() => onOpen(l.id)}>
                  <span className="block truncate font-medium">{l.name} <span className="text-sm font-normal text-muted">· {countAt(l.id)} products</span></span>
                  <span className="block truncate text-xs text-muted">
                    {cats.length ? cats.map((c) => groupName.get(c.group_id)).filter(Boolean).join(', ') : 'No categories yet'}
                  </span>
                </button>
                <span className="flex shrink-0 gap-1">
                  <button type="button" className="btn btn-sm !h-9 !w-9 !p-0" aria-label={`Move ${l.name} earlier`} disabled={n === 0 || save.isPending} onClick={() => move(n, n - 1)}>↑</button>
                  <button type="button" className="btn btn-sm !h-9 !w-9 !p-0" aria-label={`Move ${l.name} later`} disabled={n === locations.length - 1 || save.isPending} onClick={() => move(n, n + 1)}>↓</button>
                  <button type="button" className="btn btn-sm !h-9" onClick={() => onOpen(l.id)}>Open</button>
                </span>
              </li>
            )
          })}
        </ol>
      )}

      <form className="mt-3 flex flex-wrap gap-2 border-t border-line pt-3" onSubmit={(e) => { e.preventDefault(); add() }}>
        <input aria-label="New location" className="field min-w-48 flex-1 !py-2" value={name} onChange={(e) => setName(e.target.value)}
          placeholder="e.g. Fridge door 1 — add several with commas" />
        <button type="submit" className="btn btn-primary !py-2" disabled={!name.trim() || busy}>{busy ? 'Adding…' : 'Add location'}</button>
      </form>

      {locations.length > 0 && unplaced.length > 0 && (
        <p className="mt-3 rounded-lg border border-warn-line bg-warn-bg px-3 py-2 text-sm text-warn-ink">
          {unplaced.length} {unplaced.length === 1 ? 'product isn’t' : 'products aren’t'} in a location yet, so they come last
          on the count sheet: {unplacedByGroup.map((g) => `${g.name} (${g.n})`).join(', ')}. Add those categories to a location.
        </p>
      )}
    </section>
  )
}

function LocationEditor({ location, locations, items, groups, links, lay, onClose }: Shared & { location: StockLocation; onClose: () => void }) {
  const save = useSave('stock_locations')
  const remove = useRemove('stock_locations')
  const addLink = useSave('stock_location_groups')
  const removeLink = useRemoveLocationGroup()
  const placeItems = usePlaceItems()
  const removePlaces = useRemovePlaces()
  const [adding, setAdding] = useState(false)

  const here = links.filter((l) => l.location_id === location.id).sort((a, b) => a.sort - b.sort)
  const groupName = new Map(groups.map((g) => [g.id, categoryLabel(g)]))
  const locName = new Map(locations.map((l) => [l.id, l.name]))
  const elsewhere = (groupId: string) => links.filter((l) => l.group_id === groupId && l.location_id !== location.id).map((l) => locName.get(l.location_id)).filter(Boolean)
  const products = items.filter((i) => lay.placesOf(i.id).includes(location.id))
  const others = locations.filter((l) => l.id !== location.id)
  const busy = placeItems.isPending || removePlaces.isPending

  // New arrivals go after whatever is already arranged at a location.
  const act: Actions = {
    moveTo: (ids, to) => inBatches(ids, (c) => placeItems.mutateAsync({ locationId: to, itemIds: c, from: location.id })),
    alsoAt: (ids, to) => inBatches(ids, (c) => placeItems.mutateAsync({ locationId: to, itemIds: c })),
    takeOff: (ids) => inBatches(ids, (c) => removePlaces.mutateAsync({ locationId: location.id, itemIds: c })),
    bringHere: (ids, keep) => inBatches(ids, (c) => placeItems.mutateAsync({ locationId: location.id, itemIds: c, only: !keep })),
  }

  return (
    <section className="card p-4">
      <ErrorBox error={save.error || remove.error || addLink.error || removeLink.error || placeItems.error || removePlaces.error} />
      <div className="mb-3 flex flex-wrap items-center gap-2">
        <button type="button" className="btn btn-sm" onClick={onClose}>← All locations</button>
        <span className="ml-auto">
          <DeleteButton label="Delete location" busy={remove.isPending}
            onConfirm={async () => { await remove.mutateAsync(location.id); onClose() }} />
        </span>
      </div>

      <label className="label" htmlFor="loc-name">Location</label>
      <input id="loc-name" className="field mb-4 font-semibold" defaultValue={location.name}
        onBlur={(e) => { const v = e.target.value.trim(); if (v && v !== location.name) save.mutate({ id: location.id, name: v }) }} />

      <h3 className="label">Categories kept here</h3>
      <div className="mb-1 flex flex-wrap items-center gap-1.5">
        {here.map((l) => (
          <span key={l.group_id} className="inline-flex items-center gap-1 rounded-full border border-line bg-surface-2 py-1 pl-3 pr-1 text-sm">
            {groupName.get(l.group_id)}
            <button type="button" className="rounded-full px-1.5 text-muted hover:text-bad" aria-label={`Take ${groupName.get(l.group_id)} out of ${location.name}`}
              disabled={removeLink.isPending} onClick={() => removeLink.mutate({ location_id: location.id, group_id: l.group_id })}>×</button>
          </span>
        ))}
        <select aria-label="Add a category" className="field !w-auto !py-1.5 text-sm" value=""
          disabled={addLink.isPending}
          onChange={(e) => e.target.value && addLink.mutate({
            location_id: location.id, group_id: e.target.value, sort: here.reduce((m, l) => Math.max(m, l.sort), 0) + 10,
          })}>
          <option value="">+ Add a category…</option>
          {[...groups].sort((a, b) => a.sort - b.sort).filter((g) => !here.some((l) => l.group_id === g.id)).map((g) => {
            const at = elsewhere(g.id)
            return <option key={g.id} value={g.id}>{categoryLabel(g)}{at.length ? ` (also at ${at.join(', ')})` : ''}</option>
          })}
        </select>
      </div>
      {here.some((l) => elsewhere(l.group_id).length) && (
        <p className="mb-2 text-xs text-muted">
          A category in more than one place starts out at the first of them on your walk. Move the products that live here with
          “Add products here” below, or from the other location’s list.
        </p>
      )}

      <div className="mt-4 flex flex-wrap items-baseline justify-between gap-2 border-t border-line pt-4">
        <h3 className="font-semibold">Products here <span className="text-sm font-normal text-muted">· {products.length}</span></h3>
        <button type="button" className="btn btn-sm" onClick={() => setAdding(!adding)}>{adding ? 'Done adding' : '+ Add products here'}</button>
      </div>

      {adding && <AddProducts location={location} items={items} groups={groups} lay={lay} locName={locName} busy={busy}
        onAdd={act.bringHere} />}

      {products.length === 0 ? (
        <p className="py-6 text-center text-sm text-muted">Nothing counted here yet. Add a category above, or add products one by one.</p>
      ) : (
        // Remount when the products here change, so the draft starts from what's saved.
        <ShelfOrder key={products.map((i) => i.id).sort().join()} location={location} products={products} links={links}
          groups={groups} others={others} lay={lay} locName={locName} act={act} busy={busy} />
      )}
    </section>
  )
}

interface Actions {
  moveTo: (ids: string[], locationId: string) => Promise<void>
  alsoAt: (ids: string[], locationId: string) => Promise<void>
  takeOff: (ids: string[]) => Promise<void>
  bringHere: (ids: string[], keep: boolean) => Promise<void>
}

/** Pick products from anywhere in the store and bring them here. */
function AddProducts({ location, items, groups, lay, locName, busy, onAdd }: {
  location: StockLocation; items: StockItem[]; groups: StockGroup[]; lay: Layout
  locName: Map<string, string>; busy: boolean; onAdd: (ids: string[], keep: boolean) => Promise<void>
}) {
  const [q, setQ] = useState('')
  const [groupId, setGroupId] = useState('')
  const [picked, setPicked] = useState<Set<string>>(new Set())
  const needle = q.trim().toLowerCase()
  const LIMIT = 150
  const found = items
    .filter((i) => !lay.placesOf(i.id).includes(location.id) && (!groupId || i.group_id === groupId) && (!needle || i.name.toLowerCase().includes(needle)))
    .sort((a, b) => a.name.localeCompare(b.name))
  const shown = found.slice(0, LIMIT)
  const chosen = [...picked].filter((id) => found.some((i) => i.id === id))
  const toggle = (id: string) => { const s = new Set(picked); if (s.has(id)) s.delete(id); else s.add(id); setPicked(s) }

  return (
    <div className="mb-4 mt-2 rounded-xl border border-accent/40 p-3">
      <div className="mb-2 flex flex-wrap gap-2">
        <input type="search" aria-label="Search products" className="field min-w-40 flex-1 !py-2" placeholder="Search products…"
          value={q} onChange={(e) => setQ(e.target.value)} />
        <select aria-label="Category" className="field !w-auto !py-2" value={groupId} onChange={(e) => setGroupId(e.target.value)}>
          <option value="">All categories</option>
          {[...groups].sort((a, b) => a.sort - b.sort).map((g) => <option key={g.id} value={g.id}>{g.name}</option>)}
        </select>
      </div>
      <div className="mb-2 flex items-center gap-2 text-sm">
        <label className="flex items-center gap-2">
          <input type="checkbox" checked={shown.length > 0 && shown.every((i) => picked.has(i.id))}
            onChange={(e) => { const s = new Set(picked); for (const i of shown) if (e.target.checked) s.add(i.id); else s.delete(i.id); setPicked(s) }} />
          Tick all shown
        </label>
        <span className="text-muted">· {found.length} found{found.length > LIMIT ? `, first ${LIMIT} shown — search to narrow` : ''}</span>
      </div>
      <ul className="max-h-80 divide-y divide-line overflow-y-auto">
        {shown.map((i) => {
          const at = lay.placesOf(i.id)
          return (
            <li key={i.id}>
              <label className="flex items-center gap-3 py-2">
                <input type="checkbox" checked={picked.has(i.id)} onChange={() => toggle(i.id)} />
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-sm font-medium">{i.name}</span>
                  <span className="block truncate text-xs text-muted">{at.length ? `Now at ${at.map((l) => locName.get(l)).join(', ')}` : 'Not in a location'}</span>
                </span>
              </label>
            </li>
          )
        })}
      </ul>
      <div className="mt-2 flex flex-wrap items-center justify-end gap-2">
        <span className="mr-auto text-xs text-muted">“Also count here” keeps them where they are too — say, fridge and store room.</span>
        <button type="button" className="btn btn-sm" disabled={!chosen.length || busy}
          onClick={async () => { await onAdd(chosen, true); setPicked(new Set()) }}>
          Also count {chosen.length || ''} here
        </button>
        <button type="button" className="btn btn-primary btn-sm" disabled={!chosen.length || busy}
          onClick={async () => { await onAdd(chosen, false); setPicked(new Set()) }}>
          {busy ? 'Moving…' : `Move ${chosen.length || ''} here`}
        </button>
      </div>
    </div>
  )
}

/**
 * The products at one location in shelf order. Drag on a computer; on a phone tick a few and
 * tap "Put here" on the row they should follow — quicker than arrows on a long shelf.
 */
function ShelfOrder({ location, products, links, groups, others, lay, locName, act, busy }: {
  location: StockLocation; products: StockItem[]; links: StockLocationGroup[]; groups: StockGroup[]
  others: StockLocation[]; lay: Layout; locName: Map<string, string>; act: Actions; busy: boolean
}) {
  const saveOrder = useSetLocationOrder()
  const saved = [...products].sort(shelfOrder(location.id, lay, links, groups))
  const [ids, setIds] = useState(() => saved.map((i) => i.id))
  const [selected, setSelected] = useState<Set<string>>(new Set())
  const [dragging, setDragging] = useState<string | null>(null)
  const byId = new Map(products.map((i) => [i.id, i]))
  const groupName = new Map(groups.map((g) => [g.id, categoryLabel(g)]))
  const arranged = products.some((i) => lay.sortAt(i.id, location.id) > 0)
  const changed = !arranged || ids.some((id, n) => id !== saved[n].id)

  const move = (from: number, to: number) => {
    if (to < 0 || to >= ids.length || from === to) return
    const next = [...ids]
    next.splice(to, 0, next.splice(from, 1)[0])
    setIds(next)
  }
  /** Lift the ticked products out and drop them, in their current order, after `afterId` (or at the top). */
  const putAfter = (afterId: string | null, atEnd = false) => {
    const block = ids.filter((id) => selected.has(id))
    const rest = ids.filter((id) => !selected.has(id))
    const at = atEnd ? rest.length : afterId ? rest.indexOf(afterId) + 1 : 0
    setIds([...rest.slice(0, at), ...block, ...rest.slice(at)])
    setSelected(new Set())
  }
  const sortBy = (key: (i: StockItem) => string | number) => {
    const k = (id: string) => key(byId.get(id)!)
    setIds([...ids].sort((a, b) => {
      const x = k(a), y = k(b)
      return (typeof x === 'number' && typeof y === 'number' ? x - y : String(x).localeCompare(String(y))) || byId.get(a)!.name.localeCompare(byId.get(b)!.name)
    }))
  }
  const catRank = (i: StockItem) => {
    const here = links.find((l) => l.location_id === location.id && l.group_id === i.group_id)
    return here ? here.sort : 1e6 + (groups.find((g) => g.id === i.group_id)?.sort ?? 1e6)
  }
  const toggle = (id: string) => { const s = new Set(selected); if (s.has(id)) s.delete(id); else s.add(id); setSelected(s) }
  const picking = selected.size > 0
  const ticked = [...selected]
  // Only a product that's kept somewhere else as well can come off this shelf.
  const canTakeOff = ticked.length > 0 && ticked.every((id) => lay.placesOf(id).length > 1)
  const locked = busy || (changed && arranged)
  const run = async (fn: () => Promise<void>) => { await fn(); setSelected(new Set()) }

  return (
    <div>
      <ErrorBox error={saveOrder.error} />
      <div className="mb-2 flex flex-wrap items-center gap-2 text-sm">
        <span className="text-muted">Start from:</span>
        <button type="button" className="btn btn-sm" onClick={() => sortBy(catRank)}>By category</button>
        <button type="button" className="btn btn-sm" onClick={() => sortBy((i) => i.name)}>A–Z</button>
      </div>

      {picking && (
        <div className="sticky top-16 z-10 mb-2 flex flex-wrap items-center gap-2 rounded-xl border border-accent/40 bg-surface p-2 text-sm shadow-lg">
          <span className="font-semibold">{selected.size} ticked</span>
          <span className="text-muted">— tap “Put here” on the row they go after, or</span>
          <button type="button" className="btn btn-sm" onClick={() => putAfter(null)}>Top</button>
          <button type="button" className="btn btn-sm" onClick={() => putAfter(null, true)}>Bottom</button>
          {others.length > 0 && (
            <>
              <select aria-label="Move to another location" className="field !w-auto !py-1 text-sm" value="" disabled={locked}
                title={locked ? 'Save the order first' : undefined}
                onChange={(e) => { const to = e.target.value; if (to) run(() => act.moveTo(ticked, to)) }}>
                <option value="">Move to…</option>
                {others.map((l) => <option key={l.id} value={l.id}>{l.name}</option>)}
              </select>
              <select aria-label="Also count at another location" className="field !w-auto !py-1 text-sm" value="" disabled={locked}
                title={locked ? 'Save the order first' : undefined}
                onChange={(e) => { const to = e.target.value; if (to) run(() => act.alsoAt(ticked, to)) }}>
                <option value="">Also count at…</option>
                {others.map((l) => <option key={l.id} value={l.id}>{l.name}</option>)}
              </select>
            </>
          )}
          {canTakeOff && (
            <button type="button" className="btn btn-sm" disabled={locked} onClick={() => run(() => act.takeOff(ticked))}>
              Not here any more
            </button>
          )}
          <button type="button" className="btn btn-sm ml-auto" onClick={() => setSelected(new Set())}>Clear</button>
        </div>
      )}

      <ol className="divide-y divide-line">
        {ids.map((id, n) => {
          const i = byId.get(id)!
          const on = selected.has(id)
          return (
            <li key={id} draggable
              onDragStart={() => setDragging(id)}
              onDragEnd={() => setDragging(null)}
              onDragOver={(e) => { e.preventDefault(); if (dragging && dragging !== id) move(ids.indexOf(dragging), n) }}
              className={`flex items-center gap-2 py-2 ${dragging === id ? 'opacity-40' : ''} ${on ? 'bg-accent/5' : ''}`}>
              <span className="hidden cursor-grab select-none px-1 text-muted md:inline" aria-hidden>⠿</span>
              <input type="checkbox" aria-label={`Tick ${i.name}`} checked={on} onChange={() => toggle(id)} />
              <span className="num w-8 shrink-0 text-right text-sm text-muted">{n + 1}</span>
              <span className="min-w-0 flex-1">
                <span className="block truncate font-medium">{i.name}</span>
                <span className="block truncate text-xs text-muted">
                  {i.unit}{i.group_id && groupName.has(i.group_id) ? ` · ${groupName.get(i.group_id)}` : ''}
                  {lay.placesOf(id).length > 1 && (
                    <span className="text-accent"> · also at {lay.placesOf(id).filter((l) => l !== location.id).map((l) => locName.get(l)).join(', ')}</span>
                  )}
                </span>
              </span>
              {picking ? (
                !on && <button type="button" className="btn btn-sm !h-9 shrink-0" onClick={() => putAfter(id)}>Put here</button>
              ) : (
                <span className="flex shrink-0 gap-1">
                  <button type="button" className="btn btn-sm !h-9 !w-9 !p-0" aria-label={`Move ${i.name} up`} disabled={n === 0} onClick={() => move(n, n - 1)}>↑</button>
                  <button type="button" className="btn btn-sm !h-9 !w-9 !p-0" aria-label={`Move ${i.name} down`} disabled={n === ids.length - 1} onClick={() => move(n, n + 1)}>↓</button>
                </span>
              )}
            </li>
          )
        })}
      </ol>

      <div className="sticky bottom-[calc(4.5rem+env(safe-area-inset-bottom))] z-10 mt-3 flex items-center gap-2 rounded-xl border border-line bg-surface p-3 shadow-lg md:bottom-4">
        <span className="min-w-0 flex-1 text-sm text-muted">
          {!arranged ? 'Sorted by category for now — save to keep this order' : changed ? 'Not saved yet' : `${location.name}’s order is saved`}
        </span>
        <button type="button" className="btn" disabled={!changed || !arranged} onClick={() => setIds(saved.map((i) => i.id))}>Undo</button>
        <button type="button" className="btn btn-primary" disabled={!changed || saveOrder.isPending}
          onClick={() => saveOrder.mutate({ locationId: location.id, itemIds: ids })}>
          {saveOrder.isPending ? 'Saving…' : 'Save order'}
        </button>
      </div>
    </div>
  )
}
