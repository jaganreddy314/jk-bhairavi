const audFmt = new Intl.NumberFormat('en-AU', { style: 'currency', currency: 'AUD' })
const audWhole = new Intl.NumberFormat('en-AU', { style: 'currency', currency: 'AUD', maximumFractionDigits: 0 })
const audCompact = new Intl.NumberFormat('en-AU', { style: 'currency', currency: 'AUD', notation: 'compact', maximumFractionDigits: 1 })

export const aud = (n: number) => audFmt.format(n)
export const audRound = (n: number) => audWhole.format(n)
export const audShort = (n: number) => (Math.abs(n) >= 1000 ? audCompact.format(n) : audWhole.format(n))
export const pct = (n: number) => (Number.isFinite(n) ? `${(n * 100).toFixed(1)}%` : '—')

/** Round to cents to dodge float noise when summing money. */
export const cents = (n: number) => Math.round(n * 100) / 100

/** Parse a user-typed amount ("1,234.50", "$12") — returns 0 for blank/invalid. */
export function parseMoney(s: string): number {
  const n = Number(s.replace(/[$,\s]/g, ''))
  return Number.isFinite(n) ? cents(n) : 0
}

/** The ATO's ABN check: subtract 1 from the first digit, weight, and the sum divides by 89. */
export function abnValid(digits: string) {
  if (!/^\d{11}$/.test(digits)) return false
  const w = [10, 1, 3, 5, 7, 9, 11, 13, 15, 17, 19]
  return [...digits].reduce((s, c, i) => s + (Number(c) - (i === 0 ? 1 : 0)) * w[i], 0) % 89 === 0
}

/** "12345678901" → "12 345 678 901", the way the ABN is printed. */
export const formatAbn = (digits: string) => `${digits.slice(0, 2)} ${digits.slice(2, 5)} ${digits.slice(5, 8)} ${digits.slice(8)}`
