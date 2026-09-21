import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { supabase } from './supabase'
import type {
  AnyExpense, Expense, ExpenseCategory, Partner, PartnerContribution, RecurringExpense,
  SalesDay, SetupCost, Staff, Supplier,
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

export const useSales = (from: string, to: string) =>
  useQuery({
    queryKey: ['sales', from, to],
    queryFn: async () =>
      money(
        await run(supabase.from('sales_days').select('*').gte('sale_date', from).lte('sale_date', to).order('sale_date')),
        ['eftpos', 'cash', 'uber', 'online', 'total_recorded'],
      ) as SalesDay[],
  })

export const useAllExpenses = (from: string, to: string) =>
  useQuery({
    queryKey: ['all-expenses', from, to],
    queryFn: async () =>
      money(
        await run(supabase.from('v_all_expenses').select('*').gte('expense_date', from).lte('expense_date', to).order('expense_date')),
        ['amount'],
      ) as AnyExpense[],
  })

export interface ExpenseFilter { from: string; to: string; category?: string; supplierId?: string }
export const useExpenses = (f: ExpenseFilter) =>
  useQuery({
    queryKey: ['expenses', f],
    queryFn: async () => {
      let q = supabase.from('expenses').select('*').gte('expense_date', f.from).lte('expense_date', f.to)
      if (f.category) q = q.eq('category', f.category)
      if (f.supplierId) q = q.eq('supplier_id', f.supplierId)
      return money(await run(q.order('expense_date', { ascending: false }).order('created_at', { ascending: false })), [
        'amount', 'hours',
      ]) as Expense[]
    },
  })

export const useExpense = (id: string | undefined) =>
  useQuery({
    queryKey: ['expense', id],
    enabled: !!id,
    queryFn: async () => money([await run<Expense>(supabase.from('expenses').select('*').eq('id', id!).single())], ['amount', 'hours'])[0],
  })

export const useEarliestSale = () =>
  useQuery({
    queryKey: ['earliest'],
    queryFn: async () => {
      const [s, e] = await Promise.all([
        run(supabase.from('sales_days').select('sale_date').order('sale_date').limit(1)),
        run(supabase.from('expenses').select('expense_date').order('expense_date').limit(1)),
      ])
      const dates = [(s as { sale_date: string }[])[0]?.sale_date, (e as { expense_date: string }[])[0]?.expense_date].filter(Boolean)
      return (dates.sort()[0] as string | undefined) ?? null
    },
  })

const table = <T,>(name: string, order: string, moneyFields: string[] = []) => () =>
  useQuery({
    queryKey: [name],
    queryFn: async () => money(await run(supabase.from(name).select('*').order(order)), moneyFields as never[]) as T[],
  })

export const useCategories = table<ExpenseCategory>('expense_categories', 'sort')
export const useSuppliers = table<Supplier>('suppliers', 'name')
export const useStaff = table<Staff>('staff', 'name', ['hourly_rate'])
export const useRecurring = table<RecurringExpense>('recurring_expenses', 'name', ['amount'])
export const usePartners = table<Partner>('partners', 'name', ['ownership_pct'])
export const useContributions = table<PartnerContribution>('partner_contributions', 'contributed_on', ['amount'])
export const useSetupCosts = table<SetupCost>('setup_costs', 'item', ['amount'])

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
}

function useWrite<V>(tableName: string, fn: (v: V) => PromiseLike<{ data: unknown; error: { message: string } | null }>) {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: (v: V) => run(fn(v)),
    onSuccess: () => DEPENDENTS[tableName].forEach((k) => qc.invalidateQueries({ queryKey: [k] })),
  })
}

type Row = Record<string, unknown>

/** Insert (no id) or update (with id) a row. */
export const useSave = (tableName: string) =>
  useWrite<Row>(tableName, ({ id, ...rest }) =>
    id ? supabase.from(tableName).update(rest).eq('id', id as string) : supabase.from(tableName).insert(rest),
  )

export const useRemove = (tableName: string) =>
  useWrite<string>(tableName, (id) => supabase.from(tableName).delete().eq('id', id))

export const useUpsertSales = () =>
  useWrite<Omit<SalesDay, 'id'>[]>('sales_days', (rows) =>
    supabase.from('sales_days').upsert(rows.map((r) => ({ ...r, updated_at: new Date().toISOString() })), { onConflict: 'sale_date' }),
  )
