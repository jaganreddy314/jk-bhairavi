import { useEffect, useState, type ReactNode } from 'react'
import { useSearchParams } from 'react-router-dom'
import {
  useBulkUpdate, useItemCosts, usePlaceItems, useItemSuppliers, useRemoveItemSupplier, useSave, useSaveItemSupplier, useSetItemOrder, useStockGroups,
  useStockItems, useStockLocations, useSuppliers,
} from '../lib/api'
import { walkOrder } from '../lib/layout'
import StoreLayout from './StoreLayout'
import { CAT_LABEL, ENTRY_CATEGORIES } from '../lib/categories'
import { fmtShort } from '../lib/dates'
import { aud, parseMoney } from '../lib/format'
import type { ItemSupplier, StockGroup, StockItem, Supplier } from '../lib/types'
import { bySection, FoodHeader, linksFor, NO_SECTION, supplierOrder, type SupplierLinks } from '../components/catalogue'
import { TableEditor } from '../components/TableEditor'
import { DeleteButton, ErrorBox, Loading, MoneyInput, SaveBar, SearchBox, Segmented } from '../components/ui'

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

type Tab = 'products' | 'order' | 'layout' | 'suppliers' | 'sections'

const TAB_SUB: Record<Tab, string> = {
  products: 'Your products, suppliers and how the store is laid out.',
  order: 'The order you go through each supplier’s products when ordering.',
  layout: 'Where everything lives, in the order you walk the store.',
  suppliers: 'Who you buy from.',
  sections: 'How products are grouped.',
}

/** What the shop buys and counts: products, who supplies them, and where they live. */
export default function Catalogue() {
  const [params, setParams] = useSearchParams()
  const raw = params.get('tab')
  const tab: Tab = raw === 'suppliers' || raw === 'sections' || raw === 'order' || raw === 'layout' ? raw : 'products'
  // The drawer for adding a product opens from the header, so its state lives up here.
  const [editing, setEditing] = useState<StockItem | 'new' | null>(null)

  return (
    <div>
      <FoodHeader sub={TAB_SUB[tab]}
        action={tab === 'products' && (
          <button type="button" className="btn btn-primary" onClick={() => setEditing('new')}>
            <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" aria-hidden><path d="M5 12h14M12 5v14" /></svg>
            Add product
          </button>
        )} />
      <div className="mb-4">
        <Segmented
          ariaLabel="Catalogue"
          value={tab}
          onChange={(t) => setParams(t === 'products' ? {} : { tab: t }, { replace: true })}
          options={[
            { value: 'products', label: 'Products' },
            { value: 'order', label: 'Supplier order' },
            { value: 'layout', label: 'Store layout' },
            { value: 'suppliers', label: 'Suppliers' },
            { value: 'sections', label: 'Categories' },
          ]}
        />
      </div>
      {tab === 'products' && <Products editing={editing} setEditing={setEditing} />}
      {tab === 'order' && <SupplierOrder />}
      {tab === 'layout' && <StoreLayout />}
      {tab === 'suppliers' && <Suppliers />}
      {tab === 'sections' && <Sections />}
    </div>
  )
}

/** Products shown per category before "Show all", when every category is listed. */
const PER_GROUP = 25
const NO_SUPPLIER = '__none'

function Products({ editing, setEditing }: { editing: StockItem | 'new' | null; setEditing: (e: StockItem | 'new' | null) => void }) {
  const items = useStockItems()
  const groups = useStockGroups()
  const suppliers = useSuppliers()
  const costs = useItemCosts()
  const itemSuppliers = useItemSuppliers()
  const locations = useStockLocations()
  const [cat, setCat] = useState('all')
  const [supplierId, setSupplierId] = useState('')
  const [q, setQ] = useState('')
  const [showHidden, setShowHidden] = useState(false)
  const [selected, setSelected] = useState<Set<string>>(new Set())

  if (items.isLoading || groups.isLoading || suppliers.isLoading) return <Loading />

  const groupList = groups.data ?? []
  const supplierList = suppliers.data ?? []
  const all = items.data ?? []
  const hiddenCount = all.filter((i) => !i.active).length
  const needle = q.trim().toLowerCase()
  const linksByItem = new Map<string, ItemSupplier[]>()
  for (const l of itemSuppliers.data ?? []) linksByItem.set(l.item_id, [...(linksByItem.get(l.item_id) ?? []), l])
  const fromSupplier = (i: StockItem) =>
    !supplierId ? true
      : supplierId === NO_SUPPLIER ? !i.supplier_id && !(linksByItem.get(i.id) ?? []).length
      : i.supplier_id === supplierId || (linksByItem.get(i.id) ?? []).some((l) => l.supplier_id === supplierId)
  const pool = all.filter((i) => (showHidden || i.active) && fromSupplier(i) && (!needle || i.name.toLowerCase().includes(needle)))
  const sections = bySection(pool, groupList)
  const current = sections.some((s) => s.key === cat) ? cat : 'all'
  const shown = current === 'all' ? sections : sections.filter((s) => s.key === current)
  // Long categories are cut short while everything is listed; a search or one category shows it all.
  const capped = current === 'all' && !needle
  const rowsOf = (items: StockItem[]) => (capped ? items.slice(0, PER_GROUP) : items)
  // Only what is on screen counts as selected, so a filter change can't edit something out of sight.
  const visible = shown.flatMap((s) => rowsOf(s.items))
  const chosen = visible.filter((i) => selected.has(i.id)).map((i) => i.id)
  const toggle = (ids: string[], on: boolean) => {
    const next = new Set(selected)
    for (const id of ids) if (on) next.add(id); else next.delete(id)
    setSelected(next)
  }
  const supplierName = (id: string | null) => supplierList.find((s) => s.id === id)?.name
  const lastPaid = (i: StockItem) => costs.data?.find((c) => c.item_id === i.id)?.unit_cost
  const box = 'h-4 w-4 accent-[var(--accent)]'

  return (
    <>
      <section className="card overflow-hidden">
        <ErrorBox error={items.error} />
        <div className="flex flex-wrap items-center gap-2.5 border-b border-line px-3.5 py-3 desk:px-5">
          <SearchBox value={q} onChange={setQ} placeholder={`Search ${all.filter((i) => i.active).length.toLocaleString('en-AU')} products`} />
          <select aria-label="Supplier" className="field !h-9 !w-auto !py-0 !text-[13px]" value={supplierId} onChange={(e) => setSupplierId(e.target.value)}>
            <option value="">All suppliers</option>
            <option value={NO_SUPPLIER}>No supplier set</option>
            {supplierList.filter((s) => s.active).map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
          </select>
          <select aria-label="Category" className="field !h-9 !w-auto !py-0 !text-[13px]" value={current} onChange={(e) => setCat(e.target.value)}>
            <option value="all">All categories · {pool.length.toLocaleString('en-AU')}</option>
            {sections.map((s) => <option key={s.key} value={s.key}>{s.label} · {s.items.length}</option>)}
          </select>
        </div>

        {visible.length > 0 && (
          <label className="flex cursor-pointer items-center gap-2.5 border-b border-line-2 bg-hover px-3.5 py-2.5 text-[13px] text-ink-2 desk:px-5">
            <input type="checkbox" className={box} checked={chosen.length === visible.length}
              ref={(el) => { if (el) el.indeterminate = chosen.length > 0 && chosen.length < visible.length }}
              onChange={(e) => toggle(visible.map((i) => i.id), e.target.checked)} />
            <span className="flex-1">Select all shown</span>
            <span className="hidden text-xs text-faint desk:block">Tick products to change several at once</span>
          </label>
        )}

        {shown.length === 0 && (
          <p className="py-10 text-center text-muted">
            {all.length === 0 ? 'No products yet. Add the things you buy and count.' : 'No products match.'}
          </p>
        )}

        {shown.map((s) => {
          const rows = rowsOf(s.items)
          return (
            <div key={s.key}>
              <label className="flex cursor-pointer items-center gap-2.5 px-3.5 pb-2 pt-3 desk:px-5">
                <input type="checkbox" className={box} aria-label={`Select all in ${s.label}`}
                  checked={rows.every((i) => selected.has(i.id))}
                  onChange={(e) => toggle(rows.map((i) => i.id), e.target.checked)} />
                <span className="flex-1 font-semibold">{s.label}</span>
                <span className="num text-xs text-muted">{s.items.length} {s.items.length === 1 ? 'product' : 'products'}</span>
              </label>
              {rows.map((i) => {
                const extra = (linksByItem.get(i.id)?.length ?? 1) - 1
                const usual = supplierName(i.supplier_id)
                return (
                  <div key={i.id}
                    className={`grid grid-cols-[20px_minmax(0,1fr)_auto] items-center gap-3 border-t border-line-2 px-3.5 py-2.5 desk:grid-cols-[20px_minmax(0,1fr)_56px_150px_80px_40px] desk:px-5 ${
                      i.active ? '' : 'opacity-55'} ${selected.has(i.id) ? 'bg-accent-tint' : ''}`}>
                    <input type="checkbox" className={box} aria-label={`Select ${i.name}`}
                      checked={selected.has(i.id)} onChange={(e) => toggle([i.id], e.target.checked)} />
                    <button type="button" className="min-w-0 text-left" onClick={() => setEditing(i)}>
                      <span className="block font-medium desk:truncate">
                        {i.name}
                        {!i.active && <span className="ml-2 rounded-full bg-surface-2 px-2 py-0.5 text-[11px] font-semibold text-muted">Hidden</span>}
                      </span>
                      <span className="mt-0.5 block truncate text-xs text-muted desk:hidden">
                        {i.unit} · {usual ?? 'No supplier set'}{extra > 0 && ` +${extra}`}
                      </span>
                    </button>
                    <span className="hidden text-muted desk:block">{i.unit}</span>
                    <span className={`hidden truncate text-[13px] desk:block ${usual ? 'text-ink-2' : 'text-faint'}`}>
                      {usual ?? 'No supplier set'}
                      {extra > 0 && <span className="ml-1 rounded-full bg-surface-2 px-1.5 text-[11px] font-semibold text-accent">+{extra}</span>}
                    </span>
                    <Price unit={i.unit} cost={i.unit_cost} paid={lastPaid(i)} />
                    <span className="hidden text-right desk:block">
                      <button type="button" aria-label={`Edit ${i.name}`} onClick={() => setEditing(i)}
                        className="inline-grid h-8 w-8 place-items-center rounded-lg border border-input-line text-ink-2 hover:bg-hover">
                        <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
                          <path d="M21.174 6.812a1 1 0 0 0-3.986-3.987L3.842 16.174a2 2 0 0 0-.5.83l-1.321 4.352a.5.5 0 0 0 .623.622l4.353-1.32a2 2 0 0 0 .83-.497z" />
                        </svg>
                      </button>
                    </span>
                  </div>
                )
              })}
              {capped && s.items.length > PER_GROUP && (
                <div className="border-t border-line-2 px-3.5 pb-3.5 pt-2 desk:px-5">
                  <button type="button" className="text-[13px] font-medium text-accent" onClick={() => setCat(s.key)}>
                    Show all {s.items.length} in {s.label} →
                  </button>
                </div>
              )}
            </div>
          )
        })}

        {hiddenCount > 0 && (
          <label className="flex items-center gap-2 border-t border-line px-3.5 py-3 text-[13px] text-ink-2 desk:px-5">
            <input type="checkbox" className={box} checked={showHidden} onChange={(e) => setShowHidden(e.target.checked)} />
            Show {hiddenCount} hidden {hiddenCount === 1 ? 'product' : 'products'}
          </label>
        )}
      </section>
      <p className="mt-3 text-xs text-muted">
        The price is a fallback. Once an order for a product has been received, the price actually paid is what orders and the
        count sheet use. Hide a product to take it out of both without losing its history.
      </p>

      {chosen.length > 0 && (
        <BulkBar
          ids={chosen}
          groups={groupList.map((g) => ({ value: g.id, label: g.name }))}
          suppliers={supplierList.filter((s) => s.active).map((s) => ({ value: s.id, label: s.name }))}
          locations={[...(locations.data ?? [])].sort(walkOrder).map((l) => ({ value: l.id, label: l.name }))}
          onDone={() => setSelected(new Set())}
        />
      )}

      {editing && (
        <ProductDrawer
          key={editing === 'new' ? 'new' : editing.id}
          item={editing === 'new' ? null : editing}
          defaults={{ group_id: current !== 'all' && current !== NO_SECTION ? current : null, supplier_id: supplierId && supplierId !== NO_SUPPLIER ? supplierId : null }}
          groups={groupList}
          suppliers={supplierList}
          links={editing === 'new' ? [] : linksByItem.get(editing.id) ?? []}
          onClose={() => setEditing(null)}
        />
      )}
    </>
  )
}

/** Add or edit one product in a panel from the right (the whole screen on a phone). */
function ProductDrawer({ item, defaults, groups, suppliers, links, onClose }: {
  item: StockItem | null; defaults: { group_id: string | null; supplier_id: string | null }
  groups: StockGroup[]; suppliers: Supplier[]; links: ItemSupplier[]; onClose: () => void
}) {
  const save = useSave('stock_items')
  const [name, setName] = useState(item?.name ?? '')
  const [price, setPrice] = useState(item?.unit_cost ? String(item.unit_cost) : '')
  const [unit, setUnit] = useState(item?.unit ?? 'ea')
  const [group, setGroup] = useState(item ? item.group_id ?? '' : defaults.group_id ?? '')
  const [supplier, setSupplier] = useState(item ? item.supplier_id ?? '' : defaults.supplier_id ?? '')
  const [active, setActive] = useState(item?.active ?? true)
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose() }
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  }, [onClose])

  async function submit(e: React.FormEvent) {
    e.preventDefault()
    if (!name.trim()) return
    await save.mutateAsync({
      ...(item ? { id: item.id } : {}),
      name: name.trim(), unit, active,
      unit_cost: price.trim() === '' ? null : parseMoney(price),
      group_id: group || null,
      supplier_id: supplier || null,
    })
    onClose()
  }

  const field = (label: string, control: ReactNode) => (
    <label className="flex flex-col gap-1.5 text-[13px] font-medium text-ink-2">{label}{control}</label>
  )
  // A unit set before the fixed list existed still shows, rather than silently changing.
  const units = UNIT_OPTIONS.some((u) => u.value === unit) ? UNIT_OPTIONS : [{ value: unit, label: unit }, ...UNIT_OPTIONS]

  return (
    <>
      <div className="fixed inset-0 z-50 bg-[rgba(16,24,40,0.4)]" onClick={onClose} />
      <form role="dialog" aria-modal="true" aria-label={item ? 'Edit product' : 'Add product'} onSubmit={submit}
        className="fixed inset-y-0 right-0 z-51 flex w-full max-w-full flex-col bg-surface shadow-[-12px_0_32px_rgba(16,24,40,0.15)] desk:w-[420px]">
        <div className="flex items-center gap-3 border-b border-line px-5 pb-4 pt-[calc(env(safe-area-inset-top)+16px)]">
          <h2 className="flex-1 text-base font-semibold">{item ? 'Edit product' : 'Add product'}</h2>
          <button type="button" aria-label="Close" onClick={onClose} className="grid h-[34px] w-[34px] place-items-center rounded-lg bg-surface-2 text-ink-2">
            <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" aria-hidden><path d="M18 6 6 18M6 6l12 12" /></svg>
          </button>
        </div>
        <div className="flex flex-1 flex-col gap-4 overflow-auto p-5">
          <ErrorBox error={save.error} />
          {field('Name', <input className="field" value={name} onChange={(e) => setName(e.target.value)} required autoFocus={!item} />)}
          <div className="grid grid-cols-2 gap-3">
            {field('Price', <MoneyInput size="sm" value={price} onChange={setPrice} placeholder="0.00" aria-label="Price" />)}
            {field('Unit', (
              <select className="field" value={unit} onChange={(e) => setUnit(e.target.value)}>
                {units.map((u) => <option key={u.value} value={u.value}>{u.label}</option>)}
              </select>
            ))}
          </div>
          {field('Category', (
            <select className="field" value={group} onChange={(e) => setGroup(e.target.value)}>
              <option value="">No category</option>
              {groups.map((g) => <option key={g.id} value={g.id}>{g.name}</option>)}
            </select>
          ))}
          {field('Usually ordered from', (
            <select className="field" value={supplier} onChange={(e) => setSupplier(e.target.value)}>
              <option value="">Not set</option>
              {suppliers.filter((s) => s.active || s.id === supplier).map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
            </select>
          ))}
          <label className="flex items-center gap-2.5 text-sm">
            <input type="checkbox" className="h-4 w-4 accent-[var(--accent)]" checked={active} onChange={(e) => setActive(e.target.checked)} />
            Show in orders and stock counts
          </label>
          {item && (
            <div>
              <div className="mb-2 text-[13px] font-medium text-ink-2">Suppliers and prices</div>
              <SupplierPanel item={item} links={links} suppliers={suppliers.filter((x) => x.active)} />
            </div>
          )}
        </div>
        <div className="flex justify-end gap-2 border-t border-line px-5 pb-[calc(env(safe-area-inset-bottom)+14px)] pt-3.5">
          <button type="button" className="btn" onClick={onClose}>Cancel</button>
          <button className="btn btn-primary" disabled={!name.trim() || save.isPending}>{save.isPending ? 'Saving…' : 'Save product'}</button>
        </div>
      </form>
    </>
  )
}

const KEEP = ''
const NONE = '__none'
type BulkAction = 'price' | 'supplier' | 'category' | 'place' | 'active'

/** Change every ticked product in one go: a dark bar at the bottom, one change at a time. */
function BulkBar({
  ids, groups, suppliers, locations, onDone,
}: { ids: string[]; groups: Option[]; suppliers: Option[]; locations: Option[]; onDone: () => void }) {
  const update = useBulkUpdate('stock_items')
  const placeItems = usePlaceItems()
  const [action, setAction] = useState<BulkAction | null>(null)
  const [value, setValue] = useState(KEEP)
  const open = (a: BulkAction) => { setAction(action === a ? null : a); setValue(KEEP) }

  async function apply() {
    if (action === 'place') await placeItems.mutateAsync({ locationId: value === NONE ? null : value, itemIds: ids, only: true })
    else {
      const patch = action === 'price' ? { unit_cost: value.trim() === '' ? null : parseMoney(value) }
        : action === 'supplier' ? { supplier_id: value === NONE ? null : value }
        : action === 'category' ? { group_id: value === NONE ? null : value }
        : { active: value === 'show' }
      await update.mutateAsync({ ids, patch })
    }
    setAction(null)
    onDone()
  }

  const choose = (options: Option[], none?: string) => (
    <select aria-label="Change to" className="field !h-9 !w-auto min-w-44 !border-[#344054] !bg-[#1D2939] !py-0 !text-[13px] !text-white" value={value} onChange={(e) => setValue(e.target.value)}>
      <option value={KEEP} disabled>Choose…</option>
      {options.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
      {none && <option value={NONE}>{none}</option>}
    </select>
  )
  const btn = (a: BulkAction, label: string) => (
    <button type="button" aria-pressed={action === a} onClick={() => open(a)}
      className={`h-9 rounded-lg border px-3 text-[13px] font-medium text-white ${action === a ? 'border-[#5FC3B5] bg-[#0F766E]' : 'border-[#344054] bg-[#1D2939] hover:bg-[#344054]'}`}>
      {label}
    </button>
  )
  const ready = action === 'price' || value !== KEEP

  return (
    <div className="sticky bottom-[calc(env(safe-area-inset-bottom)+76px)] z-20 mt-3 rounded-xl bg-[#101828] p-3 text-white shadow-[var(--shadow-float)] desk:bottom-4 dark:bg-[#2A303B]">
      <ErrorBox error={update.error || placeItems.error} />
      <div className="flex flex-wrap items-center gap-2">
        <span className="min-w-[100px] flex-1 font-semibold">{ids.length} selected</span>
        {btn('price', 'Change price')}
        {btn('supplier', 'Set supplier')}
        {btn('category', 'Move category')}
        {locations.length > 0 && btn('place', 'Counted at')}
        {btn('active', 'Show / hide')}
        <button type="button" aria-label="Clear selection" onClick={onDone}
          className="grid h-9 w-9 place-items-center rounded-lg text-[#98A2B3] hover:bg-[#1D2939] hover:text-white">
          <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" aria-hidden><path d="M18 6 6 18M6 6l12 12" /></svg>
        </button>
      </div>
      {action && (
        <div className="mt-3 flex flex-wrap items-center gap-2 border-t border-[#344054] pt-3 text-[13px]">
          <span className="text-[#D0D5DD]">
            {action === 'price' ? 'New price for each' : action === 'supplier' ? 'Usually ordered from' : action === 'category' ? 'Move to'
              : action === 'place' ? 'Counted only at' : 'Show in orders and counts'}
          </span>
          {action === 'price' && (
            <input inputMode="decimal" placeholder="0.00" aria-label="New price" value={value} onChange={(e) => setValue(e.target.value)}
              className="field num !h-9 !w-28 !border-[#344054] !bg-[#1D2939] !py-0 !text-[13px] !text-white" />
          )}
          {action === 'supplier' && choose(suppliers, 'No supplier')}
          {action === 'category' && choose(groups, 'No category')}
          {action === 'place' && choose(locations, 'Wherever its category is')}
          {action === 'active' && choose([{ value: 'show', label: 'Shown' }, { value: 'hide', label: 'Hidden' }])}
          <button type="button" className="btn btn-primary btn-sm h-9" disabled={!ready || update.isPending || placeItems.isPending} onClick={apply}>
            {update.isPending || placeItems.isPending ? 'Saving…' : `Update ${ids.length}`}
          </button>
        </div>
      )}
    </div>
  )
}

interface Option { value: string; label: string }

/**
 * Who sells this product, in what carton, and what each last charged. Carton size and the
 * supplier's code save when you leave the box; the cheapest current price is marked.
 */
function SupplierPanel({ item, links, suppliers }: { item: StockItem; links: ItemSupplier[]; suppliers: Supplier[] }) {
  const save = useSaveItemSupplier()
  const remove = useRemoveItemSupplier()
  const setUsual = useSave('stock_items')
  const [adding, setAdding] = useState('')
  const name = (id: string) => suppliers.find((s) => s.id === id)?.name ?? 'Supplier'
  const priced = links.filter((l) => l.last_unit_cost)
  const cheapest = priced.length > 1 ? priced.reduce((a, b) => (b.last_unit_cost! < a.last_unit_cost! ? b : a)).supplier_id : null
  const unlinked = suppliers.filter((s) => !links.some((l) => l.supplier_id === s.id))
  const sorted = [...links].sort((a, b) => Number(b.supplier_id === item.supplier_id) - Number(a.supplier_id === item.supplier_id) || name(a.supplier_id).localeCompare(name(b.supplier_id)))

  return (
    <div className="rounded-xl bg-surface-2 p-3">
      <ErrorBox error={save.error || remove.error || setUsual.error} />
      {links.length === 0 && <p className="mb-2 text-sm text-muted">No supplier linked yet.</p>}
      {links.length > 0 && (
        <div className="-mx-1 overflow-x-auto px-1">
          <table className="num w-full min-w-[34rem] text-sm">
            <thead className="text-left text-xs text-muted">
              <tr>
                <th className="py-1 font-semibold">Supplier</th>
                <th className="py-1 font-semibold">Carton</th>
                <th className="py-1 text-right font-semibold">Per {item.unit}</th>
                <th className="py-1 text-right font-semibold">Per carton</th>
                <th className="py-1 pl-3 font-semibold">Last bought</th>
                <th className="py-1 font-semibold">Their code</th>
                <th />
              </tr>
            </thead>
            <tbody className="divide-y divide-line">
              {sorted.map((l) => (
                <tr key={l.supplier_id}>
                  <td className="py-1.5 pr-2 font-medium">
                    {name(l.supplier_id)}
                    {l.supplier_id === item.supplier_id && <span className="ml-1.5 text-[11px] font-semibold text-accent">usual</span>}
                    {l.supplier_id === cheapest && <span className="ml-1.5 rounded-full bg-good/15 px-1.5 text-[11px] font-semibold text-good">cheapest</span>}
                  </td>
                  <td className="py-1.5">
                    <input aria-label={`Units per carton from ${name(l.supplier_id)}`} className="field !w-16 !px-2 !py-1 text-right" inputMode="numeric"
                      defaultValue={l.pack_size}
                      onBlur={(e) => {
                        const n = Math.max(1, Math.round(Number(e.target.value) || 1))
                        if (n !== l.pack_size) save.mutate({ item_id: item.id, supplier_id: l.supplier_id, pack_size: n })
                        e.target.value = String(n)
                      }} />
                  </td>
                  <td className="py-1.5 text-right">{l.last_unit_cost ? aud(l.last_unit_cost) : <span className="text-muted">—</span>}</td>
                  <td className="py-1.5 text-right">{l.carton_cost && l.pack_size > 1 ? aud(l.carton_cost) : <span className="text-muted">—</span>}</td>
                  <td className="py-1.5 pl-3 text-ink-2">{l.last_bought_on ? fmtShort(l.last_bought_on) : <span className="text-muted">never</span>}</td>
                  <td className="py-1.5">
                    <input aria-label={`${name(l.supplier_id)}'s code`} className="field !w-24 !px-2 !py-1" defaultValue={l.supplier_code ?? ''}
                      onBlur={(e) => {
                        const v = e.target.value.trim() || null
                        if (v !== l.supplier_code) save.mutate({ item_id: item.id, supplier_id: l.supplier_id, supplier_code: v })
                      }} />
                  </td>
                  <td className="py-1.5 text-right">
                    <span className="inline-flex gap-1">
                      {l.supplier_id !== item.supplier_id && (
                        <button type="button" className="btn btn-sm" disabled={setUsual.isPending}
                          onClick={() => setUsual.mutate({ id: item.id, supplier_id: l.supplier_id })}>Make usual</button>
                      )}
                      <DeleteButton label="Remove" busy={remove.isPending} onConfirm={() => remove.mutate({ item_id: item.id, supplier_id: l.supplier_id })} />
                    </span>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {unlinked.length > 0 && (
        <div className="mt-2 flex flex-wrap items-center gap-2">
          <select aria-label="Add a supplier" className="field !w-auto !py-1.5 !text-sm" value={adding} onChange={(e) => setAdding(e.target.value)}>
            <option value="">Add a supplier…</option>
            {unlinked.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
          </select>
          <button type="button" className="btn btn-sm" disabled={!adding || save.isPending}
            onClick={() => save.mutate({ item_id: item.id, supplier_id: adding, pack_size: 1 }, { onSuccess: () => setAdding('') })}>Add</button>
        </div>
      )}
      <p className="mt-2 text-xs text-muted">Prices are what each supplier last charged per {item.unit}, from their orders. Ordering from a new supplier links it automatically.</p>
    </div>
  )
}

/** The price an order would use, and where it came from. */
function Price({ unit, cost, paid }: { unit: string; cost: number | null; paid: number | undefined }) {
  const value = paid || cost
  return (
    <span className="num text-right text-[13px] font-semibold desk:text-sm">
      {value ? <>{aud(value)}<span className="font-normal text-muted desk:hidden"> / {unit}</span></> : <span className="font-normal text-faint">no price</span>}
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
  const itemSuppliers = useItemSuppliers()
  const [supplierId, setSupplierId] = useState('')

  if (items.isLoading || groups.isLoading || suppliers.isLoading || itemSuppliers.isLoading) return <Loading />

  const all = (items.data ?? []).filter((i) => i.active)
  const links = itemSuppliers.data ?? []
  // A supplier's products are the ones linked to them: a product sold by two suppliers is on both lists.
  const theirs = (id: string) => { const l = linksFor(links, id); return all.filter((i) => l.has(i.id)) }
  const withItems = (suppliers.data ?? []).filter((s) => s.active && theirs(s.id).length > 0)
  const supplier = withItems.find((s) => s.id === supplierId) ?? withItems[0]

  if (!supplier)
    return (
      <p className="card px-4 py-10 text-center text-sm text-muted">
        No products have a supplier yet. Set “Usually ordered from” on the Products tab — several at once with the tick boxes.
      </p>
    )
  return (
    // Remount per supplier, or when its products change, so the draft starts from what's saved.
    // Not on every refetch — coming back to the tab mustn't throw away an unsaved arrangement.
    <Arrange key={supplier.id + theirs(supplier.id).map((i) => i.id).sort().join()} supplier={supplier}
      items={theirs(supplier.id)} links={linksFor(links, supplier.id)} groups={groups.data ?? []}
      picker={
        <select aria-label="Supplier" className="field !w-auto max-w-full" value={supplier.id} onChange={(e) => setSupplierId(e.target.value)}>
          {withItems.map((s) => <option key={s.id} value={s.id}>{s.name} ({theirs(s.id).length})</option>)}
        </select>
      } />
  )
}

const arrow = (d: string) => (
  <svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden><path d={d} /></svg>
)

function Arrange({ supplier, items, links, groups, picker }: {
  supplier: Supplier; items: StockItem[]; links: SupplierLinks; groups: StockGroup[]; picker: ReactNode
}) {
  const saveOrder = useSetItemOrder()
  const saved = [...items].sort(supplierOrder(links))
  const [ids, setIdsState] = useState(() => saved.map((i) => i.id))
  // Every arrangement before this one, so Undo steps back one move at a time.
  const [history, setHistory] = useState<string[][]>([])
  const [dragging, setDragging] = useState<string | null>(null)
  const [over, setOver] = useState<number | null>(null)
  const byId = new Map(items.map((i) => [i.id, i]))
  const groupName = (id: string | null) => groups.find((g) => g.id === id)?.name
  const changed = ids.some((id, n) => id !== saved[n].id)
  const setIds = (next: string[]) => { setHistory([...history, ids]); setIdsState(next) }

  const move = (from: number, to: number) => {
    if (to < 0 || to >= ids.length || from === to) return
    const next = [...ids]
    next.splice(to, 0, next.splice(from, 1)[0])
    setIds(next)
  }
  const sortBy = (key: (i: StockItem) => string) =>
    setIds([...ids].sort((a, b) => key(byId.get(a)!).localeCompare(key(byId.get(b)!)) || byId.get(a)!.name.localeCompare(byId.get(b)!.name)))
  const iconBtn = 'grid h-9 w-9 place-items-center rounded-lg border border-input-line bg-surface text-ink-2 hover:bg-hover disabled:opacity-35 disabled:hover:bg-surface'

  return (
    <>
      <section className="card overflow-hidden">
        <div className="flex flex-wrap items-end gap-3 border-b border-line px-3.5 py-3 desk:px-5">
          <div className="min-w-[220px] flex-1">
            <p className="mb-2.5 text-[13px] text-muted">
              Put each supplier's products in the order you go through them when ordering. New orders list them this way, and so
              does the order you send.
            </p>
            {picker}
          </div>
          <div className="flex items-center gap-2">
            <span className="text-xs text-muted">Reset to</span>
            <button type="button" className="btn btn-sm h-9" onClick={() => sortBy((i) => i.name)}>A–Z</button>
            <button type="button" className="btn btn-sm h-9" onClick={() => sortBy((i) => {
              const g = groups.find((x) => x.id === i.group_id)
              return g ? String(g.sort).padStart(6, '0') : '999999'
            })}>By category</button>
          </div>
        </div>
        <ErrorBox error={saveOrder.error} />
        <ol>
          {ids.map((id, n) => {
            const i = byId.get(id)!
            const from = dragging ? ids.indexOf(dragging) : -1
            // A teal line where the dragged row will land.
            const line = over === n && dragging && dragging !== id ? (from < n ? 'shadow-[inset_0_-2px_0_var(--accent)]' : 'shadow-[inset_0_2px_0_var(--accent)]') : ''
            return (
              <li key={id} draggable
                onDragStart={() => setDragging(id)}
                onDragOver={(e) => { e.preventDefault(); setOver(n) }}
                onDrop={(e) => { e.preventDefault(); if (dragging) move(ids.indexOf(dragging), n); setDragging(null); setOver(null) }}
                onDragEnd={() => { setDragging(null); setOver(null) }}
                className={`grid grid-cols-[28px_minmax(0,1fr)_auto] items-center gap-3 border-b border-line-2 px-3.5 py-2.5 desk:grid-cols-[16px_28px_minmax(0,1fr)_auto] desk:px-5 ${
                  dragging === id ? 'bg-hover opacity-50' : ''} ${line}`}>
                <span className="hidden cursor-grab text-faint desk:block" aria-hidden>
                  <svg viewBox="0 0 24 24" width="16" height="16" fill="currentColor"><circle cx="9" cy="5" r="1.5" /><circle cx="9" cy="12" r="1.5" /><circle cx="9" cy="19" r="1.5" /><circle cx="15" cy="5" r="1.5" /><circle cx="15" cy="12" r="1.5" /><circle cx="15" cy="19" r="1.5" /></svg>
                </span>
                <span className="num grid h-7 w-7 place-items-center rounded-lg bg-surface-2 text-xs font-semibold text-ink-2">{n + 1}</span>
                <span className="min-w-0">
                  <span className="block font-medium desk:truncate">{i.name}</span>
                  <span className="block truncate text-xs text-muted">{i.unit}{groupName(i.group_id) ? ` · ${groupName(i.group_id)}` : ''}</span>
                </span>
                <span className="flex gap-1">
                  <button type="button" className={iconBtn} aria-label={`Move ${i.name} to the top`} disabled={n === 0} onClick={() => move(n, 0)}>{arrow('M17 11 12 6l-5 5M12 18V6M5 3h14')}</button>
                  <button type="button" className={iconBtn} aria-label={`Move ${i.name} up`} disabled={n === 0} onClick={() => move(n, n - 1)}>{arrow('m18 15-6-6-6 6')}</button>
                  <button type="button" className={iconBtn} aria-label={`Move ${i.name} down`} disabled={n === ids.length - 1} onClick={() => move(n, n + 1)}>{arrow('m6 9 6 6 6-6')}</button>
                </span>
              </li>
            )
          })}
        </ol>
      </section>

      <SaveBar dirty={changed} message={changed ? `Unsaved changes to ${supplier.name}’s order` : `${supplier.name}’s order is saved`}>
        <button type="button" className="btn h-10" disabled={!history.length}
          onClick={() => { setIdsState(history[history.length - 1]); setHistory(history.slice(0, -1)) }}>Undo</button>
        <button type="button" className={`btn h-10 px-[18px] ${changed ? 'btn-primary' : 'btn-saved'}`} disabled={!changed || saveOrder.isPending}
          onClick={() => saveOrder.mutate({
            supplierId: supplier.id,
            rows: ids.map((id, n) => ({ item_id: id, sort: (n + 1) * 10 })).filter((r) => links.get(r.item_id)?.sort !== r.sort),
          })}>
          {saveOrder.isPending ? 'Saving…' : changed ? 'Save order' : 'Saved'}
        </button>
      </SaveBar>
    </>
  )
}

/** A Catalogue list: a title and a line about it over a simple editable list. */
function ListCard({ title, sub, children }: { title: string; sub: string; children: ReactNode }) {
  return (
    <section className="card overflow-hidden">
      <div className="border-b border-line px-3.5 py-3 desk:px-5">
        <h2 className="text-base font-semibold">{title}</h2>
        <p className="mt-0.5 text-[13px] text-muted">{sub}</p>
      </div>
      <div className="px-3.5 pb-3 desk:px-5">{children}</div>
    </section>
  )
}

function Suppliers() {
  const suppliers = useSuppliers()
  if (suppliers.isLoading) return <Loading />
  return (
    <ListCard title="Suppliers" sub="Untick “Active” to hide a supplier from the pickers without losing its history.">
      <TableEditor table="suppliers" rows={suppliers.data ?? []} addLabel="Add supplier" canDelete={false}
        defaults={{ default_category: 'food', active: true }}
        fields={[
          { key: 'name', label: 'Name', type: 'text', required: true },
          { key: 'default_category', label: 'Usually', type: 'select', options: CATEGORY_OPTIONS, width: 'md:w-40' },
          { key: 'active', label: 'Active', type: 'bool', width: 'md:w-16' },
        ]} />
    </ListCard>
  )
}

function Sections() {
  const groups = useStockGroups()
  if (groups.isLoading) return <Loading />
  return (
    <ListCard title="Categories"
      sub="Products are grouped by these, and the count sheet follows this order where a product isn't on a shelf yet. Lowest number first.">
      <TableEditor table="stock_groups" rows={groups.data ?? []} addLabel="Add category"
        defaults={{ sort: ((groups.data ?? []).reduce((m, g) => Math.max(m, g.sort), 0) + 10) }}
        fields={[
          { key: 'name', label: 'Category', type: 'text', required: true },
          { key: 'sort', label: 'Order', type: 'number', width: 'md:w-20 md:text-right' },
        ]} />
    </ListCard>
  )
}
