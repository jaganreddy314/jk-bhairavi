import { useMemo, useSyncExternalStore } from 'react'
import { addDays, fmtShort, monthStart, todayStr, toDate, weekStart } from './dates'

// The shop runs Monday to Sunday, so every period is a run of whole weeks around one
// selected week. Dashboard and Food share the selection: pick a week on one and the
// other opens on it too.

export type PeriodMode = 'week' | '4weeks' | 'month' | 'all'
export interface Period { mode: PeriodMode; week: string }

export const PERIOD_MODES: { value: PeriodMode; label: string }[] = [
  { value: 'week', label: 'Week' },
  { value: '4weeks', label: '4 weeks' },
  { value: 'month', label: 'Month' },
  { value: 'all', label: 'All' },
]

const MODE_KEY = 'period:mode'
const currentWeek = () => weekStart(todayStr())

// The mode is remembered on this device; the week is not, so the app always opens on
// the latest week rather than wherever someone was looking yesterday.
let state: Period = (() => {
  let mode: PeriodMode = '4weeks'
  try {
    const saved = localStorage.getItem(MODE_KEY)
    if (PERIOD_MODES.some((m) => m.value === saved)) mode = saved as PeriodMode
  } catch { /* storage unavailable */ }
  return { mode, week: currentWeek() }
})()

const listeners = new Set<() => void>()
const subscribe = (fn: () => void) => { listeners.add(fn); return () => { listeners.delete(fn) } }

export function setPeriod(next: Period) {
  const latest = currentWeek()
  state = { mode: next.mode, week: next.week > latest ? latest : next.week }
  try { localStorage.setItem(MODE_KEY, state.mode) } catch { /* storage unavailable */ }
  listeners.forEach((fn) => fn())
}

export const usePeriod = () => useSyncExternalStore(subscribe, () => state)

/** Every Monday from the first week with data to this week, oldest first. */
export function weeksSince(earliest: string | null): string[] {
  const latest = currentWeek()
  const out: string[] = []
  for (let w = earliest ? weekStart(earliest) : addDays(latest, -7 * 15); w <= latest; w = addDays(w, 7)) out.push(w)
  return out
}

/** The Mondays a period covers. A month is the weeks that start in it. */
export function periodWeeks(p: Period, all: string[]): string[] {
  switch (p.mode) {
    case 'week': return [p.week]
    case '4weeks': return all.filter((w) => w <= p.week && w > addDays(p.week, -28))
    case 'month': return all.filter((w) => monthStart(w) === monthStart(p.week))
    case 'all': return all
  }
}

const fMonth = new Intl.DateTimeFormat('en-AU', { timeZone: 'UTC', month: 'long', year: 'numeric' })
const year = (s: string) => s.slice(0, 4)

/** What the week stepper shows: "5 Oct – 11 Oct 2026", "October 2026", "All weeks". */
export function periodChip(p: Period, weeks: string[]): string {
  if (p.mode === 'all') return 'All weeks'
  if (p.mode === 'month') return fMonth.format(toDate(p.week))
  const from = weeks[0] ?? p.week
  const to = addDays(weeks[weeks.length - 1] ?? p.week, 6)
  return `${fmtShort(from)}${year(from) !== year(to) ? ` ${year(from)}` : ''} – ${fmtShort(to)} ${year(to)}`
}

export const weekLabel = (w: string) => {
  const end = addDays(w, 6)
  return `${fmtShort(w)} – ${fmtShort(end)} ${year(end)}`
}

/**
 * Everything a page needs for the shared period: every week since `earliest`, the weeks
 * in the period, the weeks a chart shows (the last 16, reaching further back when the
 * period does) and the period's first and last day.
 */
export function usePeriodRange(earliest: string | null) {
  const period = usePeriod()
  const all = useMemo(() => weeksSince(earliest), [earliest])
  const inPeriod = periodWeeks(period, all)
  const shownFrom = [inPeriod[0] ?? period.week, all[Math.max(0, all.length - 16)]].sort()[0]
  return {
    period, all, inPeriod,
    shown: all.filter((w) => w >= shownFrom),
    shownFrom,
    lastDay: addDays(all[all.length - 1], 6),
    from: inPeriod[0] ?? period.week,
    to: addDays(inPeriod[inPeriod.length - 1] ?? period.week, 6),
  }
}

/** Selecting a week from a chart or table keeps the mode, except "All", which narrows to that week. */
export const pickWeek = (p: Period, week: string) => setPeriod({ mode: p.mode === 'all' ? 'week' : p.mode, week })
