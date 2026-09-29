import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { supabase } from './supabase'
import { useBusinessId } from './business'
import type {
  AnyExpense, Business, BusinessUser, Expense, ExpenseCategory, Partner, PartnerContribution,
  RecurringExpense, SalesDay, SetupCost, Staff, Supplier,
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
}

/** Tables whose rows belong to one business; inserts get business_id filled in. */
const SCOPED = new Set(['sales_days', 'expenses', 'recurring_expenses', 'suppliers', 'staff', 'partners', 'partner_contributions', 'setup_costs'])

function useWrite<V>(tableName: string, fn: (v: V) => PromiseLike<{ data: unknown; error: { message: string } | null }>) {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: (v: V) => run(fn(v)),
    onSuccess: () => DEPENDENTS[tableName].forEach((k) => qc.invalidateQueries({ queryKey: [k] })),
  })
}

type Row = Record<string, unknown>

/** Insert (no id) or update (with id) a row in the selected business. */
export const useSave = (tableName: string) => {
  const biz = useBusinessId()
  return useWrite<Row>(tableName, ({ id, ...rest }) =>
    id
      ? supabase.from(tableName).update(rest).eq('id', id as string)
      : supabase.from(tableName).insert(SCOPED.has(tableName) ? { ...rest, business_id: biz } : rest),
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
