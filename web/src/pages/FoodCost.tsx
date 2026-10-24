import { Link } from 'react-router-dom'
import { useEarliestSale, useWeeklyFoodCost } from '../lib/api'
import { addDays, fmtLong, fmtShort } from '../lib/dates'
import { aud, audRound, cents, pct } from '../lib/format'
import { setPeriod, usePeriodRange } from '../lib/period'
import { foodCostPct } from '../lib/purchasing'
import type { WeeklyFoodCost } from '../lib/types'
import { FoodHeader } from '../components/catalogue'
import { PeriodControls } from '../components/PeriodControls'
import { Empty, ErrorBox, Kpi, KPI_GRID, Loading } from '../components/ui'

/** Above this share of sales a week's food cost is flagged amber. */
const HIGH = 0.45

export default function FoodCost() {
  const earliest = useEarliestSale()
  const { period, all, inPeriod, shownFrom, from, to } = usePeriodRange(earliest.data ?? null)
  const weeks = useWeeklyFoodCost(shownFrom, all[all.length - 1])

  return (
    <div>
      <FoodHeader sub="What the food actually cost each week: the stock you started with, plus what you bought, less what was left." />
      <div className="flex flex-wrap items-center gap-2">
        <PeriodControls period={period} weeks={all} />
        <span className="num text-[13px] text-muted">{fmtLong(from)} – {fmtLong(to)}</span>
      </div>
      <div className="mt-4"><ErrorBox error={weeks.error} /></div>
      {earliest.isLoading || weeks.isLoading ? <Loading /> : (
        <Body rows={weeks.data ?? []} inPeriod={new Set(inPeriod)} />
      )}
    </div>
  )
}

function Body({ rows, inPeriod }: { rows: WeeklyFoodCost[]; inPeriod: Set<string> }) {
  if (rows.length === 0)
    return (
      <Empty>
        Nothing here yet. Food cost needs sales or purchases in a week —{' '}
        <Link className="font-semibold text-accent" to="/orders">orders</Link> and{' '}
        <Link className="font-semibold text-accent" to="/stock">counts</Link> do the rest.
      </Empty>
    )

  const period = rows.filter((w) => inPeriod.has(w.week_start))
  const counted = period.filter((w) => w.counted)
  const sales = cents(period.reduce((s, w) => s + w.sales, 0))
  const bought = cents(period.reduce((s, w) => s + w.purchases, 0))
  const cost = cents(period.reduce((s, w) => s + w.food_cost, 0))
  const share = sales > 0 ? cost / sales : null

  return (
    <div className="grid gap-4">
      {rows.every((w) => !w.counted) && (
        <p className="rounded-[10px] border border-warn-line bg-warn-bg px-4 py-3 text-sm text-warn-ink">
          No week here has a stock count at both ends, so these are <strong>purchases</strong>, not food cost. Two counts a week
          apart is all it takes — <Link className="font-semibold underline" to="/stock">start one</Link>.
        </p>
      )}

      <div className={KPI_GRID}>
        <Kpi label="Food cost" value={share != null ? pct(share) : '—'}
          note={period.length && counted.length === period.length ? 'opening + bought − closing, ÷ sales'
            : `${counted.length} of ${period.length} ${period.length === 1 ? 'week' : 'weeks'} counted · rest is purchases`} />
        <Kpi label="Food bought" value={audRound(bought)} note="orders received and food expenses" />
        <Kpi label="Sales" value={audRound(sales)} note={`${period.length} ${period.length === 1 ? 'week' : 'weeks'}`} />
        <Kpi label="Gross margin" value={audRound(cents(sales - cost))} tone={sales - cost < 0 ? 'bad' : undefined}
          note={share != null ? `${pct(1 - share)} of sales` : '—'} />
      </div>

      <section className="card overflow-hidden">
        <div className="border-b border-line px-3.5 py-3 desk:px-5">
          <h2 className="text-base font-semibold">Food cost by week</h2>
          <p className="mt-0.5 text-[13px] text-muted">As a share of sales. Tap a week to look at just that week.</p>
        </div>
        <div className="hidden grid-cols-[150px_minmax(0,1fr)_110px_110px_90px] gap-4 border-b border-line bg-hover px-5 py-2.5 text-xs font-medium text-muted desk:grid">
          <span>Week of</span><span /><span className="text-right">Sales</span><span className="text-right">Food bought</span><span className="text-right">Food cost</span>
        </div>
        {[...rows].reverse().map((w) => {
          const p = foodCostPct(w)
          const high = p != null && p > HIGH
          return (
            <button key={w.week_start} type="button" onClick={() => setPeriod({ mode: 'week', week: w.week_start })}
              title={w.counted
                ? `Opening ${aud(w.opening_value)} + bought ${aud(w.purchases)} − closing ${aud(w.closing_value)} = ${aud(w.food_cost)}`
                : `Not counted: ${aud(w.food_cost)} is what was bought`}
              className={`num grid w-full grid-cols-[minmax(0,1fr)_auto] items-center gap-3 border-b border-line-2 px-3.5 py-3 text-left hover:bg-hover desk:grid-cols-[150px_minmax(0,1fr)_110px_110px_90px] desk:gap-4 desk:px-5 ${
                inPeriod.has(w.week_start) ? 'bg-[color-mix(in_srgb,var(--accent-tint)_45%,var(--surface))]' : ''}`}>
              <span className="min-w-0">
                <span className="block font-medium">
                  {fmtShort(w.week_start)} – {fmtShort(addDays(w.week_start, 6))}
                  {!w.counted && <span className="block text-xs font-normal text-faint">not counted</span>}
                </span>
                <span className="mt-0.5 block text-xs text-muted desk:hidden">{audRound(w.sales)} sold · {audRound(w.purchases)} bought</span>
              </span>
              <span className="hidden h-1.5 overflow-hidden rounded-[3px] bg-surface-2 desk:block">
                <span className="block h-1.5 rounded-[3px]" style={{ width: `${Math.min(100, (p ?? 0) * 100)}%`, background: high ? '#F79009' : 'var(--accent)' }} />
              </span>
              <span className="hidden text-right text-ink-2 desk:block">{w.sales ? audRound(w.sales) : '—'}</span>
              <span className="hidden text-right text-ink-2 desk:block">{w.purchases ? audRound(w.purchases) : '—'}</span>
              <span className={`text-right font-semibold ${high ? 'text-warn-ink' : ''}`}>{p != null ? pct(p) : '—'}</span>
            </button>
          )
        })}
      </section>

      <p className="text-sm text-muted">
        A week counts as counted when a finished stock count sits just before it and another falls inside it. Weeks without that
        fall back to what you bought, and say so. Hover a week for its opening and closing stock.
      </p>
    </div>
  )
}
