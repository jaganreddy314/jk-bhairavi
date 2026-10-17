import { useState } from 'react'
import { useSearchParams } from 'react-router-dom'
import { useItemCosts, useSave, useStockGroups, useStockItems, useSuppliers } from '../lib/api'
import { CAT_LABEL, ENTRY_CATEGORIES } from '../lib/categories'
import { aud } from '../lib/format'
import type { StockItem } from '../lib/types'
import { bySection, CategoryChips, FoodTabs, NO_SECTION } from '../components/catalogue'
import { RowForm, TableEditor, type Field } from '../components/TableEditor'
import { ErrorBox, Loading, Segmented } from '../components/ui'

const CATEGORY_OPTIONS = ENTRY_CATEGORIES.map((c) => ({ value: c, label: CAT_LABEL[c] }))

/** How stock is bought and counted. Free-form would make the count sheet read inconsistently. */
const UNIT_OPTIONS = [
  { value: 'ea', label: 'each' },
  { value: 'kg', label: 'kg' },
  { value: 'g', label: 'g' },
  { value: 'L', label: 'litre' },
  { value: 'mL', label: 'mL' },
  { value: 'box', label: 'box' },
  { value: 'bag', label: 'bag' },
  { value: 'carton', label: 'carton' },
  { value: 'tray', label: 'tray' },
  { value: 'pkt', label: 'packet' },
  { value: 'tub', label: 'tub' },
  { value: 'bottle', label: 'bottle' },
]

type Tab = 'products' | 'suppliers' | 'sections'

/** What the shop buys and counts: products, who supplies them, and where they live. */
export default function Catalogue() {
  const [params, setParams] = useSearchParams()
  const raw = params.get('tab')
  const tab: Tab = raw === 'suppliers' || raw === 'sections' ? raw : 'products'

  return (
    <div>
      <FoodTabs />
      <div className="mb-4">
        <Segmented
          ariaLabel="Catalogue"
          value={tab}
          onChange={(t) => setParams(t === 'products' ? {} : { tab: t }, { replace: true })}
          options={[
            { value: 'products', label: 'Products' },
            { value: 'suppliers', label: 'Suppliers' },
            { value: 'sections', label: 'Categories' },
          ]}
        />
      </div>
      {tab === 'products' && <Products />}
      {tab === 'suppliers' && <Suppliers />}
      {tab === 'sections' && <Sections />}
    </div>
  )
}

function Products() {
  const items = useStockItems()
  const groups = useStockGroups()
  const suppliers = useSuppliers()
  const costs = useItemCosts()
  const save = useSave('stock_items')
  const [cat, setCat] = useState('all')
  const [supplierId, setSupplierId] = useState('')
  const [q, setQ] = useState('')
  const [showHidden, setShowHidden] = useState(false)
  const [editing, setEditing] = useState<string | null>(null)

  if (items.isLoading || groups.isLoading || suppliers.isLoading) return <Loading />

  const groupList = groups.data ?? []
  const supplierList = suppliers.data ?? []
  const all = items.data ?? []
  const hiddenCount = all.filter((i) => !i.active).length
  const needle = q.trim().toLowerCase()
  const pool = all.filter(
    (i) => (showHidden || i.active) && (!supplierId || i.supplier_id === supplierId) && (!needle || i.name.toLowerCase().includes(needle)),
  )
  const sections = bySection(pool, groupList)
  const current = sections.some((s) => s.key === cat) ? cat : 'all'
  const shown = current === 'all' ? sections : sections.filter((s) => s.key === current)

  const fields: Field[] = [
    { key: 'name', label: 'Product', type: 'text', required: true },
    { key: 'group_id', label: 'Category', type: 'select', options: groupList.map((g) => ({ value: g.id, label: g.name })) },
    { key: 'unit', label: 'Unit', type: 'select', required: true, options: UNIT_OPTIONS },
    { key: 'supplier_id', label: 'Usually from', type: 'select', options: supplierList.filter((s) => s.active).map((s) => ({ value: s.id, label: s.name })) },
    { key: 'unit_cost', label: 'Cost per unit', type: 'money' },
    { key: 'active', label: 'Active', type: 'bool' },
  ]
  const supplierName = (id: string | null) => supplierList.find((s) => s.id === id)?.name
  const lastPaid = (i: StockItem) => costs.data?.find((c) => c.item_id === i.id)?.unit_cost

  return (
    <section className="card p-4">
      <ErrorBox error={items.error || save.error} />
      <div className="mb-3 flex flex-wrap items-center gap-2">
        <input type="search" aria-label="Search products" className="field !w-auto min-w-40 flex-1 !py-2" placeholder="Search products…"
          value={q} onChange={(e) => setQ(e.target.value)} />
        <select aria-label="Supplier" className="field !w-auto !py-2" value={supplierId} onChange={(e) => setSupplierId(e.target.value)}>
          <option value="">All suppliers</option>
          {supplierList.filter((s) => s.active).map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
        </select>
        <button type="button" className="btn btn-primary btn-sm !py-2" onClick={() => setEditing('new')}>+ Add product</button>
      </div>

      <CategoryChips
        sections={sections.map((s) => ({ key: s.key, label: s.label, count: s.items.length }))}
        value={current}
        onChange={setCat}
        total={pool.length}
      />

      {editing === 'new' && (
        <div className="mt-3 rounded-xl bg-surface-2 p-3">
          <RowForm
            fields={fields}
            busy={save.isPending}
            initial={{
              unit: 'ea', active: true,
              group_id: current !== 'all' && current !== NO_SECTION ? current : null,
              supplier_id: supplierId || null,
            }}
            onCancel={() => setEditing(null)}
            onSave={async (v) => { await save.mutateAsync(v); setEditing(null) }}
          />
        </div>
      )}

      {shown.length === 0 && (
        <p className="py-8 text-center text-sm text-muted">
          {all.length === 0 ? 'No products yet. Add the things you buy and count.' : 'No products match.'}
        </p>
      )}

      {shown.map((s) => (
        <div key={s.key} className="mt-4">
          <h3 className="mb-1 flex items-baseline justify-between border-b border-line pb-1 text-sm font-semibold">
            {s.label}
            <span className="text-xs font-normal text-muted">{s.items.length} {s.items.length === 1 ? 'product' : 'products'}</span>
          </h3>
          {/* Column labels for the wide layout; on a phone each row says what it is. */}
          <div className="hidden grid-cols-[1fr_5rem_10rem_7rem_4rem] gap-3 py-1 text-xs text-muted md:grid">
            <span>Product</span><span>Unit</span><span>Usually from</span><span className="text-right">Price</span><span />
          </div>
          <ul className="divide-y divide-line">
            {s.items.map((i) =>
              editing === i.id ? (
                <li key={i.id} className="py-3">
                  <RowForm fields={fields} initial={i as unknown as Record<string, unknown>} busy={save.isPending}
                    onCancel={() => setEditing(null)}
                    onSave={async (v) => { await save.mutateAsync({ id: i.id, ...v }); setEditing(null) }} />
                </li>
              ) : (
                <li key={i.id} className={`grid grid-cols-[1fr_auto] items-center gap-x-3 py-2.5 md:grid-cols-[1fr_5rem_10rem_7rem_4rem] ${i.active ? '' : 'opacity-55'}`}>
                  <div className="min-w-0">
                    <div className="truncate font-medium">
                      {i.name}
                      {!i.active && <span className="ml-2 rounded-full bg-surface-2 px-2 py-0.5 text-[11px] font-semibold text-muted">Hidden</span>}
                    </div>
                    <div className="truncate text-xs text-muted md:hidden">
                      {i.unit}{supplierName(i.supplier_id) ? ` · ${supplierName(i.supplier_id)}` : ''}
                    </div>
                  </div>
                  <span className="hidden text-sm text-ink-2 md:block">{i.unit}</span>
                  <span className="hidden truncate text-sm text-ink-2 md:block">{supplierName(i.supplier_id) ?? <span className="text-muted">—</span>}</span>
                  <Price unit={i.unit} cost={i.unit_cost} paid={lastPaid(i)} />
                  <span className="col-start-2 row-span-2 row-start-1 flex justify-end md:col-auto md:row-auto">
                    <button type="button" className="btn btn-sm" onClick={() => setEditing(i.id)}>Edit</button>
                  </span>
                </li>
              ),
            )}
          </ul>
        </div>
      ))}

      {hiddenCount > 0 && (
        <label className="mt-4 flex items-center gap-2 text-sm text-ink-2">
          <input type="checkbox" className="h-4 w-4" checked={showHidden} onChange={(e) => setShowHidden(e.target.checked)} />
          Show {hiddenCount} hidden {hiddenCount === 1 ? 'product' : 'products'}
        </label>
      )}
      <p className="mt-3 text-xs text-muted">
        The cost per unit is a fallback. Once an order for a product has been received, the price actually paid is what orders and
        the count sheet use. Untick “Active” to hide a product from both without losing its history.
      </p>
    </section>
  )
}

/** The price an order would use, and where it came from. */
function Price({ unit, cost, paid }: { unit: string; cost: number | null; paid: number | undefined }) {
  const value = paid || cost
  return (
    <span className="num col-start-1 text-xs text-ink-2 md:col-auto md:text-right md:text-sm">
      {value ? <>{aud(value)}<span className="text-muted md:hidden"> / {unit}</span></> : <span className="text-muted">no price</span>}
      {paid && cost && Math.abs(paid - cost) > 0.004 ? <span className="block text-[11px] text-muted">last paid</span> : null}
    </span>
  )
}

function Suppliers() {
  const suppliers = useSuppliers()
  if (suppliers.isLoading) return <Loading />
  return (
    <section className="card p-4">
      <p className="mb-2 text-sm text-muted">Untick “Active” to hide a supplier from the pickers without losing its history.</p>
      <TableEditor table="suppliers" rows={suppliers.data ?? []} addLabel="Add supplier" canDelete={false}
        defaults={{ default_category: 'food', active: true }}
        fields={[
          { key: 'name', label: 'Name', type: 'text', required: true },
          { key: 'default_category', label: 'Usually', type: 'select', options: CATEGORY_OPTIONS, width: 'md:w-40' },
          { key: 'active', label: 'Active', type: 'bool', width: 'md:w-16' },
        ]} />
    </section>
  )
}

function Sections() {
  const groups = useStockGroups()
  if (groups.isLoading) return <Loading />
  return (
    <section className="card p-4">
      <p className="mb-2 text-sm text-muted">
        Where stock lives — cool room, freezer, dry store. Products are grouped by these, and the count sheet is laid out in
        this order so you can walk the shop once. Lowest number first.
      </p>
      <TableEditor table="stock_groups" rows={groups.data ?? []} addLabel="Add category"
        defaults={{ sort: ((groups.data ?? []).reduce((m, g) => Math.max(m, g.sort), 0) + 10) }}
        fields={[
          { key: 'name', label: 'Category', type: 'text', required: true },
          { key: 'sort', label: 'Order', type: 'number', width: 'md:w-20 md:text-right' },
        ]} />
    </section>
  )
}
