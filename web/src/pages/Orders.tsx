import { useState } from 'react'
import { Link, useNavigate } from 'react-router-dom'
import { useDuplicateOrder, usePurchaseOrders, useSuppliers } from '../lib/api'
import { fmtDay } from '../lib/dates'
import { aud } from '../lib/format'
import { PO_STATUS, PO_STATUS_CLASS, PO_STATUS_LABEL } from '../lib/purchasing'
import type { PoStatus } from '../lib/types'
import { Empty, ErrorBox, Loading, PageHeader } from '../components/ui'

export function StatusPill({ status }: { status: PoStatus }) {
  return (
    <span className={`shrink-0 rounded-full px-2 py-0.5 text-xs font-semibold ${PO_STATUS_CLASS[status]}`}>
      {PO_STATUS_LABEL[status]}
    </span>
  )
}

export default function Orders() {
  const nav = useNavigate()
  const [status, setStatus] = useState<'' | PoStatus>('')
  const [supplierId, setSupplierId] = useState('')
  const orders = usePurchaseOrders({ status: status || undefined, supplierId: supplierId || undefined })
  const suppliers = useSuppliers()
  const duplicate = useDuplicateOrder()

  const supplierName = (id: string) => suppliers.data?.find((s) => s.id === id)?.name ?? '—'

  return (
    <div>
      <PageHeader
        title="Purchase orders"
        subtitle="What you've ordered from each supplier. Receiving an order records the expense for you."
        action={<Link to="/orders/new" className="btn btn-primary btn-sm">+ New order</Link>}
      />

      <div className="mb-4 flex flex-wrap items-center gap-1.5">
        <button type="button" className="chip" aria-pressed={status === ''} onClick={() => setStatus('')}>All</button>
        {PO_STATUS.map((s) => (
          <button key={s.value} type="button" className="chip" aria-pressed={status === s.value} onClick={() => setStatus(s.value)}>
            {s.label}
          </button>
        ))}
        <select aria-label="Supplier" className="field !w-auto !py-1.5 !text-sm" value={supplierId} onChange={(e) => setSupplierId(e.target.value)}>
          <option value="">Every supplier</option>
          {(suppliers.data ?? []).map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
        </select>
      </div>

      <ErrorBox error={orders.error || duplicate.error} />
      {orders.isLoading ? (
        <Loading />
      ) : orders.data?.length === 0 ? (
        <Empty>
          {status || supplierId ? 'No orders match that filter.' : (
            <>
              No orders yet. <Link className="font-semibold text-accent" to="/orders/new">Raise the first one</Link> — add the
              things you buy in <Link className="font-semibold text-accent" to="/food/catalogue">Food → Catalogue</Link> first and they'll
              be there to pick from.
            </>
          )}
        </Empty>
      ) : (
        <ul className="card divide-y divide-line">
          {orders.data!.map((o) => (
            <li key={o.id} className="flex flex-wrap items-center gap-x-3 gap-y-1 px-4 py-3">
              <Link to={`/orders/${o.id}`} className="min-w-0 flex-1">
                <span className="flex flex-wrap items-center gap-2">
                  <span className="num text-sm font-semibold text-muted">#{o.po_number}</span>
                  <span className="truncate font-semibold">{supplierName(o.supplier_id)}</span>
                  <StatusPill status={o.status} />
                </span>
                <span className="mt-0.5 block text-xs text-muted">
                  {o.status === 'received' && o.received_on
                    ? `Received ${fmtDay(o.received_on)}`
                    : o.expected_on
                      ? `Ordered ${fmtDay(o.ordered_on)} · due ${fmtDay(o.expected_on)}`
                      : `Ordered ${fmtDay(o.ordered_on)}`}
                  {' · '}
                  {o.line_count} {o.line_count === 1 ? 'item' : 'items'}
                </span>
              </Link>
              <span className="num shrink-0 font-semibold">{aud(o.total)}</span>
              <button
                type="button"
                className="btn btn-sm shrink-0"
                disabled={duplicate.isPending}
                onClick={async () => {
                  const copy = await duplicate.mutateAsync(o.id)
                  nav(`/orders/${copy.id}`)
                }}
              >
                Order again
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  )
}
