import { useState } from 'react'
import { Link } from 'react-router-dom'
import { Bar, BarChart, CartesianGrid, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts'
import { useEarliestSale, useItemSalesRows, useItemSalesWeekly, useSaveItemSales, useStockGroups, useStockItems } from '../lib/api'
import { addDays, fmtDay, fmtShort, weekStart } from '../lib/dates'
import { aud, audRound, audShort, cents, pct } from '../lib/format'
import { qtyStr } from '../lib/purchasing'
import type { ItemSale, ItemSalesWeek, StockGroup, StockItem } from '../lib/types'
import { RangeFilter, useRange } from '../components/RangeFilter'
import { axisProps, ChartCard, TipBox, usePalette } from '../components/charts'
import { bySection, CategoryChips, FoodTabs, sectionKey } from '../components/catalogue'
import { DeleteButton, Empty, ErrorBox, Loading } from '../components/ui'

export default function ItemSales() {
  const earliest = useEarliestSale().data ?? null
  const [range, setRange] = useRange('range:itemsales', '4weeks', earliest)
  const from = weekStart(range.from)
  const weekly = useItemSalesWeekly(from, range.to)
  const entries = useItemSalesRows(from, range.to)
  const items = useStockItems()
  const groups = useStockGroups()

  return (
    <div>
      <FoodTabs />
      <div className="mb-4 flex flex-wrap items-center justify-between gap-2">
        <p className="text-sm text-muted">What each product sold, week by week (Monday to Sunday).</p>
        <Link to="/food/sales/add" className="btn btn-primary btn-sm">+ Add sales</Link>
      </div>
      <div className="mb-4"><RangeFilter range={range} onChange={setRange} earliest={earliest} /></div>
      <ErrorBox error={weekly.error || entries.error} />
      {weekly.isLoading || items.isLoading || groups.isLoading ? <Loading /> : (
        <Body
          rows={weekly.data ?? []}
          items={items.data ?? []}
          groups={groups.data ?? []}
          weeks={weeksIn(from, range.to)}
          entries={entries.data ?? []}
        />
      )}
    </div>
  )
}

const weeksIn = (from: string, to: string) => {
  const out: string[] = []
  for (let w = from; w <= to; w = addDays(w, 7)) out.push(w)
  return out
}

interface ItemTotal { item: StockItem; qty: number; amount: number; byWeek: Map<string, ItemSalesWeek> }
type Sort = 'amount' | 'qty' | 'name'

function Body({ rows, items, groups, weeks, entries }: {
  rows: ItemSalesWeek[]; items: StockItem[]; groups: StockGroup[]; weeks: string[]; entries: ItemSale[]
}) {
  const p = usePalette()
  const [cat, setCat] = useState('all')
  const [sort, setSort] = useState<Sort>('amount')
  const [open, setOpen] = useState<string | null>(null)

  if (rows.length === 0)
    return (
      <Empty>
        No item sales in this range yet. <Link className="font-semibold text-accent" to="/food/sales/add">Add a week’s report</Link>{' '}
        — or a single day’s figures.
      </Empty>
    )

  const itemById = new Map(items.map((i) => [i.id, i]))
  const totals = new Map<string, ItemTotal>()
  for (const r of rows) {
    const item = itemById.get(r.item_id)
    if (!item) continue
    const t = totals.get(r.item_id) ?? { item, qty: 0, amount: 0, byWeek: new Map() }
    t.qty += r.qty
    t.amount = cents(t.amount + r.amount)
    t.byWeek.set(r.week_start, r)
    totals.set(r.item_id, t)
  }

  const sold = [...totals.values()]
  const sections = bySection(sold.map((t) => t.item), groups)
  const current = sections.some((s) => s.key === cat) ? cat : 'all'
  const inView = sold.filter((t) => current === 'all' || sectionKey(t.item) === current)
  const sorted = [...inView].sort((a, b) =>
    sort === 'name' ? a.item.name.localeCompare(b.item.name) : sort === 'qty' ? b.qty - a.qty : b.amount - a.amount)

  const viewAmount = cents(inView.reduce((s, t) => s + t.amount, 0))
  const viewQty = inView.reduce((s, t) => s + t.qty, 0)
  const best = [...inView].sort((a, b) => b.amount - a.amount)[0]
  const weeksWithData = weeks.filter((w) => inView.some((t) => t.byWeek.has(w)))
  const focus = open ? totals.get(open) : undefined
  const lastWeek = weeksWithData[weeksWithData.length - 1]
  const prevWeek = weeksWithData[weeksWithData.length - 2]

  const chart = weeks.map((w) => {
    const list = focus ? [focus] : inView
    return {
      week: w,
      label: fmtShort(w),
      amount: cents(list.reduce((s, t) => s + (t.byWeek.get(w)?.amount ?? 0), 0)),
      qty: list.reduce((s, t) => s + (t.byWeek.get(w)?.qty ?? 0), 0),
    }
  })

  return (
    <div className="grid gap-4">
      <CategoryChips
        sections={sections.map((s) => ({ key: s.key, label: s.label, count: s.items.length }))}
        value={current} onChange={(k) => { setCat(k); setOpen(null) }} total={sold.length} />

      <section className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        <Tile label="Sales" value={audRound(viewAmount)} sub={`${weeksWithData.length} ${weeksWithData.length === 1 ? 'week' : 'weeks'} with figures`} />
        <Tile label="Units sold" value={qtyStr(Math.round(viewQty))} sub={weeksWithData.length ? `${qtyStr(Math.round(viewQty / weeksWithData.length))} a week` : ''} />
        <Tile label="Products sold" value={String(inView.filter((t) => t.qty > 0 || t.amount > 0).length)} sub={`of ${items.filter((i) => i.active).length} in the catalogue`} />
        <Tile label="Best seller" value={best?.item.name ?? '—'} sub={best ? `${audRound(best.amount)} · ${pct(viewAmount ? best.amount / viewAmount : 0)} of sales` : ''} small />
      </section>

      <ChartCard
        title={focus ? `${focus.item.name} by week` : 'Sales by week'}
        subtitle={focus ? <button type="button" className="text-accent" onClick={() => setOpen(null)}>← Back to all products</button> : 'Tap a product below to see it on its own.'}
      >
        <ResponsiveContainer width="100%" height={220}>
          <BarChart data={chart} margin={{ top: 4, right: 4, left: -16, bottom: 0 }}>
            <CartesianGrid stroke={p.line} vertical={false} />
            <XAxis dataKey="label" {...axisProps(p)} />
            <YAxis tickFormatter={audShort} {...axisProps(p)} />
            <Tooltip cursor={{ fill: p.line, opacity: 0.4 }} content={({ active, payload }) => {
              const d = active ? (payload?.[0]?.payload as (typeof chart)[number] | undefined) : undefined
              return d ? <TipBox title={`Week of ${fmtDay(d.week)}`} rows={[
                { label: 'Sales', value: aud(d.amount), strong: true, color: p['c-sales'] },
                { label: 'Units', value: qtyStr(d.qty) },
              ]} /> : null
            }} />
            <Bar dataKey="amount" fill={p['c-sales']} radius={[3, 3, 0, 0]} maxBarSize={40} />
          </BarChart>
        </ResponsiveContainer>
      </ChartCard>

      <section className="card p-4">
        <div className="mb-2 flex flex-wrap items-center justify-between gap-2">
          <h2 className="font-semibold">By product</h2>
          <div role="group" aria-label="Sort by" className="flex gap-1.5">
            {([['amount', 'Sales'], ['qty', 'Units'], ['name', 'A–Z']] as const).map(([v, l]) => (
              <button key={v} type="button" className="chip !py-1 !text-xs" aria-pressed={sort === v} onClick={() => setSort(v)}>{l}</button>
            ))}
          </div>
        </div>
        <div className="grid grid-cols-[1fr_4.5rem_5.5rem] gap-2 border-b border-line py-1 text-xs text-muted sm:grid-cols-[1fr_4.5rem_6rem_4.5rem_5rem]">
          <span>Product</span><span className="text-right">Units</span><span className="text-right">Sales</span>
          <span className="hidden text-right sm:block">Share</span>
          <span className="hidden text-right sm:block" title={lastWeek && prevWeek ? `Week of ${fmtShort(lastWeek)} against week of ${fmtShort(prevWeek)}` : undefined}>Last week</span>
        </div>
        <ul className="divide-y divide-line">
          {sorted.map((t) => {
            const isOpen = open === t.item.id
            const share = viewAmount ? t.amount / viewAmount : 0
            return (
              <li key={t.item.id}>
                <button type="button" aria-expanded={isOpen} onClick={() => setOpen(isOpen ? null : t.item.id)}
                  className={`grid w-full grid-cols-[1fr_4.5rem_5.5rem] items-center gap-2 py-2 text-left sm:grid-cols-[1fr_4.5rem_6rem_4.5rem_5rem] ${isOpen ? 'bg-surface-2' : ''}`}>
                  <span className="min-w-0">
                    <span className="block truncate font-medium">{t.item.name}</span>
                    {/* A bar for share of sales, so the list reads at a glance. */}
                    <span className="mt-1 block h-1 rounded-full bg-surface-2">
                      <span className="block h-1 rounded-full" style={{ width: `${Math.max(2, share * 100)}%`, background: p['c-sales'] }} />
                    </span>
                  </span>
                  <span className="num text-right text-sm">{qtyStr(t.qty)}</span>
                  <span className="num text-right text-sm font-semibold">{aud(t.amount)}</span>
                  <span className="num hidden text-right text-sm text-ink-2 sm:block">{pct(share)}</span>
                  <span className="hidden text-right sm:block"><Trend now={lastWeek ? t.byWeek.get(lastWeek)?.qty ?? 0 : 0} before={prevWeek ? t.byWeek.get(prevWeek)?.qty ?? 0 : 0} /></span>
                </button>
                {isOpen && <WeekBreakdown total={t} weeks={weeks} />}
              </li>
            )
          })}
        </ul>
      </section>

      <Entries entries={entries} />
    </div>
  )
}

/** Units this week against last, as an arrow and a percentage. */
function Trend({ now: a, before: b }: { now: number; before: number }) {
  if (!a && !b) return <span className="text-xs text-muted">—</span>
  if (!b) return <span className="text-xs font-semibold text-good">new</span>
  const change = (a - b) / b
  if (Math.abs(change) < 0.005) return <span className="num text-xs text-muted">same</span>
  return (
    <span className={`num text-xs font-semibold ${change > 0 ? 'text-good' : 'text-bad'}`}>
      {change > 0 ? '▲' : '▼'} {pct(Math.abs(change))}
    </span>
  )
}

function WeekBreakdown({ total, weeks }: { total: ItemTotal; weeks: string[] }) {
  return (
    <div className="bg-surface-2 px-3 pb-3">
      <table className="num w-full text-sm">
        <thead className="text-xs text-muted">
          <tr><th className="py-1 text-left font-semibold">Week of</th><th className="py-1 text-right font-semibold">Units</th><th className="py-1 text-right font-semibold">Sales</th><th className="py-1 text-right font-semibold">Avg price</th></tr>
        </thead>
        <tbody className="divide-y divide-line">
          {[...weeks].reverse().map((w) => {
            const r = total.byWeek.get(w)
            return (
              <tr key={w} className={r ? '' : 'text-muted'}>
                <td className="py-1">{fmtShort(w)}{r?.from_days && <span className="ml-1 text-xs text-muted">(days)</span>}</td>
                <td className="py-1 text-right">{r ? qtyStr(r.qty) : '—'}</td>
                <td className="py-1 text-right">{r ? aud(r.amount) : '—'}</td>
                <td className="py-1 text-right">{r && r.qty ? aud(r.amount / r.qty) : '—'}</td>
              </tr>
            )
          })}
        </tbody>
      </table>
      <p className="mt-1 text-xs text-muted">“(days)” means the week was added up from daily figures.</p>
    </div>
  )
}

/** What has been entered: one line per week or day, to open again or remove. */
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
    <section className="card p-4">
      <h2 className="mb-1 font-semibold">Entered</h2>
      <ErrorBox error={remove.error} />
      <ul className="divide-y divide-line">
        {[...periods.values()].map((p) => {
          const day = p.start === p.end
          return (
            <li key={p.start + p.end} className="flex flex-wrap items-center gap-2 py-2">
              <span className="min-w-0 flex-1">
                <span className="font-medium">{day ? fmtDay(p.start) : `Week ${fmtShort(p.start)} – ${fmtShort(p.end)}`}</span>
                <span className="num ml-2 text-sm text-muted">{p.count} {p.count === 1 ? 'product' : 'products'} · {aud(p.amount)}</span>
              </span>
              <Link className="btn btn-sm" to={`/food/sales/add?kind=${day ? 'day' : 'week'}&date=${p.start}&source=manual`}>Edit</Link>
              <DeleteButton busy={remove.isPending} onConfirm={() => remove.mutate({ start: p.start, end: p.end, lines: [] })} />
            </li>
          )
        })}
      </ul>
    </section>
  )
}

function Tile({ label, value, sub, small }: { label: string; value: string; sub?: string; small?: boolean }) {
  return (
    <div className="card px-4 py-3">
      <div className="text-xs text-muted">{label}</div>
      <div className={`num truncate font-bold ${small ? 'text-lg' : 'text-2xl'}`}>{value}</div>
      {sub && <div className="truncate text-xs text-muted">{sub}</div>}
    </div>
  )
}
