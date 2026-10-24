import { useState } from 'react'
import { Link, useSearchParams } from 'react-router-dom'
import { useAddExpiry, useRemove, useSave, useStockGroups, useStockItems } from '../lib/api'
import { usePerms } from '../lib/access'
import { fmtDay, fmtShort } from '../lib/dates'
import { parseMoney } from '../lib/format'
import { qtyStr } from '../lib/purchasing'
import type { BatchState, BatchStatus, StockBatch, StockGroup, StockItem, StockLevel } from '../lib/types'
import { useStockAlerts } from '../components/alerts'
import { DeleteButton, Drawer, Empty, ErrorBox, Field, Loading, PageHeader, Pill, SearchBox, Segmented, type PillTone } from '../components/ui'

type Tab = 'expiring' | 'low' | 'dates'

const STATE: Record<BatchState, { label: string; tone: PillTone }> = {
  expired: { label: 'Expired', tone: 'danger' },
  due: { label: 'Put on clearance', tone: 'warn' },
  on_clearance: { label: 'On clearance', tone: 'info' },
  upcoming: { label: 'Not due yet', tone: 'neutral' },
}

/** "Expires today", "3 days left", "Expired 2 days ago". */
function daysLeft(n: number) {
  if (n === 0) return 'expires today'
  if (n > 0) return `${n} ${n === 1 ? 'day' : 'days'} left`
  return `expired ${-n} ${n === -1 ? 'day' : 'days'} ago`
}

/**
 * Stock that needs doing something about today: expiry dates coming up to their clearance
 * window or past it, and products running below their minimum.
 */
export default function StockAlerts() {
  const [params, setParams] = useSearchParams()
  const raw = params.get('tab')
  const tab: Tab = raw === 'low' || raw === 'dates' ? raw : 'expiring'
  // ?log=<product> opens the expiry drawer on that product (from the catalogue).
  const logFor = params.get('log')
  const [logging, setLogging] = useState<string | 'new' | null>(logFor)
  const { can } = usePerms()
  const canAct = can('stock')
  const alerts = useStockAlerts()
  const items = useStockItems()
  const groups = useStockGroups()

  const closeLog = () => {
    setLogging(null)
    if (logFor) setParams(tab === 'expiring' ? {} : { tab }, { replace: true })
  }

  if (alerts.isLoading || items.isLoading || groups.isLoading) return <Loading />

  const itemList = items.data ?? []
  const groupList = groups.data ?? []
  const all = alerts.batches.data ?? []

  return (
    <div>
      <PageHeader
        title="Stock alerts"
        subtitle="What to put on clearance before it expires, and what's running low. Checked fresh every day."
        action={canAct && (
          <button type="button" className="btn btn-primary" onClick={() => setLogging('new')}>
            <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" aria-hidden><path d="M5 12h14M12 5v14" /></svg>
            Log expiry dates
          </button>
        )}
      />
      <ErrorBox error={alerts.error} />
      <div className="mb-4">
        <Segmented
          ariaLabel="Alerts"
          value={tab}
          onChange={(t) => setParams(t === 'expiring' ? {} : { tab: t }, { replace: true })}
          options={[
            { value: 'expiring', label: `Expiring${alerts.expiring.length ? ` · ${alerts.expiring.length}` : ''}` },
            { value: 'low', label: `Low stock${alerts.low.length ? ` · ${alerts.low.length}` : ''}` },
            { value: 'dates', label: 'All dates' },
          ]}
        />
      </div>

      {tab === 'expiring' && <Expiring batches={alerts.expiring} items={itemList} canAct={canAct} upcoming={all.length - alerts.expiring.length} />}
      {tab === 'low' && <LowStock levels={alerts.levels.data ?? []} items={itemList} groups={groupList} canOrder={can('purchasing')} />}
      {tab === 'dates' && <AllDates batches={all} items={itemList} canAct={canAct} />}

      {logging && (
        <ExpiryDrawer items={itemList} groups={groupList} batches={all}
          initial={logging === 'new' ? null : logging} onClose={closeLog} />
      )}
    </div>
  )
}

function Expiring({ batches, items, canAct, upcoming }: { batches: StockBatch[]; items: StockItem[]; canAct: boolean; upcoming: number }) {
  if (!batches.length)
    return (
      <Empty>
        Nothing to clear today.
        {upcoming > 0 && <> {upcoming} {upcoming === 1 ? 'date is' : 'dates are'} logged and not due yet — see <Link className="font-semibold text-accent" to="/alerts?tab=dates">All dates</Link>.</>}
      </Empty>
    )
  const order: BatchState[] = ['expired', 'due', 'on_clearance']
  return (
    <div className="grid gap-4">
      {order.map((state) => {
        const rows = batches.filter((b) => b.state === state)
        if (!rows.length) return null
        return (
          <section key={state} className="card overflow-hidden">
            <div className="flex items-center gap-2 border-b border-line px-3.5 py-3 desk:px-5">
              <Pill tone={STATE[state].tone}>{STATE[state].label}</Pill>
              <span className="num text-xs text-muted">{rows.length}</span>
              <span className="ml-auto hidden text-xs text-muted desk:block">
                {state === 'expired' ? 'Past the date: take it off the shelf.'
                  : state === 'due' ? 'Inside the clearance window: mark it down.'
                  : 'Marked down. Mark it sold out when it’s gone.'}
              </span>
            </div>
            <ul className="divide-y divide-line-2">
              {rows.map((b) => <BatchRow key={b.id} batch={b} item={items.find((i) => i.id === b.item_id)} canAct={canAct} />)}
            </ul>
          </section>
        )
      })}
    </div>
  )
}

/** One expiry date, with the one or two things you'd do about it next. */
function BatchRow({ batch: b, item, canAct, showState }: { batch: StockBatch; item: StockItem | undefined; canAct: boolean; showState?: boolean }) {
  const save = useSave('stock_batches')
  const [editing, setEditing] = useState(false)
  const set = (status: BatchStatus) => save.mutate({ id: b.id, status })
  const actions: { status: BatchStatus; label: string; primary?: boolean }[] =
    b.state === 'due' ? [{ status: 'on_clearance', label: 'On clearance', primary: true }, { status: 'cleared', label: 'Sold out' }]
      : b.state === 'on_clearance' ? [{ status: 'cleared', label: 'Sold out', primary: true }, { status: 'written_off', label: 'Write off' }]
      : b.state === 'expired' ? [{ status: 'written_off', label: 'Write off', primary: true }, { status: 'cleared', label: 'Sold out' }]
      : [{ status: 'cleared', label: 'Sold out' }]
  return (
    <li className="flex flex-wrap items-center gap-x-3 gap-y-2 px-3.5 py-3 desk:px-5">
      <button type="button" className="min-w-0 flex-1 text-left" onClick={() => canAct && setEditing(true)} disabled={!canAct}>
        <span className="flex flex-wrap items-center gap-2">
          <span className="font-medium">{item?.name ?? 'Product'}</span>
          {showState && <Pill tone={STATE[b.state].tone}>{STATE[b.state].label}</Pill>}
        </span>
        <span className="num mt-0.5 block text-xs text-muted">
          {b.qty != null && `${qtyStr(b.qty)} ${item?.unit ?? ''} · `}
          expires {fmtDay(b.expires_on)} · <span className={b.days_left < 0 ? 'font-semibold text-bad' : ''}>{daysLeft(b.days_left)}</span>
          {b.state === 'upcoming' && ` · clearance from ${fmtShort(b.alert_from)}`}
          {b.note && ` · ${b.note}`}
        </span>
      </button>
      {canAct && (
        <span className="flex gap-1.5">
          {actions.map((a) => (
            <button key={a.status} type="button" className={`btn btn-sm ${a.primary ? 'btn-primary' : ''}`} disabled={save.isPending} onClick={() => set(a.status)}>
              {a.label}
            </button>
          ))}
        </span>
      )}
      {save.error && <div className="w-full"><ErrorBox error={save.error} /></div>}
      {editing && <BatchDrawer batch={b} item={item} onClose={() => setEditing(false)} />}
    </li>
  )
}

function LowStock({ levels, items, groups, canOrder }: { levels: StockLevel[]; items: StockItem[]; groups: StockGroup[]; canOrder: boolean }) {
  const byId = new Map(items.map((i) => [i.id, i]))
  const groupName = (i: StockItem | undefined) => groups.find((g) => g.id === i?.group_id)?.name
  // Furthest below its minimum first.
  const low = levels.filter((l) => l.on_hand != null && l.on_hand <= l.min_stock)
    .sort((a, b) => a.on_hand! / (a.min_stock || 1) - b.on_hand! / (b.min_stock || 1))
  const uncounted = levels.filter((l) => l.on_hand == null)

  if (!levels.length)
    return (
      <Empty>
        No minimums set yet. Set one on a category (Drinks: 12) or a product in{' '}
        <Link className="font-semibold text-accent" to="/food/catalogue">Catalogue</Link>.
      </Empty>
    )
  return (
    <>
      {low.length === 0 ? (
        <Empty>Nothing is below its minimum. {levels.length - uncounted.length} products are being watched.</Empty>
      ) : (
        <section className="card overflow-hidden">
          <div className="flex flex-wrap items-center gap-2 border-b border-line px-3.5 py-3 desk:px-5">
            <span className="flex-1 font-semibold">At or below minimum</span>
            {canOrder && <Link to="/orders/new" className="btn btn-sm">New order</Link>}
          </div>
          <ul className="divide-y divide-line-2">
            {low.map((l) => {
              const i = byId.get(l.item_id)
              return (
                <li key={l.item_id} className="grid grid-cols-[minmax(0,1fr)_auto] items-center gap-3 px-3.5 py-3 desk:px-5">
                  <span className="min-w-0">
                    <span className="block font-medium">{i?.name}</span>
                    <span className="block text-xs text-muted">
                      {groupName(i) ?? 'No category'} · counted {fmtShort(l.counted_on!)}
                    </span>
                  </span>
                  <span className="num text-right">
                    <span className={`block font-semibold ${l.on_hand! <= 0 ? 'text-bad' : ''}`}>{qtyStr(Math.max(0, l.on_hand!))} {i?.unit}</span>
                    <span className="block text-xs text-muted">min {qtyStr(l.min_stock)}</span>
                  </span>
                </li>
              )
            })}
          </ul>
        </section>
      )}
      {uncounted.length > 0 && (
        <p className="mt-3 text-sm text-muted">
          {uncounted.length} {uncounted.length === 1 ? 'product has' : 'products have'} a minimum but{' '}
          {uncounted.length === 1 ? 'hasn’t' : 'haven’t'} been in a finished count yet, so there's nothing to estimate from:{' '}
          {uncounted.slice(0, 6).map((l) => byId.get(l.item_id)?.name).join(', ')}{uncounted.length > 6 ? '…' : ''}.
        </p>
      )}
      <p className="mt-3 text-xs text-muted">
        Stock on hand is estimated: the last finished count, plus orders received since, less item sales since. Sales imported
        weekly make it run high until the week is in, so a fresh count is the surest figure.
      </p>
    </>
  )
}

function AllDates({ batches, items, canAct }: { batches: StockBatch[]; items: StockItem[]; canAct: boolean }) {
  const [q, setQ] = useState('')
  const needle = q.trim().toLowerCase()
  const nameOf = (id: string) => items.find((i) => i.id === id)?.name ?? ''
  const shown = batches.filter((b) => !needle || nameOf(b.item_id).toLowerCase().includes(needle))
  if (!batches.length)
    return <Empty>No expiry dates logged yet. When you check dates on a delivery or on the shelf, log them here.</Empty>
  return (
    <section className="card overflow-hidden">
      <div className="border-b border-line px-3.5 py-3 desk:px-5">
        <SearchBox value={q} onChange={setQ} placeholder={`Search ${batches.length} dates`} />
      </div>
      {shown.length === 0 && <p className="py-8 text-center text-sm text-muted">No dates match.</p>}
      <ul className="divide-y divide-line-2">
        {shown.map((b) => <BatchRow key={b.id} batch={b} item={items.find((i) => i.id === b.item_id)} canAct={canAct} showState />)}
      </ul>
    </section>
  )
}

/** Change or remove one logged date: a wrong date, a recount, or undoing a tap. */
function BatchDrawer({ batch, item, onClose }: { batch: StockBatch; item: StockItem | undefined; onClose: () => void }) {
  const save = useSave('stock_batches')
  const remove = useRemove('stock_batches')
  const [expires, setExpires] = useState(batch.expires_on)
  const [qty, setQty] = useState(batch.qty != null ? qtyStr(batch.qty) : '')
  const [status, setStatus] = useState<BatchStatus>(batch.status)
  const [note, setNote] = useState(batch.note ?? '')

  async function submit() {
    if (!expires) return
    await save.mutateAsync({
      id: batch.id, expires_on: expires, status, note: note.trim() || null,
      qty: qty.trim() === '' || parseMoney(qty) <= 0 ? null : parseMoney(qty),
    })
    onClose()
  }

  return (
    <Drawer title={item?.name ?? 'Expiry date'} sub={`Logged ${fmtShort(batch.checked_on)}`} onClose={onClose} onSubmit={submit}
      footer={<>
        <span className="mr-auto"><DeleteButton busy={remove.isPending} onConfirm={async () => { await remove.mutateAsync(batch.id); onClose() }} /></span>
        <button type="button" className="btn" onClick={onClose}>Cancel</button>
        <button className="btn btn-primary" disabled={!expires || save.isPending}>{save.isPending ? 'Saving…' : 'Save'}</button>
      </>}>
      <ErrorBox error={save.error || remove.error} />
      <div className="grid grid-cols-2 gap-3">
        <Field label="Expires"><input type="date" className="field" value={expires} onChange={(e) => setExpires(e.target.value)} required /></Field>
        <Field label={`How many${item ? ` (${item.unit})` : ''}`}>
          <input className="field num" inputMode="decimal" placeholder="Not counted" value={qty} onChange={(e) => setQty(e.target.value)} />
        </Field>
      </div>
      <Field label="Status">
        <select className="field" value={status} onChange={(e) => setStatus(e.target.value as BatchStatus)}>
          <option value="active">On the shelf</option>
          <option value="on_clearance">On clearance</option>
          <option value="cleared">Sold out</option>
          <option value="written_off">Written off</option>
        </select>
      </Field>
      <Field label="Note"><input className="field" value={note} onChange={(e) => setNote(e.target.value)} placeholder="Back of the fridge…" /></Field>
      <p className="text-xs text-muted">Clearance alerts start {batch.clearance_days} days before the date. Change that on the product or its category.</p>
    </Drawer>
  )
}

interface DateRow { expires: string; qty: string }

/**
 * Log the dates found on one product: pick it, then one line per expiry date. Saving the same
 * date as one already logged adds to it.
 */
function ExpiryDrawer({ items, groups, batches, initial, onClose }: {
  items: StockItem[]; groups: StockGroup[]; batches: StockBatch[]; initial: string | null; onClose: () => void
}) {
  const add = useAddExpiry()
  const [itemId, setItemId] = useState(initial)
  const [q, setQ] = useState('')
  const [rows, setRows] = useState<DateRow[]>([{ expires: '', qty: '' }])
  const [note, setNote] = useState('')
  const [saved, setSaved] = useState<string[]>([])

  const item = items.find((i) => i.id === itemId)
  const group = groups.find((g) => g.id === item?.group_id)
  const clearance = item?.clearance_days ?? group?.clearance_days ?? 7
  const open = batches.filter((b) => b.item_id === itemId)
  const needle = q.trim().toLowerCase()
  const matches = needle ? items.filter((i) => i.active && i.name.toLowerCase().includes(needle)).slice(0, 8) : []
  const ready = rows.filter((r) => r.expires)

  const setRow = (n: number, patch: Partial<DateRow>) => setRows(rows.map((r, i) => (i === n ? { ...r, ...patch } : r)))

  async function submit() {
    if (!item || !ready.length) return
    for (const r of ready)
      await add.mutateAsync({ itemId: item.id, expiresOn: r.expires, qty: parseMoney(r.qty) > 0 ? parseMoney(r.qty) : null, note: note.trim() || undefined })
    // Stay open for the next product: checking dates is usually a walk along a shelf.
    setSaved([item.name, ...saved])
    setItemId(null)
    setQ('')
    setRows([{ expires: '', qty: '' }])
    setNote('')
  }

  return (
    <Drawer title="Log expiry dates" sub="One line per date found on the product." onClose={onClose} onSubmit={submit}
      footer={<>
        <button type="button" className="btn" onClick={onClose}>{saved.length ? 'Done' : 'Cancel'}</button>
        <button className="btn btn-primary" disabled={!item || !ready.length || add.isPending}>
          {add.isPending ? 'Saving…' : `Save ${ready.length > 1 ? `${ready.length} dates` : 'date'}`}
        </button>
      </>}>
      <ErrorBox error={add.error} />
      {saved.length > 0 && (
        <p role="status" className="rounded-lg bg-good/10 px-3 py-2 text-sm text-good">✓ Saved {saved.join(', ')}</p>
      )}

      {!item ? (
        <div>
          <div className="mb-1.5 text-[13px] font-medium text-ink-2">Product</div>
          <SearchBox value={q} onChange={setQ} placeholder="Search products" />
          <ul className="mt-2 divide-y divide-line-2 rounded-lg border border-line empty:hidden">
            {matches.map((i) => (
              <li key={i.id}>
                <button type="button" className="w-full px-3 py-2.5 text-left hover:bg-hover" onClick={() => setItemId(i.id)}>
                  <span className="font-medium">{i.name}</span>
                  <span className="ml-2 text-xs text-muted">{groups.find((g) => g.id === i.group_id)?.name}</span>
                </button>
              </li>
            ))}
          </ul>
          {needle && !matches.length && <p className="mt-2 text-sm text-muted">No products match.</p>}
        </div>
      ) : (
        <>
          <div className="flex items-center gap-3 rounded-xl bg-surface-2 px-3 py-2.5">
            <div className="min-w-0 flex-1">
              <div className="font-semibold">{item.name}</div>
              <div className="text-xs text-muted">Clearance alerts {clearance} days before expiry{group ? ` · ${group.name}` : ''}</div>
            </div>
            <button type="button" className="btn btn-sm" onClick={() => setItemId(null)}>Change</button>
          </div>

          {open.length > 0 && (
            <div className="text-[13px] text-ink-2">
              <div className="mb-1 font-medium">Already logged</div>
              <ul className="num space-y-0.5 text-muted">
                {open.map((b) => (
                  <li key={b.id}>{b.qty != null ? `${qtyStr(b.qty)} × ` : ''}{fmtDay(b.expires_on)} · {STATE[b.state].label.toLowerCase()}</li>
                ))}
              </ul>
            </div>
          )}

          <div className="grid gap-2">
            <div className="grid grid-cols-[minmax(0,1fr)_96px_36px] gap-2 text-[13px] font-medium text-ink-2">
              <span>Expires</span><span>How many</span><span />
            </div>
            {rows.map((r, n) => (
              <div key={n} className="grid grid-cols-[minmax(0,1fr)_96px_36px] items-center gap-2">
                <input type="date" aria-label="Expires" className="field" value={r.expires}
                  onChange={(e) => setRow(n, { expires: e.target.value })} autoFocus={n === rows.length - 1 && n > 0} />
                <input aria-label="How many" className="field num" inputMode="decimal" placeholder="—" value={r.qty} onChange={(e) => setRow(n, { qty: e.target.value })} />
                {rows.length > 1 ? (
                  <button type="button" aria-label="Remove this date" className="grid h-9 w-9 place-items-center rounded-lg text-muted hover:bg-hover"
                    onClick={() => setRows(rows.filter((_, i) => i !== n))}>
                    <svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" aria-hidden><path d="M18 6 6 18M6 6l12 12" /></svg>
                  </button>
                ) : <span />}
              </div>
            ))}
            <button type="button" className="btn btn-sm justify-self-start" onClick={() => setRows([...rows, { expires: '', qty: '' }])}>+ Another date</button>
            {ready.some((r) => open.some((b) => b.expires_on === r.expires)) && (
              <p className="text-xs text-muted">A date already logged is added to, not doubled up.</p>
            )}
          </div>
          <Field label="Note" hint="Optional: where it is, what was seen."><input className="field" value={note} onChange={(e) => setNote(e.target.value)} /></Field>
        </>
      )}
    </Drawer>
  )
}
