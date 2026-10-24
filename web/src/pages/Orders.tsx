import { useState, type ReactNode } from 'react'
import { Link, useNavigate } from 'react-router-dom'
import { useDuplicateOrder, usePurchaseOrders, useSuppliers } from '../lib/api'
import { addDays, fmtShort, toDate, todayStr, weekStart } from '../lib/dates'
import { aud, cents } from '../lib/format'
import { PO_STATUS, PO_STATUS_LABEL, PO_STATUS_TONE } from '../lib/purchasing'
import type { PoStatus, PurchaseOrderTotal } from '../lib/types'
import { Empty, ErrorBox, Loading, PageHeader, Pill, Segmented } from '../components/ui'

export function StatusPill({ status, children }: { status: PoStatus; children?: ReactNode }) {
  return <Pill tone={PO_STATUS_TONE[status]}>{PO_STATUS_LABEL[status]}{children}</Pill>
}

const fDay = new Intl.DateTimeFormat('en-AU', { timeZone: 'UTC', weekday: 'short', day: 'numeric', month: 'short' })
const day = (s: string) => fDay.format(toDate(s))

/** The day an order belongs to: when it arrived once received, otherwise when it was raised. */
const orderDay = (o: PurchaseOrderTotal) => (o.status === 'received' && o.received_on ? o.received_on : o.ordered_on)

/** Each supplier keeps one colour on its tile, picked from its id so it never changes. */
const AVATAR = ['#D92D20', '#1570EF', '#079455', '#DC6803', '#7A5AF8', '#DD2590']
const avatarColour = (id: string) => AVATAR[[...id].reduce((h, c) => (h * 31 + c.charCodeAt(0)) >>> 0, 7) % AVATAR.length]
const initials = (name: string) => name.split(/[\s/]+/).filter(Boolean).slice(0, 2).map((w) => w[0]!.toUpperCase()).join('') || '?'

function SupplierTile({ id, name }: { id: string; name: string }) {
  const c = avatarColour(id)
  return (
    <span className="grid h-[34px] w-[34px] shrink-0 place-items-center rounded-lg text-xs font-semibold"
      style={{ color: c, background: `color-mix(in srgb, ${c} 12%, var(--surface))` }}>
      {initials(name)}
    </span>
  )
}

type StatusFilter = 'all' | PoStatus
// Written out in full (not built from a variable) so Tailwind sees both class names.
const COLS = 'grid-cols-[64px_minmax(0,1.6fr)_minmax(0,1fr)_110px_140px]'
const DESK_COLS = 'desk:grid-cols-[64px_minmax(0,1.6fr)_minmax(0,1fr)_110px_140px]'

export default function Orders() {
  const nav = useNavigate()
  const [status, setStatus] = useState<StatusFilter>('all')
  const [supplierId, setSupplierId] = useState('')
  // Every order once; the filters and the figures at the top are worked out from it here.
  const orders = usePurchaseOrders()
  const suppliers = useSuppliers()
  const duplicate = useDuplicateOrder()

  const supplierName = (id: string) => suppliers.data?.find((s) => s.id === id)?.name ?? '—'
  const all = orders.data ?? []
  const shown = all
    .filter((o) => (status === 'all' || o.status === status) && (!supplierId || o.supplier_id === supplierId))
    .sort((a, b) => orderDay(b).localeCompare(orderDay(a)) || b.po_number - a.po_number)

  // Grouped Monday to Sunday, newest week first.
  const thisWeek = weekStart(todayStr())
  const groups: { week: string; orders: PurchaseOrderTotal[] }[] = []
  for (const o of shown) {
    const w = weekStart(orderDay(o))
    const g = groups[groups.length - 1]
    if (g?.week === w) g.orders.push(o)
    else groups.push({ week: w, orders: [o] })
  }
  const groupLabel = (w: string) => {
    const range = `${fmtShort(w)} – ${fmtShort(addDays(w, 6))}`
    return w === thisWeek ? `This week · ${range}` : w === addDays(thisWeek, -7) ? `Last week · ${range}` : `Week of ${range}`
  }

  const received = all.filter((o) => o.status === 'received' && o.received_on)
  const receivedFrom = (from: string, to = addDays(thisWeek, 6)) =>
    cents(received.filter((o) => o.received_on! >= from && o.received_on! <= to).reduce((s, o) => s + o.total, 0))
  const last4 = receivedFrom(addDays(thisWeek, -21))
  const sent = all.filter((o) => o.status === 'sent')
  const drafts = all.filter((o) => o.status === 'draft')
  const sum = (os: PurchaseOrderTotal[]) => cents(os.reduce((s, o) => s + o.total, 0))

  const act = (o: PurchaseOrderTotal) => {
    if (o.status === 'sent') return <Link to={`/orders/${o.id}`} className="btn btn-primary btn-sm h-8">Receive</Link>
    if (o.status === 'draft') return <Link to={`/orders/${o.id}`} className="btn btn-sm h-8">Continue</Link>
    return (
      <button type="button" className="btn btn-sm h-8" disabled={duplicate.isPending}
        onClick={async () => nav(`/orders/${(await duplicate.mutateAsync(o.id)).id}`)}>
        Order again
      </button>
    )
  }
  const meta = (o: PurchaseOrderTotal) => {
    const when = o.status === 'received' && o.received_on ? `Received ${day(o.received_on)}`
      : o.status === 'sent' ? `Sent ${day(o.ordered_on)}${o.expected_on ? ` · due ${day(o.expected_on)}` : ''}`
      : o.status === 'draft' ? `Started ${day(o.ordered_on)}`
      : `Ordered ${day(o.ordered_on)}`
    return `${when} · ${o.line_count} ${o.line_count === 1 ? 'item' : 'items'}`
  }

  return (
    <div>
      <PageHeader
        title="Purchase orders"
        subtitle="What you've ordered from each supplier. Receiving an order records the expense for you."
        action={
          <Link to="/orders/new" className="btn btn-primary">
            <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" aria-hidden><path d="M5 12h14M12 5v14" /></svg>
            New order
          </Link>
        }
      />

      <ErrorBox error={orders.error || duplicate.error} />
      {orders.isLoading ? <Loading /> : all.length === 0 ? (
        <Empty>
          No orders yet. <Link className="font-semibold text-accent" to="/orders/new">Raise the first one</Link> — add the
          things you buy in <Link className="font-semibold text-accent" to="/food/catalogue">Food → Catalogue</Link> first and they'll
          be there to pick from.
        </Empty>
      ) : (
        <>
          <div className="grid grid-cols-2 gap-3 desk:grid-cols-[repeat(auto-fit,minmax(180px,1fr))]">
            <Kpi label="Received this week" value={aud(receivedFrom(thisWeek))} note={`Last week ${aud(receivedFrom(addDays(thisWeek, -7), addDays(thisWeek, -1)))}`} />
            <Kpi label="Last 4 weeks" value={aud(last4)} note={`avg ${aud(cents(last4 / 4))} / week`} />
            <Kpi label="Awaiting delivery" value={aud(sum(sent))} note={`${sent.length} sent order${sent.length === 1 ? '' : 's'}`} />
            <Kpi label="Drafts" value={String(drafts.length)} note={drafts.length ? `${aud(sum(drafts))} not yet sent` : 'nothing pending'} />
          </div>

          <div className="card mt-4 overflow-hidden">
            <div className="flex flex-wrap items-center gap-2.5 border-b border-line p-3">
              <Segmented ariaLabel="Status" value={status} onChange={setStatus}
                options={[{ value: 'all', label: 'All' }, ...PO_STATUS]} />
              <select aria-label="Supplier" className="field !h-9 !w-auto !py-0 !text-[13px]" value={supplierId} onChange={(e) => setSupplierId(e.target.value)}>
                <option value="">Every supplier</option>
                {(suppliers.data ?? []).map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
              </select>
              <span className="num ml-auto text-[13px] text-muted">{shown.length} {shown.length === 1 ? 'order' : 'orders'}</span>
            </div>
            <div className={`hidden gap-4 border-b border-line bg-hover px-5 py-2.5 text-xs font-medium text-muted desk:grid ${COLS}`}>
              <span>Order</span><span>Supplier</span><span>Status</span><span className="text-right">Total</span><span />
            </div>
            {groups.map((g) => (
              <div key={g.week}>
                <div className="num flex items-center justify-between gap-3 border-b border-line-2 bg-[color-mix(in_srgb,var(--hover)_50%,var(--surface))] px-3.5 py-2 text-xs desk:px-5 desk:py-2.5">
                  <span className="font-semibold text-ink-2">{groupLabel(g.week)}</span>
                  <span className="text-muted">{g.orders.length} order{g.orders.length === 1 ? '' : 's'} · <strong className="font-semibold text-ink">{aud(sum(g.orders))}</strong></span>
                </div>
                {g.orders.map((o) => (
                  <div key={o.id} role="link" tabIndex={0} onClick={() => nav(`/orders/${o.id}`)} onKeyDown={(e) => e.key === 'Enter' && nav(`/orders/${o.id}`)}
                    className={`grid cursor-pointer grid-cols-[minmax(0,1fr)_auto] items-center gap-3 border-b border-line-2 px-3.5 py-3 hover:bg-hover desk:gap-4 desk:px-5 ${DESK_COLS}`}>
                    <span className="num hidden text-muted desk:block">#{o.po_number}</span>
                    <div className="flex min-w-0 items-center gap-3">
                      <SupplierTile id={o.supplier_id} name={supplierName(o.supplier_id)} />
                      <div className="min-w-0">
                        <div className="truncate font-semibold">{supplierName(o.supplier_id)}</div>
                        <div className="mt-0.5 truncate text-xs text-muted">{meta(o)}</div>
                        <span className="mt-1.5 inline-flex desk:hidden"><StatusPill status={o.status}> · #{o.po_number}</StatusPill></span>
                      </div>
                    </div>
                    <span className="hidden desk:block"><StatusPill status={o.status} /></span>
                    <span className="num text-right font-semibold">{aud(o.total)}</span>
                    <span className="hidden text-right desk:block" onClick={(e) => e.stopPropagation()}>{act(o)}</span>
                  </div>
                ))}
              </div>
            ))}
            {shown.length === 0 && <p className="py-10 text-center text-muted">No orders match these filters.</p>}
          </div>
        </>
      )}
    </div>
  )
}

function Kpi({ label, value, note }: { label: string; value: string; note: string }) {
  return (
    <div className="card min-w-0 p-3 desk:p-4">
      <div className="text-[13px] font-medium text-muted">{label}</div>
      <div className="num mt-1.5 text-xl font-semibold tracking-[-0.02em] desk:text-[26px] desk:leading-8">{value}</div>
      <div className="mt-1 truncate text-xs text-muted">{note}</div>
    </div>
  )
}
