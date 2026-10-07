import { Link } from 'react-router-dom'
import { Bar, BarChart, CartesianGrid, Line, ResponsiveContainer, ComposedChart, Tooltip, XAxis, YAxis } from 'recharts'
import { useEarliestSale, useWeeklyFoodCost } from '../lib/api'
import { addDays, fmtDay, fmtShort, todayStr, weekStart } from '../lib/dates'
import { aud, audRound, audShort, cents, pct } from '../lib/format'
import { foodCostPct, stockMovement } from '../lib/purchasing'
import type { WeeklyFoodCost } from '../lib/types'
import { RangeFilter, useRange } from '../components/RangeFilter'
import { axisProps, ChartCard, Legend, TipBox, usePalette } from '../components/charts'
import { Empty, ErrorBox, Loading } from '../components/ui'

export default function FoodCost() {
  const earliest = useEarliestSale().data ?? null
  const [range, setRange] = useRange('range:foodcost', '4weeks', earliest)
  // The view is keyed by week, so the range has to start at a week boundary.
  const weeks = useWeeklyFoodCost(weekStart(range.from), range.to)

  return (
    <div>
      <div className="mb-4">
        <h1 className="mb-1 text-2xl font-bold tracking-tight">Food cost</h1>
        <p className="mb-2 text-sm text-muted">
          What the food actually cost each week: the stock you started with, plus what you bought, less what was left.
        </p>
        <RangeFilter range={range} onChange={setRange} earliest={earliest} />
      </div>
      <ErrorBox error={weeks.error} />
      {weeks.isLoading ? <Loading /> : <Body rows={weeks.data ?? []} />}
    </div>
  )
}

function Body({ rows }: { rows: WeeklyFoodCost[] }) {
  const p = usePalette()
  const thisWeek = weekStart(todayStr())

  if (rows.length === 0)
    return (
      <Empty>
        Nothing in this range yet. Food cost needs sales or purchases in a week —{' '}
        <Link className="font-semibold text-accent" to="/orders">orders</Link> and{' '}
        <Link className="font-semibold text-accent" to="/stock">counts</Link> do the rest.
      </Empty>
    )

  // The latest finished week is the headline: this week is still running, so it reads low.
  const done = rows.filter((w) => w.week_start < thisWeek)
  const latest = done[done.length - 1] ?? rows[rows.length - 1]
  const counted = rows.filter((w) => w.counted)

  // Only weeks with a count at both ends: mixing in uncounted weeks would quietly average
  // a real food cost with a purchases figure. Weighted by sales rather than a mean of the
  // weekly percentages, so a quiet week can't pull the figure around.
  const countedSales = cents(counted.reduce((s, w) => s + w.sales, 0))
  const countedCost = cents(counted.reduce((s, w) => s + w.food_cost, 0))
  const avgPct = countedSales > 0 ? countedCost / countedSales : null

  const chart = rows.map((w) => ({
    week: w.week_start,
    label: fmtShort(w.week_start),
    purchases: w.purchases,
    cost: w.counted ? w.food_cost : null,
    pctOfSales: w.sales > 0 && w.counted ? (w.food_cost / w.sales) * 100 : null,
    row: w,
  }))

  return (
    <div className="grid gap-4">
      {counted.length === 0 && (
        <p className="rounded-lg border border-warn-line bg-warn-bg px-3 py-2 text-sm text-warn-ink">
          No week here has a stock count at both ends, so these are <strong>purchases</strong>, not food cost. Two counts a week
          apart is all it takes — <Link className="font-semibold underline" to="/stock">start one</Link>.
        </p>
      )}

      <section className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        <Tile
          label={`Week of ${fmtShort(latest.week_start)}`}
          value={foodCostPct(latest) != null ? pct(foodCostPct(latest)!) : '—'}
          sub={`${audRound(latest.food_cost)} of ${audRound(latest.sales)} sales`}
          tone={latest.counted ? undefined : 'soft'}
        />
        <Tile label="Food cost that week" value={audRound(latest.food_cost)}
          sub={latest.counted ? 'opening + bought − closing' : 'purchases only — not counted'} />
        <Tile label="Bought that week" value={audRound(latest.purchases)}
          sub={latest.counted ? describeMovement(latest) : 'no count to compare'} />
        <Tile label="Average, counted weeks" value={avgPct != null ? pct(avgPct) : '—'}
          sub={`${counted.length} of ${rows.length} ${rows.length === 1 ? 'week' : 'weeks'} counted`} />
      </section>

      <ChartCard
        title="Food cost by week"
        subtitle="Bars are what you bought; the line is what it cost once stock is taken into account."
        legend={<Legend items={[{ label: 'Bought', color: p['c-expenses'] }, { label: 'Food cost', color: p['c-food'], line: true }]} />}
      >
        <ResponsiveContainer width="100%" height={260}>
          <ComposedChart data={chart} margin={{ top: 4, right: 4, left: -16, bottom: 0 }}>
            <CartesianGrid stroke={p.line} vertical={false} />
            <XAxis dataKey="label" {...axisProps(p)} />
            <YAxis tickFormatter={audShort} {...axisProps(p)} />
            <Tooltip content={<CostTip />} />
            <Bar dataKey="purchases" fill={p['c-expenses']} radius={[3, 3, 0, 0]} maxBarSize={40} />
            <Line type="monotone" dataKey="cost" stroke={p['c-food']} strokeWidth={2.5} dot={{ r: 3 }} connectNulls={false} />
          </ComposedChart>
        </ResponsiveContainer>
      </ChartCard>

      {counted.length > 0 && (
        <ChartCard title="Food cost as a share of sales" subtitle="Only weeks counted at both ends can be shown here.">
          <ResponsiveContainer width="100%" height={200}>
            <BarChart data={chart.filter((c) => c.pctOfSales != null)} margin={{ top: 4, right: 4, left: -16, bottom: 0 }}>
              <CartesianGrid stroke={p.line} vertical={false} />
              <XAxis dataKey="label" {...axisProps(p)} />
              <YAxis tickFormatter={(v: number) => `${v.toFixed(0)}%`} {...axisProps(p)} />
              <Tooltip content={<CostTip />} />
              <Bar dataKey="pctOfSales" fill={p['c-food']} radius={[3, 3, 0, 0]} maxBarSize={40} />
            </BarChart>
          </ResponsiveContainer>
        </ChartCard>
      )}

      <WeekTable rows={[...rows].reverse()} />

      <p className="text-sm text-muted">
        A week counts as counted when a finished stock count sits just before it and another falls inside it. Weeks without that
        fall back to what you bought, and say so. The dashboard's “Food cost” tile is always purchases — this page is the real one.
      </p>
    </div>
  )
}

function describeMovement(w: WeeklyFoodCost): string {
  const move = stockMovement(w)
  if (move == null) return ''
  if (Math.abs(move) < 1) return 'stock held level'
  return move > 0 ? `${audRound(move)} more stock on hand` : `${audRound(-move)} of stock used up`
}

function Tile({ label, value, sub, tone }: { label: string; value: string; sub?: string; tone?: 'soft' }) {
  return (
    <div className="card p-3">
      <p className="text-xs font-medium text-muted">{label}</p>
      <p className={`num mt-0.5 text-xl font-bold ${tone === 'soft' ? 'text-ink-2' : ''}`}>{value}</p>
      {sub && <p className="mt-0.5 text-xs text-muted">{sub}</p>}
    </div>
  )
}

type TipProps = { active?: boolean; payload?: readonly { payload?: unknown }[] }

function CostTip(props: TipProps) {
  if (!props.active || !props.payload?.length) return null
  const { row } = props.payload[0].payload as { row: WeeklyFoodCost }
  const share = foodCostPct(row)
  return (
    <TipBox
      title={`Week of ${fmtDay(row.week_start)}`}
      rows={[
        { label: 'Sales', value: aud(row.sales) },
        { label: 'Opening stock', value: row.counted ? aud(row.opening_value) : '—' },
        { label: 'Bought', value: aud(row.purchases) },
        { label: 'Closing stock', value: row.counted ? aud(row.closing_value) : '—' },
        { label: 'Food cost', value: aud(row.food_cost), strong: true },
      ]}
      footer={
        row.counted
          ? share != null
            ? `${pct(share)} of sales`
            : 'no sales that week'
          : 'Not counted — this is what you bought'
      }
    />
  )
}

function WeekTable({ rows }: { rows: WeeklyFoodCost[] }) {
  return (
    <section className="card overflow-x-auto p-4">
      <h2 className="mb-2 font-semibold">Week by week</h2>
      <table className="w-full min-w-[42rem] text-sm">
        <thead>
          <tr className="border-b border-line text-left text-xs text-muted">
            <th className="py-1.5 pr-2 font-semibold">Week</th>
            <th className="py-1.5 pr-2 text-right font-semibold">Sales</th>
            <th className="py-1.5 pr-2 text-right font-semibold">Opening</th>
            <th className="py-1.5 pr-2 text-right font-semibold">Bought</th>
            <th className="py-1.5 pr-2 text-right font-semibold">Closing</th>
            <th className="py-1.5 pr-2 text-right font-semibold">Food cost</th>
            <th className="py-1.5 text-right font-semibold">% of sales</th>
          </tr>
        </thead>
        <tbody className="num">
          {rows.map((w) => {
            const share = foodCostPct(w)
            return (
              <tr key={w.week_start} className="border-b border-line/60 last:border-0">
                <td className="py-1.5 pr-2 whitespace-nowrap">
                  {fmtShort(w.week_start)} – {fmtShort(addDays(w.week_start, 6))}
                  {!w.counted && <span className="ml-1.5 text-xs font-semibold text-muted" title="No stock count this week">not counted</span>}
                </td>
                <td className="py-1.5 pr-2 text-right">{w.sales ? audRound(w.sales) : '—'}</td>
                <td className="py-1.5 pr-2 text-right text-ink-2">{w.counted ? audRound(w.opening_value) : '—'}</td>
                <td className="py-1.5 pr-2 text-right">{w.purchases ? audRound(w.purchases) : '—'}</td>
                <td className="py-1.5 pr-2 text-right text-ink-2">{w.counted ? audRound(w.closing_value) : '—'}</td>
                <td className="py-1.5 pr-2 text-right font-semibold">{audRound(w.food_cost)}</td>
                <td className="py-1.5 text-right font-semibold">{share != null ? pct(share) : '—'}</td>
              </tr>
            )
          })}
        </tbody>
        <tfoot>
          <tr className="border-t border-line font-bold">
            <td className="py-1.5 pr-2">Total</td>
            <td className="py-1.5 pr-2 text-right">{audRound(cents(rows.reduce((s, w) => s + w.sales, 0)))}</td>
            <td />
            <td className="py-1.5 pr-2 text-right">{audRound(cents(rows.reduce((s, w) => s + w.purchases, 0)))}</td>
            <td />
            <td className="py-1.5 pr-2 text-right">{audRound(cents(rows.reduce((s, w) => s + w.food_cost, 0)))}</td>
            <td />
          </tr>
        </tfoot>
      </table>
    </section>
  )
}
