import { useMemo, useState } from 'react'
import { Link } from 'react-router-dom'
import {
  Bar, BarChart, CartesianGrid, Line, LineChart, ResponsiveContainer, Tooltip, XAxis, YAxis,
} from 'recharts'
import { useAllExpenses, useEarliestSale, useSales, useStaff, useSuppliers } from '../lib/api'
import { useBusiness } from '../lib/business'
import { CAT_COLOR, CAT_LABEL, CHANNELS, OPERATING } from '../lib/categories'
import { addDays, eachDay, fmtDay, fmtLong, fmtShort, todayStr, weekdayIdx, WEEKDAYS } from '../lib/dates'
import { aud, audRound, audShort, cents, pct } from '../lib/format'
import { dayTotal, hasMismatch, splitSum } from '../lib/logic'
import type { AnyExpense, CategoryCode, SalesDay } from '../lib/types'
import { periodWeeks, setPeriod, usePeriod, weeksSince, type Period } from '../lib/period'
import { PeriodControls } from '../components/PeriodControls'
import { axisProps, ChartCard, Legend, TipBox, usePalette, WeekBars, WeekLine } from '../components/charts'
import { CatDot, ErrorBox, Loading } from '../components/ui'

// Recharts hands tooltip payloads over untyped; this pulls our row back out.
type TipProps = { active?: boolean; payload?: readonly { payload?: unknown }[] }
const tipRow = <T,>(p: TipProps) => (p.active && p.payload?.length ? (p.payload[0].payload as T) : null)

const sum = <T,>(xs: T[], f: (x: T) => number) => cents(xs.reduce((s, x) => s + f(x), 0))

export default function Dashboard() {
  const earliest = useEarliestSale()
  const period = usePeriod()
  const all = useMemo(() => weeksSince(earliest.data ?? null), [earliest.data])
  const inPeriod = periodWeeks(period, all)
  // The chart shows the last 16 weeks, reaching further back when the period does.
  const shownFrom = [inPeriod[0] ?? period.week, all[Math.max(0, all.length - 16)]].sort()[0]
  const lastDay = addDays(all[all.length - 1], 6)
  const sales = useSales(shownFrom, lastDay)
  const expenses = useAllExpenses(shownFrom, lastDay)
  const from = inPeriod[0] ?? period.week
  const to = addDays(inPeriod[inPeriod.length - 1] ?? period.week, 6)

  return (
    <div>
      <div className="flex flex-wrap items-end justify-between gap-4">
        <div>
          <h1 className="text-2xl font-semibold tracking-[-0.02em]">How the shop is doing</h1>
          <p className="num mt-1 text-sm text-muted">{fmtLong(from)} – {fmtLong(to)}</p>
        </div>
        <PeriodControls period={period} weeks={all} />
      </div>
      <div className="mt-5">
        <ErrorBox error={sales.error || expenses.error} />
        {earliest.isLoading || sales.isLoading || expenses.isLoading ? (
          <Loading />
        ) : (
          <Body from={from} to={to} period={period} shown={all.filter((w) => w >= shownFrom)} inPeriod={inPeriod}
            sales={sales.data ?? []} expenses={(expenses.data ?? []).filter((e) => e.category !== 'setup')} />
        )}
      </div>
    </div>
  )
}

function Body({ from, to, period, shown, inPeriod, sales: shownSales, expenses: shownExpenses }: {
  from: string; to: string; period: Period; shown: string[]; inPeriod: string[]; sales: SalesDay[]; expenses: AnyExpense[]
}) {
  const p = usePalette()
  // 'simple' businesses record one sales figure plus the cash they collected (fuel included),
  // so the payment-channel split is replaced by the cash figure.
  const simple = useBusiness().business?.sales_mode === 'simple'
  const [openCat, setOpenCat] = useState<CategoryCode | null>(null)
  const [showTable, setShowTable] = useState(false)
  const sales = useMemo(() => shownSales.filter((d) => d.sale_date >= from && d.sale_date <= to), [shownSales, from, to])
  const expenses = useMemo(() => shownExpenses.filter((e) => e.expense_date >= from && e.expense_date <= to), [shownExpenses, from, to])

  const m = useMemo(() => {
    const totalSales = sum(sales, dayTotal)
    const byCat = new Map<CategoryCode, number>()
    for (const e of expenses) byCat.set(e.category, cents((byCat.get(e.category) ?? 0) + e.amount))
    const cat = (c: CategoryCode) => byCat.get(c) ?? 0
    const opex = cents(OPERATING.reduce((s, c) => s + cat(c), 0))
    const equipment = cat('equipment')
    const tradingDays = sales.filter((d) => dayTotal(d) > 0).length
    const on = new Set(inPeriod)

    // Weekly roll-up, Monday start, for every week the chart shows.
    const weeks = shown.map((w) => {
      const end = addDays(w, 6)
      const s = shownSales.filter((d) => d.sale_date >= w && d.sale_date <= end)
      const e = shownExpenses.filter((x) => x.expense_date >= w && x.expense_date <= end)
      const c = (k: CategoryCode) => sum(e.filter((x) => x.category === k), (x) => x.amount)
      const row = {
        week: w, label: fmtShort(w), on: on.has(w), sales: sum(s, dayTotal), days: s.length,
        cash: sum(s, (d) => d.cash_collected ?? 0),
        food: c('food'), labour: c('labour'), rent: c('rent'), utilities: c('utilities'), other: c('other'), equipment: c('equipment'),
        expenses: 0, profit: 0, values: [] as number[], value: null as number | null,
      }
      row.expenses = cents(row.food + row.labour + row.rent + row.utilities + row.other)
      row.profit = cents(row.sales - row.expenses)
      row.values = [row.sales, row.expenses]
      // Weeks with nothing entered yet stay off the profit line instead of plotting a fake $0.
      row.value = row.sales || row.expenses ? row.profit : null
      return row
    })

    const byDate = new Map(sales.map((d) => [d.sale_date, d]))
    const today = todayStr()
    const daily = eachDay(from, to < today ? to : today).map((d) => {
      const row = byDate.get(d)
      return { date: d, label: fmtShort(d), total: row ? dayTotal(row) : null, cash: row?.cash_collected ?? null, row }
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
      cashCollected: sum(sales, (d) => d.cash_collected ?? 0),
      cashDays: sales.filter((d) => d.cash_collected != null).length,
      profit: cents(totalSales - opex), food: cat('food'), labour: cat('labour'),
    }
  }, [sales, expenses, shownSales, shownExpenses, shown, inPeriod, from, to])

  const periodRows = m.weeks.filter((w) => w.on)
  const noWages = periodRows.filter((w) => w.sales > 0 && w.labour === 0)
  const noFood = periodRows.filter((w) => w.sales > 0 && w.food === 0)
  const catRows = [...OPERATING, 'equipment' as CategoryCode]
    .map((c) => ({ code: c, value: m.byCat.get(c) ?? 0 }))
    .sort((a, b) => b.value - a.value)
  const channelTotal = m.channels.reduce((s, c) => s + c.value, 0) || 1
  const share = (v: number) => (m.totalSales ? pct(v / m.totalSales) : '—')
  const pick = (week: string) => setPeriod({ mode: period.mode === 'all' ? 'week' : period.mode, week })
  // Wages for the latest week missing them: dated that Sunday, or today if the week isn't over.
  const wagesWeek = noWages[noWages.length - 1]?.week
  const wagesDate = wagesWeek && [addDays(wagesWeek, 6), todayStr()].sort()[0]

  return (
    <div className="grid gap-4">
      {(noWages.length > 0 || noFood.length > 0) && (
        <div role="alert" className="flex flex-wrap items-center gap-3 rounded-[10px] border border-warn-line bg-warn-bg px-4 py-3 text-warn-ink">
          <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="shrink-0" aria-hidden>
            <path d="m21.73 18-8-14a2 2 0 0 0-3.48 0l-8 14A2 2 0 0 0 4 21h16a2 2 0 0 0 1.73-3" /><path d="M12 9v4" /><path d="M12 17h.01" />
          </svg>
          <div className="min-w-60 flex-1 space-y-0.5">
            {noWages.length > 0 && <p><b className="font-semibold">No wages entered</b> for {weekList(noWages.map((w) => w.week))} — profit looks higher than it is.</p>}
            {noFood.length > 0 && <p><b className="font-semibold">No food costs entered</b> for {weekList(noFood.map((w) => w.week))}.</p>}
          </div>
          <Link to={wagesDate ? `/expenses/new?category=labour&date=${wagesDate}` : '/expenses/new'}
            className="rounded-lg border border-warn-line bg-surface px-3 py-1.5 font-semibold text-warn-ink hover:bg-hover">
            {wagesDate ? 'Add wages' : 'Add an expense'}
          </Link>
        </div>
      )}

      {/* KPI tiles */}
      <div className="grid grid-cols-2 gap-3 desk:grid-cols-[repeat(auto-fit,minmax(180px,1fr))]">
        <Tile label="Total sales" value={audRound(m.totalSales)} sub={`${m.tradingDays} trading day${m.tradingDays === 1 ? '' : 's'}`} />
        <Tile label="Expenses" value={audRound(m.opex)} sub={m.equipment ? `+ ${audRound(m.equipment)} equipment` : 'operating costs'} />
        <Tile label="Profit" value={audRound(m.profit)} tone={m.profit < 0 ? 'bad' : m.profit > 0 ? 'good' : undefined}
          sub={m.equipment ? `${audRound(m.profit - m.equipment)} after equipment` : m.totalSales ? `${pct(m.profit / m.totalSales)} margin` : 'no sales recorded'} />
        <Tile label="Food bought" value={share(m.food)} sub={`${audRound(m.food)} · food cost →`} to="/food" />
        <Tile label="Labour" value={share(m.labour)} sub={m.labour ? `${audRound(m.labour)} of sales` : 'no wages entered'} />
        {simple ? (
          <Tile label="Cash collected" value={audRound(m.cashCollected)}
            sub={m.cashDays ? `over ${m.cashDays} day${m.cashDays === 1 ? '' : 's'}, fuel included` : 'none entered'} />
        ) : (
          <Tile label="Avg sales / day" value={m.tradingDays ? audRound(m.totalSales / m.tradingDays) : '—'} sub="per trading day" />
        )}
      </div>

      <div className="grid gap-4 lg:grid-cols-3">
        {/* Weekly sales vs expenses, profit on its own chart below (no dual axis) */}
        <ChartCard className="lg:col-span-2" title="Sales vs expenses by week"
          subtitle="Expenses = food, labour, rent, utilities, other (equipment excluded). Click a week to view it."
          legend={<Legend items={[{ label: 'Sales', color: p['c-sales'] }, { label: 'Expenses', color: p['c-expenses'] }]} />}>
          <div className="mt-2">
            <WeekBars cols={m.weeks} colors={[p['c-sales'], p['c-expenses']]} height={220}
              selected={period.week} highlight={period.mode === 'week'} onPick={pick}
              ariaLabel={(w) => `Week of ${fmtShort(w.week)}: sales ${aud(w.sales)}, expenses ${aud(w.expenses)}`}
              tip={(w) => (
                <TipBox title={`Week of ${fmtShort(w.week)}`} rows={[
                  { label: 'Sales', value: aud(w.sales), color: p['c-sales'] },
                  { label: 'Expenses', value: aud(w.expenses), color: p['c-expenses'] },
                  { label: 'Profit', value: aud(w.profit), strong: true },
                ]} footer={`${w.days} day${w.days === 1 ? '' : 's'} of sales${w.equipment ? ` · ${aud(w.equipment)} equipment` : ''}`} />
              )} />
          </div>

          <div className="mt-5 border-t border-track pt-4">
            <h3 className="mb-3 text-sm font-semibold">Profit by week</h3>
            <WeekLine cols={m.weeks} height={120} good={p.good} bad={p.bad} surface={p.surface}
              selected={period.week} highlight={false} onPick={pick}
              ariaLabel={(w) => `Week of ${fmtShort(w.week)}: profit ${w.value == null ? 'nothing entered' : aud(w.profit)}`}
              tip={(w) => (
                <TipBox title={`Week of ${fmtShort(w.week)}`} rows={w.value == null
                  ? [{ label: 'Nothing entered', value: '' }]
                  : [{ label: 'Profit', value: aud(w.profit), strong: true }, { label: 'Margin', value: w.sales ? pct(w.profit / w.sales) : '—' }]} />
              )} />
          </div>

          <button type="button" className="mt-4 text-[13px] font-medium text-accent" aria-expanded={showTable} onClick={() => setShowTable((v) => !v)}>
            {showTable ? '▾ Hide table' : '▸ Show as table'}
          </button>
          {showTable && <WeeklyTable weeks={periodRows} simple={simple} />}
        </ChartCard>

        {/* Where the money goes */}
        <ChartCard title="Where the money goes" subtitle="Tap a category to see its items">
          <ul>
            {catRows.map((c) => (
              <li key={c.code}>
                <button type="button" onClick={() => setOpenCat(openCat === c.code ? null : c.code)} aria-expanded={openCat === c.code}
                  className={`-mx-2 flex w-[calc(100%+16px)] flex-col gap-2 rounded-lg px-2 py-3 text-left hover:bg-hover ${openCat === c.code ? 'bg-hover' : ''}`}>
                  <span className="num flex items-center gap-2.5">
                    <CatDot code={c.code} size={8} />
                    <span className="flex-1 font-medium">
                      {CAT_LABEL[c.code]}{c.code === 'equipment' && <span className="ml-1 text-xs font-normal text-faint">(one-off)</span>}
                    </span>
                    <span className="font-semibold">{aud(c.value)}</span>
                    <span className="w-[54px] text-right text-xs text-muted">{share(c.value)}</span>
                  </span>
                  <span className="block h-1.5 overflow-hidden rounded-[3px] bg-surface-2">
                    <span className="block h-1.5 rounded-[3px]"
                      style={{ width: `${m.totalSales ? Math.min(100, (c.value / m.totalSales) * 100) : c.value ? 100 : 0}%`, background: CAT_COLOR[c.code] }} />
                  </span>
                </button>
                {openCat === c.code && <CategoryItems items={expenses.filter((e) => e.category === c.code)} />}
              </li>
            ))}
          </ul>
          <p className="mt-3 text-xs text-faint">% = share of sales in this period.</p>
        </ChartCard>
      </div>

      <ChartCard title={simple ? 'Daily sales and cash' : 'Daily sales'}
        subtitle={simple ? 'Cash collected includes fuel money, so it moves independently of sales'
          : m.daily.some((d) => d.row && hasMismatch(d.row)) ? '≠ in the tooltip marks days where the old sheet total differs from the channels' : undefined}
        legend={<Legend items={simple
          ? [{ label: 'Sales', color: p['c-sales'], line: true }, { label: 'Cash collected', color: p['c-cash'], line: true }]
          : [{ label: 'Day total', color: p['c-sales'], line: true }]} />}>
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
                  rows={simple
                    ? [
                        { label: 'Sales', value: aud(dayTotal(r)), color: p['c-sales'], strong: true },
                        { label: 'Cash collected', value: r.cash_collected == null ? '—' : aud(r.cash_collected), color: p['c-cash'] },
                      ]
                    : [
                        { label: hasMismatch(r) ? 'Total ≠' : 'Total', value: aud(dayTotal(r)), strong: true },
                        ...CHANNELS.filter((c) => r[c.key]).map((c) => ({ label: c.label, value: aud(r[c.key]) })),
                      ]}
                  footer={[hasMismatch(r) && `Channels add up to ${aud(splitSum(r))}`, r.notes].filter(Boolean).join(' · ') || undefined} />
              }} />
              <Line dataKey="total" stroke={p['c-sales']} strokeWidth={2} connectNulls={false} isAnimationActive={false}
                dot={{ r: 4, fill: p['c-sales'], stroke: p.surface, strokeWidth: 2 }} activeDot={{ r: 6, stroke: p.surface, strokeWidth: 2 }} />
              {simple && (
                <Line dataKey="cash" stroke={p['c-cash']} strokeWidth={2} connectNulls={false} isAnimationActive={false}
                  dot={{ r: 4, fill: p['c-cash'], stroke: p.surface, strokeWidth: 2 }} activeDot={{ r: 6, stroke: p.surface, strokeWidth: 2 }} />
              )}
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

        {simple ? (
          <ChartCard title="Cash collected by week" subtitle="Cash in hand, fuel included — not part of sales">
            {m.cashCollected === 0 ? (
              <p className="py-6 text-center text-sm text-muted">No cash figures entered for this period.</p>
            ) : (
              <>
                <div className="mb-3 flex items-baseline justify-between">
                  <span className="text-sm text-ink-2">Total for the period</span>
                  <span className="num text-2xl font-bold">{aud(m.cashCollected)}</span>
                </div>
                <ul className="space-y-2">
                  {periodRows.filter((w) => w.cash > 0 || w.sales > 0).map((w) => (
                    <li key={w.week}>
                      <div className="flex items-baseline justify-between text-sm">
                        <span className="font-medium">Week of {fmtShort(w.week)}</span>
                        <span className="num"><b>{aud(w.cash)}</b></span>
                      </div>
                      <div className="mt-1 h-2 rounded-full bg-surface-2">
                        <div className="h-2 rounded-full" style={{ width: `${(w.cash / Math.max(...periodRows.map((x) => x.cash), 1)) * 100}%`, minWidth: w.cash ? 4 : 0, background: 'var(--c-cash)' }} />
                      </div>
                    </li>
                  ))}
                </ul>
              </>
            )}
          </ChartCard>
        ) : (
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
        )}
      </div>
    </div>
  )
}

function weekList(weeks: string[]) {
  const names = weeks.map((w) => `week of ${fmtShort(w)}`)
  return names.length <= 3 ? names.join(', ') : `${names.slice(0, 2).join(', ')} and ${names.length - 2} more weeks`
}

function Tile({ label, value, sub, tone, to }: { label: string; value: string; sub?: string; tone?: 'bad' | 'good'; to?: string }) {
  const body = (
    <>
      <div className="text-[13px] font-medium text-muted">{label}</div>
      <div className={`num mt-1.5 text-xl font-semibold tracking-[-0.02em] desk:text-[26px] desk:leading-8 ${tone === 'bad' ? 'text-bad' : tone === 'good' ? 'text-good' : ''}`}>{value}</div>
      {sub && <div className="mt-1 truncate text-xs text-muted">{sub}</div>}
    </>
  )
  if (to) return <Link to={to} className="card min-w-0 p-3 hover:bg-hover desk:p-4">{body}</Link>
  return <div className="card min-w-0 p-3 desk:p-4">{body}</div>
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

function WeeklyTable({ weeks, simple }: { weeks: { week: string; days: number; sales: number; cash: number; food: number; labour: number; rent: number; utilities: number; other: number; expenses: number; profit: number; equipment: number }[]; simple: boolean }) {
  const cols = (simple
    ? ['sales', 'cash', 'food', 'labour', 'rent', 'utilities', 'other', 'expenses', 'profit', 'equipment']
    : ['sales', 'food', 'labour', 'rent', 'utilities', 'other', 'expenses', 'profit', 'equipment']) as readonly ('sales' | 'cash' | 'food' | 'labour' | 'rent' | 'utilities' | 'other' | 'expenses' | 'profit' | 'equipment')[]
  return (
    <div className="-mx-4 mt-3 overflow-x-auto px-4">
      <table className="num w-full min-w-[720px] text-right text-[13px]">
        <thead className="text-muted">
          <tr className="border-b border-line">
            <th className="p-2 pl-0 text-left font-medium">Week of</th>
            <th className="p-2 font-medium">Days</th>
            {cols.map((c) => <th key={c} className="p-2 font-medium capitalize">{c}</th>)}
          </tr>
        </thead>
        <tbody className="divide-y divide-line-2">
          {weeks.map((w) => (
            <tr key={w.week}>
              <td className="p-2 pl-0 text-left">{fmtShort(w.week)}</td>
              <td className="p-2">{w.days}</td>
              {cols.map((c) => (
                <td key={c} className={`p-2 ${c === 'profit' ? 'font-semibold' : ''} ${c === 'profit' && w.profit < 0 ? 'text-bad' : ''}`}>{aud(w[c])}</td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}
