// PAYG withholding, from the ATO's statements of formulas for payments made from 1 July 2026
// (Taxation Administration (Withholding Schedules) Instrument 2026, F2026L00716):
//   Schedule 1  — amounts to be withheld (scales 1–6)
//   Schedule 8  — with a study and training support loan (HELP, VSL, SFSS, SSL, AASL)
//   Schedule 15 — working holiday makers
// Each row is [weekly earnings less than, a, b]; withholding is y = a·x − b on the weekly
// figure, with x = whole dollars of earnings + 99 cents. Update these when the ATO publishes
// new schedules (usually for 1 July).

type Row = [number, number, number]
const TOP = Infinity

const SCHEDULE_1: Record<1 | 2 | 3 | 5 | 6, Row[]> = {
  1: [[188, 0.15, 0.15], [371, 0.2084, 11.0185], [515, 0.179, 0.1066], [932, 0.3227, 74.1674], [2246, 0.32, 71.6508], [3303, 0.39, 228.8816], [TOP, 0.47, 493.1893]],
  2: [[362, 0, 0], [538, 0.15, 54.3462], [673, 0.25, 108.2135], [721, 0.17, 54.3473], [865, 0.179, 60.8377], [1282, 0.3227, 185.1935], [2596, 0.32, 181.7319], [3653, 0.39, 363.4627], [TOP, 0.47, 655.7704]],
  3: [[2596, 0.3, 0.3], [3653, 0.37, 181.7308], [TOP, 0.45, 474.0385]],
  5: [[362, 0, 0], [721, 0.15, 54.3462], [865, 0.159, 60.8365], [1282, 0.3027, 185.1923], [2596, 0.3, 181.7308], [3653, 0.37, 363.4615], [TOP, 0.45, 655.7692]],
  6: [[362, 0, 0], [721, 0.15, 54.3462], [865, 0.159, 60.8365], [908, 0.3027, 185.1923], [1135, 0.3527, 230.6135], [1282, 0.3127, 185.1923], [2596, 0.31, 181.7308], [3653, 0.38, 363.4615], [TOP, 0.46, 655.7692]],
}

/** Schedule 8: the same scales with the study and training support loans component built in. */
const WITH_STSL: Record<1 | 2 | 3 | 5 | 6, Row[]> = {
  1: [[188, 0.15, 0.15], [371, 0.2084, 11.0185], [515, 0.179, 0.1066], [932, 0.3227, 74.1674], [987, 0.32, 71.6508], [2144, 0.47, 219.7124], [2246, 0.49, 262.6035], [2727, 0.56, 419.8343], [3303, 0.49, 228.8816], [TOP, 0.57, 493.1893]],
  2: [[362, 0, 0], [538, 0.15, 54.3462], [673, 0.25, 108.2135], [721, 0.17, 54.3473], [865, 0.179, 60.8377], [1282, 0.3227, 185.1935], [1337, 0.32, 181.7319], [2494, 0.47, 382.2935], [2596, 0.49, 432.1846], [3577, 0.56, 613.9154], [3653, 0.49, 363.4627], [TOP, 0.57, 655.7704]],
  3: [[1337, 0.3, 0.3], [2494, 0.45, 200.5615], [2596, 0.47, 250.4527], [3577, 0.54, 432.1835], [3653, 0.47, 181.7308], [TOP, 0.55, 474.0385]],
  5: [[362, 0, 0], [721, 0.15, 54.3462], [865, 0.159, 60.8365], [1282, 0.3027, 185.1923], [1337, 0.3, 181.7308], [2494, 0.45, 382.2923], [2596, 0.47, 432.1835], [3577, 0.54, 613.9142], [3653, 0.47, 363.4615], [TOP, 0.55, 655.7692]],
  6: [[362, 0, 0], [721, 0.15, 54.3462], [865, 0.159, 60.8365], [908, 0.3027, 185.1923], [1135, 0.3527, 230.6135], [1282, 0.3127, 185.1923], [1337, 0.31, 181.7308], [2494, 0.46, 382.2923], [2596, 0.48, 432.1835], [3577, 0.55, 613.9142], [3653, 0.48, 363.4615], [TOP, 0.56, 655.7692]],
}

/** Schedule 15, Table A: the rate by how much has already been paid this income year. */
const WHM: [number, number][] = [[45_000, 0.15], [135_000, 0.3], [190_000, 0.37], [TOP, 0.45]]

export const WITHHOLDING_SOURCE = 'ATO withholding schedules for payments from 1 July 2026 (Schedules 1, 8 and 15)'

export type Frequency = 'weekly' | 'fortnightly' | 'monthly'

export interface TaxProfile {
  has_tfn: boolean
  tfn_status: string
  residency: string | null
  tax_free_threshold: boolean | null
  study_loan: boolean | null
  medicare_variation: string | null
}

export interface Withholding {
  amount: number
  /** How it was worked out, for the payslip and the pay run screen. */
  basis: string
  /** Something a person should look at before paying. */
  warning?: string
}

/** Round to the nearest dollar, 50 cents up, straight from the formula result. */
const dollar = (y: number) => Math.floor(y + 0.5 + 1e-9)

/** x = whole dollars + 99 cents, on the weekly equivalent of the pay. */
function weeklyX(earnings: number, f: Frequency) {
  const weekly = f === 'weekly' ? earnings
    : f === 'fortnightly' ? earnings / 2
    : ((Math.round(earnings * 100) % 100 === 33 ? earnings + 0.01 : earnings) * 3) / 13
  return Math.floor(weekly + 1e-9) + 0.99
}

/** Back from the rounded weekly amount to the pay period. */
const fromWeekly = (y: number, f: Frequency) => (f === 'weekly' ? y : f === 'fortnightly' ? y * 2 : dollar((y * 13) / 3))

function fromTable(rows: Row[], x: number) {
  const [, a, b] = rows.find(([lt]) => x < lt)!
  return Math.max(0, dollar(a * x - b))
}

/**
 * Tax to withhold from one pay. `paidThisYear` is what this person had already been paid in
 * the income year before this pay (only working holiday makers need it).
 */
export function withholding(earnings: number, f: Frequency, p: TaxProfile | undefined, paidThisYear = 0): Withholding {
  if (earnings <= 0) return { amount: 0, basis: 'Nothing to withhold' }
  const foreign = p?.residency === 'foreign'
  const exempt = ['applied', 'under_18', 'pensioner', 'exempt'].includes(p?.tfn_status ?? '')
  const tfn = !!p?.has_tfn || exempt

  if (p?.residency === 'working_holiday') {
    if (!tfn) return { amount: Math.floor(earnings * 0.45), basis: 'Working holiday maker without a TFN · 45%', warning: 'No TFN: withholding 45%.' }
    const rate = WHM.find(([upTo]) => paidThisYear < upTo)![1]
    return { amount: dollar(rate * Math.floor(earnings + 1e-9)), basis: `Working holiday maker · ${rate * 100}% (Schedule 15)`,
      warning: 'Assumes you are registered with the ATO as an employer of working holiday makers; otherwise foreign resident rates apply.' }
  }
  if (!tfn) {
    const rate = foreign ? 0.45 : 0.47
    return { amount: Math.floor(Math.floor(earnings + 1e-9) * rate), basis: `No TFN declaration · ${rate * 100}%`,
      warning: 'No TFN declaration: tax is withheld at the top rate until one is received.' }
  }
  const medicare = (p?.medicare_variation ?? '').toLowerCase()
  const scale: 1 | 2 | 3 | 5 | 6 = foreign ? 3 : !p?.tax_free_threshold ? 1 : medicare.includes('full') ? 5 : medicare.includes('half') ? 6 : 2
  const stsl = !!p?.study_loan
  const y = fromTable((stsl ? WITH_STSL : SCHEDULE_1)[scale], weeklyX(earnings, f))
  const SCALE_NAME = { 1: 'no tax-free threshold', 2: 'tax-free threshold', 3: 'foreign resident', 5: 'full Medicare exemption', 6: 'half Medicare exemption' }
  return {
    amount: fromWeekly(y, f),
    basis: `Scale ${scale} · ${SCALE_NAME[scale]}${stsl ? ' · with study loan' : ''}`,
    warning: p?.tfn_status === 'applied' && !p.has_tfn ? 'They’ve applied for a TFN: if it isn’t provided within 28 days, withhold at the no-TFN rate.'
      : medicare && !medicare.includes('full') && !medicare.includes('half') ? 'Medicare levy variation noted — family adjustments aren’t worked out here; check the amount.' : undefined,
  }
}
