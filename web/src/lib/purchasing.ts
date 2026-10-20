import { fmtDay } from './dates'
import { aud, cents } from './format'
import type { PoStatus, PurchaseOrderLine, StockCountLine, WeeklyFoodCost } from './types'

export const lineTotal = (l: Pick<PurchaseOrderLine, 'qty' | 'unit_cost'>) => cents(l.qty * l.unit_cost)
export const orderTotal = (lines: Pick<PurchaseOrderLine, 'qty' | 'unit_cost'>[]) =>
  cents(lines.reduce((s, l) => s + l.qty * l.unit_cost, 0))

export const countLineValue = (l: Pick<StockCountLine, 'qty' | 'unit_cost'>) => cents(l.qty * l.unit_cost)
export const countTotal = (lines: Pick<StockCountLine, 'qty' | 'unit_cost'>[]) =>
  cents(lines.reduce((s, l) => s + l.qty * l.unit_cost, 0))

export const PO_STATUS: { value: PoStatus; label: string }[] = [
  { value: 'draft', label: 'Draft' },
  { value: 'sent', label: 'Sent' },
  { value: 'received', label: 'Received' },
  { value: 'cancelled', label: 'Cancelled' },
]

export const PO_STATUS_LABEL: Record<PoStatus, string> = {
  draft: 'Draft',
  sent: 'Sent',
  received: 'Received',
  cancelled: 'Cancelled',
}

/** Tailwind classes for the little status pill, so one status looks the same everywhere. */
export const PO_STATUS_CLASS: Record<PoStatus, string> = {
  draft: 'bg-surface-2 text-ink-2',
  sent: 'bg-warn-bg text-warn-ink border border-warn-line',
  received: 'bg-good/10 text-good',
  cancelled: 'bg-surface-2 text-muted line-through',
}

/** Quantities are typed by hand, so trailing zeros are trimmed: 2.500 reads as 2.5. */
export const qtyStr = (n: number) => String(Math.round(n * 1000) / 1000)

/**
 * The order as plain text, to paste into WhatsApp, a text message or an email.
 * Quantity and unit lead each line because that is what the supplier picks from;
 * prices are left off individual lines so a stale cost never reads as an agreed price,
 * and the total is marked approximate for the same reason.
 */
export function orderText(o: {
  businessName: string
  supplierName: string
  poNumber: number
  expectedOn: string | null
  note: string | null
  lines: { qty: number; unit: string; name: string }[]
  total: number
}): string {
  const out = [`Order — ${o.businessName}`, `For: ${o.supplierName}`]
  if (o.expectedOn) out.push(`Deliver: ${fmtDay(o.expectedOn)}`)
  out.push('')
  for (const l of o.lines) out.push(`${qtyStr(l.qty)} ${l.unit}  ${l.name}`)
  out.push('')
  if (o.total > 0) out.push(`Approx ${aud(o.total)}`)
  if (o.note?.trim()) out.push(o.note.trim())
  out.push(`Ref PO #${o.poNumber}`)
  return out.join('\n')
}

/**
 * Food cost as a share of sales. Null when there were no sales that week, so a
 * quiet week shows "—" instead of a meaningless percentage or a division by zero.
 */
export const foodCostPct = (w: Pick<WeeklyFoodCost, 'food_cost' | 'sales'>) =>
  w.sales > 0 ? w.food_cost / w.sales : null

/** What the stock did over the week: positive means more stock on hand than at the start. */
export const stockMovement = (w: Pick<WeeklyFoodCost, 'opening_value' | 'closing_value' | 'counted'>) =>
  w.counted ? cents(w.closing_value - w.opening_value) : null
