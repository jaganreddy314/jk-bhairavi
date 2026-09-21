import { addDays, addMonthsClamped, diffDays, todayStr } from './dates'
import { cents } from './format'
import type { RecurringExpense, SalesDay } from './types'

export const splitSum = (d: Pick<SalesDay, 'eftpos' | 'cash' | 'uber' | 'online'>) =>
  cents(d.eftpos + d.cash + d.uber + d.online)

/** The day's takings: the recorded total if there is one, otherwise the sum of the four channels. */
export const dayTotal = (d: SalesDay) => (d.total_recorded ?? splitSum(d))

/** True when the old-sheet total and the channel sum disagree (shown as ≠). */
export const hasMismatch = (d: SalesDay) => d.total_recorded != null && Math.abs(d.total_recorded - splitSum(d)) >= 0.01

/**
 * total_recorded to save after editing a day's channels. The recorded total from the old
 * sheet is kept only while the channels are untouched, or still all zero (days where only
 * a total was written down). Otherwise the app's own sum takes over.
 */
export function nextTotalRecorded(
  existing: SalesDay | undefined,
  next: Pick<SalesDay, 'eftpos' | 'cash' | 'uber' | 'online'>,
): number | null {
  if (!existing || existing.total_recorded == null) return null
  const unchanged =
    existing.eftpos === next.eftpos && existing.cash === next.cash && existing.uber === next.uber && existing.online === next.online
  return unchanged || splitSum(next) === 0 ? existing.total_recorded : null
}

/** n-th occurrence date of a recurring expense (n = 0 is start_date). */
export function occurrence(r: Pick<RecurringExpense, 'start_date' | 'frequency'>, n: number): string {
  if (r.frequency === 'monthly') return addMonthsClamped(r.start_date, n)
  return addDays(r.start_date, n * (r.frequency === 'weekly' ? 7 : 14))
}

/** Next date on or after today this item falls due, or null if it has ended. */
export function nextDue(r: RecurringExpense, today = todayStr()): string | null {
  let n = 0
  if (r.frequency !== 'monthly' && today > r.start_date) {
    const step = r.frequency === 'weekly' ? 7 : 14
    n = Math.ceil(diffDays(r.start_date, today) / step)
  } else {
    while (occurrence(r, n) < today) n++
  }
  const d = occurrence(r, n)
  return r.end_date && d > r.end_date ? null : d
}

/** Rough weekly cost, for comparing items with different frequencies. */
export function perWeek(r: Pick<RecurringExpense, 'amount' | 'frequency'>): number {
  if (r.frequency === 'weekly') return r.amount
  if (r.frequency === 'fortnightly') return r.amount / 2
  return (r.amount * 12) / 52
}

export type RecurringStatus = 'active' | 'paused' | 'upcoming'
export function recurringStatus(r: RecurringExpense, today = todayStr()): RecurringStatus {
  if (r.end_date && r.end_date < today) return 'paused'
  if (r.start_date > today) return 'upcoming'
  return 'active'
}
