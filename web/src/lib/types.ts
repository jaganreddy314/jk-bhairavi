// Row types for the tables and views in supabase/schema.sql.
// Regenerate with `supabase gen types typescript` once a project is linked, if the schema changes.

/** How a business records a trading day. */
export type SalesMode = 'channels' | 'simple'

export interface Business {
  id: string
  /** The trading name: what the shop is called, shown everywhere in the app. */
  name: string
  sales_mode: SalesMode
  /** The company, trust or sole trader behind it. Shown on payslips with the ABN. */
  legal_name: string | null
  abn: string | null
  address: string | null
  phone: string | null
  email: string | null
  gst_registered: boolean
  /** Which till or POS the shop uses, for importing its sales reports. */
  till_system: string | null
  created_at?: string
  created_by?: string | null
}

/** A row of the platform admin's list of every business. */
export interface AdminBusiness {
  id: string
  name: string
  legal_name: string | null
  abn: string | null
  created_at: string
  created_by: string | null
  owners: string[]
  members: number
  last_sales: string | null
  i_am_member: boolean
}

export interface BusinessUser {
  email: string
  business_id: string
  display_name: string | null
  group_id: string
}

/** An area of the app a security group can open. */
export type Perm = 'finance' | 'sales' | 'purchasing' | 'stock' | 'catalogue' | 'people' | 'roster' | 'payroll' | 'sensitive' | 'admin'

export interface SecurityGroup {
  id: string
  business_id: string
  name: string
  description: string | null
  perms: Perm[]
  /** The built-in Owner group: every area, always. */
  is_owner: boolean
  sort: number
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

/** Who a labour expense paid: a name and the rate used for hours × rate. */
export interface StaffName {
  id: string
  name: string
  hourly_rate: number | null
  active: boolean
}

export type EmploymentType = 'full_time' | 'part_time' | 'casual'

/** The employee record. `name` follows first/last (or preferred) name, set by the database. */
export interface Staff {
  id: string
  business_id: string
  name: string
  /** The rate a labour expense uses for hours × rate: the person's weekday rate. */
  hourly_rate: number | null
  active: boolean
  /** 'payee' rows ("Super", "Tax") are what some labour expenses were booked against, not people. */
  kind: 'employee' | 'payee'
  first_name: string | null
  last_name: string | null
  preferred_name: string | null
  email: string | null
  mobile: string | null
  date_of_birth: string | null
  address: string | null
  emergency_contact: string | null
  role_title: string | null
  employment_type: EmploymentType
  status: 'active' | 'former'
  start_date: string | null
  end_date: string | null
  award_code: string | null
  classification_id: string | null
  above_award: number
  ordinary_hours: number | null
  agreed_days: string | null
  visa_type: string | null
  visa_expiry: string | null
  fortnight_hour_limit: number | null
  /** Part-time agreed days: 1 = Monday … 7 = Sunday. */
  agreed_dows: number[] | null
  xero_employee_id: string | null
  right_to_work: string | null
  right_to_work_checked_on: string | null
  fwis_given_on: string | null
  ceis_given_on: string | null
  notes: string | null
}

export interface Award {
  code: string
  name: string
  url: string | null
}

/** Multipliers on the ordinary hourly rate, by day. sat_pm only where Saturday afternoons differ. */
export interface DayMultipliers { weekday: number; sat: number; sat_pm?: number; sun: number; ph: number }
export type JuniorBand = 'u17' | '17' | '18' | '19' | '20'

export interface AwardRuleSet {
  id: string
  award_code: string
  key: string
  name: string
  effective_from: string
  ftpt: DayMultipliers
  casual: DayMultipliers
  junior: { ftpt: Record<JuniorBand, number>; casual: Record<JuniorBand, number> }
  extras: Record<string, { label: string; per_hour: number }>
  notes: string | null
}

export interface AwardClassification {
  id: string
  award_code: string
  rule_set_key: string
  code: string
  name: string
  sort: number
  active: boolean
}

export interface AwardRate {
  classification_id: string
  effective_from: string
  weekly: number
  hourly: number
}

export interface PayrollSettings {
  business_id: string
  pay_frequency: 'weekly' | 'fortnightly' | 'monthly'
  period_start_dow: number
  pay_day_offset: number
  default_award_code: string | null
  state: string
  super_rate: number
  super_payment_method: string | null
  stp_status: string
  /** 'QLD-BNE' adds the Brisbane show day to the statewide holidays. */
  holiday_region: 'QLD' | 'QLD-BNE'
  /** Minutes after midnight. */
  store_open: number
  store_close: number
  aba_bank_code: string | null
  aba_apca_id: string | null
  aba_user_name: string | null
  aba_bsb: string | null
  aba_account: string | null
  aba_balancing: boolean
  payslip_reply_to: string | null
}

export type TfnStatus = 'missing' | 'provided' | 'applied' | 'under_18' | 'pensioner' | 'exempt'

/** What's on file for tax. The number itself never leaves the database; tfn_last3 is shown. */
export interface StaffTax {
  staff_id: string
  tfn_last3: string | null
  tfn_status: TfnStatus
  declaration_date: string | null
  residency: 'resident' | 'foreign' | 'working_holiday' | null
  tax_free_threshold: boolean | null
  study_loan: boolean | null
  medicare_variation: string | null
}

export interface StaffSuper {
  staff_id: string
  business_id: string
  choice: 'pending' | 'chosen' | 'stapled' | 'default' | 'smsf'
  fund_name: string | null
  usi: string | null
  fund_abn: string | null
  member_number: string | null
  smsf_esa: string | null
  smsf_bsb: string | null
  smsf_account: string | null
  extra_percent: number | null
}

export interface StaffBank {
  staff_id: string
  account_name: string | null
  bsb: string | null
  account_last4: string | null
}

export interface StaffLeave {
  staff_id: string
  business_id: string
  leave_type: 'annual' | 'personal' | 'long_service'
  hours: number
  as_of: string
}

/** Whether tax, super and bank details are on file, for people who can't see them. */
export interface StaffReadiness {
  staff_id: string
  has_tfn: boolean
  tfn_status: TfnStatus
  has_super: boolean
  has_bank: boolean
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
  /** Alert when a product in this category drops to this many. A product's own wins. */
  min_stock: number | null
  /** Days before expiry its products go on clearance. A product's own wins; else a week. */
  clearance_days: number | null
  /** The department this category sits in (Drinks for Energy Drinks), if the shop uses them. */
  parent_id: string | null
  /** Filled in by useStockGroups: the department's name, for headings and labels. */
  parent_name?: string | null
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
  /** Alert at or below this many; null = its category's. */
  min_stock: number | null
  /** Days before expiry to put it on clearance; null = its category's. */
  clearance_days: number | null
}

export type BatchStatus = 'active' | 'on_clearance' | 'cleared' | 'written_off'
/** upcoming: not due yet · due: put it on clearance · on_clearance: marked down · expired: write it off */
export type BatchState = 'upcoming' | 'due' | 'on_clearance' | 'expired'

/** Some of a product sharing one expiry date, still on the shelf (v_stock_batches). */
export interface StockBatch {
  id: string
  business_id: string
  item_id: string
  expires_on: string
  qty: number | null
  status: BatchStatus
  checked_on: string
  note: string | null
  clearance_days: number
  /** The day it's due for clearance. */
  alert_from: string
  /** Negative once it has expired. */
  days_left: number
  state: BatchState
}

/** Estimated stock on hand of a product with a minimum (stock_levels). */
export interface StockLevel {
  item_id: string
  min_stock: number
  /** The last finished count it was in; null if it has never been counted. */
  counted_on: string | null
  /** That count, plus received since, less sold since. Null when never counted. */
  on_hand: number | null
}

/** A spot counted from on the stock take walk: a shelf side, a fridge door, a store room shelf. */
export interface StockLocation {
  id: string
  business_id: string
  name: string
  sort: number
}

/** A place a product is counted at, put there by hand. Without any it counts where its category is. */
export interface StockItemPlace {
  business_id: string
  item_id: string
  location_id: string
  /** Position on that shelf; 0 until arranged. */
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
  /** For a product counted in several places, what was found at each: {location id: qty}. qty is their sum. */
  place_qty: Record<string, number> | null
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

/** What the roster knows about a person: enough to cost and check shifts, nothing personal. */
export type RosterPerson = Pick<Staff, 'id' | 'name' | 'first_name' | 'last_name' | 'kind' | 'status' | 'employment_type' | 'date_of_birth'
  | 'award_code' | 'classification_id' | 'above_award' | 'ordinary_hours' | 'agreed_dows' | 'fortnight_hour_limit' | 'start_date' | 'end_date' | 'role_title'> & {
  /** Where they sit on the roster: their position's group, then this order within it. */
  position_id: string | null
  roster_sort: number | null
}

/** A business's own list of jobs on a shift (Console, Driveway, Kitchen…), in roster order. */
export interface RosterPosition {
  id: string
  business_id: string
  name: string
  sort: number
}

export interface Shift {
  id: string
  business_id: string
  staff_id: string
  shift_date: string
  /** Minutes after midnight. */
  start_minute: number
  end_minute: number
  break_minutes: number
  note: string | null
}

export interface RosterWeek {
  business_id: string
  week_start: string
  published_at: string | null
  changed_since_publish: boolean
}

/** When someone can work on a weekday (1 = Monday). No row means any time. */
export interface StaffAvailability {
  staff_id: string
  business_id: string
  dow: number
  available: boolean
  from_minute: number | null
  to_minute: number | null
  note: string | null
}

export interface PublicHoliday {
  holiday_date: string
  region: 'QLD' | 'QLD-BNE'
  name: string
  /** Part-day holidays start here (Christmas Eve: 6pm). */
  from_minute: number
}

export interface PayRunLine {
  id: string
  pay_run_id: string
  business_id: string
  staff_id: string
  /** Draft: what was typed in (leave, allowances, adjustments). */
  inputs: import('./payrun').PayInputs
  /** Finalised: the payslip as paid. */
  result: (Omit<import('./payrun').PayLine, 'staffId'> & { super_fund?: string | null; leave?: Record<string, number>; person?: Record<string, unknown>; ytd?: { gross: number; tax: number; super: number } }) | null
  gross: number | null
  tax: number | null
  super: number | null
  net: number | null
  emailed_at: string | null
}

export interface PayRun {
  id: string
  business_id: string
  period_start: string
  period_end: string
  pay_date: string
  status: 'draft' | 'finalised'
  finalised_at: string | null
  note: string | null
  xero_sent_at: string | null
  xero_result: XeroPushResult[] | null
  pay_run_lines?: PayRunLine[]
}

export interface XeroPushResult { name: string; status: 'sent' | 'updated' | 'skipped'; note?: string }
export interface XeroConnection { business_id: string; tenant_id: string; tenant_name: string | null; connected_by: string | null; connected_at: string }
export interface XeroRateMap { business_id: string; pay_label: string; earnings_rate_id: string; earnings_rate_name: string | null }
export interface XeroImportCandidate {
  id: string
  name: string
  email: string | null
  start: string | null
  status: 'active' | 'former'
  /** Who they probably are in the app: already linked, same email, or same name. */
  match: { staff_id: string; name: string; by: 'xero' | 'email' | 'name' } | null
}
export interface XeroImportResult { name: string; staff_id: string | null; status: 'created' | 'updated' | 'unchanged' | 'failed'; filled: string[]; notes: string[] }
export interface XeroCatalog {
  employees: { id: string; name: string; calendar: string | null }[]
  earningsRates: { id: string; name: string; type: string; rateType: string }[]
  calendars: { id: string; name: string; type: string }[]
}
