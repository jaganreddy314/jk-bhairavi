import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { supabase } from './supabase'
import { useBusinessId } from './business'
import type {
  AnyExpense, Business, BusinessUser, Expense, ExpenseCategory, ItemCost, Partner, PartnerContribution,
  PurchaseOrder, PurchaseOrderLine, PurchaseOrderTotal, RecurringExpense, SalesDay, SetupCost, Staff,
  StockCount, StockCountLine, StockCountValue, StockGroup, StockItem, Supplier, WeeklyFoodCost,
} from './types'

// PostgREST can return numeric columns as strings; coerce the money fields we use.
const num = (v: unknown) => (v == null ? null : Number(v))
function money<T>(rows: T[], fields: (keyof T)[]): T[] {
  return rows.map((r) => {
    const out = { ...r }
    for (const f of fields) (out as Record<keyof T, unknown>)[f] = num(r[f])
    return out
  })
}

async function run<T>(p: PromiseLike<{ data: T | null; error: { message: string } | null }>): Promise<T> {
  const { data, error } = await p
  if (error) throw new Error(error.message)
  return data as T
}

// ---------- reads ----------
// Every query is filtered by the selected business. Row-level security enforces the same
// thing server-side; the filter also keeps each business's cached data separate.

export const useSales = (from: string, to: string) => {
  const biz = useBusinessId()
  return useQuery({
    queryKey: ['sales', biz, from, to],
    queryFn: async () =>
      money(
        await run(supabase.from('sales_days').select('*').eq('business_id', biz)
          .gte('sale_date', from).lte('sale_date', to).order('sale_date')),
        ['eftpos', 'cash', 'uber', 'online', 'total_recorded', 'cash_collected'],
      ) as SalesDay[],
  })
}

export const useAllExpenses = (from: string, to: string) => {
  const biz = useBusinessId()
  return useQuery({
    queryKey: ['all-expenses', biz, from, to],
    queryFn: async () =>
      money(
        await run(supabase.from('v_all_expenses').select('*').eq('business_id', biz)
          .gte('expense_date', from).lte('expense_date', to).order('expense_date')),
        ['amount'],
      ) as AnyExpense[],
  })
}

export interface ExpenseFilter { from: string; to: string; category?: string; supplierId?: string }
export const useExpenses = (f: ExpenseFilter) => {
  const biz = useBusinessId()
  return useQuery({
    queryKey: ['expenses', biz, f],
    queryFn: async () => {
      let q = supabase.from('expenses').select('*').eq('business_id', biz)
        .gte('expense_date', f.from).lte('expense_date', f.to)
      if (f.category) q = q.eq('category', f.category)
      if (f.supplierId) q = q.eq('supplier_id', f.supplierId)
      return money(await run(q.order('expense_date', { ascending: false }).order('created_at', { ascending: false })), [
        'amount', 'hours',
      ]) as Expense[]
    },
  })
}

export const useExpense = (id: string | undefined) =>
  useQuery({
    queryKey: ['expense', id],
    enabled: !!id,
    queryFn: async () => money([await run<Expense>(supabase.from('expenses').select('*').eq('id', id!).single())], ['amount', 'hours'])[0],
  })

export const useEarliestSale = () => {
  const biz = useBusinessId()
  return useQuery({
    queryKey: ['earliest', biz],
    queryFn: async () => {
      const [s, e] = await Promise.all([
        run(supabase.from('sales_days').select('sale_date').eq('business_id', biz).order('sale_date').limit(1)),
        run(supabase.from('expenses').select('expense_date').eq('business_id', biz).order('expense_date').limit(1)),
      ])
      const dates = [(s as { sale_date: string }[])[0]?.sale_date, (e as { expense_date: string }[])[0]?.expense_date].filter(Boolean)
      return (dates.sort()[0] as string | undefined) ?? null
    },
  })
}

/** A whole table for the selected business (small lists: suppliers, staff, partners…). */
const scopedTable = <T,>(name: string, order: string, moneyFields: string[] = []) => () => {
  const biz = useBusinessId()
  return useQuery({
    queryKey: [name, biz],
    queryFn: async () =>
      money(await run(supabase.from(name).select('*').eq('business_id', biz).order(order)), moneyFields as never[]) as T[],
  })
}

export const useSuppliers = scopedTable<Supplier>('suppliers', 'name')
export const useStaff = scopedTable<Staff>('staff', 'name', ['hourly_rate'])
export const useRecurring = scopedTable<RecurringExpense>('recurring_expenses', 'name', ['amount'])
export const usePartners = scopedTable<Partner>('partners', 'name', ['ownership_pct'])
export const useContributions = scopedTable<PartnerContribution>('partner_contributions', 'contributed_on', ['amount'])
export const useSetupCosts = scopedTable<SetupCost>('setup_costs', 'item', ['amount'])

/** Categories are the same for every business. */
export const useCategories = () =>
  useQuery({
    queryKey: ['expense_categories'],
    queryFn: async () => (await run(supabase.from('expense_categories').select('*').order('sort'))) as ExpenseCategory[],
  })

/** People who can use the selected business. */
export const useBusinessUsers = () => {
  const biz = useBusinessId()
  return useQuery({
    queryKey: ['business_users', biz],
    queryFn: async () =>
      (await run(supabase.from('business_users').select('*').eq('business_id', biz).order('email'))) as BusinessUser[],
  })
}

// ---------- writes ----------

/** Tables → the query keys that depend on them, so a write refreshes every screen that shows it. */
const DEPENDENTS: Record<string, string[]> = {
  sales_days: ['sales', 'earliest'],
  expenses: ['expenses', 'expense', 'all-expenses', 'earliest'],
  recurring_expenses: ['recurring_expenses', 'all-expenses'],
  suppliers: ['suppliers'],
  staff: ['staff'],
  partners: ['partners'],
  partner_contributions: ['partner_contributions'],
  setup_costs: ['setup_costs'],
  businesses: ['businesses'],
  business_users: ['business_users'],
  stock_groups: ['stock_groups', 'stock_items'],
  // An item's name, cost or group shows up on count sheets and order lines alike.
  stock_items: ['stock_items', 'item_costs', 'stock_count_lines', 'order_lines'],
  purchase_orders: ['purchase_orders', 'purchase_order'],
  // A line changes the order's total, and receiving reprices future sheets.
  purchase_order_lines: ['order_lines', 'purchase_orders', 'item_costs'],
  stock_counts: ['stock_counts', 'stock_count', 'food_cost'],
  stock_count_lines: ['stock_count_lines', 'stock_counts', 'food_cost'],
}

/** Tables whose rows belong to one business; inserts get business_id filled in. */
// purchase_order_lines and stock_count_lines are left out on purpose: a database trigger
// copies business_id from the parent order or count, which is what row-level security checks.
const SCOPED = new Set(['sales_days', 'expenses', 'recurring_expenses', 'suppliers', 'staff', 'partners',
  'partner_contributions', 'setup_costs', 'stock_groups', 'stock_items', 'purchase_orders', 'stock_counts'])

function useWrite<V>(tableName: string, fn: (v: V) => PromiseLike<{ data: unknown; error: { message: string } | null }>) {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: (v: V) => run(fn(v)),
    onSuccess: () => DEPENDENTS[tableName].forEach((k) => qc.invalidateQueries({ queryKey: [k] })),
  })
}

type Row = Record<string, unknown>

/**
 * Insert (no id) or update (with id) a row in the selected business.
 * An insert returns the rows written, so a caller that needs the new id — a new order,
 * which then has lines added to it — can read it straight back.
 */
export const useSave = (tableName: string) => {
  const biz = useBusinessId()
  return useWrite<Row>(tableName, ({ id, ...rest }) =>
    id
      ? supabase.from(tableName).update(rest).eq('id', id as string)
      : supabase.from(tableName).insert(SCOPED.has(tableName) ? { ...rest, business_id: biz } : rest).select(),
  )
}

export const useRemove = (tableName: string) =>
  useWrite<string>(tableName, (id) => supabase.from(tableName).delete().eq('id', id))

export const useUpsertSales = () => {
  const biz = useBusinessId()
  return useWrite<Omit<SalesDay, 'id' | 'business_id'>[]>('sales_days', (rows) =>
    supabase.from('sales_days').upsert(
      rows.map((r) => ({ ...r, business_id: biz, updated_at: new Date().toISOString() })),
      { onConflict: 'business_id,sale_date' },
    ),
  )
}

// ---------- businesses & their people ----------

export const useSaveBusiness = () =>
  useWrite<{ id: string; name?: string; sales_mode?: string }>('businesses', ({ id, ...rest }) =>
    supabase.from('businesses').update(rest).eq('id', id),
  )

export const useAddPerson = () => {
  const biz = useBusinessId()
  return useWrite<{ email: string; display_name: string | null }>('business_users', (p) =>
    supabase.from('business_users').insert({ ...p, email: p.email.trim().toLowerCase(), business_id: biz }),
  )
}

export const useRemovePerson = () => {
  const biz = useBusinessId()
  return useWrite<string>('business_users', (email) =>
    supabase.from('business_users').delete().eq('business_id', biz).eq('email', email),
  )
}

/**
 * Creating a business returns it, so the caller can switch to it straight away.
 * The list of businesses is refreshed before this resolves, so the new one is
 * already known to the switcher by the time we select it.
 */
export const useCreateBusiness = () => {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: (name: string) => run<Business>(supabase.rpc('create_business', { p_name: name.trim() })),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['businesses'] }),
  })
}

// ---------- purchasing & stock ----------

export const useStockGroups = scopedTable<StockGroup>('stock_groups', 'sort')
export const useStockItems = scopedTable<StockItem>('stock_items', 'name', ['unit_cost'])

/** What each item costs now: the last price paid, else its standard cost. */
export const useItemCosts = () => {
  const biz = useBusinessId()
  return useQuery({
    queryKey: ['item_costs', biz],
    queryFn: async () =>
      money(await run(supabase.from('v_item_cost').select('*').eq('business_id', biz)), ['unit_cost']) as ItemCost[],
  })
}

export interface OrderFilter { status?: string; supplierId?: string }
export const usePurchaseOrders = (f: OrderFilter = {}) => {
  const biz = useBusinessId()
  return useQuery({
    queryKey: ['purchase_orders', biz, f],
    queryFn: async () => {
      let q = supabase.from('v_purchase_order_totals').select('*').eq('business_id', biz)
      if (f.status) q = q.eq('status', f.status)
      if (f.supplierId) q = q.eq('supplier_id', f.supplierId)
      return money(await run(q.order('po_number', { ascending: false })), ['total', 'line_count']) as PurchaseOrderTotal[]
    },
  })
}

export const usePurchaseOrder = (id: string | undefined) =>
  useQuery({
    queryKey: ['purchase_order', id],
    enabled: !!id,
    queryFn: async () => (await run(supabase.from('purchase_orders').select('*').eq('id', id!).single())) as PurchaseOrder,
  })

export const useOrderLines = (orderId: string | undefined) =>
  useQuery({
    queryKey: ['order_lines', orderId],
    enabled: !!orderId,
    queryFn: async () =>
      money(
        await run(supabase.from('purchase_order_lines').select('*').eq('purchase_order_id', orderId!).order('sort').order('id')),
        ['qty', 'unit_cost'],
      ) as PurchaseOrderLine[],
  })

export const useStockCounts = () => {
  const biz = useBusinessId()
  return useQuery({
    queryKey: ['stock_counts', biz],
    queryFn: async () =>
      money(
        await run(supabase.from('v_stock_count_values').select('*').eq('business_id', biz).order('count_date', { ascending: false })),
        ['value', 'items_counted'],
      ) as StockCountValue[],
  })
}

export const useStockCount = (id: string | undefined) =>
  useQuery({
    queryKey: ['stock_count', id],
    enabled: !!id,
    queryFn: async () => (await run(supabase.from('stock_counts').select('*').eq('id', id!).single())) as StockCount,
  })

export const useStockCountLines = (countId: string | undefined) =>
  useQuery({
    queryKey: ['stock_count_lines', countId],
    enabled: !!countId,
    queryFn: async () =>
      money(await run(supabase.from('stock_count_lines').select('*').eq('stock_count_id', countId!)), ['qty', 'unit_cost']) as StockCountLine[],
  })

/** Weekly food cost: opening stock + purchases − closing stock. Weeks, not days. */
export const useWeeklyFoodCost = (fromWeek: string, to: string) => {
  const biz = useBusinessId()
  return useQuery({
    queryKey: ['food_cost', biz, fromWeek, to],
    queryFn: async () =>
      money(
        await run(supabase.from('v_weekly_food_cost').select('*').eq('business_id', biz)
          .gte('week_start', fromWeek).lte('week_start', to).order('week_start')),
        ['sales', 'purchases', 'opening_value', 'closing_value', 'food_cost'],
      ) as WeeklyFoodCost[],
  })
}

// ---------- actions the database does in one go ----------

/** Everything a write to one of these touches, so every screen showing it refreshes. */
const ALL_PURCHASING = ['purchase_orders', 'purchase_order', 'order_lines', 'item_costs', 'expenses',
  'expense', 'all-expenses', 'earliest', 'food_cost'] as const

function useRpc<V>(name: string, keys: readonly string[], args: (v: V) => Record<string, unknown>) {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: (v: V) => run(supabase.rpc(name, args(v))),
    onSuccess: () => keys.forEach((k) => qc.invalidateQueries({ queryKey: [k] })),
  })
}

/**
 * Receiving an order writes the food expense it became, so the purchase reaches the
 * dashboard and the food cost without being typed twice. `total` records what was
 * actually billed when that differs from what was ordered.
 */
export const useReceiveOrder = () =>
  useRpc<{ id: string; received_on: string; total?: number; paid_via?: string }>('receive_purchase_order', ALL_PURCHASING, (v) => ({
    p_id: v.id,
    p_received_on: v.received_on,
    p_total: v.total ?? null,
    p_paid_via: v.paid_via ?? 'bank',
  }))

/** Undo receiving: deletes the expense it created and puts the order back to sent. */
export const useReopenOrder = () =>
  useRpc<string>('reopen_purchase_order', ALL_PURCHASING, (id) => ({ p_id: id }))

/** A fresh draft with the same lines, repriced to today. Returns the new order. */
export const useDuplicateOrder = () => {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: (id: string) => run<PurchaseOrder>(supabase.rpc('duplicate_purchase_order', { p_id: id })),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['purchase_orders'] }),
  })
}

/**
 * Open the count sheet for a date: one line per active item at today's cost.
 * Safe to call again — it returns the existing sheet and only adds lines for new items.
 */
export const useStartStockCount = () => {
  const biz = useBusinessId()
  const qc = useQueryClient()
  return useMutation({
    mutationFn: (date: string) => run<StockCount>(supabase.rpc('start_stock_count', { p_business: biz, p_date: date })),
    onSuccess: () => ['stock_counts', 'stock_count_lines', 'food_cost'].forEach((k) => qc.invalidateQueries({ queryKey: [k] })),
  })
}

/** Saving a count sheet: every changed quantity in one round trip. */
export const useSaveCountLines = () => {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: (lines: { id: string; qty: number }[]) =>
      Promise.all(lines.map((l) => run(supabase.from('stock_count_lines').update({ qty: l.qty }).eq('id', l.id)))),
    onSuccess: () => ['stock_count_lines', 'stock_counts', 'food_cost'].forEach((k) => qc.invalidateQueries({ queryKey: [k] })),
  })
}

// ---------- passwords ----------

/**
 * Change your own password. Nothing privileged about it — the session being changed is
 * the one making the request.
 */
export const useChangeMyPassword = () =>
  useMutation({
    mutationFn: async (password: string) => {
      const { error } = await supabase.auth.updateUser({ password })
      if (error) throw new Error(error.message)
    },
  })

/**
 * Set someone else's password, so a person can be given access without waiting on an
 * email. Only an Edge Function can do this: it needs the service-role key, which must
 * never reach a browser. The function checks that you and they share a business before
 * it will act, and creates their login if they've been added in Settings but have never
 * signed in.
 */
export const useSetPersonPassword = () => {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: async ({ email, password }: { email: string; password: string }) => {
      const { data, error } = await supabase.functions.invoke<{ ok: boolean; created: boolean }>('set-password', {
        body: { email, password },
      })
      // A refused call arrives as a FunctionsHttpError with the reason in the response body.
      if (error) {
        let message = error.message
        const res = (error as { context?: Response }).context
        if (res && typeof res.json === 'function') {
          try { message = (await res.json())?.error ?? message } catch { /* keep the original */ }
        }
        throw new Error(message)
      }
      return data!
    },
    onSuccess: () => qc.invalidateQueries({ queryKey: ['business_users'] }),
  })
}
