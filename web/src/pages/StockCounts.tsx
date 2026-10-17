import { useState } from 'react'
import { Link, useNavigate } from 'react-router-dom'
import { useStartStockCount, useStockCounts, useStockItems } from '../lib/api'
import { addDays, fmtDay, todayStr, weekdayIdx } from '../lib/dates'
import { aud } from '../lib/format'
import { Empty, ErrorBox, Loading, PageHeader } from '../components/ui'

/**
 * The obvious date to count: the end of the week just gone. A count is the stock on hand
 * at close of trade on its date, so counting on a Monday is really counting Sunday night.
 */
function suggestedDate(today = todayStr()): string {
  const idx = weekdayIdx(today) // 0 = Monday
  return idx === 0 ? addDays(today, -1) : today
}

export default function StockCounts() {
  const nav = useNavigate()
  const counts = useStockCounts()
  const items = useStockItems()
  const start = useStartStockCount()
  const [date, setDate] = useState(suggestedDate)

  const itemCount = (items.data ?? []).filter((i) => i.active).length
  const existing = counts.data?.find((c) => c.count_date === date)

  return (
    <div>
      <PageHeader
        title="Stock counts"
        subtitle="Count what's on hand at the end of each week. That's what turns purchases into a real food cost."
      />
      <ErrorBox error={counts.error || start.error} />

      <section className="card mb-4 p-4">
        <h2 className="font-semibold">Count the stock</h2>
        <p className="mt-0.5 text-sm text-muted">
          Stock on hand at <strong>close of trade</strong> on the date you pick. Count after you shut on Sunday and leave the
          date as it is; count on Monday morning and it still belongs to Sunday.
        </p>
        <div className="mt-3 flex flex-wrap items-end gap-2">
          <div>
            <label className="label" htmlFor="count-date">Date</label>
            <input id="count-date" type="date" className="field !w-auto" value={date} max={todayStr()}
              onChange={(e) => e.target.value && setDate(e.target.value)} />
          </div>
          <button
            type="button"
            className="btn btn-primary"
            disabled={start.isPending || itemCount === 0}
            onClick={async () => {
              const c = await start.mutateAsync(date)
              nav(`/stock/${c.id}`)
            }}
          >
            {start.isPending ? 'Opening…' : existing ? 'Open that count' : 'Start count sheet'}
          </button>
        </div>
        {itemCount === 0 ? (
          <p className="mt-2 text-sm text-muted">
            There's nothing to count yet. Add what you keep in stock in{' '}
            <Link className="font-semibold text-accent" to="/food/catalogue">Food → Catalogue</Link>.
          </p>
        ) : (
          <p className="mt-2 text-xs text-muted">
            {existing
              ? `Already counted ${fmtDay(date)} — this opens that sheet again.`
              : `${itemCount} ${itemCount === 1 ? 'item' : 'items'} to count, priced at what you last paid.`}
          </p>
        )}
      </section>

      {counts.isLoading ? (
        <Loading />
      ) : counts.data?.length === 0 ? (
        <Empty>No counts yet. The first one sets the opening stock for the week after it.</Empty>
      ) : (
        <ul className="card divide-y divide-line">
          {counts.data!.map((c) => (
            <li key={c.id} className="flex flex-wrap items-center gap-x-3 gap-y-1 px-4 py-3">
              <Link to={`/stock/${c.id}`} className="min-w-0 flex-1">
                <span className="flex flex-wrap items-center gap-2">
                  <span className="font-semibold">{fmtDay(c.count_date)}</span>
                  {c.status === 'open' && (
                    <span className="rounded-full border border-warn-line bg-warn-bg px-2 py-0.5 text-xs font-semibold text-warn-ink">
                      Still counting
                    </span>
                  )}
                </span>
                <span className="mt-0.5 block text-xs text-muted">
                  {c.items_counted} {c.items_counted === 1 ? 'item' : 'items'} with stock
                  {c.note ? ` · ${c.note}` : ''}
                </span>
              </Link>
              <span className="num shrink-0 font-semibold">{aud(c.value)}</span>
            </li>
          ))}
        </ul>
      )}

      <p className="mt-4 text-sm text-muted">
        Once two counts bracket a week, <Link className="font-semibold text-accent" to="/food">Food cost</Link> shows what
        that week's food actually cost.
      </p>
    </div>
  )
}
