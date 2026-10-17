import { useState } from 'react'
import { useSearchParams } from 'react-router-dom'
import { useBulkUpdate, useItemCosts, useSave, useSetItemOrder, useStockGroups, useStockItems, useSuppliers } from '../lib/api'
import { CAT_LABEL, ENTRY_CATEGORIES } from '../lib/categories'
import { aud } from '../lib/format'
import type { StockGroup, StockItem, Supplier } from '../lib/types'
import { bySection, CategoryChips, FoodTabs, NO_SECTION, supplierOrder } from '../components/catalogue'
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

type Tab = 'products' | 'order' | 'suppliers' | 'sections'

/** What the shop buys and counts: products, who supplies them, and where they live. */
export default function Catalogue() {
  const [params, setParams] = useSearchParams()
  const raw = params.get('tab')
  const tab: Tab = raw === 'suppliers' || raw === 'sections' || raw === 'order' ? raw : 'products'

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
            { value: 'order', label: 'Supplier order' },
            { value: 'suppliers', label: 'Suppliers' },
            { value: 'sections', label: 'Categories' },
          ]}
        />
      </div>
      {tab === 'products' && <Products />}
      {tab === 'order' && <SupplierOrder />}
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
  const [selected, setSelected] = useState<Set<string>>(new Set())

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
  // Only what is on screen counts as selected, so a filter change can't edit something out of sight.
  const visible = shown.flatMap((s) => s.items)
  const chosen = visible.filter((i) => selected.has(i.id)).map((i) => i.id)
  const toggle = (ids: string[], on: boolean) => {
    const next = new Set(selected)
    for (const id of ids) if (on) next.add(id); else next.delete(id)
    setSelected(next)
  }

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

      {visible.length > 0 && (
        <div className="mt-3 flex items-center justify-between gap-2 text-sm">
          <label className="flex items-center gap-2 text-ink-2">
            <input type="checkbox" className="h-4 w-4" checked={chosen.length === visible.length}
              ref={(el) => { if (el) el.indeterminate = chosen.length > 0 && chosen.length < visible.length }}
              onChange={(e) => toggle(visible.map((i) => i.id), e.target.checked)} />
            Select all {visible.length}
          </label>
          {chosen.length === 0 && <span className="text-xs text-muted">Tick products to change several at once.</span>}
        </div>
      )}

      {chosen.length > 0 && (
        <BulkBar
          ids={chosen}
          groups={groupList.map((g) => ({ value: g.id, label: g.name }))}
          suppliers={supplierList.filter((s) => s.active).map((s) => ({ value: s.id, label: s.name }))}
          onDone={() => setSelected(new Set())}
        />
      )}

      {shown.length === 0 && (
        <p className="py-8 text-center text-sm text-muted">
          {all.length === 0 ? 'No products yet. Add the things you buy and count.' : 'No products match.'}
        </p>
      )}

      {shown.map((s) => (
        <div key={s.key} className="mt-4">
          <h3 className="mb-1 flex items-baseline justify-between border-b border-line pb-1 text-sm font-semibold">
            <label className="flex items-center gap-3">
              <input type="checkbox" className="h-4 w-4" aria-label={`Select all in ${s.label}`}
                checked={s.items.every((i) => selected.has(i.id))}
                onChange={(e) => toggle(s.items.map((i) => i.id), e.target.checked)} />
              {s.label}
            </label>
            <span className="text-xs font-normal text-muted">{s.items.length} {s.items.length === 1 ? 'product' : 'products'}</span>
          </h3>
          {/* Column labels for the wide layout; on a phone each row says what it is. */}
          <div className="hidden grid-cols-[1rem_1fr_5rem_10rem_7rem_4rem] gap-3 py-1 text-xs text-muted md:grid">
            <span /><span>Product</span><span>Unit</span><span>Usually from</span><span className="text-right">Price</span><span />
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
                <li key={i.id} className={`grid grid-cols-[1rem_1fr_auto] items-center gap-x-3 py-2.5 md:grid-cols-[1rem_1fr_5rem_10rem_7rem_4rem] ${i.active ? '' : 'opacity-55'} ${selected.has(i.id) ? '-mx-2 rounded-lg bg-accent/8 px-2' : ''}`}>
                  <input type="checkbox" className="row-span-2 h-4 w-4 md:row-span-1" aria-label={`Select ${i.name}`}
                    checked={selected.has(i.id)} onChange={(e) => toggle([i.id], e.target.checked)} />
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
                  <span className="col-start-3 row-span-2 row-start-1 flex justify-end md:col-auto md:row-auto">
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

const KEEP = ''
const NONE = '__none'

/** Change the category, supplier or visibility of every ticked product in one go. Blank means leave as is. */
function BulkBar({
  ids, groups, suppliers, onDone,
}: { ids: string[]; groups: Option[]; suppliers: Option[]; onDone: () => void }) {
  const update = useBulkUpdate('stock_items')
  const [group, setGroup] = useState(KEEP)
  const [supplier, setSupplier] = useState(KEEP)
  const [active, setActive] = useState(KEEP)
  const patch: Record<string, unknown> = {}
  if (group !== KEEP) patch.group_id = group === NONE ? null : group
  if (supplier !== KEEP) patch.supplier_id = supplier === NONE ? null : supplier
  if (active !== KEEP) patch.active = active === 'show'
  const changes = Object.keys(patch).length

  const pick = (label: string, value: string, set: (v: string) => void, options: Option[], none: string) => (
    <div className="min-w-36 flex-1">
      <label className="label">{label}
        <select className="field mt-1.5 !py-2" value={value} onChange={(e) => set(e.target.value)}>
          <option value={KEEP}>Leave as is</option>
          {options.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
          <option value={NONE}>{none}</option>
        </select>
      </label>
    </div>
  )

  return (
    <div className="sticky top-16 z-10 mt-3 rounded-xl border border-accent/40 bg-surface p-3 shadow-lg">
      <ErrorBox error={update.error} />
      <p className="mb-2 text-sm font-semibold">{ids.length} {ids.length === 1 ? 'product' : 'products'} selected</p>
      <div className="flex flex-wrap items-end gap-2">
        {pick('Category', group, setGroup, groups, 'No category')}
        {pick('Usually from', supplier, setSupplier, suppliers, 'No supplier')}
        <div className="min-w-32">
          <label className="label">Show in orders &amp; counts
            <select className="field mt-1.5 !py-2" value={active} onChange={(e) => setActive(e.target.value)}>
              <option value={KEEP}>Leave as is</option>
              <option value="show">Active</option>
              <option value="hide">Hidden</option>
            </select>
          </label>
        </div>
        <button type="button" className="btn btn-primary !py-2" disabled={!changes || update.isPending}
          onClick={async () => {
            await update.mutateAsync({ ids, patch })
            setGroup(KEEP); setSupplier(KEEP); setActive(KEEP)
            onDone()
          }}>
          {update.isPending ? 'Saving…' : `Update ${ids.length}`}
        </button>
        <button type="button" className="btn !py-2" onClick={onDone}>Clear</button>
      </div>
    </div>
  )
}

interface Option { value: string; label: string }

/** The price an order would use, and where it came from. */
function Price({ unit, cost, paid }: { unit: string; cost: number | null; paid: number | undefined }) {
  const value = paid || cost
  return (
    <span className="num col-start-2 text-xs text-ink-2 md:col-auto md:text-right md:text-sm">
      {value ? <>{aud(value)}<span className="text-muted md:hidden"> / {unit}</span></> : <span className="text-muted">no price</span>}
      {paid && cost && Math.abs(paid - cost) > 0.004 ? <span className="block text-[11px] text-muted">last paid</span> : null}
    </span>
  )
}

/**
 * Arrange each supplier's items in the order you go through them — their price list, or
 * the shelves. New orders list the items this way, and the order sent to the supplier follows it.
 */
function SupplierOrder() {
  const items = useStockItems()
  const groups = useStockGroups()
  const suppliers = useSuppliers()
  const [supplierId, setSupplierId] = useState('')

  if (items.isLoading || groups.isLoading || suppliers.isLoading) return <Loading />

  const all = (items.data ?? []).filter((i) => i.active)
  const withItems = (suppliers.data ?? []).filter((s) => s.active && all.some((i) => i.supplier_id === s.id))
  const supplier = withItems.find((s) => s.id === supplierId) ?? withItems[0]

  return (
    <section className="card p-4">
      <p className="mb-3 text-sm text-muted">
        Put each supplier’s products in the order you go through them when ordering. New orders list them this way, and so
        does the order you send.
      </p>
      {!supplier ? (
        <p className="py-6 text-center text-sm text-muted">
          No products have a supplier yet. Set “Usually from” on the Products tab — several at once with the tick boxes.
        </p>
      ) : (
        <>
          <label className="label" htmlFor="so-supplier">Supplier</label>
          <select id="so-supplier" className="field mb-3 !w-auto !py-2" value={supplier.id} onChange={(e) => setSupplierId(e.target.value)}>
            {withItems.map((s) => (
              <option key={s.id} value={s.id}>{s.name} ({all.filter((i) => i.supplier_id === s.id).length})</option>
            ))}
          </select>
          {/* Remount per supplier, or when its products change, so the draft starts from what's saved.
              Not on every refetch — coming back to the tab mustn't throw away an unsaved arrangement. */}
          <Arrange key={supplier.id + all.filter((i) => i.supplier_id === supplier.id).map((i) => i.id).sort().join()} supplier={supplier} items={all.filter((i) => i.supplier_id === supplier.id)} groups={groups.data ?? []} />
        </>
      )}
    </section>
  )
}

function Arrange({ supplier, items, groups }: { supplier: Supplier; items: StockItem[]; groups: StockGroup[] }) {
  const saveOrder = useSetItemOrder()
  const saved = [...items].sort(supplierOrder(supplier.id))
  const [ids, setIds] = useState(() => saved.map((i) => i.id))
  const [dragging, setDragging] = useState<string | null>(null)
  const byId = new Map(items.map((i) => [i.id, i]))
  const groupName = (id: string | null) => groups.find((g) => g.id === id)?.name
  const changed = ids.some((id, n) => id !== saved[n].id)

  const move = (from: number, to: number) => {
    if (to < 0 || to >= ids.length || from === to) return
    const next = [...ids]
    next.splice(to, 0, next.splice(from, 1)[0])
    setIds(next)
  }
  const sortBy = (key: (i: StockItem) => string) =>
    setIds([...ids].sort((a, b) => key(byId.get(a)!).localeCompare(key(byId.get(b)!)) || byId.get(a)!.name.localeCompare(byId.get(b)!.name)))

  return (
    <div>
      <ErrorBox error={saveOrder.error} />
      <div className="mb-2 flex flex-wrap items-center gap-2 text-sm">
        <span className="text-muted">Start from:</span>
        <button type="button" className="btn btn-sm" onClick={() => sortBy((i) => i.name)}>A–Z</button>
        <button type="button" className="btn btn-sm" onClick={() => sortBy((i) => {
          const g = groups.find((x) => x.id === i.group_id)
          return g ? String(g.sort).padStart(6, '0') : '999999'
        })}>By category</button>
      </div>

      <ol className="divide-y divide-line">
        {ids.map((id, n) => {
          const i = byId.get(id)!
          return (
            <li key={id} draggable
              onDragStart={() => setDragging(id)}
              onDragEnd={() => setDragging(null)}
              onDragOver={(e) => { e.preventDefault(); if (dragging && dragging !== id) move(ids.indexOf(dragging), n) }}
              className={`flex items-center gap-2 py-2 ${dragging === id ? 'opacity-40' : ''}`}>
              <span className="hidden cursor-grab select-none px-1 text-muted md:inline" aria-hidden>⠿</span>
              <span className="num w-7 shrink-0 text-right text-sm text-muted">{n + 1}</span>
              <span className="min-w-0 flex-1">
                <span className="block truncate font-medium">{i.name}</span>
                <span className="block truncate text-xs text-muted">{i.unit}{groupName(i.group_id) ? ` · ${groupName(i.group_id)}` : ''}</span>
              </span>
              <span className="flex shrink-0 gap-1">
                <button type="button" className="btn btn-sm !h-9 !w-9 !p-0" aria-label={`Move ${i.name} to the top`} disabled={n === 0} onClick={() => move(n, 0)}>⤒</button>
                <button type="button" className="btn btn-sm !h-9 !w-9 !p-0" aria-label={`Move ${i.name} up`} disabled={n === 0} onClick={() => move(n, n - 1)}>↑</button>
                <button type="button" className="btn btn-sm !h-9 !w-9 !p-0" aria-label={`Move ${i.name} down`} disabled={n === ids.length - 1} onClick={() => move(n, n + 1)}>↓</button>
              </span>
            </li>
          )
        })}
      </ol>

      <div className="sticky bottom-[calc(4.5rem+env(safe-area-inset-bottom))] z-10 mt-3 flex items-center gap-2 rounded-xl border border-line bg-surface p-3 shadow-lg md:bottom-4">
        <span className="min-w-0 flex-1 text-sm text-muted">{changed ? 'Not saved yet' : `${supplier.name}’s order is saved`}</span>
        <button type="button" className="btn" disabled={!changed} onClick={() => setIds(saved.map((i) => i.id))}>Undo</button>
        <button type="button" className="btn btn-primary" disabled={!changed || saveOrder.isPending}
          onClick={() => saveOrder.mutate(
            ids.map((id, n) => ({ id, supplier_sort: (n + 1) * 10 })).filter((r) => byId.get(r.id)!.supplier_sort !== r.supplier_sort),
          )}>
          {saveOrder.isPending ? 'Saving…' : 'Save order'}
        </button>
      </div>
    </div>
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
