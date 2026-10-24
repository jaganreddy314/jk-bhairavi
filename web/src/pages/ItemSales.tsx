import { useState } from 'react'
import { Link } from 'react-router-dom'
import { useEarliestSale, useItemSalesRows, useItemSalesWeekly, useSaveItemSales, useStockGroups, useStockItems } from '../lib/api'
import { fmtDay, fmtLong, fmtShort } from '../lib/dates'
import { aud, audRound, cents, pct } from '../lib/format'
import { pickWeek, usePeriodRange, type Period } from '../lib/period'
import { qtyStr } from '../lib/purchasing'
import type { ItemSale, ItemSalesWeek, StockGroup, StockItem } from '../lib/types'
import { TipBox, usePalette, WeekBars } from '../components/charts'
import { bySection, FoodHeader, sectionKey } from '../components/catalogue'
import { PeriodControls } from '../components/PeriodControls'
import { DeleteButton, Empty, ErrorBox, Kpi, KPI_GRID, Loading, SearchBox, Segmented } from '../components/ui'

export default function ItemSales() {
  const earliest = useEarliestSale()
  const { period, all, inPeriod, shown, shownFrom, from, to } = usePeriodRange(earliest.data ?? null)
  const weekly = useItemSalesWeekly(shownFrom, all[all.length - 1])
  const entries = useItemSalesRows(from, to)
  const items = useStockItems()
  const groups = useStockGroups()

  return (
    <div>
      <FoodHeader sub="What each product sold, week by week (Monday to Sunday)."
        action={
          <Link to="/food/sales/add" className="btn btn-primary">
            <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" aria-hidden><path d="M5 12h14M12 5v14" /></svg>
            Add sales
          </Link>
        } />
      <div className="flex flex-wrap items-center gap-2">
        <PeriodControls period={period} weeks={all} />
        <span className="num text-[13px] text-muted">{fmtLong(from)} – {fmtLong(to)}</span>
      </div>
      <div className="mt-4"><ErrorBox error={weekly.error || entries.error} /></div>
      {earliest.isLoading || weekly.isLoading || items.isLoading || groups.isLoading ? <Loading /> : (
        <Body rows={weekly.data ?? []} items={items.data ?? []} groups={groups.data ?? []}
          period={period} shown={shown} inPeriod={inPeriod} entries={entries.data ?? []} />
      )}
    </div>
  )
}

interface ItemTotal { item: StockItem; qty: number; amount: number; byWeek: Map<string, ItemSalesWeek> }
type Sort = 'amount' | 'qty' | 'name'
type Show = 'all' | 'sold' | 'unsold'
const PAGE = 100

function Body({ rows, items, groups, period, shown, inPeriod, entries }: {
  rows: ItemSalesWeek[]; items: StockItem[]; groups: StockGroup[]; period: Period; shown: string[]; inPeriod: string[]; entries: ItemSale[]
}) {
  const p = usePalette()
  const [cat, setCat] = useState('all')
  const [sort, setSort] = useState<Sort>('amount')
  const [open, setOpen] = useState<string | null>(null)
  const [show, setShow] = useState<Show>('all')
  const [q, setQ] = useState('')
  const [limit, setLimit] = useState(PAGE)

  if (rows.length === 0)
    return (
      <Empty>
        No item sales entered yet. <Link className="font-semibold text-accent" to="/food/sales/add">Add a week’s report</Link>{' '}
        — or a single day’s figures.
      </Empty>
    )

  const periodSet = new Set(inPeriod)
  // Only weeks somebody entered figures for can say what didn't sell.
  const weeksWithData = shown.filter((w) => rows.some((r) => r.week_start === w))
  const periodWithData = weeksWithData.filter((w) => periodSet.has(w))
  // "vs last week" compares the period's latest week with figures against the one before it.
  const lastWeek = periodWithData[periodWithData.length - 1]
  const prevWeek = lastWeek ? weeksWithData[weeksWithData.indexOf(lastWeek) - 1] : undefined

  // Every active product, sold or not — plus a hidden one if it still sold something.
  const itemById = new Map(items.map((i) => [i.id, i]))
  const groupName = new Map(groups.map((g) => [g.id, g.name]))
  const totals = new Map<string, ItemTotal>(
    items.filter((i) => i.active).map((i) => [i.id, { item: i, qty: 0, amount: 0, byWeek: new Map() }]),
  )
  for (const r of rows) {
    const item = itemById.get(r.item_id)
    if (!item) continue
    const t = totals.get(r.item_id) ?? { item, qty: 0, amount: 0, byWeek: new Map() }
    t.byWeek.set(r.week_start, r)
    if (periodSet.has(r.week_start)) {
      t.qty += r.qty
      t.amount = cents(t.amount + r.amount)
    }
    totals.set(r.item_id, t)
  }

  const isSold = (t: ItemTotal) => t.qty > 0 || t.amount > 0
  const everything = [...totals.values()]
  const needle = q.trim().toLowerCase()
  const searched = everything.filter((t) => !needle || t.item.name.toLowerCase().includes(needle))
  // The category list is scoped to what the search leaves, so every option has something in it.
  const sections = bySection(searched.map((t) => t.item), groups)
  const current = sections.some((s) => s.key === cat) ? cat : 'all'
  const inCat = (t: ItemTotal) => current === 'all' || sectionKey(t.item) === current
  const catAll = searched.filter(inCat)
  const catSold = catAll.filter(isSold)
  const shownRows = catAll.filter((t) => show === 'all' || (show === 'sold') === isSold(t))
  const sorted = [...shownRows].sort((a, b) =>
    sort === 'name' ? a.item.name.localeCompare(b.item.name)
      : (sort === 'qty' ? b.qty - a.qty : b.amount - a.amount) || a.item.name.localeCompare(b.item.name))

  // Tiles count the chosen category across sold and unsold alike, whatever the list is showing.
  const viewAmount = cents(catSold.reduce((s, t) => s + t.amount, 0))
  const viewQty = catSold.reduce((s, t) => s + t.qty, 0)
  const best = [...catSold].sort((a, b) => b.amount - a.amount)[0]
  const weeksCounted = periodWithData.length
  const focus = open ? totals.get(open) : undefined
  const maxAmount = Math.max(1, ...catSold.map((t) => t.amount))

  const chart = shown.map((w) => {
    const list = focus ? [focus] : catAll
    return {
      week: w, label: fmtShort(w), on: periodSet.has(w),
      values: [cents(list.reduce((s, t) => s + (t.byWeek.get(w)?.amount ?? 0), 0))],
      qty: list.reduce((s, t) => s + (t.byWeek.get(w)?.qty ?? 0), 0),
    }
  })

  return (
    <div className="grid gap-4">
      <div className={KPI_GRID}>
        <Kpi label="Sales" value={audRound(viewAmount)} note={`${weeksCounted} ${weeksCounted === 1 ? 'week' : 'weeks'} with figures`} />
        <Kpi label="Units sold" value={Math.round(viewQty).toLocaleString('en-AU')}
          note={weeksCounted > 1 ? `${Math.round(viewQty / weeksCounted).toLocaleString('en-AU')} a week` : undefined} />
        <Kpi label="Products sold" value={catSold.length.toLocaleString('en-AU')}
          note={`${(catAll.length - catSold.length).toLocaleString('en-AU')} didn’t sell · ${catAll.length.toLocaleString('en-AU')} in all`} />
        <Kpi label="Best seller" value={best?.item.name ?? '—'} small
          note={best ? `${audRound(best.amount)} · ${pct(viewAmount ? best.amount / viewAmount : 0)} of sales` : undefined} />
      </div>

      <section className="card min-w-0 p-4 desk:p-5">
        <div className="mb-3">
          <h2 className="text-base font-semibold">{focus ? `${focus.item.name} by week` : 'Sales by week'}</h2>
          <p className="mt-0.5 text-[13px] text-muted">
            {focus
              ? <button type="button" className="text-accent" onClick={() => setOpen(null)}>← Back to all products</button>
              : 'Monday to Sunday. Tap a week’s bar to see just that week.'}
          </p>
        </div>
        <WeekBars cols={chart} colors={[p['c-sales']]} height={200}
          selected={period.week} highlight={period.mode === 'week'} onPick={(w) => pickWeek(period, w)}
          ariaLabel={(c) => `Week of ${fmtShort(c.week)}: ${aud(c.values[0])}`}
          tip={(c) => <TipBox title={`Week of ${fmtDay(c.week)}`} rows={[
            { label: 'Sales', value: aud(c.values[0]), strong: true, color: p['c-sales'] },
            { label: 'Units', value: qtyStr(c.qty) },
          ]} />} />
      </section>

      <section className="card min-w-0 overflow-hidden">
        <div className="flex flex-wrap items-center gap-2.5 border-b border-line px-3.5 py-3 desk:px-5">
          <h2 className="min-w-[120px] flex-1 text-base font-semibold">By product</h2>
          <span className="text-xs text-muted">Sort</span>
          <Segmented ariaLabel="Sort by" value={sort} onChange={setSort}
            options={[{ value: 'amount', label: 'Sales' }, { value: 'qty', label: 'Units' }, { value: 'name', label: 'A–Z' }]} />
        </div>
        <div className="flex flex-wrap items-center gap-2.5 border-b border-line px-3.5 py-3 desk:px-5">
          <Segmented ariaLabel="Which products" value={show} onChange={(v) => { setShow(v); setLimit(PAGE) }} options={[
            { value: 'all', label: `All ${catAll.length.toLocaleString('en-AU')}` },
            { value: 'sold', label: `Sold ${catSold.length.toLocaleString('en-AU')}` },
            { value: 'unsold', label: `Not sold ${(catAll.length - catSold.length).toLocaleString('en-AU')}` },
          ]} />
          <select aria-label="Category" className="field !h-9 !w-auto !py-0 !text-[13px]" value={current}
            onChange={(e) => { setCat(e.target.value); setOpen(null); setLimit(PAGE) }}>
            <option value="all">All categories · {searched.length.toLocaleString('en-AU')}</option>
            {sections.map((s) => <option key={s.key} value={s.key}>{s.label} · {s.items.length}</option>)}
          </select>
          <SearchBox value={q} onChange={(v) => { setQ(v); setLimit(PAGE) }} placeholder="Search products" />
        </div>
        <div className="hidden grid-cols-[minmax(0,1fr)_70px_110px_64px_110px] gap-4 border-b border-line bg-hover px-5 py-2.5 text-xs font-medium text-muted desk:grid">
          <span>Product</span><span className="text-right">Units</span><span className="text-right">Sales</span><span className="text-right">Share</span>
          <span className="text-right" title={lastWeek && prevWeek ? `Week of ${fmtShort(lastWeek)} against week of ${fmtShort(prevWeek)}` : undefined}>vs last week</span>
        </div>
        {sorted.length === 0 && (
          <p className="py-10 text-center text-muted">
            {show === 'unsold' ? 'Everything here sold something.' : show === 'sold' ? 'Nothing here sold.' : 'No products match.'}
          </p>
        )}
        {sorted.slice(0, limit).map((t) => {
          const isOpen = open === t.item.id
          const sold = isSold(t)
          const share = viewAmount ? t.amount / viewAmount : 0
          const change = <Trend now={lastWeek ? t.byWeek.get(lastWeek)?.qty ?? 0 : 0} before={prevWeek ? t.byWeek.get(prevWeek)?.qty ?? 0 : 0} />
          return (
            <div key={t.item.id} className="border-b border-line-2">
              <button type="button" aria-expanded={isOpen} onClick={() => setOpen(isOpen ? null : t.item.id)}
                className={`num grid w-full grid-cols-[minmax(0,1fr)_auto] items-center gap-3 px-3.5 py-3 text-left hover:bg-hover desk:grid-cols-[minmax(0,1fr)_70px_110px_64px_110px] desk:gap-4 desk:px-5 ${
                  isOpen ? 'bg-hover' : ''} ${sold ? '' : 'text-muted'}`}>
                <span className="min-w-0">
                  <span className="block font-medium desk:truncate">{t.item.name}</span>
                  <span className="mt-0.5 block text-xs text-muted">
                    {groupName.get(t.item.group_id ?? '') ?? 'No category'}
                    <span className="desk:hidden"> · {qtyStr(t.qty)} units · </span>
                    <span className="desk:hidden">{change}</span>
                  </span>
                  <span className="mt-1.5 block h-[3px] max-w-[420px] rounded-sm bg-surface-2">
                    {sold && <span className="block h-[3px] rounded-sm bg-accent" style={{ width: `${Math.max(2, (t.amount / maxAmount) * 100)}%` }} />}
                  </span>
                </span>
                <span className="hidden text-right text-ink-2 desk:block">{qtyStr(t.qty)}</span>
                <span className="text-right font-semibold">{aud(t.amount)}</span>
                <span className="hidden text-right text-ink-2 desk:block">{sold ? pct(share) : '—'}</span>
                <span className="hidden text-right text-[13px] desk:block">{change}</span>
              </button>
              {isOpen && <WeekBreakdown total={t} weeks={weeksWithData} />}
            </div>
          )
        })}
        <div className="flex flex-wrap items-center gap-3 px-3.5 py-3 text-xs text-muted desk:px-5">
          <span className="flex-1">Showing {Math.min(limit, sorted.length).toLocaleString('en-AU')} of {sorted.length.toLocaleString('en-AU')} products</span>
          {sorted.length > limit && (
            <button type="button" className="btn btn-sm" onClick={() => setLimit(limit + PAGE * 5)}>Show more</button>
          )}
        </div>
      </section>

      <Entries entries={entries} />
    </div>
  )
}

/** Units this week against last, as an arrow and a percentage. */
function Trend({ now: a, before: b }: { now: number; before: number }) {
  if (!a && !b) return <span className="text-faint">—</span>
  if (!b) return <span className="font-medium text-accent">new</span>
  const change = (a - b) / b
  if (Math.abs(change) < 0.005) return <span className="text-faint">same</span>
  return <span className={`font-medium ${change > 0 ? 'text-good' : 'text-bad'}`}>{change > 0 ? '▲' : '▼'} {pct(Math.abs(change))}</span>
}

function WeekBreakdown({ total, weeks }: { total: ItemTotal; weeks: string[] }) {
  return (
    <div className="bg-hover px-3.5 pb-3 desk:px-5">
      <table className="num w-full max-w-xl text-sm">
        <thead className="text-xs text-muted">
          <tr><th className="py-1.5 text-left font-medium">Week of</th><th className="py-1.5 text-right font-medium">Units</th><th className="py-1.5 text-right font-medium">Sales</th><th className="py-1.5 text-right font-medium">Avg price</th></tr>
        </thead>
        <tbody className="divide-y divide-line">
          {[...weeks].reverse().map((w) => {
            const r = total.byWeek.get(w)
            return (
              <tr key={w} className={r ? '' : 'text-muted'}>
                <td className="py-1.5">{fmtShort(w)}{r?.from_days && <span className="ml-1 text-xs text-muted">(days)</span>}</td>
                <td className="py-1.5 text-right">{r ? qtyStr(r.qty) : '—'}</td>
                <td className="py-1.5 text-right">{r ? aud(r.amount) : '—'}</td>
                <td className="py-1.5 text-right">{r && r.qty ? aud(r.amount / r.qty) : '—'}</td>
              </tr>
            )
          })}
        </tbody>
      </table>
      <p className="mt-1 text-xs text-muted">“(days)” means the week was added up from daily figures.</p>
    </div>
  )
}

/** What has been entered in the period: one line per week or day, to open again or remove. */
function Entries({ entries }: { entries: ItemSale[] }) {
  const remove = useSaveItemSales()
  const periods = new Map<string, { start: string; end: string; count: number; amount: number }>()
  for (const e of entries) {
    const key = `${e.period_start}|${e.period_end}`
    const p = periods.get(key) ?? { start: e.period_start, end: e.period_end, count: 0, amount: 0 }
    p.count++
    p.amount = cents(p.amount + e.amount)
    periods.set(key, p)
  }
  if (!periods.size) return null
  return (
    <section className="card overflow-hidden">
      <div className="border-b border-line px-3.5 py-3 desk:px-5">
        <h2 className="text-base font-semibold">Entered</h2>
        <p className="mt-0.5 text-[13px] text-muted">The reports and days added for this period.</p>
      </div>
      <ErrorBox error={remove.error} />
      {[...periods.values()].map((p) => {
        const day = p.start === p.end
        return (
          <div key={p.start + p.end} className="flex flex-wrap items-center gap-2 border-b border-line-2 px-3.5 py-3 last:border-0 desk:px-5">
            <span className="min-w-0 flex-1">
              <span className="font-medium">{day ? fmtDay(p.start) : `Week ${fmtShort(p.start)} – ${fmtShort(p.end)}`}</span>
              <span className="num ml-2 text-[13px] text-muted">{p.count} {p.count === 1 ? 'product' : 'products'} · {aud(p.amount)}</span>
            </span>
            <Link className="btn btn-sm" to={`/food/sales/add?kind=${day ? 'day' : 'week'}&date=${p.start}&source=manual`}>Edit</Link>
            <DeleteButton busy={remove.isPending} onConfirm={() => remove.mutate({ start: p.start, end: p.end, lines: [] })} />
          </div>
        )
      })}
    </section>
  )
}
