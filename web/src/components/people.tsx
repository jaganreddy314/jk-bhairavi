import { useAwardClassifications, useAwardRates, useAwardRuleSets } from '../lib/api'
import { toDate, todayStr } from '../lib/dates'
import { checksFor, payRates, rateOn, ruleSetOn, type Check, type PayRates } from '../lib/payroll'
import type { AwardClassification, Staff, StaffReadiness } from '../lib/types'
import type { PillTone } from './ui'

const fDate = new Intl.DateTimeFormat('en-AU', { timeZone: 'UTC', day: 'numeric', month: 'short', year: 'numeric' })
export const fmtDate = (s: string | null | undefined) => (s ? fDate.format(toDate(s)) : '')

/** Each person keeps one colour on their initials, picked from their id. */
const AVATAR = ['#0F766E', '#444CE7', '#C11574', '#B54708', '#026AA2', '#475467']
export const avatarColour = (id: string) => AVATAR[[...id].reduce((h, c) => (h * 31 + c.charCodeAt(0)) >>> 0, 7) % AVATAR.length]

export const initialsOf = (p: Pick<Staff, 'first_name' | 'last_name' | 'name'>) =>
  ((p.first_name?.[0] ?? p.name[0] ?? '?') + (p.last_name?.[0] ?? '')).toUpperCase()

export function PersonAvatar({ person, size = 36 }: { person: Staff; size?: number }) {
  const c = avatarColour(person.id)
  return (
    <span style={{ width: size, height: size, color: c, background: `color-mix(in srgb, ${c} 13%, var(--surface))`, fontSize: size * 0.36 }}
      className="grid shrink-0 place-items-center rounded-full font-semibold">
      {initialsOf(person)}
    </span>
  )
}

/** Everything the award tables say about one person's pay, today. */
export function usePayLookup() {
  const classes = useAwardClassifications()
  const rates = useAwardRates()
  const rules = useAwardRuleSets()
  const ready = !!(classes.data && rates.data && rules.data)
  const today = todayStr()
  const classOf = (p: Pick<Staff, 'classification_id'>): AwardClassification | undefined =>
    classes.data?.find((c) => c.id === p.classification_id)
  const ratesFor = (p: Staff): PayRates | null => {
    const c = classOf(p)
    if (!c || !rates.data || !rules.data) return null
    return payRates(p, rateOn(rates.data, c.id, today), ruleSetOn(rules.data, c.award_code, c.rule_set_key, today), today)
  }
  return { ready, classOf, ratesFor, classes: classes.data ?? [], rates: rates.data ?? [], rules: rules.data ?? [] }
}

export interface Readiness { tone: PillTone; label: string; note: string; ok: boolean; checks: Check[] }

export function readinessOf(p: Staff, r: StaffReadiness | undefined, rates: PayRates | null): Readiness {
  const checks = checksFor(p, r, rates)
  if (p.status === 'former') return { tone: 'neutral', label: 'Former', note: p.end_date ? `Left ${fmtDate(p.end_date)}` : 'No longer working here', ok: false, checks }
  const missing = checks.filter((c) => !c.ok)
  if (!missing.length) return { tone: 'success', label: 'Ready for payroll', note: 'Everything needed for a pay run', ok: true, checks }
  return {
    tone: 'warn', label: `${missing.length} to fix`, ok: false, checks,
    note: missing.map((m) => m.label.replace(' declaration', '').replace(' and classification', '').replace(' and contact details', '')).join(', '),
  }
}

/** A person who hasn't started yet. */
export const startsLater = (p: Staff) => !!p.start_date && p.start_date > todayStr()
