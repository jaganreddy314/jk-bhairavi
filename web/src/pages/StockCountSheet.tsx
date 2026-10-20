import { useMemo, useState } from 'react'
import { Link, useNavigate, useParams } from 'react-router-dom'
import {
  useItemPlaces, useRemove, useSave, useSaveCountLines, useStartStockCount, useStockCount, useStockCountLines,
  useStockCounts, useStockGroups, useStockItems, useStockLocationGroups, useStockLocations,
} from '../lib/api'
import { fmtDay } from '../lib/dates'
import { aud } from '../lib/format'
import { layout, walkSections } from '../lib/layout'
import { countLineValue, countTotal, qtyStr } from '../lib/purchasing'
import type { StockCount, StockCountLine } from '../lib/types'
import { DeleteButton, ErrorBox, Flash, Loading, PageHeader } from '../components/ui'

// One shared empty array: `?? []` would be a new array every render, which defeats
// the memos built on top of it and re-groups the whole sheet on every keystroke.
const NO_LINES: StockCountLine[] = []

export default function StockCountSheet() {
  const { id } = useParams()
  const count = useStockCount(id)
  if (count.isLoading) return <Loading />
  if (count.error || !count.data) return <div className="mx-auto max-w-2xl"><ErrorBox error={count.error ?? 'Count not found'} /></div>
  return <Sheet count={count.data} />
}

function Sheet({ count }: { count: StockCount }) {
  const nav = useNavigate()
  const lines = useStockCountLines(count.id)
  const items = useStockItems()
  const groups = useStockGroups()
  const locations = useStockLocations()
  const locationGroups = useStockLocationGroups()
  const places = useItemPlaces()
  const allCounts = useStockCounts()
  const saveLines = useSaveCountLines()
  const saveCount = useSave('stock_counts')
  const removeCount = useRemove('stock_counts')
  const topUp = useStartStockCount()

  // Quantities are typed into local state and saved in one go: a full sheet is 30-odd
  // boxes, and a request per keystroke on a phone in a cool room is no use to anybody.
  // Keyed by line id, or "line id@location id" for a product counted in several places.
  const [draft, setDraft] = useState<Record<string, string>>({})
  const [saved, setSaved] = useState(0)

  const final = count.status === 'final'
  const rows = lines.data ?? NO_LINES

  // The count before this one, to show what was on the shelf last time.
  const previous = (allCounts.data ?? [])
    .filter((c) => c.status === 'final' && c.count_date < count.count_date)
    .sort((a, b) => b.count_date.localeCompare(a.count_date))[0]
  const previousLines = useStockCountLines(previous?.id)
  const previousLine = useMemo(
    () => new Map((previousLines.data ?? []).map((l) => [l.item_id, l])),
    [previousLines.data],
  )

  const lay = useMemo(
    () => layout(items.data ?? [], locations.data ?? [], locationGroups.data ?? [], places.data ?? []),
    [items.data, locations.data, locationGroups.data, places.data],
  )
  /** The places a line is split across — only for a product kept in more than one. */
  const splitOf = (l: StockCountLine) => { const at = lay.placesOf(l.item_id); return at.length > 1 ? at : null }
  /** What was saved at each place. A figure from before the product was split sits at its first place. */
  const storedParts = (l: StockCountLine, at: string[]): Record<string, number> =>
    l.place_qty ?? (l.qty ? { [at[0]]: l.qty } : {})
  /** What's at one place, as shown in its box. */
  const partStr = (l: StockCountLine, at: string[], loc: string) => {
    const k = `${l.id}@${loc}`
    if (k in draft) return draft[k]
    const v = storedParts(l, at)[loc]
    return v ? qtyStr(v) : ''
  }
  /** All the places added up, including any saved at a location no longer on the walk. */
  const partsOf = (l: StockCountLine, at: string[]) => {
    const out: Record<string, number> = { ...storedParts(l, at) }
    for (const loc of at) {
      const v = partStr(l, at, loc).trim()
      if (v === '') delete out[loc]
      else out[loc] = Number(v) || 0
    }
    return out
  }
  const qtyOf = (l: StockCountLine) => {
    const at = splitOf(l)
    if (!at) return l.id in draft ? Number(draft[l.id]) || 0 : l.qty
    return Math.round(Object.values(partsOf(l, at)).reduce((a, b) => a + b, 0) * 1000) / 1000
  }
  /** What one row stands for: its place's share when the product is split, else the whole line. */
  const qtyAt = (l: StockCountLine, loc: string | null) => {
    const at = splitOf(l)
    return at && loc ? Number(partStr(l, at, loc)) || 0 : qtyOf(l)
  }
  const effective = rows.map((l) => ({ ...l, qty: qtyOf(l) }))
  const total = countTotal(effective)

  const byItem = useMemo(() => new Map(rows.map((l) => [l.item_id, l])), [rows])
  // Laid out the way you walk the shop: shelf by shelf, door by door (Food → Catalogue → Store layout).
  const sections = useMemo(
    () => walkSections(items.data ?? [], groups.data ?? [], locations.data ?? [], locationGroups.data ?? [], lay, (item) => byItem.get(item.id)),
    [items.data, groups.data, locations.data, locationGroups.data, lay, byItem],
  )
  const groupName = useMemo(() => new Map((groups.data ?? []).map((g) => [g.id, g.name])), [groups.data])
  const locName = useMemo(() => new Map((locations.data ?? []).map((l) => [l.id, l.name])), [locations.data])
  // A line counts as done once a figure is in it, a zero included.
  const entered = (l: StockCountLine, loc: string | null) => {
    const at = splitOf(l)
    if (at && loc) {
      const k = `${l.id}@${loc}`
      return k in draft ? draft[k].trim() !== '' : loc in storedParts(l, at)
    }
    return l.id in draft ? draft[l.id].trim() !== '' : l.qty > 0
  }

  // What has changed, ready to save: the new total, and for a split product where it was found.
  const touched = new Set(Object.keys(draft).map((k) => k.split('@')[0]))
  const dirty = rows.filter((l) => touched.has(l.id)).flatMap((l): { id: string; qty: number; place_qty: Record<string, number> | null }[] => {
    const at = splitOf(l)
    if (!at) {
      if (!(l.id in draft)) return []
      const qty = Number(draft[l.id]) || 0
      return qty !== l.qty ? [{ id: l.id, qty, place_qty: null }] : []
    }
    const parts = partsOf(l, at)
    const same = (a: Record<string, number>, b: Record<string, number>) =>
      Object.keys(a).length === Object.keys(b).length && Object.entries(a).every(([k, v]) => b[k] === v)
    return same(parts, storedParts(l, at)) ? [] : [{ id: l.id, qty: qtyOf(l), place_qty: parts }]
  })

  // Items added since the sheet was opened have no line on it yet.
  const missing = (items.data ?? []).filter((i) => i.active && !byItem.has(i.id)).length

  async function save() {
    if (!dirty.length) return
    await saveLines.mutateAsync(dirty)
    setDraft({})
    setSaved(Date.now())
  }

  return (
    <div className="mx-auto max-w-2xl pb-32 md:pb-24">
      <PageHeader
        title={`Stock on ${fmtDay(count.count_date)}`}
        subtitle={final ? 'Finished — this week’s figures use it.' : 'Close of trade. Enter what’s on the shelf.'}
        action={<Link to="/stock" className="text-sm font-medium text-accent">All counts →</Link>}
      />
      <ErrorBox error={lines.error || saveLines.error || saveCount.error || removeCount.error || topUp.error} />

      {previous && (
        <p className="mb-3 text-sm text-muted">
          Last counted {fmtDay(previous.count_date)} — {aud(previous.value)} on hand. The “was” figures below are from that count.
        </p>
      )}

      {missing > 0 && !final && (
        <p className="mb-3 flex flex-wrap items-center gap-2 rounded-lg border border-warn-line bg-warn-bg px-3 py-2 text-sm text-warn-ink">
          {missing} new {missing === 1 ? 'item isn’t' : 'items aren’t'} on this sheet yet.
          <button type="button" className="btn btn-sm" disabled={topUp.isPending}
            onClick={() => topUp.mutate(count.count_date)}>
            {topUp.isPending ? 'Adding…' : 'Add them'}
          </button>
        </p>
      )}

      {!final && rows.length > 0 && (
        <p className="mb-3 text-sm text-muted">
          {(locations.data ?? []).length
            ? 'In the order you walk the store.'
            : 'Tip: set up your shelves and fridge doors so this sheet follows your walk round the store.'}{' '}
          <Link className="font-semibold text-accent" to="/food/catalogue?tab=layout">Store layout →</Link>
        </p>
      )}

      {/* Jump straight to a shelf; the figure is how many on it have been counted. */}
      {sections.length > 1 && (
        <nav aria-label="Jump to" className="sticky top-14 z-10 -mx-4 mb-3 flex gap-1.5 overflow-x-auto bg-page/95 px-4 py-2 backdrop-blur">
          {sections.map((s) => {
            const done = s.rows.filter(({ row }) => entered(row, s.locationId)).length
            return (
              <a key={s.key || 'loose'} href={`#walk-${s.key}`}
                className={`shrink-0 rounded-full border px-3 py-1 text-xs font-medium ${done === s.rows.length ? 'border-good/40 bg-good/10 text-good' : 'border-line bg-surface text-ink-2'}`}
                onClick={(e) => { e.preventDefault(); document.getElementById(`walk-${s.key}`)?.scrollIntoView({ behavior: 'smooth', block: 'start' }) }}>
                {s.name} <span className="num text-muted">{done}/{s.rows.length}</span>
              </a>
            )
          })}
        </nav>
      )}

      {lines.isLoading ? (
        <Loading />
      ) : rows.length === 0 ? (
        <p className="card px-4 py-8 text-center text-sm text-muted">
          Nothing to count. Add stock items in <Link className="font-semibold text-accent" to="/food/catalogue">Food → Catalogue</Link>.
        </p>
      ) : (
        <div className="grid gap-4">
          {sections.map((s) => {
            const sectionTotal = countTotal(s.rows.map(({ row }) => ({ qty: qtyAt(row, s.locationId), unit_cost: row.unit_cost })))
            return (
              <section key={s.key || 'loose'} id={`walk-${s.key}`} className="card scroll-mt-28 p-4">
                <div className="mb-1 flex items-baseline justify-between gap-3">
                  <h2 className="font-semibold">{s.name} <span className="text-sm font-normal text-muted">· {s.rows.length}</span></h2>
                  <span className="num text-sm font-semibold text-ink-2">{aud(sectionTotal)}</span>
                </div>
                <ul className="divide-y divide-line">
                  {s.rows.map(({ item, row }) => {
                    const at = s.locationId ? splitOf(row) : null
                    const loc = at ? s.locationId! : null
                    const prev = previousLine.get(item.id)
                    // Last time's figure for this place when it was split then too, else the whole.
                    const was = loc && prev?.place_qty ? prev.place_qty[loc] : prev?.qty
                    const value = countLineValue({ qty: qtyAt(row, loc), unit_cost: row.unit_cost })
                    const key = loc ? `${row.id}@${loc}` : row.id
                    return (
                      <li key={row.id} className="flex items-center gap-3 py-2">
                        <span className="min-w-0 flex-1">
                          <span className="block truncate font-medium">{item.name}</span>
                          <span className="text-xs text-muted">
                            {s.locationId && item.group_id && groupName.has(item.group_id) && `${groupName.get(item.group_id)} · `}
                            {aud(row.unit_cost)}/{item.unit}
                            {was != null && was > 0 && ` · was ${qtyStr(was)}`}
                          </span>
                          {at && (
                            <span className="block truncate text-xs text-accent">
                              Also at {at.filter((l) => l !== loc).map((l) => locName.get(l)).join(', ')} · total {qtyStr(qtyOf(row))} {item.unit}
                            </span>
                          )}
                        </span>
                        {final ? (
                          <span className="num w-24 text-right text-sm text-ink-2">{qtyStr(qtyAt(row, loc))} {item.unit}</span>
                        ) : (
                          <span className="flex shrink-0 items-center gap-1.5">
                            <input
                              aria-label={`${item.name} quantity in ${item.unit}`}
                              className="field !w-20 !py-2 text-right"
                              inputMode="decimal"
                              placeholder="0"
                              value={at && loc ? partStr(row, at, loc) : row.id in draft ? draft[row.id] : row.qty ? qtyStr(row.qty) : ''}
                              onChange={(e) => setDraft({ ...draft, [key]: e.target.value })}
                            />
                            <span className="w-7 text-xs text-muted">{item.unit}</span>
                          </span>
                        )}
                        <span className="num w-20 shrink-0 text-right text-sm font-semibold">{aud(value)}</span>
                      </li>
                    )
                  })}
                </ul>
              </section>
            )
          })}

          <section className="card p-4">
            <label className="label" htmlFor="count-note">Note <span className="font-normal text-muted">(optional)</span></label>
            <input id="count-note" className="field" defaultValue={count.note ?? ''} disabled={final}
              placeholder="Who counted, anything odd…"
              onBlur={(e) => e.target.value !== (count.note ?? '') && saveCount.mutate({ id: count.id, note: e.target.value || null })} />

            <div className="mt-4 flex flex-wrap items-center gap-2 border-t border-line pt-4">
              {final ? (
                <button type="button" className="btn" disabled={saveCount.isPending}
                  onClick={() => saveCount.mutate({ id: count.id, status: 'open' })}>
                  Reopen to change it
                </button>
              ) : (
                <button type="button" className="btn btn-primary" disabled={saveCount.isPending || dirty.length > 0}
                  onClick={() => saveCount.mutate({ id: count.id, status: 'final' })}>
                  Finish this count
                </button>
              )}
              {!final && dirty.length > 0 && <span className="text-xs text-muted">Save your changes first.</span>}
              <span className="ml-auto">
                <DeleteButton label="Delete count" busy={removeCount.isPending}
                  onConfirm={async () => { await removeCount.mutateAsync(count.id); nav('/stock') }} />
              </span>
            </div>
            {!final && (
              <p className="mt-2 text-xs text-muted">
                Only finished counts are used, so a half-done sheet never moves your food cost.
              </p>
            )}
          </section>
        </div>
      )}

      {/* Running total and Save stay in reach while you work down the shelves. */}
      {!final && rows.length > 0 && (
        <div className="fixed inset-x-0 bottom-[calc(3.75rem+env(safe-area-inset-bottom))] z-30 border-t border-line bg-surface/95 py-2 backdrop-blur md:bottom-0 md:pb-[calc(env(safe-area-inset-bottom)+0.5rem)]">
          <div className="mx-auto flex max-w-2xl items-center gap-3 px-4">
            <span className="min-w-0 flex-1">
              <span className="block text-xs text-muted">Stock on hand</span>
              <span className="num block text-lg font-bold">{aud(total)}</span>
            </span>
            <Flash signal={saved} />
            <button type="button" className="btn btn-primary" disabled={!dirty.length || saveLines.isPending} onClick={save}>
              {saveLines.isPending ? 'Saving…' : dirty.length ? `Save ${dirty.length}` : 'Saved'}
            </button>
          </div>
        </div>
      )}
    </div>
  )
}
