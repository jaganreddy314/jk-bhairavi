import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { supabase } from './supabase'
import { useBusinessId } from './business'
import type {
  AnyExpense, Business, BusinessUser, Expense, ExpenseCategory, ItemCost, Partner, PartnerContribution,
  PurchaseOrder, PurchaseOrderLine, PurchaseOrderTotal, RecurringExpense, SalesDay, SetupCost, Staff,
  StockCount, StockCountLine, StockCountValue, StockGroup, StockItem, Supplier, WeeklyFoodCost,
  ItemAlias, ItemSale, ItemSalesWeek, ItemSupplier, StockItemPlace, StockLocation, StockLocationGroup,
} from './types'
import { codeKey, normalise } from './report'

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

/**
 * Every row, not just the first 1,000. The API caps each request at 1,000 rows (max_rows),
 * and a catalogue or a few weeks of item sales passes that, so ask page by page.
 * The query must sort on something unique, or a row could land on two pages or none.
 */
async function runAll<T>(page: (from: number, to: number) => PromiseLike<{ data: T[] | null; error: { message: string } | null }>): Promise<T[]> {
  const SIZE = 1000
  const out: T[] = []
  for (let from = 0; ; from += SIZE) {
    const rows = await run(page(from, from + SIZE - 1))
    out.push(...rows)
    if (rows.length < SIZE) return out
  }
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
        await runAll((a, b) => supabase.from('sales_days').select('*').eq('business_id', biz)
          .gte('sale_date', from).lte('sale_date', to).order('sale_date').order('id').range(a, b)),
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
        await runAll((a, b) => supabase.from('v_all_expenses').select('*').eq('business_id', biz)
          .gte('expense_date', from).lte('expense_date', to).order('expense_date').order('id').order('is_recurring').range(a, b)),
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
      const page = (a: number, b: number) => {
        let q = supabase.from('expenses').select('*').eq('business_id', biz)
          .gte('expense_date', f.from).lte('expense_date', f.to)
        if (f.category) q = q.eq('category', f.category)
        if (f.supplierId) q = q.eq('supplier_id', f.supplierId)
        return q.order('expense_date', { ascending: false }).order('created_at', { ascending: false }).order('id').range(a, b)
      }
      return money(await runAll(page), [
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
      money(await runAll((a, b) => supabase.from(name).select('*').eq('business_id', biz).order(order).order('id').range(a, b)), moneyFields as never[]) as T[],
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
  stock_groups: ['stock_groups', 'stock_items', 'stock_location_groups'],
  stock_locations: ['stock_locations', 'stock_location_groups', 'stock_item_places'],
  stock_location_groups: ['stock_location_groups'],
  stock_item_places: ['stock_item_places'],
  // An item's name, cost or group shows up on count sheets and order lines alike.
  stock_items: ['stock_items', 'item_costs', 'stock_count_lines', 'order_lines', 'item_suppliers'],
  purchase_orders: ['purchase_orders', 'purchase_order'],
  // A line changes the order's total, and receiving reprices future sheets.
  // …and ordering a product from a supplier links them and sets that supplier's price.
  purchase_order_lines: ['order_lines', 'purchase_orders', 'item_costs', 'item_suppliers'],
  stock_counts: ['stock_counts', 'stock_count', 'food_cost'],
  // A new product can be added from an import, and its sales go with it.
  item_sales: ['item_sales'],
  item_suppliers: ['item_suppliers'],
  stock_count_lines: ['stock_count_lines', 'stock_counts', 'food_cost'],
}

/** Tables whose rows belong to one business; inserts get business_id filled in. */
// purchase_order_lines and stock_count_lines are left out on purpose: a database trigger
// copies business_id from the parent order or count, which is what row-level security checks.
const SCOPED = new Set(['sales_days', 'expenses', 'recurring_expenses', 'suppliers', 'staff', 'partners',
  'partner_contributions', 'setup_costs', 'stock_groups', 'stock_items',
  'stock_locations', 'stock_location_groups', 'purchase_orders', 'stock_counts'])

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

/** Several order lines in one insert — what the item picker adds. */
export const useAddOrderLines = () =>
  useWrite<Row[]>('purchase_order_lines', (rows) => supabase.from('purchase_order_lines').insert(rows))

/** The same change to many rows at once — the catalogue's bulk edit. */
export const useBulkUpdate = (tableName: string) =>
  useWrite<{ ids: string[]; patch: Row }>(tableName, ({ ids, patch }) => supabase.from(tableName).update(patch).in('id', ids))

/** Save a supplier's item order: each id gets its position. Only rows whose position changed are sent. */
export const useSetItemOrder = () =>
  useWrite<{ supplierId: string; rows: { item_id: string; sort: number }[] }>('item_suppliers', async ({ supplierId, rows }) => {
    const results = await Promise.all(rows.map((r) =>
      supabase.from('item_suppliers').update({ sort: r.sort }).eq('item_id', r.item_id).eq('supplier_id', supplierId)))
    return results.find((r) => r.error) ?? { data: null, error: null }
  })

/** Link a product to a supplier, or change that supplier's carton size or item code. */
export const useSaveItemSupplier = () => {
  const biz = useBusinessId()
  return useWrite<{ item_id: string; supplier_id: string; pack_size?: number; supplier_code?: string | null }>('item_suppliers', (v) =>
    supabase.from('item_suppliers').upsert({ ...v, business_id: biz }, { onConflict: 'item_id,supplier_id' }))
}

export const useRemoveItemSupplier = () =>
  useWrite<{ item_id: string; supplier_id: string }>('item_suppliers', (v) =>
    supabase.from('item_suppliers').delete().eq('item_id', v.item_id).eq('supplier_id', v.supplier_id))

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
export const useStockLocations = scopedTable<StockLocation>('stock_locations', 'sort')

/** Which categories are kept at which location. */
export const useStockLocationGroups = () => {
  const biz = useBusinessId()
  return useQuery({
    queryKey: ['stock_location_groups', biz],
    queryFn: async () =>
      (await runAll((a, b) => supabase.from('stock_location_groups').select('*').eq('business_id', biz)
        .order('location_id').order('group_id').range(a, b))) as StockLocationGroup[],
  })
}

/** Every place products have been put by hand, with their position there. */
export const useItemPlaces = () => {
  const biz = useBusinessId()
  return useQuery({
    queryKey: ['stock_item_places', biz],
    queryFn: async () =>
      (await runAll((a, b) => supabase.from('stock_item_places').select('*').eq('business_id', biz)
        .order('item_id').order('location_id').range(a, b))) as StockItemPlace[],
  })
}

export const useRemoveLocationGroup = () =>
  useWrite<{ location_id: string; group_id: string }>('stock_location_groups', (v) =>
    supabase.from('stock_location_groups').delete().eq('location_id', v.location_id).eq('group_id', v.group_id))

/** Place products at a location in this order — the whole shelf in one go. */
export const useSetLocationOrder = () =>
  useWrite<{ locationId: string; itemIds: string[] }>('stock_item_places', (v) =>
    supabase.rpc('set_location_order', { p_location: v.locationId, p_items: v.itemIds }))

/**
 * Put products at a location. `only`: it becomes their one place (null location = back to their
 * category's spot). `from`: move them from there. Neither: add it as another place.
 */
export const usePlaceItems = () =>
  useWrite<{ locationId: string | null; itemIds: string[]; from?: string; only?: boolean }>('stock_item_places', (v) =>
    supabase.rpc('place_items', { p_location: v.locationId, p_items: v.itemIds, p_from: v.from ?? null, p_only: v.only ?? false }))

/** Stop counting products at a location — for ones that are kept somewhere else too. */
export const useRemovePlaces = () =>
  useWrite<{ locationId: string; itemIds: string[] }>('stock_item_places', (v) =>
    supabase.from('stock_item_places').delete().eq('location_id', v.locationId).in('item_id', v.itemIds))

/** Every product–supplier link, with that supplier's carton and what they last charged. */
export const useItemSuppliers = () => {
  const biz = useBusinessId()
  return useQuery({
    queryKey: ['item_suppliers', biz],
    queryFn: async () =>
      money(
        await runAll((a, b) => supabase.from('v_item_supplier_price').select('*').eq('business_id', biz)
          .order('item_id').order('supplier_id').range(a, b)),
        ['last_unit_cost', 'carton_cost'],
      ) as ItemSupplier[],
  })
}

/** What each item costs now: the last price paid, else its standard cost. */
export const useItemCosts = () => {
  const biz = useBusinessId()
  return useQuery({
    queryKey: ['item_costs', biz],
    queryFn: async () =>
      money(await runAll((a, b) => supabase.from('v_item_cost').select('*').eq('business_id', biz).order('item_id').range(a, b)), ['unit_cost']) as ItemCost[],
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
      money(await runAll((a, b) => supabase.from('stock_count_lines').select('*').eq('stock_count_id', countId!).order('id').range(a, b)), ['qty', 'unit_cost']) as StockCountLine[],
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

// ---------- item sales ----------

/** Each item's sales per week, for weeks starting fromWeek to `to`. */
export const useItemSalesWeekly = (fromWeek: string, to: string) => {
  const biz = useBusinessId()
  return useQuery({
    queryKey: ['item_sales', 'weekly', biz, fromWeek, to],
    queryFn: async () =>
      money(
        await runAll((a, b) => supabase.from('v_item_sales_weekly').select('*').eq('business_id', biz)
          .gte('week_start', fromWeek).lte('week_start', to).order('week_start').order('item_id').range(a, b)),
        ['qty', 'amount'],
      ) as ItemSalesWeek[],
  })
}

/** The stored rows for periods starting in a range: what was entered, as it was entered. */
export const useItemSalesRows = (from: string, to: string) => {
  const biz = useBusinessId()
  return useQuery({
    queryKey: ['item_sales', 'rows', biz, from, to],
    queryFn: async () =>
      money(
        await runAll((a, b) => supabase.from('item_sales').select('*').eq('business_id', biz)
          .gte('period_start', from).lte('period_start', to).order('period_start', { ascending: false }).order('id').range(a, b)),
        ['qty', 'amount'],
      ) as ItemSale[],
  })
}

export const useItemAliases = () => {
  const biz = useBusinessId()
  return useQuery({
    queryKey: ['item_aliases', biz],
    queryFn: async () => (await runAll((a, b) => supabase.from('item_aliases').select('*').eq('business_id', biz).order('alias').range(a, b))) as ItemAlias[],
  })
}

export interface SalesLine {
  /** A catalogue item, or null with newName to add it to the catalogue first. */
  item_id: string | null
  newName?: string
  qty: number
  amount: number
  /** The name the report used, remembered so the next import matches it. */
  reportName?: string
  /** The till's code for it, remembered the same way (it survives a renamed product). */
  reportCode?: string
}

/**
 * Save one day's or week's item sales, replacing whatever that period held. Products the
 * report named that aren't in the catalogue yet are added first, and report names are remembered.
 */
export const useSaveItemSales = () => {
  const biz = useBusinessId()
  const qc = useQueryClient()
  return useMutation({
    mutationFn: async ({ start, end, lines }: { start: string; end: string; lines: SalesLine[] }) => {
      const newNames = [...new Set(lines.filter((l) => !l.item_id && l.newName).map((l) => l.newName!.trim()))]
      const created = newNames.length
        ? ((await run(supabase.from('stock_items').insert(newNames.map((name) => ({ business_id: biz, name, unit: 'ea', active: true }))).select())) as StockItem[])
        : []
      const idOf = (l: SalesLine) => l.item_id ?? created.find((c) => c.name === l.newName?.trim())?.id

      // One line per item: two report names for the same item are added together.
      const byItem = new Map<string, { item_id: string; qty: number; amount: number }>()
      for (const l of lines) {
        const id = idOf(l)
        if (!id) continue
        const prev = byItem.get(id) ?? { item_id: id, qty: 0, amount: 0 }
        byItem.set(id, { item_id: id, qty: prev.qty + l.qty, amount: Math.round((prev.amount + l.amount) * 100) / 100 })
      }

      const aliases = new Map<string, string>()
      for (const l of lines) {
        const id = idOf(l)
        if (id && l.reportName) aliases.set(normalise(l.reportName), id)
        if (id && l.reportCode) aliases.set(codeKey(l.reportCode), id)
      }
      if (aliases.size)
        await run(supabase.from('item_aliases').upsert(
          [...aliases].map(([alias, item_id]) => ({ business_id: biz, alias, item_id })),
          { onConflict: 'business_id,alias' },
        ))

      return run(supabase.rpc('replace_item_sales', { p_business: biz, p_start: start, p_end: end, p_rows: [...byItem.values()] }))
    },
    onSuccess: () => ['item_sales', 'item_aliases', 'stock_items'].forEach((k) => qc.invalidateQueries({ queryKey: [k] })),
  })
}

// ---------- actions the database does in one go ----------

/** Everything a write to one of these touches, so every screen showing it refreshes. */
const ALL_PURCHASING = ['purchase_orders', 'purchase_order', 'order_lines', 'item_costs', 'expenses',
  'expense', 'all-expenses', 'earliest', 'food_cost', 'item_suppliers'] as const

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
    mutationFn: (lines: { id: string; qty: number; place_qty?: Record<string, number> | null }[]) =>
      Promise.all(lines.map(({ id, ...patch }) => run(supabase.from('stock_count_lines').update(patch).eq('id', id)))),
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
