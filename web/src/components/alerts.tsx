import { Link } from 'react-router-dom'
import { useStockBatches, useStockLevels } from '../lib/api'

/**
 * What needs doing today: expiry dates inside their clearance window (or past it), and
 * products estimated at or below their minimum. Products never counted have no estimate,
 * so they can't be low.
 */
export function useStockAlerts() {
  const batches = useStockBatches()
  const levels = useStockLevels()
  const expiring = (batches.data ?? []).filter((b) => b.state !== 'upcoming')
  const low = (levels.data ?? []).filter((l) => l.on_hand != null && l.on_hand <= l.min_stock)
  return {
    batches, levels, expiring, low,
    expired: expiring.filter((b) => b.state === 'expired').length,
    count: expiring.length + low.length,
    isLoading: batches.isLoading || levels.isLoading,
    error: batches.error || levels.error,
  }
}

/** The count beside "Stock alerts" in the navigation. Nothing when all is well. */
export function AlertBadge() {
  const { count, expired } = useStockAlerts()
  if (!count) return null
  return (
    <span className={`num ml-auto min-w-5 rounded-full px-1.5 text-center text-[11px] font-semibold leading-5 ${
      expired ? 'bg-bad text-white' : 'bg-warn-bg text-warn-ink'}`}>
      {count}
    </span>
  )
}

/** One line at the top of a page when something needs doing, linking to the alerts. */
export function AlertsBanner() {
  const { expiring, low, expired } = useStockAlerts()
  if (!expiring.length && !low.length) return null
  const parts = [
    expired > 0 && `${expired} expired`,
    expiring.length - expired > 0 && `${expiring.length - expired} due for clearance`,
    low.length > 0 && `${low.length} low on stock`,
  ].filter(Boolean)
  return (
    <div role="status" className="mb-4 flex flex-wrap items-center gap-3 rounded-[10px] border border-warn-line bg-warn-bg px-4 py-3 text-warn-ink">
      <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="shrink-0" aria-hidden>
        <path d="M10.268 21a2 2 0 0 0 3.464 0" /><path d="M3.262 15.326A1 1 0 0 0 4 17h16a1 1 0 0 0 .74-1.673C19.41 13.956 18 12.499 18 8A6 6 0 0 0 6 8c0 4.499-1.411 5.956-2.738 7.326" />
      </svg>
      <p className="min-w-60 flex-1"><b className="font-semibold">Stock alerts:</b> {parts.join(' · ')}</p>
      <Link to={expiring.length ? '/alerts' : '/alerts?tab=low'}
        className="rounded-lg border border-warn-line bg-surface px-3 py-1.5 font-semibold text-warn-ink hover:bg-hover">
        View alerts
      </Link>
    </div>
  )
}
