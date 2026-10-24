import { todayStr, toDate } from './dates'
import type {
  AwardClassification, AwardRate, AwardRuleSet, DayMultipliers, EmploymentType, JuniorBand, Perm, Staff, StaffReadiness,
} from './types'

export const EMPLOYMENT: { value: EmploymentType; label: string }[] = [
  { value: 'full_time', label: 'Full-time' },
  { value: 'part_time', label: 'Part-time' },
  { value: 'casual', label: 'Casual' },
]
export const employmentLabel = (t: EmploymentType) => EMPLOYMENT.find((e) => e.value === t)?.label ?? t

/** Whole years old on a date. */
export function ageOn(dob: string | null, on = todayStr()): number | null {
  if (!dob) return null
  const b = toDate(dob), d = toDate(on)
  let age = d.getUTCFullYear() - b.getUTCFullYear()
  if (d.getUTCMonth() < b.getUTCMonth() || (d.getUTCMonth() === b.getUTCMonth() && d.getUTCDate() < b.getUTCDate())) age--
  return age
}

const bandOf = (age: number | null): JuniorBand | null =>
  age == null || age >= 21 ? null : age <= 16 ? 'u17' : (String(age) as JuniorBand)
const BAND_LABEL: Record<JuniorBand, string> = { u17: 'Under 17', 17: '17', 18: '18', 19: '19', 20: '20' }

/** Round to the cent the way the Fair Work pay guides do (half up, without float drift). */
const cent = (n: number) => Math.round(n * 100 + 1e-7) / 100

/** The rate in force on a date: the latest one that started on or before it. */
export function rateOn(rates: AwardRate[], classificationId: string | null, on = todayStr()): AwardRate | null {
  return rates
    .filter((r) => r.classification_id === classificationId && r.effective_from <= on)
    .sort((a, b) => b.effective_from.localeCompare(a.effective_from))[0] ?? null
}

export function ruleSetOn(sets: AwardRuleSet[], awardCode: string | null, key: string | undefined, on = todayStr()): AwardRuleSet | null {
  return sets
    .filter((s) => s.award_code === awardCode && s.key === key && s.effective_from <= on)
    .sort((a, b) => b.effective_from.localeCompare(a.effective_from))[0] ?? null
}

export interface PayRates {
  /** Ordinary hourly rate after any junior percentage and above-award amount. */
  base: number
  /** What a normal weekday hour pays: casual loading included for casuals. */
  weekday: number
  junior: { band: string; pct: number } | null
  rows: { label: string; rate: number; note: string }[]
  rule: AwardRuleSet
  adult: number
}

const pctLabel = (m: number) => `${(m * 100).toFixed(m * 100 % 1 ? 2 : 0).replace(/0+$/, '').replace(/\.$/, '')}%`

/**
 * Hourly rates by day. The pay guides take the junior percentage of the adult ordinary rate
 * first, then apply the day's multiplier (casual loading is part of the casual multipliers).
 * Above-award pay is added to the ordinary rate before the multipliers.
 */
export function payRates(p: Pick<Staff, 'employment_type' | 'date_of_birth' | 'above_award'>, rate: AwardRate | null, rule: AwardRuleSet | null, on = todayStr()): PayRates | null {
  if (!rate || !rule) return null
  const casual = p.employment_type === 'casual'
  const band = bandOf(ageOn(p.date_of_birth, on))
  const jpct = band ? rule.junior[casual ? 'casual' : 'ftpt'][band] ?? 1 : 1
  const base = cent(cent(rate.hourly * jpct) + (p.above_award || 0))
  const m: DayMultipliers = casual ? rule.casual : rule.ftpt
  const at = (x: number) => cent(base * x)
  const satDiffers = m.sat_pm != null && m.sat_pm !== m.sat
  const rows = [
    { label: 'Mon – Fri', rate: at(m.weekday), note: m.weekday === 1 ? 'ordinary' : pctLabel(m.weekday) + (casual && m.weekday === 1.25 ? ' · casual loading' : '') },
    ...(satDiffers
      ? [{ label: 'Sat before noon', rate: at(m.sat), note: pctLabel(m.sat) }, { label: 'Sat after noon', rate: at(m.sat_pm!), note: pctLabel(m.sat_pm!) }]
      : [{ label: 'Saturday', rate: at(m.sat), note: pctLabel(m.sat) }]),
    { label: 'Sunday', rate: at(m.sun), note: pctLabel(m.sun) },
    { label: 'Public holiday', rate: at(m.ph), note: pctLabel(m.ph) },
  ]
  return {
    base, weekday: at(m.weekday), rows, rule, adult: rate.hourly,
    junior: band && jpct < 1 ? { band: BAND_LABEL[band], pct: jpct } : null,
  }
}

/** The classifications on an award, as options for a picker. */
export const classificationOptions = (all: AwardClassification[], awardCode: string | null) =>
  all.filter((c) => c.award_code === awardCode && c.active).sort((a, b) => a.sort - b.sort)

// ---------- payroll readiness ----------

export interface Check { key: string; label: string; ok: boolean; sub: string }

export function checksFor(p: Staff, r: StaffReadiness | undefined, rates: PayRates | null): Check[] {
  const out: Check[] = [
    { key: 'personal', label: 'Personal and contact details', ok: !!(p.date_of_birth && p.email && p.mobile),
      sub: p.date_of_birth && p.email && p.mobile ? 'Date of birth, email and mobile' : 'Needs date of birth, email and mobile' },
    { key: 'pay', label: 'Pay rate and classification', ok: !!rates,
      sub: rates ? (rates.junior ? `Junior rate · ${rates.junior.band}` : 'Award rate set') : 'Choose their award classification' },
    { key: 'tfn', label: 'TFN declaration', ok: !!r && (r.has_tfn || ['applied', 'under_18', 'pensioner', 'exempt'].includes(r.tfn_status)),
      sub: r?.has_tfn ? 'Received' : r && r.tfn_status !== 'missing' ? 'Exemption or application noted' : 'Not received. Without it, tax is withheld at the no-TFN rate.' },
    { key: 'super', label: 'Super fund', ok: !!r?.has_super, sub: r?.has_super ? 'Fund on file' : 'Ask for their choice of fund, or request their stapled fund' },
    { key: 'bank', label: 'Bank account', ok: !!r?.has_bank, sub: r?.has_bank ? 'On file' : 'Needed to pay wages' },
    { key: 'fwis', label: 'Fair Work Information Statement', ok: !!p.fwis_given_on, sub: p.fwis_given_on ? 'Given' : 'Must be given before or soon after they start' },
  ]
  if (p.employment_type === 'casual')
    out.push({ key: 'ceis', label: 'Casual Employment Information Statement', ok: !!p.ceis_given_on,
      sub: p.ceis_given_on ? 'Given' : 'Required for casual employees' })
  out.push({ key: 'rtw', label: 'Right to work checked', ok: !!p.right_to_work, sub: p.right_to_work ?? 'Check citizenship or visa (VEVO)' })
  return out
}

// ---------- areas a security group can open ----------

export const PERMS: { key: Perm; label: string; sub: string }[] = [
  { key: 'finance', label: 'Money', sub: 'Dashboard, expenses, food cost and item sales' },
  { key: 'sales', label: 'Enter sales', sub: 'The day’s takings and cash' },
  { key: 'purchasing', label: 'Purchase orders', sub: 'Order from suppliers and receive deliveries' },
  { key: 'stock', label: 'Stock counts', sub: 'Count what’s on the shelves' },
  { key: 'catalogue', label: 'Catalogue', sub: 'Products, suppliers and the store layout' },
  { key: 'people', label: 'People', sub: 'The team and their employment details' },
  { key: 'payroll', label: 'Payroll', sub: 'Pay rates, awards and payroll setup; editing people' },
  { key: 'sensitive', label: 'Tax, bank and super', sub: 'Tax file numbers, bank accounts and super funds' },
  { key: 'admin', label: 'Settings and access', sub: 'Business settings, who can sign in and security groups' },
]
