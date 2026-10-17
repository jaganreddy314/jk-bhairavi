import { useMemo, useState } from 'react'
import { Link, useNavigate, useParams } from 'react-router-dom'
import {
  useAddOrderLines, useItemCosts, useOrderLines, usePurchaseOrder, useReceiveOrder, useRemove, useReopenOrder,
  useSave, useStockGroups, useStockItems, useSuppliers,
} from '../lib/api'
import { useBusiness } from '../lib/business'
import { PAID_VIA } from '../lib/categories'
import { fmtDay, todayStr } from '../lib/dates'
import { aud, parseMoney } from '../lib/format'
import { lineTotal, orderText, orderTotal, qtyStr } from '../lib/purchasing'
import type { ItemCost, PaidVia, PurchaseOrder, PurchaseOrderLine, StockGroup, StockItem, Supplier } from '../lib/types'
import { ItemPicker, PickSummary, pickedLines, type Picks } from '../components/catalogue'
import { DeleteButton, ErrorBox, Flash, Loading, PageHeader, Segmented } from '../components/ui'
import { StatusPill } from './Orders'

export default function OrderForm() {
  const { id } = useParams()
  const order = usePurchaseOrder(id)

  if (!id) return <NewOrder />
  if (order.isLoading) return <Loading />
  if (order.error || !order.data) return <div className="mx-auto max-w-2xl"><ErrorBox error={order.error ?? 'Order not found'} /></div>
  return <Editor order={order.data} />
}

/** Supplier and dates, then every item with a quantity box — the order is filled in one go. */
function NewOrder() {
  const nav = useNavigate()
  const suppliers = useSuppliers()
  const items = useStockItems()
  const groups = useStockGroups()
  const costs = useItemCosts()
  const save = useSave('purchase_orders')
  const addLines = useAddOrderLines()
  const [supplierId, setSupplierId] = useState('')
  const [orderedOn, setOrderedOn] = useState(todayStr())
  const [expectedOn, setExpectedOn] = useState('')
  const [picks, setPicks] = useState<Picks>({})

  const active = (suppliers.data ?? []).filter((s) => s.active)
  const supplier = active.find((s) => s.id === supplierId)
  const lines = pickedLines(picks)
  const busy = save.isPending || addLines.isPending

  async function create() {
    if (!supplierId) return
    const row = await save.mutateAsync({
      supplier_id: supplierId, status: 'draft', ordered_on: orderedOn, expected_on: expectedOn || null,
    })
    // The insert comes back as an array of the rows written.
    const created = (row as PurchaseOrder[] | null)?.[0]
    if (!created) return nav('/orders')
    if (lines.length) await addLines.mutateAsync(lines.map((l, i) => ({ ...l, purchase_order_id: created.id, sort: i })))
    nav(`/orders/${created.id}`)
  }

  return (
    <div className="mx-auto max-w-2xl">
      <PageHeader title="New order" action={<Link to="/orders" className="text-sm font-medium text-accent">All orders →</Link>} />
      <form className="card mb-4 grid gap-3 p-4 sm:grid-cols-3" onSubmit={(e) => { e.preventDefault(); create() }}>
        <ErrorBox error={save.error || addLines.error} />
        <div className="sm:col-span-3">
          <label className="label" htmlFor="supplier">Supplier</label>
          <select id="supplier" className="field" value={supplierId} required
            onChange={(e) => { setSupplierId(e.target.value); setPicks({}) }}>
            <option value="">— Choose —</option>
            {active.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
          </select>
          {active.length === 0 && (
            <p className="mt-1 text-xs text-muted">No suppliers yet — add them in <Link className="text-accent" to="/food/catalogue?tab=suppliers">Food → Catalogue</Link>.</p>
          )}
        </div>
        <div>
          <label className="label" htmlFor="ordered">Ordered</label>
          <input id="ordered" type="date" className="field" value={orderedOn} onChange={(e) => setOrderedOn(e.target.value)} required />
        </div>
        <div>
          <label className="label" htmlFor="expected">Delivery <span className="font-normal text-muted">(optional)</span></label>
          <input id="expected" type="date" className="field" value={expectedOn} min={orderedOn} onChange={(e) => setExpectedOn(e.target.value)} />
        </div>
      </form>

      {supplier && (
        <section className="card p-4">
          <h2 className="mb-3 font-semibold">What do you need?</h2>
          {items.isLoading || groups.isLoading ? <Loading /> : (
            <ItemPicker key={supplier.id} supplier={supplier} items={items.data ?? []} groups={groups.data ?? []} costs={costs.data ?? []}
              picks={picks} onChange={setPicks} />
          )}
          <PickSummary picks={picks}>
            <button type="button" className="btn btn-primary" disabled={busy} onClick={create}>
              {busy ? 'Creating…' : lines.length ? 'Create order' : 'Create empty order'}
            </button>
          </PickSummary>
        </section>
      )}
    </div>
  )
}

function Editor({ order }: { order: PurchaseOrder }) {
  const nav = useNavigate()
  const { business } = useBusiness()
  const suppliers = useSuppliers()
  const items = useStockItems()
  const groups = useStockGroups()
  const costs = useItemCosts()
  const lines = useOrderLines(order.id)
  const saveOrder = useSave('purchase_orders')
  const removeOrder = useRemove('purchase_orders')
  const receive = useReceiveOrder()
  const reopen = useReopenOrder()
  const [receiving, setReceiving] = useState(false)
  const [copied, setCopied] = useState(0)
  const [shareText, setShareText] = useState<string | null>(null)

  const locked = order.status === 'received' || order.status === 'cancelled'
  const rows = lines.data ?? []
  const total = orderTotal(rows)
  const supplier = suppliers.data?.find((s) => s.id === order.supplier_id)
  const itemById = useMemo(() => new Map((items.data ?? []).map((i) => [i.id, i])), [items.data])

  const text = () =>
    orderText({
      businessName: business?.name ?? '',
      supplierName: supplier?.name ?? '',
      poNumber: order.po_number,
      expectedOn: order.expected_on,
      note: order.note,
      total,
      lines: rows.map((l) => {
        const item = l.item_id ? itemById.get(l.item_id) : undefined
        return { qty: l.qty, unit: item?.unit ?? '', name: item?.name ?? l.description ?? '' }
      }),
    })

  async function copyOrder() {
    const t = text()
    try {
      await navigator.clipboard.writeText(t)
      setCopied(Date.now())
    } catch {
      // No clipboard permission (or an insecure origin): show it to copy by hand.
      setShareText(t)
    }
  }

  return (
    <div className="mx-auto max-w-2xl">
      <PageHeader
        title={`Order #${order.po_number}`}
        subtitle={
          <span className="flex flex-wrap items-center gap-2">
            {supplier?.name ?? '—'} <StatusPill status={order.status} />
          </span>
        }
        action={<Link to="/orders" className="text-sm font-medium text-accent">All orders →</Link>}
      />
      <ErrorBox error={lines.error || saveOrder.error || removeOrder.error || receive.error || reopen.error} />

      {order.status === 'received' && (
        <p className="mb-3 rounded-lg border border-good/40 bg-good/10 px-3 py-2 text-sm text-good">
          Received {order.received_on && fmtDay(order.received_on)} — recorded as a{' '}
          {order.expense_id ? <Link className="font-semibold underline" to={`/expenses/${order.expense_id}`}>{aud(total)} expense</Link> : 'expense'}
          , so it already counts toward the week's food cost.
        </p>
      )}

      <section className="card mb-4 p-4">
        <Header order={order} locked={locked} />
      </section>

      <section className="card mb-4 p-4">
        <h2 className="mb-1 font-semibold">What you're ordering</h2>
        {lines.isLoading ? (
          <Loading />
        ) : (
          <>
            <ul className="divide-y divide-line">
              {rows.map((l) => (
                <LineRow key={l.id} line={l} item={l.item_id ? itemById.get(l.item_id) : undefined} locked={locked} />
              ))}
            </ul>
            {rows.length === 0 && <p className="py-3 text-sm text-muted">Nothing on this order yet.</p>}
            {!locked && (
              <AddItems
                orderId={order.id}
                supplier={supplier}
                items={items.data ?? []}
                groups={groups.data ?? []}
                costs={costs.data ?? []}
                alreadyOn={new Set(rows.map((l) => l.item_id).filter(Boolean) as string[])}
                nextSort={rows.reduce((m, l) => Math.max(m, l.sort + 1), 0)}
                startOpen={rows.length === 0}
              />
            )}
            <p className="num mt-3 flex items-baseline justify-between border-t border-line pt-3 font-bold">
              <span>Total</span>
              <span>{aud(total)}</span>
            </p>
          </>
        )}
      </section>

      <section className="card p-4">
        <div className="flex flex-wrap items-center gap-2">
          {order.status === 'draft' && (
            <button type="button" className="btn btn-primary" disabled={!rows.length || saveOrder.isPending}
              onClick={() => saveOrder.mutate({ id: order.id, status: 'sent' })}>
              Mark as sent
            </button>
          )}
          <button type="button" className="btn" disabled={!rows.length} onClick={copyOrder}>Copy order</button>
          {(order.status === 'sent' || order.status === 'draft') && (
            <button type="button" className="btn btn-primary" disabled={!rows.length} onClick={() => setReceiving((v) => !v)}>
              Received it
            </button>
          )}
          {order.status === 'received' && (
            <button type="button" className="btn" disabled={reopen.isPending} onClick={() => reopen.mutate(order.id)}>
              {reopen.isPending ? 'Undoing…' : 'Undo receive'}
            </button>
          )}
          {order.status !== 'received' && order.status !== 'cancelled' && (
            <button type="button" className="btn" onClick={() => saveOrder.mutate({ id: order.id, status: 'cancelled' })}>
              Cancel order
            </button>
          )}
          {order.status === 'cancelled' && (
            <button type="button" className="btn" onClick={() => saveOrder.mutate({ id: order.id, status: 'draft' })}>
              Reopen as draft
            </button>
          )}
          <span className="ml-auto flex items-center gap-2">
            <Flash signal={copied}>Copied</Flash>
            {order.status !== 'received' && (
              <DeleteButton label="Delete order" busy={removeOrder.isPending}
                onConfirm={async () => { await removeOrder.mutateAsync(order.id); nav('/orders') }} />
            )}
          </span>
        </div>

        {receiving && order.status !== 'received' && (
          <ReceivePanel
            ordered={total}
            busy={receive.isPending}
            onCancel={() => setReceiving(false)}
            onConfirm={async (v) => {
              await receive.mutateAsync({ id: order.id, ...v })
              setReceiving(false)
            }}
          />
        )}

        {shareText && (
          <div className="mt-3">
            <label className="label" htmlFor="share">Copy this and send it to {supplier?.name}</label>
            <textarea id="share" className="field font-mono text-sm" rows={rows.length + 7} readOnly value={shareText}
              onFocus={(e) => e.currentTarget.select()} />
            <button type="button" className="btn btn-sm mt-2" onClick={() => setShareText(null)}>Done</button>
          </div>
        )}
      </section>
    </div>
  )
}

/** Dates and the note. Each field saves when you leave it. */
function Header({ order, locked }: { order: PurchaseOrder; locked: boolean }) {
  const save = useSave('purchase_orders')
  const field = (key: keyof PurchaseOrder, value: string) =>
    String(order[key] ?? '') === value ? undefined : save.mutate({ id: order.id, [key]: value || null })

  return (
    <div className="grid gap-3 sm:grid-cols-3">
      <div>
        <label className="label" htmlFor="h-ordered">Ordered</label>
        <input id="h-ordered" type="date" className="field" defaultValue={order.ordered_on} disabled={locked}
          onBlur={(e) => e.target.value && field('ordered_on', e.target.value)} />
      </div>
      <div>
        <label className="label" htmlFor="h-expected">Delivery</label>
        <input id="h-expected" type="date" className="field" defaultValue={order.expected_on ?? ''} disabled={locked}
          onBlur={(e) => field('expected_on', e.target.value)} />
      </div>
      <div>
        <label className="label" htmlFor="h-note">Note</label>
        <input id="h-note" className="field" defaultValue={order.note ?? ''} disabled={locked} placeholder="Leave at the back door…"
          onBlur={(e) => field('note', e.target.value)} />
      </div>
    </div>
  )
}

/** One line. Quantity and price save when you leave the box. */
function LineRow({ line, item, locked }: { line: PurchaseOrderLine; item: StockItem | undefined; locked: boolean }) {
  const save = useSave('purchase_order_lines')
  const remove = useRemove('purchase_order_lines')
  const name = item?.name ?? line.description ?? 'Item'

  return (
    <li className="flex flex-wrap items-center gap-x-3 gap-y-2 py-2.5">
      <span className="min-w-0 flex-1">
        <span className="block truncate font-medium">{name}</span>
        {!item && line.description && <span className="text-xs text-muted">one-off</span>}
      </span>
      {locked ? (
        <span className="num text-sm text-ink-2">{qtyStr(line.qty)} {item?.unit} × {aud(line.unit_cost)}</span>
      ) : (
        <>
          <span className="flex items-center gap-1">
            <input aria-label={`Quantity of ${name}`} className="field !w-20 !py-1.5 text-right" inputMode="decimal"
              defaultValue={qtyStr(line.qty)}
              onBlur={(e) => {
                const qty = parseMoney(e.target.value)
                if (qty > 0 && qty !== line.qty) save.mutate({ id: line.id, qty })
                else e.target.value = qtyStr(line.qty)
              }} />
            <span className="w-8 text-xs text-muted">{item?.unit}</span>
          </span>
          <input aria-label={`Price per ${item?.unit ?? 'unit'} of ${name}`} className="field !w-24 !py-1.5 text-right" inputMode="decimal"
            defaultValue={String(line.unit_cost)}
            onBlur={(e) => {
              const unit_cost = parseMoney(e.target.value)
              if (unit_cost !== line.unit_cost) save.mutate({ id: line.id, unit_cost })
            }} />
        </>
      )}
      <span className="num w-20 shrink-0 text-right font-semibold">{aud(lineTotal(line))}</span>
      {!locked && (
        <button type="button" className="btn btn-sm btn-danger shrink-0" aria-label={`Remove ${name}`}
          disabled={remove.isPending} onClick={() => remove.mutate(line.id)}>
          ×
        </button>
      )}
    </li>
  )
}

/** More from the catalogue (the same list as a new order), or a one-off line. */
function AddItems({
  orderId, supplier, items, groups, costs, alreadyOn, nextSort, startOpen,
}: {
  orderId: string
  supplier: Supplier | undefined
  items: StockItem[]
  groups: StockGroup[]
  costs: ItemCost[]
  alreadyOn: Set<string>
  nextSort: number
  startOpen: boolean
}) {
  const add = useAddOrderLines()
  const [mode, setMode] = useState<'closed' | 'items' | 'oneoff'>(startOpen ? 'items' : 'closed')
  const [picks, setPicks] = useState<Picks>({})
  const lines = pickedLines(picks)

  if (mode === 'closed')
    return (
      <div className="mt-3 flex flex-wrap gap-2">
        <button type="button" className="btn btn-sm" onClick={() => setMode('items')}>+ Add items</button>
        <button type="button" className="btn btn-sm" onClick={() => setMode('oneoff')}>+ One-off item</button>
      </div>
    )

  if (mode === 'oneoff') return <OneOffLine orderId={orderId} sort={nextSort} onDone={() => setMode('closed')} />

  return (
    <div className="mt-3 rounded-xl border border-line p-3">
      <ErrorBox error={add.error} />
      <ItemPicker supplier={supplier} items={items} groups={groups} costs={costs} exclude={alreadyOn} picks={picks} onChange={setPicks} />
      <PickSummary picks={picks}>
        <button type="button" className="btn" onClick={() => { setPicks({}); setMode('closed') }}>Close</button>
        <button type="button" className="btn btn-primary" disabled={!lines.length || add.isPending}
          onClick={async () => {
            await add.mutateAsync(lines.map((l, i) => ({ ...l, purchase_order_id: orderId, sort: nextSort + i })))
            setPicks({})
          }}>
          {add.isPending ? 'Adding…' : `Add ${lines.length || ''} to order`}
        </button>
      </PickSummary>
    </div>
  )
}

/** Something bought once that isn't worth adding to the catalogue. */
function OneOffLine({ orderId, sort, onDone }: { orderId: string; sort: number; onDone: () => void }) {
  const save = useSave('purchase_order_lines')
  const [description, setDescription] = useState('')
  const [qty, setQty] = useState('')
  const [cost, setCost] = useState('')
  const qtyNum = parseMoney(qty)
  const valid = qtyNum > 0 && description.trim() !== ''

  return (
    <form
      className="mt-3 grid gap-2 rounded-xl bg-surface-2 p-3 sm:grid-cols-[1fr_5rem_6rem_auto_auto] sm:items-end"
      onSubmit={async (e) => {
        e.preventDefault()
        if (!valid) return
        await save.mutateAsync({
          purchase_order_id: orderId, item_id: null, description: description.trim(), qty: qtyNum, unit_cost: parseMoney(cost), sort,
        })
        onDone()
      }}
    >
      <ErrorBox error={save.error} />
      <div>
        <label className="label" htmlFor="oo-what">What is it</label>
        <input id="oo-what" className="field" value={description} autoFocus onChange={(e) => setDescription(e.target.value)} />
      </div>
      <div>
        <label className="label" htmlFor="oo-qty">Qty</label>
        <input id="oo-qty" className="field" inputMode="decimal" placeholder="0" value={qty} onChange={(e) => setQty(e.target.value)} />
      </div>
      <div>
        <label className="label" htmlFor="oo-cost">Price each</label>
        <input id="oo-cost" className="field" inputMode="decimal" placeholder="0.00" value={cost} onChange={(e) => setCost(e.target.value)} />
      </div>
      <button className="btn btn-primary !py-2.5" disabled={!valid || save.isPending}>Add</button>
      <button type="button" className="btn !py-2.5" onClick={onDone}>Cancel</button>
    </form>
  )
}

/** Confirm what arrived. The total is editable, because invoices don't always match the order. */
function ReceivePanel({
  ordered, busy, onConfirm, onCancel,
}: {
  ordered: number
  busy: boolean
  onConfirm: (v: { received_on: string; total: number; paid_via: PaidVia }) => void
  onCancel: () => void
}) {
  const [date, setDate] = useState(todayStr())
  const [total, setTotal] = useState(String(ordered))
  const [paidVia, setPaidVia] = useState<PaidVia>('bank')
  const billed = parseMoney(total)

  return (
    <div className="mt-3 rounded-xl bg-surface-2 p-3">
      <p className="mb-3 text-sm text-ink-2">
        This records a food expense of the amount below, dated the day it arrived. Change the total if the invoice differs.
      </p>
      <div className="grid gap-3 sm:grid-cols-2">
        <div>
          <label className="label" htmlFor="r-date">Arrived</label>
          <input id="r-date" type="date" className="field" value={date} onChange={(e) => setDate(e.target.value)} />
        </div>
        <div>
          <label className="label" htmlFor="r-total">Invoice total</label>
          <input id="r-total" className="field" inputMode="decimal" value={total} onChange={(e) => setTotal(e.target.value)} />
          {billed !== ordered && (
            <p className="mt-1 text-xs text-muted">
              Ordered {aud(ordered)} — {billed > ordered ? 'up' : 'down'} {aud(Math.abs(billed - ordered))}.
            </p>
          )}
        </div>
      </div>
      <div className="mt-3">
        <span className="label">Paid via</span>
        <Segmented ariaLabel="Paid via" value={paidVia} onChange={setPaidVia} options={PAID_VIA} />
      </div>
      <div className="mt-3 flex gap-2">
        <button type="button" className="btn btn-primary" disabled={busy || billed < 0}
          onClick={() => onConfirm({ received_on: date, total: billed, paid_via: paidVia })}>
          {busy ? 'Saving…' : `Confirm — record ${aud(billed)}`}
        </button>
        <button type="button" className="btn" onClick={onCancel}>Cancel</button>
      </div>
    </div>
  )
}
