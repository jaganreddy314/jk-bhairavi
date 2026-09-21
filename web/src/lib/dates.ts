// Dates are plain 'YYYY-MM-DD' strings everywhere. Arithmetic happens in UTC so the
// device's own timezone never shifts a day. "Today" is Brisbane's today.

const MS_DAY = 86_400_000

export function todayStr(): string {
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'Australia/Brisbane' }).format(new Date())
}

export const toDate = (s: string) => new Date(`${s}T00:00:00Z`)
export const toStr = (d: Date) => d.toISOString().slice(0, 10)

export const addDays = (s: string, n: number) => toStr(new Date(toDate(s).getTime() + n * MS_DAY))
export const diffDays = (a: string, b: string) => Math.round((toDate(b).getTime() - toDate(a).getTime()) / MS_DAY)

/** 0 = Monday … 6 = Sunday */
export const weekdayIdx = (s: string) => (toDate(s).getUTCDay() + 6) % 7
export const weekStart = (s: string) => addDays(s, -weekdayIdx(s))
export const monthStart = (s: string) => `${s.slice(0, 7)}-01`

/** start + n months, keeping the day-of-month and clamping to month end (31 Jan → 28 Feb). */
export function addMonthsClamped(start: string, n: number): string {
  const d = toDate(start)
  const y = d.getUTCFullYear()
  const m = d.getUTCMonth() + n
  const lastDay = new Date(Date.UTC(y, m + 1, 0)).getUTCDate()
  return toStr(new Date(Date.UTC(y, m, Math.min(d.getUTCDate(), lastDay))))
}

export const WEEKDAYS = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun']

const fmt = (opts: Intl.DateTimeFormatOptions) => new Intl.DateTimeFormat('en-AU', { timeZone: 'UTC', ...opts })
const fShort = fmt({ day: 'numeric', month: 'short' })
const fLong = fmt({ weekday: 'short', day: 'numeric', month: 'short', year: 'numeric' })
const fDay = fmt({ weekday: 'short', day: 'numeric', month: 'short' })

export const fmtShort = (s: string) => fShort.format(toDate(s)) // 31 Aug
export const fmtLong = (s: string) => fLong.format(toDate(s)) // Mon, 31 Aug 2026
export const fmtDay = (s: string) => fDay.format(toDate(s)) // Mon 31 Aug

export function eachDay(from: string, to: string): string[] {
  const out: string[] = []
  for (let d = from; d <= to; d = addDays(d, 1)) out.push(d)
  return out
}
