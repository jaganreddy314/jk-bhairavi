import { PERIOD_MODES, periodChip, periodWeeks, setPeriod, weekLabel, type Period } from '../lib/period'
import { Segmented } from './ui'

const Chevron = ({ d }: { d: string }) => (
  <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden><path d={d} /></svg>
)

/**
 * Week / 4 weeks / Month / All, then ‹ week › with every week one tap away in a native
 * picker laid invisibly over the label. Stepping from “All” narrows to a single week.
 */
export function PeriodControls({ period, weeks }: { period: Period; weeks: string[] }) {
  const i = Math.max(0, weeks.indexOf(period.week))
  const latest = weeks.length - 1
  const go = (n: number) => setPeriod({ mode: period.mode === 'all' ? 'week' : period.mode, week: weeks[Math.min(latest, Math.max(0, n))] })
  const stepBtn = 'grid h-full w-9 place-items-center bg-surface text-ink-2 hover:bg-hover disabled:opacity-40 disabled:hover:bg-surface'

  return (
    <div className="flex flex-wrap items-center gap-2">
      <Segmented ariaLabel="Period" value={period.mode} options={PERIOD_MODES}
        onChange={(mode) => setPeriod({ ...period, mode })} />
      <div className="flex h-[38px] items-center overflow-hidden rounded-lg border border-input-line bg-surface shadow-[0_1px_2px_rgba(16,24,40,0.05)]">
        <button type="button" aria-label="Previous week" className={`${stepBtn} border-r border-line`} disabled={i === 0} onClick={() => go(i - 1)}>
          <Chevron d="m15 18-6-6 6-6" />
        </button>
        <label className="num relative flex h-full min-w-[190px] cursor-pointer items-center gap-2 px-3 text-[13px] font-medium text-ink-2 hover:bg-hover">
          <svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="text-muted" aria-hidden>
            <rect width="18" height="18" x="3" y="4" rx="2" /><path d="M16 2v4M8 2v4M3 10h18" />
          </svg>
          <span className="flex-1 whitespace-nowrap">{periodChip(period, periodWeeks(period, weeks))}</span>
          <span className="text-muted"><Chevron d="m6 9 6 6 6-6" /></span>
          <select aria-label="Pick a week" className="absolute inset-0 cursor-pointer opacity-0" value={weeks[i]}
            onChange={(e) => setPeriod({ mode: period.mode === 'all' ? 'week' : period.mode, week: e.target.value })}>
            {[...weeks].reverse().map((w) => <option key={w} value={w}>{weekLabel(w)}</option>)}
          </select>
        </label>
        <button type="button" aria-label="Next week" className={`${stepBtn} border-l border-line`} disabled={i === latest} onClick={() => go(i + 1)}>
          <Chevron d="m9 18 6-6-6-6" />
        </button>
      </div>
      {i !== latest && period.mode !== 'all' && (
        <button type="button" className="btn btn-sm h-[38px] font-medium" onClick={() => go(latest)}>Latest week</button>
      )}
    </div>
  )
}
