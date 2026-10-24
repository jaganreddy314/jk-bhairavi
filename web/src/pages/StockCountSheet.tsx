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
import { DeleteButton, ErrorBox, Loading, Segmented } from '../components/ui'

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
  const [shelf, setShelf] = useState(0)
  const [query, setQuery] = useState('')
  const [filter, setFilter] = useState<'all' | 'todo'>('all')

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
  }

  /** The box for one row: a place's share of a split product, or the whole line. */
  const keyOf = (row: StockCountLine, loc: string | null) => (loc && splitOf(row) ? `${row.id}@${loc}` : row.id)
  const shownStr = (row: StockCountLine, loc: string | null) => {
    const at = splitOf(row)
    if (at && loc) return partStr(row, at, loc)
    return row.id in draft ? draft[row.id] : row.qty ? qtyStr(row.qty) : ''
  }
  const step = (row: StockCountLine, loc: string | null, by: number) => {
    const next = Math.max(0, Math.round(((Number(shownStr(row, loc)) || 0) + by) * 1000) / 1000)
    setDraft({ ...draft, [keyOf(row, loc)]: qtyStr(next) })
  }

  const progress = sections.map((s) => ({ done: s.rows.filter(({ row }) => entered(row, s.locationId)).length, of: s.rows.length }))
  const countedAll = progress.reduce((a, p) => a + p.done, 0)
  const rowsAll = progress.reduce((a, p) => a + p.of, 0)
  const at = Math.min(shelf, Math.max(0, sections.length - 1))
  const current = sections[at]
  const go = (i: number) => { setShelf(i); setQuery(''); window.scrollTo({ top: 0, behavior: 'smooth' }) }

  // A search looks through every shelf; otherwise it's the shelf you're standing at.
  const q = query.trim().toLowerCase()
  const visible = (q
    ? sections.flatMap((s) => s.rows.filter(({ item }) => item.name.toLowerCase().includes(q)).map((r) => ({ ...r, section: s })))
    : (current?.rows ?? []).map((r) => ({ ...r, section: current! })))
    .filter(({ row, section }) => filter === 'all' || !entered(row, section.locationId))
  const shelfValue = current ? countTotal(current.rows.map(({ row }) => ({ qty: qtyAt(row, current.locationId), unit_cost: row.unit_cost }))) : 0

  const outline = 'btn btn-sm h-9 font-medium'
  const icon = (d: string) => <svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden><path d={d} /></svg>

  return (
    <div className="flex min-h-[calc(100dvh-8rem)] flex-col">
      <div className="flex flex-wrap items-end justify-between gap-4">
        <div>
          <div className="text-[13px] font-medium text-accent">{final ? 'Finished count' : 'Close of trade'}</div>
          <h1 className="mt-0.5 text-2xl font-semibold tracking-[-0.02em]">Stock on {fmtDay(count.count_date)}</h1>
          <p className="mt-1 text-muted">{final ? 'This week’s figures use it.' : 'Enter what’s on the shelf, in the order you walk the store.'}</p>
        </div>
        <div className="flex gap-2">
          <Link to="/food/catalogue?tab=layout" className={outline}>{icon('M3 3h7v7H3zM14 3h7v7h-7zM14 14h7v7h-7zM3 14h7v7H3z')}Store layout</Link>
          <Link to="/stock" className={outline}>{icon('M8 6h13M8 12h13M8 18h13M3.5 6h.01M3.5 12h.01M3.5 18h.01')}All counts</Link>
        </div>
      </div>

      <div className="mt-4 space-y-2 empty:hidden">
        <ErrorBox error={lines.error || saveLines.error || saveCount.error || removeCount.error || topUp.error} />
        {previous && (
          <p className="text-sm text-muted">
            Last counted {fmtDay(previous.count_date)} — {aud(previous.value)} on hand. The “was” figures are from that count.
          </p>
        )}
        {missing > 0 && !final && (
          <p className="flex flex-wrap items-center gap-2 rounded-[10px] border border-warn-line bg-warn-bg px-3 py-2 text-sm text-warn-ink">
            {missing} new {missing === 1 ? 'item isn’t' : 'items aren’t'} on this sheet yet.
            <button type="button" className="btn btn-sm" disabled={topUp.isPending} onClick={() => topUp.mutate(count.count_date)}>
              {topUp.isPending ? 'Adding…' : 'Add them'}
            </button>
          </p>
        )}
        {!final && rows.length > 0 && !(locations.data ?? []).length && (
          <p className="text-sm text-muted">
            Tip: set up your shelves and fridge doors so this sheet follows your walk round the store.{' '}
            <Link className="font-semibold text-accent" to="/food/catalogue?tab=layout">Store layout →</Link>
          </p>
        )}
      </div>

      {lines.isLoading ? <Loading /> : rows.length === 0 ? (
        <p className="card mt-5 px-4 py-8 text-center text-sm text-muted">
          Nothing to count. Add stock items in <Link className="font-semibold text-accent" to="/food/catalogue">Food → Catalogue</Link>.
        </p>
      ) : (
        <div className="mt-5 flex flex-1 flex-wrap items-start gap-4">
          {/* Phone: the shelves as a row of chips. */}
          <div className="-mx-4 flex w-[calc(100%+2rem)] gap-2 overflow-x-auto px-4 pb-0.5 [scrollbar-width:none] desk:hidden">
            {sections.map((s, i) => (
              <button key={s.key || 'loose'} type="button" onClick={() => go(i)}
                className={`flex h-10 shrink-0 items-center gap-2 whitespace-nowrap rounded-full border pl-2 pr-3 text-[13px] font-medium ${
                  i === at ? 'border-accent-tint-line bg-accent-tint text-accent' : 'border-line bg-surface text-ink-2'}`}>
                <ShelfNumber n={i + 1} done={progress[i].done === progress[i].of} size={22} />
                {s.name}<span className="num font-normal text-muted">{progress[i].done}/{progress[i].of}</span>
              </button>
            ))}
          </div>

          {/* Computer: the walk down the side, with how far through each shelf you are. */}
          <aside className="card sticky top-4 hidden max-h-[calc(100dvh-7rem)] max-w-[280px] flex-[1_1_240px] overflow-y-auto p-2 desk:block">
            <div className="px-2.5 pb-1.5 pt-2 text-[11px] font-medium uppercase tracking-[0.04em] text-faint">Walk order</div>
            {sections.map((s, i) => (
              <button key={s.key || 'loose'} type="button" onClick={() => go(i)}
                className={`flex w-full flex-col gap-1.5 rounded-lg p-2.5 text-left ${i === at ? 'bg-accent-tint' : 'hover:bg-surface-2'}`}>
                <span className="flex w-full items-center gap-2">
                  <ShelfNumber n={i + 1} done={progress[i].done === progress[i].of} size={20} />
                  <span className={`flex-1 text-[13px] font-medium ${i === at ? 'text-accent' : ''}`}>{s.name}</span>
                  <span className="num text-xs text-muted">{progress[i].done}/{progress[i].of}</span>
                </span>
                <span className="ml-7 block h-1 w-[calc(100%-28px)] overflow-hidden rounded-sm bg-track">
                  <span className="block h-1 rounded-sm bg-accent" style={{ width: `${(progress[i].done / progress[i].of) * 100}%` }} />
                </span>
              </button>
            ))}
          </aside>

          <section className="card min-w-0 flex-[999_1_520px] overflow-hidden">
            <div className="flex flex-wrap items-center gap-3 border-b border-line px-3.5 py-3 desk:px-5">
              <div className="min-w-40 flex-1">
                <div className="text-base font-semibold">{q ? `Matching “${query.trim()}”` : current?.name}</div>
                <div className="num text-xs text-muted">
                  {q ? `${visible.length} found across every shelf` : `${progress[at]?.done ?? 0} of ${current?.rows.length ?? 0} counted · ${aud(shelfValue)}`}
                </div>
              </div>
              <label className="flex h-9 w-full items-center gap-2 rounded-lg border border-input-line px-2.5 focus-within:border-accent desk:w-[220px]">
                {icon('m21 21-4.3-4.3M11 19a8 8 0 1 0 0-16 8 8 0 0 0 0 16z')}
                <input value={query} onChange={(e) => setQuery(e.target.value)} placeholder="Find item" aria-label="Find item"
                  className="min-w-0 flex-1 bg-transparent text-base outline-none focus-visible:outline-none desk:text-[13px]" />
              </label>
              <Segmented ariaLabel="Show" value={filter} onChange={setFilter} options={[{ value: 'all', label: 'All' }, { value: 'todo', label: 'Not counted' }]} />
            </div>
            <div className="hidden grid-cols-[minmax(0,1fr)_150px_100px] gap-4 border-b border-line bg-hover px-5 py-2.5 text-xs font-medium text-muted desk:grid">
              <span>Item</span><span className="text-center">On shelf</span><span className="text-right">Value</span>
            </div>

            {visible.map(({ item, row, section }) => {
              const loc = section.locationId
              const split = loc ? splitOf(row) : null
              const done = entered(row, loc)
              const prev = previousLine.get(item.id)
              // Last time's figure for this place when it was split then too, else the whole.
              const was = loc && split && prev?.place_qty ? prev.place_qty[loc] : prev?.qty
              const value = aud(countLineValue({ qty: qtyAt(row, split ? loc : null), unit_cost: row.unit_cost }))
              return (
                <div key={`${section.key}:${row.id}`}
                  className="grid grid-cols-[minmax(0,1fr)_128px] items-center gap-3 border-b border-line-2 px-3.5 py-3 desk:grid-cols-[minmax(0,1fr)_150px_100px] desk:gap-4 desk:px-5">
                  <div className="flex min-w-0 items-center gap-3">
                    <span className={`grid h-[18px] w-[18px] shrink-0 place-items-center rounded-full border-[1.5px] ${done ? 'border-accent bg-accent text-accent-ink' : 'border-input-line'}`}>
                      {done && <svg viewBox="0 0 24 24" width="11" height="11" fill="none" stroke="currentColor" strokeWidth="3.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden><path d="M20 6 9 17l-5-5" /></svg>}
                    </span>
                    <div className="min-w-0">
                      <div className="text-sm font-medium leading-tight desk:truncate">{item.name}</div>
                      <div className="num text-xs text-muted">
                        {q ? `${section.name} · ` : loc && item.group_id && groupName.has(item.group_id) ? `${groupName.get(item.group_id)} · ` : ''}
                        {aud(row.unit_cost)}/{item.unit}
                        {was != null && was > 0 && ` · was ${qtyStr(was)}`}
                        <span className={`desk:hidden ${done ? 'font-semibold text-ink' : ''}`}> · {value}</span>
                      </div>
                      {split && (
                        <div className="truncate text-xs text-accent">
                          Also at {split.filter((l) => l !== loc).map((l) => locName.get(l)).join(', ')} · total {qtyStr(qtyOf(row))} {item.unit}
                        </div>
                      )}
                    </div>
                  </div>
                  {final ? (
                    <span className="num text-center text-sm text-ink-2">{qtyStr(qtyAt(row, split ? loc : null))} {item.unit}</span>
                  ) : (
                    <div className={`flex h-10 items-center overflow-hidden rounded-lg border bg-surface desk:h-9 ${done ? 'border-accent-tint-line' : 'border-input-line'}`}>
                      <button type="button" aria-label={`One less ${item.name}`} onClick={() => step(row, loc, -1)}
                        className="h-full w-10 border-r border-track text-base text-ink-2 hover:bg-hover desk:w-9">−</button>
                      <input aria-label={`${item.name} quantity in ${item.unit}`} inputMode="decimal" placeholder="–"
                        className="num h-full w-full min-w-0 flex-1 bg-transparent text-center text-[15px] font-semibold outline-none focus-visible:outline-none"
                        value={shownStr(row, loc)} onChange={(e) => setDraft({ ...draft, [keyOf(row, loc)]: e.target.value })} />
                      <button type="button" aria-label={`One more ${item.name}`} onClick={() => step(row, loc, 1)}
                        className="h-full w-10 border-l border-track text-base text-ink-2 hover:bg-hover desk:w-9">+</button>
                    </div>
                  )}
                  <span className={`num hidden text-right font-semibold desk:block ${done ? '' : 'text-faint'}`}>{value}</span>
                </div>
              )
            })}
            {visible.length === 0 && (
              <p className="py-10 text-center text-muted">{q ? 'No items match your search.' : filter === 'todo' ? 'Everything on this shelf is counted.' : 'Nothing on this shelf.'}</p>
            )}
            {!q && (
              <div className="flex items-center justify-between gap-3 px-3.5 py-3 desk:px-5">
                <button type="button" className={outline} disabled={at === 0} onClick={() => go(at - 1)}>← {at > 0 ? sections[at - 1].name : 'Start'}</button>
                <button type="button" className={outline} disabled={at >= sections.length - 1} onClick={() => go(at + 1)}>
                  {at < sections.length - 1 ? sections[at + 1].name : 'Last shelf'} →
                </button>
              </div>
            )}
          </section>
        </div>
      )}

      {rows.length > 0 && (
        <section className="card mt-4 p-4 desk:p-5">
          <label className="label" htmlFor="count-note">Note <span className="font-normal text-faint">(optional)</span></label>
          <input id="count-note" className="field" defaultValue={count.note ?? ''} disabled={final}
            placeholder="Who counted, anything odd…"
            onBlur={(e) => e.target.value !== (count.note ?? '') && saveCount.mutate({ id: count.id, note: e.target.value || null })} />
          <div className="mt-4 flex flex-wrap items-center gap-2 border-t border-line pt-4">
            {final ? (
              <button type="button" className="btn" disabled={saveCount.isPending} onClick={() => saveCount.mutate({ id: count.id, status: 'open' })}>
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
          {!final && <p className="mt-2 text-xs text-muted">Only finished counts are used, so a half-done sheet never moves your food cost.</p>}
        </section>
      )}

      {/* Running total, progress and Save stay in reach while you work down the shelves. */}
      {!final && rows.length > 0 && (
        <div className="sticky bottom-[calc(env(safe-area-inset-bottom)+64px)] z-10 -mx-4 mt-4 flex flex-wrap items-center gap-x-3 gap-y-2 border-t border-line bg-surface/95 px-4 py-2.5 backdrop-blur desk:bottom-0 desk:-mx-8 desk:gap-6 desk:px-8 desk:py-3.5">
          <div>
            <div className="text-xs text-muted">Stock on hand</div>
            <div className="num text-[22px] font-semibold tracking-[-0.02em]">{aud(total)}</div>
          </div>
          <div className="min-w-[100px] max-w-[360px] flex-1 desk:min-w-[180px]">
            <div className="num flex justify-between text-xs text-muted"><span>Counted</span><span>{countedAll} of {rowsAll} items</span></div>
            <div className="mt-1.5 h-1.5 overflow-hidden rounded-[3px] bg-track">
              <div className="h-1.5 rounded-[3px] bg-accent" style={{ width: `${rowsAll ? (countedAll / rowsAll) * 100 : 0}%` }} />
            </div>
          </div>
          <span className="ml-auto hidden text-xs text-muted desk:block">{dirty.length ? 'Unsaved changes' : 'All changes saved'}</span>
          <button type="button" className={`btn h-10 px-[18px] ${dirty.length ? 'btn-primary' : 'btn-saved'}`} disabled={!dirty.length || saveLines.isPending} onClick={save}>
            {saveLines.isPending ? 'Saving…' : dirty.length ? 'Save count' : 'Saved'}
          </button>
        </div>
      )}
    </div>
  )
}

/** The numbered circle for a shelf: filled teal once everything on it is counted. */
function ShelfNumber({ n, done, size }: { n: number; done: boolean; size: number }) {
  return (
    <span style={{ width: size, height: size }}
      className={`grid shrink-0 place-items-center rounded-full text-[11px] font-semibold ${done ? 'bg-accent text-accent-ink' : 'bg-surface-2 text-ink-2'}`}>
      {n}
    </span>
  )
}
