import { useState } from 'react'
import { useSearchParams } from 'react-router-dom'
import { useRemove, useSales, useUpsertSales } from '../lib/api'
import { useBusiness } from '../lib/business'
import { CHANNELS, type ChannelKey } from '../lib/categories'
import { addDays, fmtDay, fmtLong, fmtShort, todayStr, weekStart } from '../lib/dates'
import { aud, cents, parseMoney } from '../lib/format'
import { nextTotalRecorded, splitSum } from '../lib/logic'
import type { SalesDay, SalesMode } from '../lib/types'
import { DeleteButton, ErrorBox, Flash, Loading, PageHeader, Segmented } from '../components/ui'

// A day is typed as strings and only turned into numbers on save.
// 'channels' businesses fill in the four payment channels; 'simple' ones type the day's
// sales and the cash collected, which are unrelated figures (cash includes fuel takings).
type Amounts = Record<ChannelKey | 'total' | 'cash_collected', string>
const blank = { eftpos: '', cash: '', uber: '', online: '', total: '', cash_collected: '' } as Amounts
const show = (n: number | null | undefined) => (n ? String(n) : '')

const toInputs = (d?: SalesDay): Amounts =>
  d
    ? {
        eftpos: show(d.eftpos), cash: show(d.cash), uber: show(d.uber), online: show(d.online),
        // A day entered before the switch to simple mode keeps its figure in the channels.
        total: show(d.total_recorded ?? splitSum(d)), cash_collected: show(d.cash_collected),
      }
    : { ...blank }

const channelValues = (a: Amounts) => ({
  eftpos: parseMoney(a.eftpos), cash: parseMoney(a.cash), uber: parseMoney(a.uber), online: parseMoney(a.online),
})

/** What to save for one day, in either mode. */
function rowFor(mode: SalesMode, date: string, a: Amounts, existing?: SalesDay, notes?: string | null) {
  if (mode === 'simple')
    return {
      sale_date: date, eftpos: 0, cash: 0, uber: 0, online: 0,
      total_recorded: parseMoney(a.total),
      cash_collected: a.cash_collected.trim() === '' ? null : parseMoney(a.cash_collected),
      notes: notes !== undefined ? notes : existing?.notes ?? null,
    }
  const channels = channelValues(a)
  return {
    sale_date: date, ...channels,
    total_recorded: nextTotalRecorded(existing, channels),
    cash_collected: existing?.cash_collected ?? null,
    notes: notes !== undefined ? notes : existing?.notes ?? null,
  }
}

/** Has this day been edited compared with what's stored? */
function isDirty(mode: SalesMode, a: Amounts, existing?: SalesDay) {
  if (mode === 'simple') {
    const total = parseMoney(a.total)
    const cash = a.cash_collected.trim() === '' ? null : parseMoney(a.cash_collected)
    return existing ? total !== (existing.total_recorded ?? 0) || cash !== existing.cash_collected : total !== 0 || cash !== null
  }
  const v = channelValues(a)
  return existing ? CHANNELS.some((c) => existing[c.key] !== v[c.key]) : splitSum(v) !== 0
}

export default function SalesEntry() {
  const [params, setParams] = useSearchParams()
  const view = params.get('view') === 'week' ? 'week' : 'day'
  return (
    <div>
      <PageHeader
        title="Enter sales"
        action={
          <Segmented ariaLabel="Entry view" value={view}
            onChange={(v) => setParams(v === 'week' ? { view: 'week' } : {}, { replace: true })}
            options={[{ value: 'day', label: 'One day' }, { value: 'week', label: 'Week grid' }]} />
        }
      />
      {view === 'day' ? <DayEntry /> : <WeekGrid />}
    </div>
  )
}

/** How this business records a day. */
const useMode = (): SalesMode => useBusiness().business?.sales_mode ?? 'channels'

// ---------------- One day ----------------

function DayEntry() {
  const [date, setDate] = useState(todayStr())
  const { data, isLoading, error } = useSales(date, date)
  const existing = data?.[0]
  const [saved, setSaved] = useState(0)
  return (
    <div className="mx-auto max-w-md">
      <div className="mb-4 flex items-center gap-2">
        <button type="button" className="btn px-3" aria-label="Previous day" onClick={() => setDate(addDays(date, -1))}>‹</button>
        <input type="date" aria-label="Date" className="field text-center" value={date} max={todayStr()}
          onChange={(e) => e.target.value && setDate(e.target.value)} />
        <button type="button" className="btn px-3" aria-label="Next day" disabled={date >= todayStr()} onClick={() => setDate(addDays(date, 1))}>›</button>
      </div>
      <ErrorBox error={error} />
      {isLoading ? <Loading /> : <DayForm key={`${date}:${existing?.id ?? 'new'}`} date={date} existing={existing} onSaved={() => setSaved(Date.now())} />}
      <div className="mt-2 h-5 text-center"><Flash signal={saved} /></div>
    </div>
  )
}

function DayForm({ date, existing, onSaved }: { date: string; existing?: SalesDay; onSaved: () => void }) {
  const mode = useMode()
  const [amounts, setAmounts] = useState<Amounts>(toInputs(existing))
  const [notes, setNotes] = useState(existing?.notes ?? '')
  const upsert = useUpsertSales()
  const remove = useRemove('sales_days')
  const set = (k: keyof Amounts, v: string) => setAmounts({ ...amounts, [k]: v })

  const row = rowFor(mode, date, amounts, existing, notes.trim() || null)
  const sum = splitSum(channelValues(amounts))

  async function save(e: React.FormEvent) {
    e.preventDefault()
    await upsert.mutateAsync([row])
    onSaved()
  }

  return (
    <form onSubmit={save} className="card p-4">
      <h2 className="mb-3 font-semibold">{fmtLong(date)}</h2>
      <ErrorBox error={upsert.error || remove.error} />

      {mode === 'simple' ? (
        <div className="space-y-4">
          <div>
            <label className="label" htmlFor="amt-total">Total sales</label>
            <input id="amt-total" className="field field-lg" inputMode="decimal" placeholder="0" autoComplete="off"
              value={amounts.total} onChange={(e) => set('total', e.target.value)} />
          </div>
          <div>
            <label className="label" htmlFor="amt-cash_collected">Cash collected</label>
            <input id="amt-cash_collected" className="field field-lg" inputMode="decimal" placeholder="0" autoComplete="off"
              value={amounts.cash_collected} onChange={(e) => set('cash_collected', e.target.value)} />
            <p className="mt-1 text-xs text-muted">All cash in hand, fuel included. Never counted as sales.</p>
          </div>
        </div>
      ) : (
        <>
          <div className="grid grid-cols-2 gap-3">
            {CHANNELS.map((c) => (
              <div key={c.key}>
                <label className="label" htmlFor={`amt-${c.key}`}>{c.label}</label>
                <input id={`amt-${c.key}`} className="field field-lg" inputMode="decimal" placeholder="0" autoComplete="off"
                  value={amounts[c.key]} onChange={(e) => set(c.key, e.target.value)} />
              </div>
            ))}
          </div>
          <div className="mt-4 flex items-baseline justify-between rounded-xl bg-surface-2 px-4 py-3">
            <span className="text-sm font-semibold text-ink-2">Day total</span>
            <span className="num text-2xl font-bold">{aud(row.total_recorded ?? sum)}</span>
          </div>
          {existing?.total_recorded != null && (
            <p className="mt-2 text-xs text-muted">
              {row.total_recorded != null
                ? `Using the total from the old sheet (${aud(existing.total_recorded)})${sum ? `; channels add up to ${aud(sum)}` : ''}.`
                : `Saving replaces the old sheet total (${aud(existing.total_recorded)}) with the sum of the channels.`}
            </p>
          )}
        </>
      )}

      <label className="label mt-4" htmlFor="notes">Notes</label>
      <textarea id="notes" rows={2} className="field" value={notes} onChange={(e) => setNotes(e.target.value)}
        placeholder="e.g. cash banked, short-staffed" />

      <div className="mt-4 flex flex-wrap items-center gap-3">
        <button className="btn btn-primary flex-1" disabled={upsert.isPending}>{upsert.isPending ? 'Saving…' : existing ? 'Update day' : 'Save day'}</button>
        {existing && <DeleteButton busy={remove.isPending} onConfirm={() => remove.mutate(existing.id)} />}
      </div>
    </form>
  )
}

// ---------------- Week grid ----------------

function WeekGrid() {
  const [ws, setWs] = useState(weekStart(todayStr()))
  const { data, isLoading, error } = useSales(ws, addDays(ws, 6))
  return (
    <div>
      <div className="mb-4 flex items-center gap-2">
        <button type="button" className="btn px-3" aria-label="Previous week" onClick={() => setWs(addDays(ws, -7))}>‹</button>
        <div className="min-w-44 text-center font-semibold">Week of {fmtShort(ws)} – {fmtShort(addDays(ws, 6))}</div>
        <button type="button" className="btn px-3" aria-label="Next week" disabled={addDays(ws, 7) > todayStr()} onClick={() => setWs(addDays(ws, 7))}>›</button>
        {ws !== weekStart(todayStr()) && (
          <button type="button" className="btn btn-sm ml-1" onClick={() => setWs(weekStart(todayStr()))}>This week</button>
        )}
      </div>
      <ErrorBox error={error} />
      {isLoading ? <Loading /> : <WeekForm key={ws} ws={ws} rows={data ?? []} />}
    </div>
  )
}

function WeekForm({ ws, rows }: { ws: string; rows: SalesDay[] }) {
  const mode = useMode()
  const days = Array.from({ length: 7 }, (_, i) => addDays(ws, i))
  const byDate = new Map(rows.map((r) => [r.sale_date, r]))
  const [grid, setGrid] = useState<Record<string, Amounts>>(() => Object.fromEntries(days.map((d) => [d, toInputs(byDate.get(d))])))
  const [saved, setSaved] = useState(0)
  const upsert = useUpsertSales()
  const today = todayStr()

  // The rows of the grid, in order.
  const lines: { key: keyof Amounts; label: string }[] =
    mode === 'simple'
      ? [{ key: 'total', label: 'Sales' }, { key: 'cash_collected', label: 'Cash collected' }]
      : CHANNELS.map((c) => ({ key: c.key as keyof Amounts, label: c.label.replace(' (EFTPOS)', '') }))

  const dayInfo = days.map((d) => {
    const existing = byDate.get(d)
    const row = rowFor(mode, d, grid[d], existing)
    const total = row.total_recorded ?? splitSum(row)
    const mismatch = mode === 'channels' && row.total_recorded != null && Math.abs(row.total_recorded - splitSum(row)) >= 0.01
    return { d, existing, row, total, changed: isDirty(mode, grid[d], existing), mismatch }
  })
  const dirty = dayInfo.filter((x) => x.changed)
  const weekTotal = cents(dayInfo.reduce((s, x) => s + x.total, 0))
  const lineTotal = (key: keyof Amounts) => cents(days.reduce((s, d) => s + parseMoney(grid[d][key]), 0))

  async function save() {
    await upsert.mutateAsync(dirty.map((x) => x.row))
    setSaved(Date.now())
  }

  return (
    <div className="card p-3 sm:p-4">
      <ErrorBox error={upsert.error} />
      <div className="-mx-3 overflow-x-auto px-3 sm:mx-0 sm:px-0">
        <table className="num w-full min-w-[720px] border-separate border-spacing-1 text-sm">
          <thead>
            <tr>
              <th className="w-28" />
              {days.map((d) => (
                <th key={d} scope="col" className={`pb-1 text-center font-semibold ${d === today ? 'text-accent' : 'text-ink-2'}`}>
                  {fmtDay(d).replace(/ \w+$/, '')}
                </th>
              ))}
              <th scope="col" className="pb-1 text-right font-semibold text-ink-2">Week</th>
            </tr>
          </thead>
          <tbody>
            {lines.map((line) => (
              <tr key={line.key}>
                <th scope="row" className="pr-2 text-left font-medium text-ink-2">{line.label}</th>
                {days.map((d) => (
                  <td key={d}>
                    <input
                      aria-label={`${line.label} ${fmtDay(d)}`}
                      className="field !px-2 !py-2 text-right"
                      inputMode="decimal"
                      autoComplete="off"
                      disabled={d > today}
                      value={grid[d][line.key]}
                      onChange={(e) => setGrid({ ...grid, [d]: { ...grid[d], [line.key]: e.target.value } })}
                    />
                  </td>
                ))}
                <td className="pl-2 text-right font-semibold text-ink-2">{aud(lineTotal(line.key))}</td>
              </tr>
            ))}
            {mode === 'channels' && (
              <tr>
                <th scope="row" className="pr-2 pt-2 text-left font-bold">Total</th>
                {dayInfo.map((x) => (
                  <td key={x.d} className="pt-2 text-right font-bold">
                    {x.total ? aud(x.total) : <span className="text-muted">—</span>}
                    {x.mismatch && <span className="ml-0.5 text-warn-ink" title={`Old sheet total; channels add up to ${aud(splitSum(x.row))}`}>≠</span>}
                  </td>
                ))}
                <td className="pl-2 pt-2 text-right text-base font-bold">{aud(weekTotal)}</td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
      {mode === 'simple' ? (
        <p className="mt-2 text-xs text-muted">Cash collected includes fuel money and is never counted as sales.</p>
      ) : dayInfo.some((x) => x.mismatch) ? (
        <p className="mt-2 text-xs text-muted">≠ = total written in the old sheet differs from the channels. Editing that day’s numbers switches it to the sum.</p>
      ) : null}
      <div className="mt-4 flex items-center gap-3">
        <button type="button" className="btn btn-primary" disabled={!dirty.length || upsert.isPending} onClick={save}>
          {upsert.isPending ? 'Saving…' : dirty.length ? `Save ${dirty.length} day${dirty.length > 1 ? 's' : ''}` : 'No changes'}
        </button>
        <Flash signal={saved} />
      </div>
    </div>
  )
}
