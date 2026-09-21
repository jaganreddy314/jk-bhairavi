import { useState } from 'react'
import { useSearchParams } from 'react-router-dom'
import { useRemove, useSales, useUpsertSales } from '../lib/api'
import { CHANNELS, type ChannelKey } from '../lib/categories'
import { addDays, fmtDay, fmtLong, fmtShort, todayStr, weekStart } from '../lib/dates'
import { aud, cents, parseMoney } from '../lib/format'
import { nextTotalRecorded, splitSum } from '../lib/logic'
import type { SalesDay } from '../lib/types'
import { DeleteButton, ErrorBox, Flash, Loading, PageHeader, Segmented } from '../components/ui'

type Amounts = Record<ChannelKey, string>
const blank: Amounts = { eftpos: '', cash: '', uber: '', online: '' }
const toInputs = (d?: SalesDay): Amounts =>
  d ? { eftpos: show(d.eftpos), cash: show(d.cash), uber: show(d.uber), online: show(d.online) } : { ...blank }
const show = (n: number) => (n ? String(n) : '')
const toNumbers = (a: Amounts) => ({
  eftpos: parseMoney(a.eftpos), cash: parseMoney(a.cash), uber: parseMoney(a.uber), online: parseMoney(a.online),
})

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
  const [amounts, setAmounts] = useState<Amounts>(toInputs(existing))
  const [notes, setNotes] = useState(existing?.notes ?? '')
  const upsert = useUpsertSales()
  const remove = useRemove('sales_days')

  const values = toNumbers(amounts)
  const sum = splitSum(values)
  const recorded = nextTotalRecorded(existing, values)

  async function save(e: React.FormEvent) {
    e.preventDefault()
    await upsert.mutateAsync([{ sale_date: date, ...values, total_recorded: recorded, notes: notes.trim() || null }])
    onSaved()
  }

  return (
    <form onSubmit={save} className="card p-4">
      <h2 className="mb-3 font-semibold">{fmtLong(date)}</h2>
      <ErrorBox error={upsert.error || remove.error} />
      <div className="grid grid-cols-2 gap-3">
        {CHANNELS.map((c) => (
          <div key={c.key}>
            <label className="label" htmlFor={`amt-${c.key}`}>{c.label}</label>
            <input id={`amt-${c.key}`} className="field field-lg" inputMode="decimal" placeholder="0" autoComplete="off"
              value={amounts[c.key]} onChange={(e) => setAmounts({ ...amounts, [c.key]: e.target.value })} />
          </div>
        ))}
      </div>

      <div className="mt-4 flex items-baseline justify-between rounded-xl bg-surface-2 px-4 py-3">
        <span className="text-sm font-semibold text-ink-2">Day total</span>
        <span className="num text-2xl font-bold">{aud(recorded ?? sum)}</span>
      </div>
      {existing?.total_recorded != null && (
        <p className="mt-2 text-xs text-muted">
          {recorded != null
            ? `Using the total from the old sheet (${aud(existing.total_recorded)})${sum ? `; channels add up to ${aud(sum)}` : ''}.`
            : `Saving replaces the old sheet total (${aud(existing.total_recorded)}) with the sum of the channels.`}
        </p>
      )}

      <label className="label mt-4" htmlFor="notes">Notes</label>
      <textarea id="notes" rows={2} className="field" value={notes} onChange={(e) => setNotes(e.target.value)}
        placeholder="e.g. cash deposited, short-staffed" />

      <div className="mt-4 flex flex-wrap items-center gap-3">
        <button className="btn btn-primary flex-1" disabled={upsert.isPending}>{upsert.isPending ? 'Saving…' : existing ? 'Update day' : 'Save day'}</button>
        {existing && <DeleteButton busy={remove.isPending} onConfirm={() => remove.mutate(existing.id)} />}
      </div>
    </form>
  )
}

// ---------------- Week grid (mirrors the old sheet) ----------------

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
  const days = Array.from({ length: 7 }, (_, i) => addDays(ws, i))
  const byDate = new Map(rows.map((r) => [r.sale_date, r]))
  const [grid, setGrid] = useState<Record<string, Amounts>>(() => Object.fromEntries(days.map((d) => [d, toInputs(byDate.get(d))])))
  const [saved, setSaved] = useState(0)
  const upsert = useUpsertSales()
  const today = todayStr()

  const dayInfo = days.map((d) => {
    const existing = byDate.get(d)
    const values = toNumbers(grid[d])
    const recorded = nextTotalRecorded(existing, values)
    const total = recorded ?? splitSum(values)
    const changed = existing
      ? CHANNELS.some((c) => existing[c.key] !== values[c.key])
      : splitSum(values) !== 0
    const mismatch = recorded != null && Math.abs(recorded - splitSum(values)) >= 0.01
    return { d, existing, values, recorded, total, changed, mismatch }
  })
  const dirty = dayInfo.filter((x) => x.changed)
  const weekTotal = cents(dayInfo.reduce((s, x) => s + x.total, 0))

  async function save() {
    await upsert.mutateAsync(
      dirty.map((x) => ({ sale_date: x.d, ...x.values, total_recorded: x.recorded, notes: x.existing?.notes ?? null })),
    )
    setSaved(Date.now())
  }

  return (
    <div className="card p-3 sm:p-4">
      <ErrorBox error={upsert.error} />
      <div className="-mx-3 overflow-x-auto px-3 sm:mx-0 sm:px-0">
        <table className="num w-full min-w-[720px] border-separate border-spacing-1 text-sm">
          <thead>
            <tr>
              <th className="w-24" />
              {days.map((d) => (
                <th key={d} scope="col" className={`pb-1 text-center font-semibold ${d === today ? 'text-accent' : 'text-ink-2'}`}>
                  {fmtDay(d).replace(/ \w+$/, '')}
                </th>
              ))}
              <th scope="col" className="pb-1 text-right font-semibold text-ink-2">Week</th>
            </tr>
          </thead>
          <tbody>
            {CHANNELS.map((c) => (
              <tr key={c.key}>
                <th scope="row" className="pr-2 text-left font-medium text-ink-2">{c.label.replace(' (EFTPOS)', '')}</th>
                {days.map((d) => (
                  <td key={d}>
                    <input
                      aria-label={`${c.label} ${fmtDay(d)}`}
                      className="field !px-2 !py-2 text-right"
                      inputMode="decimal"
                      autoComplete="off"
                      disabled={d > today}
                      value={grid[d][c.key]}
                      onChange={(e) => setGrid({ ...grid, [d]: { ...grid[d], [c.key]: e.target.value } })}
                    />
                  </td>
                ))}
                <td className="pl-2 text-right text-ink-2">{aud(dayInfo.reduce((s, x) => s + x.values[c.key], 0))}</td>
              </tr>
            ))}
            <tr>
              <th scope="row" className="pr-2 pt-2 text-left font-bold">Total</th>
              {dayInfo.map((x) => (
                <td key={x.d} className="pt-2 text-right font-bold">
                  {x.total ? aud(x.total) : <span className="text-muted">—</span>}
                  {x.mismatch && <span className="ml-0.5 text-warn-ink" title={`Old sheet total; channels add up to ${aud(splitSum(x.values))}`}>≠</span>}
                </td>
              ))}
              <td className="pl-2 pt-2 text-right text-base font-bold">{aud(weekTotal)}</td>
            </tr>
          </tbody>
        </table>
      </div>
      {dayInfo.some((x) => x.mismatch) && (
        <p className="mt-2 text-xs text-muted">≠ = total written in the old sheet differs from the channels. Editing that day’s numbers switches it to the sum.</p>
      )}
      <div className="mt-4 flex items-center gap-3">
        <button type="button" className="btn btn-primary" disabled={!dirty.length || upsert.isPending} onClick={save}>
          {upsert.isPending ? 'Saving…' : dirty.length ? `Save ${dirty.length} day${dirty.length > 1 ? 's' : ''}` : 'No changes'}
        </button>
        <Flash signal={saved} />
      </div>
    </div>
  )
}
