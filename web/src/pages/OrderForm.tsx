import { useMemo, useState } from 'react'
import { Link, useNavigate, useParams } from 'react-router-dom'
import {
  useItemCosts, useOrderLines, usePurchaseOrder, useReceiveOrder, useRemove, useReopenOrder,
  useSave, useStockGroups, useStockItems, useSuppliers,
} from '../lib/api'
import { useBusiness } from '../lib/business'
import { PAID_VIA } from '../lib/categories'
import { fmtDay, todayStr } from '../lib/dates'
import { aud, parseMoney } from '../lib/format'
import { lineTotal, orderText, orderTotal, qtyStr } from '../lib/purchasing'
import type { PaidVia, PurchaseOrder, PurchaseOrderLine, StockItem } from '../lib/types'
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

/** Just the header: supplier and dates. The lines are added once the order exists. */
function NewOrder() {
  const nav = useNavigate()
  const suppliers = useSuppliers()
  const save = useSave('purchase_orders')
  const [supplierId, setSupplierId] = useState('')
  const [orderedOn, setOrderedOn] = useState(todayStr())
  const [expectedOn, setExpectedOn] = useState('')

  const active = (suppliers.data ?? []).filter((s) => s.active)

  return (
    <div className="mx-auto max-w-md">
      <PageHeader title="New order" action={<Link to="/orders" className="text-sm font-medium text-accent">All orders →</Link>} />
      <form
        className="card space-y-4 p-4"
        onSubmit={async (e) => {
          e.preventDefault()
          if (!supplierId) return
          const row = await save.mutateAsync({
            supplier_id: supplierId, status: 'draft', ordered_on: orderedOn, expected_on: expectedOn || null,
          })
          // The insert comes back as an array of the rows written.
          const created = (row as PurchaseOrder[] | null)?.[0]
          nav(created ? `/orders/${created.id}` : '/orders')
        }}
      >
        <ErrorBox error={save.error} />
        <div>
          <label className="label" htmlFor="supplier">Supplier</label>
          <select id="supplier" className="field" value={supplierId} onChange={(e) => setSupplierId(e.target.value)} required>
            <option value="">— Choose —</option>
            {active.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
          </select>
          {active.length === 0 && (
            <p className="mt-1 text-xs text-muted">No suppliers yet — add them in <Link className="text-accent" to="/settings#suppliers">Settings</Link>.</p>
          )}
        </div>
        <div className="grid grid-cols-2 gap-3">
          <div>
            <label className="label" htmlFor="ordered">Ordered</label>
            <input id="ordered" type="date" className="field" value={orderedOn} onChange={(e) => setOrderedOn(e.target.value)} required />
          </div>
          <div>
            <label className="label" htmlFor="expected">Delivery <span className="font-normal text-muted">(optional)</span></label>
            <input id="expected" type="date" className="field" value={expectedOn} min={orderedOn} onChange={(e) => setExpectedOn(e.target.value)} />
          </div>
        </div>
        <button className="btn btn-primary w-full" disabled={!supplierId || save.isPending}>
          {save.isPending ? 'Creating…' : 'Create order'}
        </button>
      </form>
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
              <AddLine
                orderId={order.id}
                supplierId={order.supplier_id}
                items={items.data ?? []}
                groups={groups.data ?? []}
                costs={costs.data ?? []}
                alreadyOn={new Set(rows.map((l) => l.item_id).filter(Boolean) as string[])}
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

/** Pick an item, say how much. The supplier's own items come first. */
function AddLine({
  orderId, supplierId, items, groups, costs, alreadyOn,
}: {
  orderId: string
  supplierId: string
  items: StockItem[]
  groups: { id: string; name: string; sort: number }[]
  costs: { item_id: string; unit_cost: number }[]
  alreadyOn: Set<string>
}) {
  const save = useSave('purchase_order_lines')
  const [itemId, setItemId] = useState('')
  const [description, setDescription] = useState('')
  const [qty, setQty] = useState('')
  const [cost, setCost] = useState('')
  const [costTouched, setCostTouched] = useState(false)

  const costOf = (id: string) => costs.find((c) => c.item_id === id)?.unit_cost ?? 0
  const chosen = items.find((i) => i.id === itemId)
  const shownCost = !costTouched && chosen ? String(costOf(chosen.id) || chosen.unit_cost || '') : cost
  const oneOff = itemId === '__other'

  // The supplier you're ordering from first, then everything else, grouped by section.
  const groupName = (id: string | null) => groups.find((g) => g.id === id)?.name ?? 'Other items'
  const selectable = items.filter((i) => i.active && !alreadyOn.has(i.id))
  const theirs = selectable.filter((i) => i.supplier_id === supplierId)
  const rest = selectable.filter((i) => i.supplier_id !== supplierId)
  const options = (list: StockItem[]) => {
    const byGroup = new Map<string, StockItem[]>()
    for (const i of [...list].sort((a, b) => a.name.localeCompare(b.name))) {
      const key = groupName(i.group_id)
      byGroup.set(key, [...(byGroup.get(key) ?? []), i])
    }
    return [...byGroup.entries()].sort((a, b) => a[0].localeCompare(b[0]))
  }

  const qtyNum = parseMoney(qty)
  const valid = qtyNum > 0 && (oneOff ? description.trim() !== '' : !!itemId)

  function reset() {
    setItemId('')
    setDescription('')
    setQty('')
    setCost('')
    setCostTouched(false)
  }

  return (
    <form
      className="mt-3 grid gap-2 rounded-xl bg-surface-2 p-3 sm:grid-cols-[1fr_5rem_6rem_auto] sm:items-end"
      onSubmit={async (e) => {
        e.preventDefault()
        if (!valid) return
        await save.mutateAsync({
          purchase_order_id: orderId,
          item_id: oneOff ? null : itemId,
          description: oneOff ? description.trim() : null,
          qty: qtyNum,
          unit_cost: parseMoney(shownCost),
        })
        reset()
      }}
    >
      <div className="sm:col-span-1">
        <label className="label" htmlFor="add-item">Item</label>
        <select id="add-item" className="field" value={itemId} onChange={(e) => { setItemId(e.target.value); setCostTouched(false) }}>
          <option value="">— Choose —</option>
          {theirs.length > 0 && (
            <optgroup label="Usually from this supplier">
              {theirs.sort((a, b) => a.name.localeCompare(b.name)).map((i) => <option key={i.id} value={i.id}>{i.name}</option>)}
            </optgroup>
          )}
          {options(rest).map(([g, list]) => (
            <optgroup key={g} label={g}>
              {list.map((i) => <option key={i.id} value={i.id}>{i.name}</option>)}
            </optgroup>
          ))}
          <option value="__other">Something else (one-off)…</option>
        </select>
        {oneOff && (
          <input aria-label="What is it" className="field mt-2" placeholder="What is it?" value={description}
            onChange={(e) => setDescription(e.target.value)} />
        )}
      </div>
      <div>
        <label className="label" htmlFor="add-qty">Qty{chosen ? ` (${chosen.unit})` : ''}</label>
        <input id="add-qty" className="field" inputMode="decimal" placeholder="0" value={qty} onChange={(e) => setQty(e.target.value)} />
      </div>
      <div>
        <label className="label" htmlFor="add-cost">Price each</label>
        <input id="add-cost" className="field" inputMode="decimal" placeholder="0.00" value={shownCost}
          onChange={(e) => { setCost(e.target.value); setCostTouched(true) }} />
      </div>
      <button className="btn btn-primary !py-2.5" disabled={!valid || save.isPending}>Add</button>
      {!oneOff && chosen && !costTouched && costOf(chosen.id) > 0 && (
        <p className="text-xs text-muted sm:col-span-4">Last paid {aud(costOf(chosen.id))} per {chosen.unit}.</p>
      )}
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
