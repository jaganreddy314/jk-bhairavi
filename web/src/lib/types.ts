// Row types for the tables and views in supabase/schema.sql.
// Regenerate with `supabase gen types typescript` once a project is linked, if the schema changes.

/** How a business records a trading day. */
export type SalesMode = 'channels' | 'simple'

export interface Business {
  id: string
  name: string
  sales_mode: SalesMode
  created_at?: string
}

export interface BusinessUser {
  email: string
  business_id: string
  display_name: string | null
}

export type PaidVia = 'bank' | 'amex' | 'cash' | 'other'
export type Frequency = 'weekly' | 'fortnightly' | 'monthly'
export type CategoryCode = 'food' | 'labour' | 'rent' | 'utilities' | 'equipment' | 'other' | 'setup'

export interface SalesDay {
  id: string
  business_id: string
  sale_date: string
  eftpos: number
  cash: number
  uber: number
  online: number
  total_recorded: number | null
  /** Cash in hand that day. Unrelated to sales (a service station till also takes fuel money). */
  cash_collected: number | null
  notes: string | null
}

export interface ExpenseCategory {
  code: CategoryCode
  label: string
  is_operating: boolean
  sort: number
}

export interface Supplier {
  id: string
  business_id: string
  name: string
  default_category: CategoryCode | null
  active: boolean
}

export interface Staff {
  id: string
  business_id: string
  name: string
  hourly_rate: number | null
  active: boolean
}

export interface Expense {
  id: string
  business_id: string
  expense_date: string
  category: CategoryCode
  supplier_id: string | null
  staff_id: string | null
  hours: number | null
  amount: number
  paid_via: PaidVia
  note: string | null
}

/** Row of v_all_expenses: one-off expenses plus computed recurring occurrences. */
export interface AnyExpense {
  id: string
  business_id: string
  expense_date: string
  category: CategoryCode
  supplier_id: string | null
  staff_id: string | null
  amount: number
  paid_via: PaidVia
  note: string | null
  is_recurring: boolean
}

export interface RecurringExpense {
  id: string
  business_id: string
  name: string
  category: CategoryCode
  supplier_id: string | null
  amount: number
  frequency: Frequency
  start_date: string
  end_date: string | null
  paid_via: PaidVia
  note: string | null
}

export interface Partner {
  id: string
  business_id: string
  name: string
  ownership_pct: number
}

export interface PartnerContribution {
  id: string
  business_id: string
  partner_id: string
  contributed_on: string | null
  amount: number
  description: string | null
}

export interface SetupCost {
  id: string
  business_id: string
  item: string
  amount: number
  incurred_on: string | null
  note: string | null
}
