import { useMemo, useState } from 'react'
import { Link } from 'react-router-dom'
import {
  Bar, BarChart, CartesianGrid, Line, LineChart, ReferenceLine, ResponsiveContainer, Tooltip, XAxis, YAxis,
} from 'recharts'
import { useAllExpenses, useEarliestSale, useSales, useStaff, useSuppliers } from '../lib/api'
import { CAT_COLOR, CAT_LABEL, CHANNELS, OPERATING } from '../lib/categories'
import { addDays, eachDay, fmtDay, fmtLong, fmtShort, weekdayIdx, weekStart, WEEKDAYS } from '../lib/dates'
import { aud, audRound, audShort, cents, pct } from '../lib/format'
import { dayTotal, hasMismatch, splitSum } from '../lib/logic'
import type { AnyExpense, CategoryCode, SalesDay } from '../lib/types'
import { RangeFilter, useRange } from '../components/RangeFilter'
import { axisProps, ChartCard, Legend, TipBox, usePalette } from '../components/charts'
import { CatDot, ErrorBox, Loading } from '../components/ui'

// Recharts hands tooltip payloads over untyped; this pulls our row back out.
type TipProps = { active?: boolean; payload?: readonly { payload?: unknown }[] }
const tipRow = <T,>(p: TipProps) => (p.active && p.payload?.length ? (p.payload[0].payload as T) : null)

const sum = <T,>(xs: T[], f: (x: T) => number) => cents(xs.reduce((s, x) => s + f(x), 0))

export default function Dashboard() {
  const earliest = useEarliestSale().data ?? null
  const [range, setRange] = useRange('range:dashboard', '4weeks', earliest)
  const sales = useSales(range.from, range.to)
  const expenses = useAllExpenses(range.from, range.to)

  return (
    <div>
      <div className="mb-4">
        <h1 className="mb-2 text-2xl font-bold tracking-tight">How the shop is doing</h1>
        <RangeFilter range={range} onChange={setRange} earliest={earliest} />
        <p className="mt-1.5 text-xs text-muted">{fmtLong(range.from)} – {fmtLong(range.to)}</p>
      </div>
      <ErrorBox error={sales.error || expenses.error} />
      {sales.isLoading || expenses.isLoading ? (
        <Loading />
      ) : (
        <Body from={range.from} to={range.to} sales={sales.data ?? []} expenses={(expenses.data ?? []).filter((e) => e.category !== 'setup')} />
      )}
    </div>
  )
}

function Body({ from, to, sales, expenses }: { from: string; to: string; sales: SalesDay[]; expenses: AnyExpense[] }) {
  const p = usePalette()
  const [openCat, setOpenCat] = useState<CategoryCode | null>(null)

  const m = useMemo(() => {
    const totalSales = sum(sales, dayTotal)
    const byCat = new Map<CategoryCode, number>()
    for (const e of expenses) byCat.set(e.category, cents((byCat.get(e.category) ?? 0) + e.amount))
    const cat = (c: CategoryCode) => byCat.get(c) ?? 0
    const opex = cents(OPERATING.reduce((s, c) => s + cat(c), 0))
    const equipment = cat('equipment')
    const tradingDays = sales.filter((d) => dayTotal(d) > 0).length

    // Weekly roll-up, Monday start, covering every week in the range.
    const weeks: { week: string; label: string; sales: number; expenses: number; profit: number; profitPlot: number | null; food: number; labour: number; rent: number; utilities: number; other: number; equipment: number; days: number }[] = []
    for (let w = weekStart(from); w <= to; w = addDays(w, 7)) {
      const end = addDays(w, 6)
      const s = sales.filter((d) => d.sale_date >= w && d.sale_date <= end)
      const e = expenses.filter((x) => x.expense_date >= w && x.expense_date <= end)
      const c = (k: CategoryCode) => sum(e.filter((x) => x.category === k), (x) => x.amount)
      const row = {
        week: w, label: fmtShort(w), sales: sum(s, dayTotal), days: s.length,
        food: c('food'), labour: c('labour'), rent: c('rent'), utilities: c('utilities'), other: c('other'), equipment: c('equipment'),
        expenses: 0, profit: 0, profitPlot: null as number | null,
      }
      row.expenses = cents(row.food + row.labour + row.rent + row.utilities + row.other)
      row.profit = cents(row.sales - row.expenses)
      // Weeks with nothing entered yet stay off the profit line instead of plotting a fake $0.
      row.profitPlot = row.sales || row.expenses ? row.profit : null
      weeks.push(row)
    }

    const byDate = new Map(sales.map((d) => [d.sale_date, d]))
    const firstDay = sales[0]?.sale_date ?? from
    const daily = eachDay(firstDay > from ? firstDay : from, to).map((d) => {
      const row = byDate.get(d)
      return { date: d, label: fmtShort(d), total: row ? dayTotal(row) : null, row }
    })

    const weekday = WEEKDAYS.map((name, i) => {
      const ds = sales.filter((d) => weekdayIdx(d.sale_date) === i && dayTotal(d) > 0)
      return { name, avg: ds.length ? cents(sum(ds, dayTotal) / ds.length) : 0, n: ds.length }
    })

    const unsplitDays = sales.filter((d) => splitSum(d) === 0 && dayTotal(d) > 0)
    const channels = [
      ...CHANNELS.map((c) => ({ label: c.label, value: sum(sales, (d) => d[c.key]) })),
      { label: 'Not split (total only)', value: sum(unsplitDays, dayTotal) },
    ].filter((c, i) => i < 4 || c.value > 0)

    return {
      totalSales, byCat, opex, equipment, tradingDays, weeks, daily, weekday, channels, unsplitDays,
      profit: cents(totalSales - opex), food: cat('food'), labour: cat('labour'),
    }
  }, [sales, expenses, from, to])

  const noWages = m.weeks.filter((w) => w.sales > 0 && w.labour === 0)
  const noFood = m.weeks.filter((w) => w.sales > 0 && w.food === 0)
  const catRows = [...OPERATING, 'equipment' as CategoryCode]
    .map((c) => ({ code: c, value: m.byCat.get(c) ?? 0 }))
    .sort((a, b) => b.value - a.value)
  const catMax = Math.max(...catRows.map((c) => c.value), 1)
  const channelTotal = m.channels.reduce((s, c) => s + c.value, 0) || 1

  if (!sales.length && !expenses.length)
    return (
      <div className="card px-4 py-10 text-center">
        <p className="text-ink-2">Nothing recorded in this range yet.</p>
        <div className="mt-4 flex justify-center gap-2">
          <Link to="/sales" className="btn btn-primary">Enter sales</Link>
          <Link to="/expenses/new" className="btn">Add expense</Link>
        </div>
      </div>
    )

  return (
    <div className="grid gap-4">
      {(noWages.length > 0 || noFood.length > 0) && (
        <div role="alert" className="rounded-xl border border-warn-line bg-warn-bg px-4 py-3 text-sm text-warn-ink">
          <div className="flex gap-2">
            <span aria-hidden>⚠</span>
            <div className="space-y-1">
              {noWages.length > 0 && <p><b>No wages entered</b> for {weekList(noWages.map((w) => w.week))} — profit looks higher than it is.</p>}
              {noFood.length > 0 && <p><b>No food costs entered</b> for {weekList(noFood.map((w) => w.week))}.</p>}
              <Link to="/expenses/new" className="inline-block font-semibold underline">Add an expense</Link>
            </div>
          </div>
        </div>
      )}

      {/* KPI tiles */}
      <div className="grid grid-cols-2 gap-3 lg:grid-cols-6">
        <Tile label="Total sales" value={audRound(m.totalSales)} sub={`${m.tradingDays} trading day${m.tradingDays === 1 ? '' : 's'}`} />
        <Tile label="Expenses" value={audRound(m.opex)} sub={m.equipment ? `+ ${audRound(m.equipment)} equipment` : 'operating costs'} />
        <Tile label="Profit" value={audRound(m.profit)} tone={m.profit < 0 ? 'bad' : undefined}
          sub={m.equipment ? `${audRound(m.profit - m.equipment)} after equipment` : `${pct(m.profit / m.totalSales)} margin`} />
        <Tile label="Food cost" value={pct(m.food / m.totalSales)} sub={`${audRound(m.food)} of sales`} />
        <Tile label="Labour" value={pct(m.labour / m.totalSales)} sub={m.labour ? `${audRound(m.labour)} of sales` : 'no wages entered'} />
        <Tile label="Avg sales / day" value={audRound(m.tradingDays ? m.totalSales / m.tradingDays : 0)} sub="per trading day" />
      </div>

      <div className="grid gap-4 lg:grid-cols-5">
        {/* Weekly sales vs expenses, profit on its own chart below (no dual axis) */}
        <ChartCard className="lg:col-span-3" title="Sales vs expenses by week" subtitle="Expenses = food, labour, rent, utilities, other (equipment excluded)"
          legend={<Legend items={[{ label: 'Sales', color: p['c-sales'] }, { label: 'Expenses', color: p['c-expenses'] }]} />}>
          <div className="h-64">
            <ResponsiveContainer>
              <BarChart data={m.weeks} barGap={2} barCategoryGap="22%" margin={{ top: 4, right: 4, left: 0, bottom: 0 }}>
                <CartesianGrid vertical={false} stroke={p.line} />
                <XAxis dataKey="label" {...axisProps(p)} />
                <YAxis {...axisProps(p)} axisLine={false} width={52} tickFormatter={audShort} />
                <Tooltip cursor={{ fill: p.line, opacity: 0.5 }} content={(t) => {
                  const w = tipRow<(typeof m.weeks)[number]>(t)
                  return w && (
                    <TipBox title={`Week of ${fmtShort(w.week)}`} rows={[
                      { label: 'Sales', value: aud(w.sales), color: p['c-sales'] },
                      { label: 'Expenses', value: aud(w.expenses), color: p['c-expenses'] },
                      { label: 'Profit', value: aud(w.profit), strong: true },
                    ]} footer={`${w.days} day${w.days === 1 ? '' : 's'} of sales${w.equipment ? ` · ${aud(w.equipment)} equipment` : ''}`} />
                  )
                }} />
                <Bar dataKey="sales" name="Sales" fill={p['c-sales']} radius={[4, 4, 0, 0]} maxBarSize={36} />
                <Bar dataKey="expenses" name="Expenses" fill={p['c-expenses']} radius={[4, 4, 0, 0]} maxBarSize={36} />
              </BarChart>
            </ResponsiveContainer>
          </div>

          <h3 className="mb-1 mt-4 text-sm font-semibold text-ink-2">Profit by week</h3>
          <div className="h-32">
            <ResponsiveContainer>
              <LineChart data={m.weeks} margin={{ top: 8, right: 12, left: 0, bottom: 0 }}>
                <CartesianGrid vertical={false} stroke={p.line} />
                <XAxis dataKey="label" {...axisProps(p)} />
                <YAxis {...axisProps(p)} axisLine={false} width={52} tickFormatter={audShort} />
                <ReferenceLine y={0} stroke={p.axis} />
                <Tooltip cursor={{ stroke: p.axis }} content={(t) => {
                  const w = tipRow<(typeof m.weeks)[number]>(t)
                  return w && <TipBox title={`Week of ${fmtShort(w.week)}`} rows={[
                    { label: 'Profit', value: aud(w.profit), strong: true },
                    { label: 'Margin', value: pct(w.profit / w.sales) },
                  ]} />
                }} />
                <Line dataKey="profitPlot" stroke={p['c-profit']} strokeWidth={2} dot={{ r: 4, fill: p['c-profit'], stroke: p.surface, strokeWidth: 2 }}
                  activeDot={{ r: 6, stroke: p.surface, strokeWidth: 2 }} isAnimationActive={false} />
              </LineChart>
            </ResponsiveContainer>
          </div>

          <details className="mt-3 text-sm">
            <summary className="cursor-pointer text-accent">Show as table</summary>
            <WeeklyTable weeks={m.weeks} />
          </details>
        </ChartCard>

        {/* Where the money goes */}
        <ChartCard className="lg:col-span-2" title="Where the money goes" subtitle="Tap a category to see its items">
          <ul className="space-y-1">
            {catRows.map((c) => (
              <li key={c.code}>
                <button type="button" onClick={() => setOpenCat(openCat === c.code ? null : c.code)} aria-expanded={openCat === c.code}
                  className={`w-full rounded-lg px-2 py-1.5 text-left hover:bg-surface-2 ${openCat === c.code ? 'bg-surface-2' : ''}`}>
                  <div className="flex items-baseline justify-between gap-2 text-sm">
                    <span className="inline-flex items-center gap-1.5 font-medium">
                      <CatDot code={c.code} />{CAT_LABEL[c.code]}{c.code === 'equipment' && <span className="text-xs text-muted">(one-off)</span>}
                    </span>
                    <span className="num">
                      <b>{aud(c.value)}</b>
                      <span className="ml-1.5 inline-block w-12 text-right text-xs text-muted">{m.totalSales ? pct(c.value / m.totalSales) : ''}</span>
                    </span>
                  </div>
                  <div className="mt-1 h-2 rounded-full bg-surface-2">
                    <div className="h-2 rounded-full" style={{ width: `${(c.value / catMax) * 100}%`, background: CAT_COLOR[c.code], minWidth: c.value ? 4 : 0 }} />
                  </div>
                </button>
                {openCat === c.code && <CategoryItems items={expenses.filter((e) => e.category === c.code)} />}
              </li>
            ))}
          </ul>
          <p className="mt-2 text-xs text-muted">% = share of sales in this period.</p>
        </ChartCard>
      </div>

      <ChartCard title="Daily sales" subtitle={m.daily.some((d) => d.row && hasMismatch(d.row)) ? '≠ in the tooltip marks days where the old sheet total differs from the channels' : undefined}
        legend={<Legend items={[{ label: 'Day total', color: p['c-sales'], line: true }]} />}>
        <div className="h-60">
          <ResponsiveContainer>
            <LineChart data={m.daily} margin={{ top: 8, right: 12, left: 0, bottom: 0 }}>
              <CartesianGrid vertical={false} stroke={p.line} />
              <XAxis dataKey="label" {...axisProps(p)} minTickGap={24} />
              <YAxis {...axisProps(p)} axisLine={false} width={52} tickFormatter={audShort} />
              <Tooltip cursor={{ stroke: p.axis }} content={(t) => {
                const d = tipRow<(typeof m.daily)[number]>(t)
                if (!d) return null
                if (!d.row) return <TipBox title={fmtDay(d.date)} rows={[{ label: 'No sales entered', value: '' }]} />
                const r = d.row
                return <TipBox title={fmtDay(d.date)}
                  rows={[
                    { label: hasMismatch(r) ? 'Total ≠' : 'Total', value: aud(dayTotal(r)), strong: true },
                    ...CHANNELS.filter((c) => r[c.key]).map((c) => ({ label: c.label, value: aud(r[c.key]) })),
                  ]}
                  footer={[hasMismatch(r) && `Channels add up to ${aud(splitSum(r))}`, r.notes].filter(Boolean).join(' · ') || undefined} />
              }} />
              <Line dataKey="total" stroke={p['c-sales']} strokeWidth={2} connectNulls={false} isAnimationActive={false}
                dot={{ r: 4, fill: p['c-sales'], stroke: p.surface, strokeWidth: 2 }} activeDot={{ r: 6, stroke: p.surface, strokeWidth: 2 }} />
            </LineChart>
          </ResponsiveContainer>
        </div>
      </ChartCard>

      <div className="grid gap-4 lg:grid-cols-2">
        <ChartCard title="Average sales by weekday" subtitle="Average takings on days with sales">
          <div className="h-52">
            <ResponsiveContainer>
              <BarChart data={m.weekday} margin={{ top: 4, right: 4, left: 0, bottom: 0 }} barCategoryGap="24%">
                <CartesianGrid vertical={false} stroke={p.line} />
                <XAxis dataKey="name" {...axisProps(p)} />
                <YAxis {...axisProps(p)} axisLine={false} width={52} tickFormatter={audShort} />
                <Tooltip cursor={{ fill: p.line, opacity: 0.5 }} content={(t) => {
                  const d = tipRow<(typeof m.weekday)[number]>(t)
                  return d && <TipBox title={d.name} rows={[{ label: 'Average', value: aud(d.avg), strong: true }]} footer={`over ${d.n} day${d.n === 1 ? '' : 's'}`} />
                }} />
                <Bar dataKey="avg" fill={p['c-sales']} radius={[4, 4, 0, 0]} maxBarSize={44} />
              </BarChart>
            </ResponsiveContainer>
          </div>
        </ChartCard>

        <ChartCard title="How customers pay" subtitle={m.unsplitDays.length ? `${m.unsplitDays.length} day${m.unsplitDays.length === 1 ? '' : 's'} only have a total, no split` : undefined}>
          <ul className="space-y-3">
            {m.channels.map((c) => (
              <li key={c.label}>
                <div className="flex items-baseline justify-between text-sm">
                  <span className="font-medium">{c.label}</span>
                  <span className="num"><b>{aud(c.value)}</b><span className="ml-1.5 inline-block w-12 text-right text-xs text-muted">{pct(c.value / channelTotal)}</span></span>
                </div>
                <div className="mt-1 h-2 rounded-full bg-surface-2">
                  <div className="h-2 rounded-full" style={{ width: `${(c.value / channelTotal) * 100}%`, minWidth: c.value ? 4 : 0, background: c.label.startsWith('Not split') ? 'var(--muted)' : 'var(--c-sales)' }} />
                </div>
              </li>
            ))}
          </ul>
        </ChartCard>
      </div>
    </div>
  )
}

function weekList(weeks: string[]) {
  const names = weeks.map((w) => `week of ${fmtShort(w)}`)
  return names.length <= 3 ? names.join(', ') : `${names.slice(0, 2).join(', ')} and ${names.length - 2} more weeks`
}

function Tile({ label, value, sub, tone }: { label: string; value: string; sub?: string; tone?: 'bad' }) {
  return (
    <div className="card px-4 py-3">
      <div className="text-xs font-medium text-muted">{label}</div>
      <div className={`mt-0.5 text-2xl font-bold tracking-tight ${tone === 'bad' ? 'text-bad' : ''}`}>{value}</div>
      {sub && <div className="mt-0.5 truncate text-xs text-ink-2">{sub}</div>}
    </div>
  )
}

function CategoryItems({ items }: { items: AnyExpense[] }) {
  const supplierName = new Map((useSuppliers().data ?? []).map((s) => [s.id, s.name]))
  const staffName = new Map((useStaff().data ?? []).map((s) => [s.id, s.name]))
  if (!items.length) return <p className="px-2 py-2 text-xs text-muted">Nothing entered in this period.</p>
  return (
    <ul className="mx-2 mb-2 divide-y divide-line rounded-lg border border-line text-sm">
      {[...items].sort((a, b) => b.expense_date.localeCompare(a.expense_date)).map((e, i) => (
        <li key={`${e.id}-${e.expense_date}-${i}`} className="flex items-baseline justify-between gap-3 px-3 py-2">
          <div className="min-w-0">
            <div className="truncate">
              {staffName.get(e.staff_id ?? '') ?? supplierName.get(e.supplier_id ?? '') ?? (e.is_recurring ? e.note : CAT_LABEL[e.category])}
              {e.is_recurring && <span className="ml-1.5 rounded bg-surface-2 px-1.5 py-0.5 text-[10px] font-semibold text-ink-2">STANDARD</span>}
            </div>
            <div className="truncate text-xs text-muted">{fmtDay(e.expense_date)}{!e.is_recurring && e.note ? ` · ${e.note}` : ''}</div>
          </div>
          <span className="num shrink-0 font-medium">
            {e.is_recurring ? aud(e.amount) : <Link to={`/expenses/${e.id}`} className="hover:underline">{aud(e.amount)}</Link>}
          </span>
        </li>
      ))}
    </ul>
  )
}

function WeeklyTable({ weeks }: { weeks: { week: string; days: number; sales: number; food: number; labour: number; rent: number; utilities: number; other: number; expenses: number; profit: number; equipment: number }[] }) {
  const cols = ['sales', 'food', 'labour', 'rent', 'utilities', 'other', 'expenses', 'profit', 'equipment'] as const
  return (
    <div className="-mx-4 mt-2 overflow-x-auto px-4">
      <table className="num w-full min-w-[720px] text-right text-xs">
        <thead className="text-muted">
          <tr>
            <th className="py-1 text-left font-semibold">Week of</th>
            <th className="py-1 font-semibold">Days</th>
            {cols.map((c) => <th key={c} className="py-1 font-semibold capitalize">{c}</th>)}
          </tr>
        </thead>
        <tbody className="divide-y divide-line">
          {weeks.map((w) => (
            <tr key={w.week}>
              <td className="py-1.5 text-left">{fmtShort(w.week)}</td>
              <td className="py-1.5">{w.days}</td>
              {cols.map((c) => (
                <td key={c} className={`py-1.5 ${c === 'profit' ? 'font-semibold' : ''} ${c === 'profit' && w.profit < 0 ? 'text-bad' : ''}`}>{aud(w[c])}</td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}
