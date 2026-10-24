import { addDays, toDate } from './dates'
import { ageOn, shiftCost, type PayRates, type ShiftPart } from './payroll'
import { withholding, type Frequency, type TaxProfile, type Withholding } from './withholding'
import type { PublicHoliday, Shift, Staff } from './types'

/** What a person typed into their line while the pay run is a draft. */
export interface PayInputs {
  annualHours?: number
  personalHours?: number
  items?: ExtraItem[]
}

/**
 * Anything beyond rostered hours and leave.
 *  allowance     — taxable, counts for super (e.g. a tool allowance)
 *  overtime      — taxable, doesn't count for super
 *  adjustment    — taxable, counts for super; can be negative (a correction)
 *  reimbursement — paying back an expense: not taxed, not super, added after tax
 */
export interface ExtraItem { label: string; amount: number; kind: 'allowance' | 'overtime' | 'adjustment' | 'reimbursement'; hours?: number; rate?: number }

export interface PayItem {
  label: string
  hours?: number
  rate?: number
  amount: number
  kind: ShiftPart['kind'] | 'leave' | 'loading' | ExtraItem['kind']
  /** Counts as ordinary time earnings, which super is worked out on. */
  ote: boolean
}

export interface PayLine {
  staffId: string
  items: PayItem[]
  workedHours: number
  gross: number
  ote: number
  tax: Withholding
  superRate: number
  super: number
  superNote: string | null
  reimbursements: number
  net: number
  accrued: { annual: number; personal: number }
  taken: { annual: number; personal: number }
  /** Hours per day of the period for each rate, as Xero timesheets want them. */
  days: { label: string; units: number[] }[]
  warnings: string[]
}

const cent = (n: number) => Math.round(n * 100 + 1e-7) / 100

/** Annual leave: 4 weeks a year; personal/carer's leave: 10 days a year — both per ordinary hour. */
const ANNUAL_PER_HOUR = 4 / 52
const PERSONAL_PER_HOUR = 10 / 260
const LEAVE_LOADING = 0.175

/**
 * One person's pay for a period: their shifts at award rates, leave taken, anything added
 * by hand, then tax, super and leave accrual.
 */
export function payLine(o: {
  person: Staff
  rates: PayRates | null
  shifts: Shift[]
  holidayOn: (date: string) => PublicHoliday | null
  inputs: PayInputs
  profile: TaxProfile | undefined
  frequency: Frequency
  superRate: number
  periodStart: string
  periodEnd: string
  paidThisYear: number
  hasBank: boolean
  leaveBalance: { annual: number; personal: number }
}): PayLine {
  const { person: p, rates, inputs } = o
  const warnings: string[] = []
  const items: PayItem[] = []

  // Shifts, grouped by what they pay: "Ordinary hours 18h @ $33.05".
  const grouped = new Map<string, PayItem>()
  const nDays = Math.round((toDate(o.periodEnd).getTime() - toDate(o.periodStart).getTime()) / 864e5) + 1
  const days = new Map<string, number[]>()
  let worked = 0
  for (const s of o.shifts) {
    worked += (s.end_minute - s.start_minute - s.break_minutes) / 60
    if (!rates) continue
    for (const part of shiftCost(rates, s.shift_date, s.start_minute, s.end_minute, s.break_minutes, o.holidayOn(s.shift_date)).parts) {
      const key = `${part.label}|${part.rate}`
      const g = grouped.get(key) ?? { label: part.label, hours: 0, rate: part.rate, amount: 0, kind: part.kind, ote: true }
      g.hours! += part.hours
      grouped.set(key, g)
      const d = Math.round((toDate(s.shift_date).getTime() - toDate(o.periodStart).getTime()) / 864e5)
      if (d >= 0 && d < nDays) {
        const u = days.get(part.label) ?? Array(nDays).fill(0)
        u[d] = Math.round((u[d] + part.hours) * 100) / 100
        days.set(part.label, u)
      }
    }
  }
  for (const g of grouped.values()) items.push({ ...g, hours: Math.round(g.hours! * 100) / 100, amount: cent(g.hours! * g.rate!) })
  if (!rates && o.shifts.length) warnings.push('No award classification, so their hours can’t be paid. Set it in People.')

  // Leave taken: full-time and part-time only, at their ordinary rate.
  const casual = p.employment_type === 'casual'
  const annual = casual ? 0 : inputs.annualHours ?? 0
  const personal = casual ? 0 : inputs.personalHours ?? 0
  if ((inputs.annualHours || inputs.personalHours) && casual) warnings.push('Casuals don’t get paid leave; the leave hours were left off.')
  if (rates && annual > 0) {
    items.push({ label: 'Annual leave', hours: annual, rate: rates.base, amount: cent(annual * rates.base), kind: 'leave', ote: true })
    items.push({ label: 'Annual leave loading 17.5%', amount: cent(annual * rates.base * LEAVE_LOADING), kind: 'loading', ote: true })
  }
  if (rates && personal > 0) items.push({ label: 'Personal / carer’s leave', hours: personal, rate: rates.base, amount: cent(personal * rates.base), kind: 'leave', ote: true })
  if (annual > o.leaveBalance.annual + 0.001) warnings.push(`Annual leave taken (${annual}h) is more than their balance (${o.leaveBalance.annual.toFixed(1)}h).`)
  if (personal > o.leaveBalance.personal + 0.001) warnings.push(`Personal leave taken (${personal}h) is more than their balance (${o.leaveBalance.personal.toFixed(1)}h).`)

  for (const x of inputs.items ?? []) {
    if (!x.amount) continue
    items.push({ label: x.label || x.kind, hours: x.hours, rate: x.rate, amount: cent(x.amount), kind: x.kind, ote: x.kind === 'allowance' || x.kind === 'adjustment' })
  }

  // Hours past full-time, or past what a part-timer agreed, are overtime the award prices
  // differently — flagged here so it's paid as overtime rather than at ordinary rates.
  const weeks = Math.max(1, Math.round((toDate(o.periodEnd).getTime() - toDate(o.periodStart).getTime()) / 6048e5))
  const limit = p.employment_type === 'full_time' ? 38 * weeks : p.employment_type === 'part_time' && p.ordinary_hours ? p.ordinary_hours * weeks : null
  if (limit && worked > limit + 0.001 && !(inputs.items ?? []).some((x) => x.kind === 'overtime'))
    warnings.push(`Worked ${worked.toFixed(1)}h against ${limit}h ordinary. The extra ${(worked - limit).toFixed(1)}h is overtime under the award: it's paid here at its normal rate, so add only the overtime loading on top as an Overtime item.`)

  const taxable = items.filter((i) => i.kind !== 'reimbursement')
  const gross = cent(taxable.reduce((s, i) => s + i.amount, 0))
  const ote = cent(taxable.filter((i) => i.ote).reduce((s, i) => s + i.amount, 0))
  const reimbursements = cent(items.filter((i) => i.kind === 'reimbursement').reduce((s, i) => s + i.amount, 0))
  const tax = withholding(gross, o.frequency, o.profile, o.paidThisYear)
  if (tax.warning) warnings.push(tax.warning)

  // Super guarantee on ordinary time earnings. Under-18s only qualify in a week they work
  // more than 30 hours.
  const age = ageOn(p.date_of_birth, o.periodEnd)
  const under18 = age != null && age < 18 && worked + annual + personal <= 30 * weeks
  const sup = under18 ? 0 : cent(ote * o.superRate / 100)
  const superNote = under18 ? 'Under 18 and worked 30 hours or less: no super guarantee this week' : null

  const ordinaryWorked = Math.max(0, Math.min(worked, limit ?? worked))
  const accrued = casual ? { annual: 0, personal: 0 }
    : { annual: round4((ordinaryWorked + annual + personal) * ANNUAL_PER_HOUR), personal: round4((ordinaryWorked + annual + personal) * PERSONAL_PER_HOUR) }

  if (!o.hasBank && gross > 0) warnings.push('No bank account on file to pay them into.')

  return {
    staffId: p.id, items, workedHours: Math.round(worked * 100) / 100, gross, ote, tax, superRate: o.superRate, super: sup, superNote,
    reimbursements, net: cent(gross - tax.amount + reimbursements), accrued, taken: { annual, personal },
    days: [...days.entries()].map(([label, units]) => ({ label, units })), warnings,
  }
}

const round4 = (n: number) => Math.round(n * 10000) / 10000

/** The financial year a date falls in starts on this 1 July. */
export const financialYearStart = (date: string) => (date.slice(5) >= '07-01' ? `${date.slice(0, 4)}-07-01` : `${Number(date.slice(0, 4)) - 1}-07-01`)

/** Payday Super: contributions must reach the fund within 7 business days of payday. */
export function superDueDate(payDate: string, holidays: PublicHoliday[]) {
  const off = new Set(holidays.map((h) => h.holiday_date))
  let d = payDate, n = 0
  while (n < 7) {
    d = addDays(d, 1)
    const dow = toDate(d).getUTCDay()
    if (dow !== 0 && dow !== 6 && !off.has(d)) n++
  }
  return d
}
