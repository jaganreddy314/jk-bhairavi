import { useRef, useState } from 'react'
import { useSearchParams } from 'react-router-dom'
import {
  useImportMenu, useMenuCategories, useMenuItemModifiers, useMenuItems, useMenuItemSizes, useModifierGroups,
  useModifierOptions, useSave, useSaveMenuItem, useStockItems,
} from '../lib/api'
import { aud, parseMoney } from '../lib/format'
import type { MenuItem, MenuItemModifier, MenuItemSize, ModifierGroup, ModifierOption } from '../lib/types'
import { FoodHeader } from '../components/catalogue'
import { Drawer, ErrorBox, Field, Loading, MoneyInput, Pill, SearchBox, Segmented } from '../components/ui'

type Tab = 'items' | 'options'

const TAB_SUB: Record<Tab, string> = {
  items: 'What the till sells, at the prices it charges. GST is included.',
  options: 'The questions asked when an item is ordered, and what each answer costs.',
}

/** The till's menu: items, sizes and option groups. */
export default function Menu() {
  const [params, setParams] = useSearchParams()
  const tab: Tab = params.get('tab') === 'options' ? 'options' : 'items'
  return (
    <div>
      <FoodHeader sub={TAB_SUB[tab]} action={<ImportButton />} />
      <div className="mb-4">
        <Segmented ariaLabel="Menu" value={tab} onChange={(t) => setParams(t === 'items' ? {} : { tab: t }, { replace: true })}
          options={[{ value: 'items', label: 'Items' }, { value: 'options', label: 'Options' }]} />
      </div>
      {tab === 'items' ? <Items /> : <Options />}
    </div>
  )
}

/**
 * Loads a menu document (made by the POS repo's menu script from the shop's website).
 * Prices are updated and new items added; nothing is removed, so running it twice is safe.
 */
function ImportButton() {
  const imp = useImportMenu()
  const input = useRef<HTMLInputElement>(null)
  const [result, setResult] = useState<string | null>(null)
  async function load(file: File) {
    setResult(null)
    try {
      const doc = JSON.parse(await file.text())
      const r = (await imp.mutateAsync(doc)) as { items: number; new: number }
      setResult(`${r.items} items loaded, ${r.new} new`)
    } catch (e) {
      setResult(e instanceof SyntaxError ? 'That file isn’t a menu document.' : null)
    }
  }
  return (
    <div className="flex flex-col items-end gap-1">
      <input ref={input} type="file" accept="application/json,.json" hidden
        onChange={(e) => { const f = e.target.files?.[0]; e.target.value = ''; if (f) load(f) }} />
      <button type="button" className="btn" disabled={imp.isPending} onClick={() => input.current?.click()}>
        {imp.isPending ? 'Importing…' : 'Import menu'}
      </button>
      {result && <span className="text-xs text-muted">{result}</span>}
      {imp.error && <span className="text-xs text-bad">{imp.error.message}</span>}
    </div>
  )
}

/** "Small $5.00 · Large $7.00", or the item's own price. */
function priceLabel(item: MenuItem, sizes: MenuItemSize[]) {
  if (item.price != null) return aud(item.price)
  const shown = sizes.filter((s) => s.active)
  if (shown.length === 0) return 'No price'
  return shown.map((s) => `${s.name} ${aud(s.price)}`).join(' · ')
}

/** "Required · choose 1", "Choose up to 2", "Choose 6". */
function ruleLabel(min: number, max: number, repeat: boolean) {
  const rule = min === max ? `${min === 0 ? 'Optional' : 'Required'} · choose ${max}` : min === 0 ? `Choose up to ${max}` : `Choose ${min}–${max}`
  return repeat ? `${rule}, repeats allowed` : rule
}

const limits = (link: MenuItemModifier, g: ModifierGroup) => ({
  min: link.min_choices ?? g.min_choices,
  max: link.max_choices ?? g.max_choices,
  repeat: link.repeat ?? g.repeat,
})

function Items() {
  const cats = useMenuCategories()
  const items = useMenuItems()
  const sizes = useMenuItemSizes()
  const groups = useModifierGroups()
  const links = useMenuItemModifiers()
  const [q, setQ] = useState('')
  const [cat, setCat] = useState('all')
  const [showHidden, setShowHidden] = useState(false)
  const [editing, setEditing] = useState<MenuItem | null>(null)

  if (cats.isLoading || items.isLoading) return <Loading />

  const all = items.data ?? []
  const needle = q.trim().toLowerCase()
  const sizesOf = (id: string) => (sizes.data ?? []).filter((s) => s.item_id === id)
  const groupsOf = (id: string) => (links.data ?? []).filter((l) => l.item_id === id)
    .map((l) => ({ link: l, group: (groups.data ?? []).find((g) => g.id === l.group_id) }))
    .filter((x): x is { link: MenuItemModifier; group: ModifierGroup } => !!x.group)
  const shown = all.filter((i) => (showHidden || i.active) && (cat === 'all' || i.category_id === cat) &&
    (!needle || i.name.toLowerCase().includes(needle) || (i.plu ?? '').toLowerCase() === needle || (i.description ?? '').toLowerCase().includes(needle)))
  const sections = (cats.data ?? []).map((c) => ({ cat: c, items: shown.filter((i) => i.category_id === c.id) })).filter((s) => s.items.length > 0)
  const hidden = all.filter((i) => !i.active).length

  if (all.length === 0) {
    return (
      <div className="card px-4 py-10 text-center text-sm text-muted">
        No menu yet. Use <span className="font-medium text-ink-2">Import menu</span> to load one, such as the file the POS’s menu script builds from your website.
      </div>
    )
  }

  return (
    <>
      <section className="card overflow-hidden">
        <ErrorBox error={items.error} />
        <div className="flex flex-wrap items-center gap-2.5 border-b border-line px-3.5 py-3 desk:px-5">
          <SearchBox value={q} onChange={setQ} placeholder={`Search ${all.filter((i) => i.active).length} items`} />
          <select aria-label="Category" className="field !h-9 !w-auto !py-0 !text-[13px]" value={cat} onChange={(e) => setCat(e.target.value)}>
            <option value="all">All categories</option>
            {(cats.data ?? []).map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
          </select>
          {hidden > 0 && (
            <label className="flex items-center gap-2 text-[13px] text-ink-2">
              <input type="checkbox" className="h-4 w-4 accent-[var(--accent)]" checked={showHidden} onChange={(e) => setShowHidden(e.target.checked)} />
              Show {hidden} hidden
            </label>
          )}
        </div>
        {sections.length === 0 && <p className="py-10 text-center text-muted">No items match.</p>}
        {sections.map((s) => (
          <div key={s.cat.id}>
            <div className="flex items-center gap-2.5 px-3.5 pb-2 pt-3 desk:px-5">
              <span className="flex-1 font-semibold">{s.cat.name}</span>
              <span className="num text-xs text-muted">{s.items.length} {s.items.length === 1 ? 'item' : 'items'}</span>
            </div>
            {s.items.map((i) => {
              const asks = groupsOf(i.id)
              return (
                <button key={i.id} type="button" onClick={() => setEditing(i)}
                  className="flex w-full items-start gap-3 border-t border-line-2 px-3.5 py-2.5 text-left hover:bg-hover desk:px-5">
                  <div className="min-w-0 flex-1">
                    <div className="flex items-center gap-2">
                      <span className="font-medium">{i.name}</span>
                      {i.plu && <span className="num text-xs text-faint">{i.plu}</span>}
                      {!i.active && <Pill tone="neutral">Hidden</Pill>}
                      {i.gst_free && <Pill tone="info">GST-free</Pill>}
                    </div>
                    {(i.description || asks.length > 0) && (
                      <div className="mt-0.5 truncate text-[13px] text-muted">
                        {[i.description, asks.map((a) => a.group.name).join(', ')].filter(Boolean).join(' · ')}
                      </div>
                    )}
                  </div>
                  <span className="num shrink-0 text-right text-sm text-ink-2">{priceLabel(i, sizesOf(i.id))}</span>
                </button>
              )
            })}
          </div>
        ))}
      </section>
      {editing && (
        <ItemDrawer key={editing.id} item={editing} sizes={sizesOf(editing.id)} asks={groupsOf(editing.id)} onClose={() => setEditing(null)} />
      )}
    </>
  )
}

function ItemDrawer({ item, sizes, asks, onClose }: {
  item: MenuItem; sizes: MenuItemSize[]; asks: { link: MenuItemModifier; group: ModifierGroup }[]; onClose: () => void
}) {
  const save = useSaveMenuItem()
  const cats = useMenuCategories()
  const stock = useStockItems()
  const [name, setName] = useState(item.name)
  const [description, setDescription] = useState(item.description ?? '')
  const [category, setCategory] = useState(item.category_id)
  const [price, setPrice] = useState(item.price != null ? item.price.toFixed(2) : '')
  const [sizeRows, setSizeRows] = useState(sizes.map((s) => ({ id: s.id, name: s.name, price: s.price.toFixed(2), active: s.active })))
  const [gstFree, setGstFree] = useState(item.gst_free)
  const [active, setActive] = useState(item.active)
  const [stockItem, setStockItem] = useState(item.stock_item_id ?? '')
  const hasSizes = sizes.length > 0
  const valid = name.trim() !== '' && (hasSizes || price.trim() !== '')

  async function submit() {
    if (!valid) return
    await save.mutateAsync({
      item: {
        id: item.id, name: name.trim(), description: description.trim() || null, category_id: category,
        price: hasSizes ? null : parseMoney(price), gst_free: gstFree, active, stock_item_id: stockItem || null,
      },
      sizes: sizeRows.map((s) => ({ id: s.id, price: parseMoney(s.price), active: s.active })),
    })
    onClose()
  }

  return (
    <Drawer title={item.name} sub={item.plu ? `Till code ${item.plu}` : undefined} onClose={onClose} onSubmit={submit}
      footer={<>
        <button type="button" className="btn" onClick={onClose}>Cancel</button>
        <button className="btn btn-primary" disabled={!valid || save.isPending}>{save.isPending ? 'Saving…' : 'Save item'}</button>
      </>}>
      <ErrorBox error={save.error} />
      <Field label="Name"><input className="field" value={name} onChange={(e) => setName(e.target.value)} required /></Field>
      <Field label="Description" hint="Shown under the name on the till.">
        <input className="field" value={description} onChange={(e) => setDescription(e.target.value)} />
      </Field>
      <Field label="Category">
        <select className="field" value={category} onChange={(e) => setCategory(e.target.value)}>
          {(cats.data ?? []).map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
        </select>
      </Field>
      {hasSizes ? (
        <div>
          <div className="mb-2 text-[13px] font-medium text-ink-2">Sizes</div>
          <div className="flex flex-col gap-2">
            {sizeRows.map((s, k) => (
              <div key={s.id} className="flex items-center gap-2.5">
                <span className="flex-1 text-sm">{s.name}</span>
                <MoneyInput size="sm" className="w-28" value={s.price} aria-label={`${s.name} price`}
                  onChange={(v) => setSizeRows(sizeRows.map((r, j) => (j === k ? { ...r, price: v } : r)))} />
                <label className="flex items-center gap-1.5 text-[13px] text-ink-2">
                  <input type="checkbox" className="h-4 w-4 accent-[var(--accent)]" checked={s.active}
                    onChange={(e) => setSizeRows(sizeRows.map((r, j) => (j === k ? { ...r, active: e.target.checked } : r)))} />
                  Sold
                </label>
              </div>
            ))}
          </div>
          <p className="mt-1.5 text-xs text-muted">The size chosen replaces the price; it isn’t added to it.</p>
        </div>
      ) : (
        <Field label="Price" hint="GST included.">
          <MoneyInput size="sm" value={price} onChange={setPrice} aria-label="Price" />
        </Field>
      )}
      {asks.length > 0 && (
        <div>
          <div className="mb-2 text-[13px] font-medium text-ink-2">Asks</div>
          <ul className="space-y-1 text-sm">
            {asks.map(({ link, group }) => {
              const l = limits(link, group)
              return <li key={group.id}>{group.name} <span className="text-muted">· {ruleLabel(l.min, l.max, l.repeat)}</span></li>
            })}
          </ul>
        </div>
      )}
      <Field label="Catalogue product" hint="Only for things sold as bought, like a can of drink, so their sales count against stock.">
        <select className="field" value={stockItem} onChange={(e) => setStockItem(e.target.value)}>
          <option value="">None</option>
          {(stock.data ?? []).filter((s) => s.active || s.id === stockItem).map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
        </select>
      </Field>
      <label className="flex items-center gap-2.5 text-sm">
        <input type="checkbox" className="h-4 w-4 accent-[var(--accent)]" checked={gstFree} onChange={(e) => setGstFree(e.target.checked)} />
        GST-free (fresh, uncooked food)
      </label>
      <label className="flex items-center gap-2.5 text-sm">
        <input type="checkbox" className="h-4 w-4 accent-[var(--accent)]" checked={active} onChange={(e) => setActive(e.target.checked)} />
        Show on the till
      </label>
    </Drawer>
  )
}

function Options() {
  const groups = useModifierGroups()
  const options = useModifierOptions()
  const links = useMenuItemModifiers()
  const [editing, setEditing] = useState<ModifierGroup | null>(null)
  if (groups.isLoading || options.isLoading) return <Loading />
  const list = groups.data ?? []
  const optionsOf = (id: string) => (options.data ?? []).filter((o) => o.group_id === id)
  const usedBy = (id: string) => (links.data ?? []).filter((l) => l.group_id === id).length

  if (list.length === 0) return <div className="card px-4 py-10 text-center text-sm text-muted">No option groups yet. They come with an imported menu.</div>

  return (
    <>
      <section className="card overflow-hidden">
        {list.map((g) => {
          const opts = optionsOf(g.id)
          return (
            <button key={g.id} type="button" onClick={() => setEditing(g)}
              className="flex w-full items-start gap-3 border-t border-line-2 px-3.5 py-3 text-left first:border-t-0 hover:bg-hover desk:px-5">
              <div className="min-w-0 flex-1">
                <div className="font-medium">{g.name}</div>
                <div className="mt-0.5 text-[13px] text-muted">
                  {opts.filter((o) => o.active).map((o) => (o.price ? `${o.name} +${aud(o.price)}` : o.name)).join(' · ')}
                </div>
              </div>
              <div className="shrink-0 text-right text-xs text-muted">
                <div>{ruleLabel(g.min_choices, g.max_choices, g.repeat)}</div>
                <div className="num">{usedBy(g.id)} {usedBy(g.id) === 1 ? 'item' : 'items'}</div>
              </div>
            </button>
          )
        })}
      </section>
      {editing && <GroupDrawer key={editing.id} group={editing} options={optionsOf(editing.id)} onClose={() => setEditing(null)} />}
    </>
  )
}

/** A group's own rule, and its answers' names and prices. Items that ask it differently keep their own limits. */
function GroupDrawer({ group, options, onClose }: { group: ModifierGroup; options: ModifierOption[]; onClose: () => void }) {
  const saveGroup = useSave('modifier_groups')
  const saveOption = useSave('modifier_options')
  const [name, setName] = useState(group.name)
  const [min, setMin] = useState(String(group.min_choices))
  const [max, setMax] = useState(String(group.max_choices))
  const [rows, setRows] = useState(options.map((o) => ({ id: o.id, name: o.name, price: o.price ? o.price.toFixed(2) : '', active: o.active })))
  const lo = Math.max(0, Math.round(Number(min) || 0))
  const hi = Math.max(1, Math.round(Number(max) || 1))
  const valid = name.trim() !== '' && lo <= hi && rows.every((r) => r.name.trim() !== '')
  const busy = saveGroup.isPending || saveOption.isPending

  async function submit() {
    if (!valid) return
    await saveGroup.mutateAsync({ id: group.id, name: name.trim(), min_choices: lo, max_choices: hi })
    const before = new Map(options.map((o) => [o.id, o]))
    for (const r of rows) {
      const o = before.get(r.id)!
      const price = r.price.trim() === '' ? 0 : parseMoney(r.price)
      if (o.name !== r.name.trim() || o.price !== price || o.active !== r.active) {
        await saveOption.mutateAsync({ id: r.id, name: r.name.trim(), price, active: r.active })
      }
    }
    onClose()
  }

  return (
    <Drawer title={group.name} sub="Changes apply to every item that asks this." onClose={onClose} onSubmit={submit}
      footer={<>
        <button type="button" className="btn" onClick={onClose}>Cancel</button>
        <button className="btn btn-primary" disabled={!valid || busy}>{busy ? 'Saving…' : 'Save options'}</button>
      </>}>
      <ErrorBox error={saveGroup.error ?? saveOption.error} />
      <Field label="Name"><input className="field" value={name} onChange={(e) => setName(e.target.value)} required /></Field>
      <div className="grid grid-cols-2 gap-3">
        <Field label="At least" hint="0 makes it optional.">
          <input className="field num" inputMode="numeric" value={min} onChange={(e) => setMin(e.target.value)} />
        </Field>
        <Field label="At most"><input className="field num" inputMode="numeric" value={max} onChange={(e) => setMax(e.target.value)} /></Field>
      </div>
      <div>
        <div className="mb-2 text-[13px] font-medium text-ink-2">Answers</div>
        <div className="flex flex-col gap-2">
          {rows.map((r, k) => (
            <div key={r.id} className="flex items-center gap-2.5">
              <input className="field min-w-0 flex-1" value={r.name} aria-label="Answer"
                onChange={(e) => setRows(rows.map((x, j) => (j === k ? { ...x, name: e.target.value } : x)))} />
              <MoneyInput size="sm" className="w-24" value={r.price} placeholder="0.00" aria-label={`${r.name} extra charge`}
                onChange={(v) => setRows(rows.map((x, j) => (j === k ? { ...x, price: v } : x)))} />
              <label className="flex items-center gap-1.5 text-[13px] text-ink-2">
                <input type="checkbox" className="h-4 w-4 accent-[var(--accent)]" checked={r.active}
                  onChange={(e) => setRows(rows.map((x, j) => (j === k ? { ...x, active: e.target.checked } : x)))} />
                Offer
              </label>
            </div>
          ))}
        </div>
        <p className="mt-1.5 text-xs text-muted">The amount is added to the item’s price. Leave it empty for no charge.</p>
      </div>
    </Drawer>
  )
}
