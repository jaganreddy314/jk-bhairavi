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

// ---------- purchasing & stock ----------

export type PoStatus = 'draft' | 'sent' | 'received' | 'cancelled'
export type StockCountStatus = 'open' | 'final'

/** A section of the count sheet, in the order you walk the shop. */
export interface StockGroup {
  id: string
  business_id: string
  name: string
  sort: number
}

export interface StockItem {
  id: string
  business_id: string
  name: string
  /** How you order and count it: kg, box, bag, ea, L… */
  unit: string
  group_id: string | null
  supplier_id: string | null
  /** Fallback cost per unit; the last price paid wins when there is one. */
  unit_cost: number | null
  active: boolean
  /** Position in its supplier's list — the order you go through when ordering. */
  supplier_sort: number
  /** Where it's counted, when placed by hand; otherwise its category's location. */
  location_id: string | null
  /** Position within that location on the stock take walk; 0 until arranged. */
  location_sort: number
}

/** A spot counted from on the stock take walk: a shelf side, a fridge door, a store room shelf. */
export interface StockLocation {
  id: string
  business_id: string
  name: string
  sort: number
}

/** A category kept at a location. A category can be at several (Drinks across the fridge doors). */
export interface StockLocationGroup {
  business_id: string
  location_id: string
  group_id: string
  sort: number
}

export interface PurchaseOrder {
  id: string
  business_id: string
  po_number: number
  supplier_id: string
  status: PoStatus
  ordered_on: string
  expected_on: string | null
  received_on: string | null
  /** The food expense this order became when it was received. */
  expense_id: string | null
  note: string | null
}

/** Row of v_purchase_order_totals: an order with its line count and value. */
export interface PurchaseOrderTotal extends Omit<PurchaseOrder, 'id'> {
  id: string
  line_count: number
  total: number
}

export interface PurchaseOrderLine {
  id: string
  purchase_order_id: string
  business_id: string
  item_id: string | null
  /** Used instead of an item for something bought once. */
  description: string | null
  qty: number
  unit_cost: number
  sort: number
}

export interface StockCount {
  id: string
  business_id: string
  /** Stock on hand at close of trade on this date. */
  count_date: string
  status: StockCountStatus
  note: string | null
}

/** Row of v_stock_count_values: a count with how much stock it found. */
export interface StockCountValue extends StockCount {
  items_counted: number
  value: number
}

export interface StockCountLine {
  id: string
  stock_count_id: string
  business_id: string
  item_id: string
  qty: number
  /** Frozen when the sheet was started, so a later price change can't move a past week. */
  unit_cost: number
}

/** Row of v_weekly_food_cost: opening stock + purchases − closing stock, per week. */
export interface WeeklyFoodCost {
  business_id: string
  week_start: string
  sales: number
  purchases: number
  opening_date: string | null
  closing_date: string | null
  opening_value: number
  closing_value: number
  /** False when the week has no count at either end: food_cost is purchases only. */
  counted: boolean
  food_cost: number
}

/** Row of v_item_cost: what an item costs now. */
export interface ItemCost {
  item_id: string
  business_id: string
  unit_cost: number
}

/** Sales of one item over one day or one Monday–Sunday week, from the till's report. */
export interface ItemSale {
  id: string
  business_id: string
  item_id: string
  period_start: string
  /** Same as period_start for a day; the Sunday for a week. */
  period_end: string
  qty: number
  amount: number
}

/** One item's sales for one week: the week's own figure, or its days added up. */
export interface ItemSalesWeek {
  business_id: string
  item_id: string
  week_start: string
  qty: number
  amount: number
  from_days: boolean
}

/** How the till's report names an item (lower-cased), remembered for the next import. */
export interface ItemAlias {
  business_id: string
  alias: string
  item_id: string
}

/**
 * One supplier for one product: their carton size, their item code, where it sits in their
 * order list, and what they last charged (read from orders, not typed in).
 */
export interface ItemSupplier {
  business_id: string
  item_id: string
  supplier_id: string
  /** Units in this supplier's carton. 1 when they sell it singly. */
  pack_size: number
  supplier_code: string | null
  sort: number
  last_unit_cost: number | null
  carton_cost: number | null
  last_bought_on: string | null
}
