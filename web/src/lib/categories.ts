import type { CategoryCode, PaidVia } from './types'

// Fixed colour per category, used by every chart and dot in the app.
export const CAT_COLOR: Record<CategoryCode, string> = {
  food: 'var(--c-food)',
  labour: 'var(--c-labour)',
  rent: 'var(--c-rent)',
  utilities: 'var(--c-utilities)',
  equipment: 'var(--c-equipment)',
  other: 'var(--c-other)',
  setup: 'var(--c-setup)',
}

export const CAT_LABEL: Record<CategoryCode, string> = {
  food: 'Food & supplies',
  labour: 'Labour / wages',
  rent: 'Rent',
  utilities: 'Utilities',
  equipment: 'Equipment',
  other: 'Other',
  setup: 'Setup (one-off)',
}

/** Categories that count toward operating profit. Equipment is reported separately; setup never. */
export const OPERATING: CategoryCode[] = ['food', 'labour', 'rent', 'utilities', 'other']

/** Categories you can pick when entering an expense (setup costs live in Settings). */
export const ENTRY_CATEGORIES: CategoryCode[] = ['food', 'labour', 'rent', 'utilities', 'equipment', 'other']

export const PAID_VIA: { value: PaidVia; label: string }[] = [
  { value: 'bank', label: 'Bank' },
  { value: 'amex', label: 'Amex' },
  { value: 'cash', label: 'Cash' },
  { value: 'other', label: 'Other' },
]

export const CHANNELS = [
  { key: 'eftpos', label: 'Card (EFTPOS)' },
  { key: 'cash', label: 'Cash' },
  { key: 'uber', label: 'Uber' },
  { key: 'online', label: 'Online' },
] as const
export type ChannelKey = (typeof CHANNELS)[number]['key']
