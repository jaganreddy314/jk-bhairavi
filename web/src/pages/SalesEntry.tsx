import { useState } from 'react'
import { useSearchParams } from 'react-router-dom'
import { useRemove, useSales, useUpsertSales } from '../lib/api'
import { useBusiness } from '../lib/business'
import { CHANNELS, type ChannelKey } from '../lib/categories'
import { addDays, fmtShort, toDate, todayStr, weekStart } from '../lib/dates'
import { aud, audRound, cents, parseMoney } from '../lib/format'
import { dayTotal, nextTotalRecorded, splitSum } from '../lib/logic'
import type { SalesDay, SalesMode } from '../lib/types'
import { DeleteButton, ErrorBox, Loading, MoneyInput, PageHeader, Pill, PILL_DOT, SaveBar, Segmented } from '../components/ui'

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

const fmt = (opts: Intl.DateTimeFormatOptions) => new Intl.DateTimeFormat('en-AU', { timeZone: 'UTC', ...opts })
const fDow = fmt({ weekday: 'short' })
const fDayLong = fmt({ weekday: 'long', day: 'numeric', month: 'short' })
const fTitle = fmt({ weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' })
const fGridDay = fmt({ weekday: 'short', day: 'numeric', month: 'short' })
const dow = (d: string) => fDow.format(toDate(d))

/** How this business records a day. */
const useMode = (): SalesMode => useBusiness().business?.sales_mode ?? 'channels'

/** The figures typed for each field, in the order they appear. */
const fieldsFor = (mode: SalesMode): { key: keyof Amounts; label: string; hint?: string }[] =>
  mode === 'simple'
    ? [
        { key: 'total', label: 'Total sales', hint: 'Shop sales only, from the end-of-day report.' },
        { key: 'cash_collected', label: 'Cash collected', hint: 'All cash in hand, fuel included.' },
      ]
    : CHANNELS.map((c) => ({ key: c.key as keyof Amounts, label: c.label }))

export default function SalesEntry() {
  const [params, setParams] = useSearchParams()
  const view = params.get('view') === 'week' ? 'week' : 'day'
  const mode = useMode()
  const today = todayStr()
  const [date, setDate] = useState(today)
  const [justSaved, setJustSaved] = useState('')
  const ws = weekStart(date)
  const { data, isLoading, error } = useSales(ws, addDays(ws, 6))
  const rows = data ?? []
  const byDate = new Map(rows.map((r) => [r.sale_date, r]))
  const days = Array.from({ length: 7 }, (_, i) => addDays(ws, i))
  const past = days.filter((d) => d <= today)
  const entered = past.filter((d) => byDate.has(d))
  const pick = (d: string) => { setDate(d > today ? today : d); setJustSaved('') }

  return (
    <div className="mx-auto max-w-[1180px]">
      <PageHeader
        title="Enter sales"
        subtitle={mode === 'simple'
          ? 'Close of trade totals. Cash collected is tracked separately and never counted as sales.'
          : 'Close of trade totals, split by how customers paid.'}
        action={
          <Segmented ariaLabel="Entry view" value={view}
            onChange={(v) => setParams(v === 'week' ? { view: 'week' } : {}, { replace: true })}
            options={[{ value: 'day', label: 'One day' }, { value: 'week', label: 'Week grid' }]} />
        }
      />

      <div className="flex flex-wrap items-center gap-2">
        <WeekStepper ws={ws} date={date} today={today} onPick={pick} />
        {date !== today && <button type="button" className="btn btn-sm h-[38px] font-medium" onClick={() => pick(today)}>Today</button>}
        <span className="num ml-auto text-[13px] text-muted">{entered.length} of {past.length} day{past.length === 1 ? '' : 's'} entered</span>
      </div>

      <div className="mt-3"><ErrorBox error={error} /></div>
      {isLoading ? <Loading /> : view === 'day' ? (
        <>
          <DayStrip days={days} byDate={byDate} date={date} today={today} onPick={pick} />
          <div className="mt-4 flex flex-wrap items-start gap-4">
            <DayForm key={`${date}:${byDate.get(date)?.id ?? 'new'}`} date={date} existing={byDate.get(date)} justSaved={justSaved}
              nextMissing={past.find((d) => d !== date && !byDate.has(d)) ?? null}
              stillToEnter={past.filter((d) => !byDate.has(d))}
              onSaved={(next) => { setJustSaved(`Saved ${fmt({ weekday: 'long' }).format(toDate(date))}.`); if (next) setDate(next) }} />
            <WeekSoFar days={days} byDate={byDate} date={date} today={today} onPick={pick} simple={mode === 'simple'} />
          </div>
        </>
      ) : (
        <WeekForm key={`${ws}:${rows.map((r) => r.id).join()}`} days={days} byDate={byDate} today={today} />
      )}
    </div>
  )
}

/** ‹ Week of 19 Oct – 25 Oct 2026 ›. Tapping the label opens a calendar to jump to any day. */
function WeekStepper({ ws, date, today, onPick }: { ws: string; date: string; today: string; onPick: (d: string) => void }) {
  const end = addDays(ws, 6)
  const btn = 'grid h-full w-9 place-items-center bg-surface text-ink-2 hover:bg-hover disabled:opacity-35 disabled:hover:bg-surface'
  return (
    <div className="flex h-[38px] items-center overflow-hidden rounded-lg border border-input-line bg-surface">
      <button type="button" aria-label="Previous week" className={`${btn} border-r border-line`} onClick={() => onPick(addDays(date, -7))}>
        <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden><path d="m15 18-6-6 6-6" /></svg>
      </button>
      <label className="num relative flex h-full cursor-pointer items-center whitespace-nowrap px-3.5 text-[13px] font-medium text-ink-2 hover:bg-hover">
        Week of {fmtShort(ws)} – {fmtShort(end)} {end.slice(0, 4)}
        <input type="date" aria-label="Jump to a day" className="absolute inset-0 cursor-pointer opacity-0" max={today} value={date}
          onClick={(e) => { try { e.currentTarget.showPicker() } catch { /* older browsers open it themselves */ } }}
          onChange={(e) => e.target.value && onPick(e.target.value)} />
      </label>
      <button type="button" aria-label="Next week" className={`${btn} border-l border-line`} disabled={addDays(ws, 7) > today}
        onClick={() => onPick(addDays(date, 7))}>
        <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden><path d="m9 18 6-6-6-6" /></svg>
      </button>
    </div>
  )
}

interface WeekProps { days: string[]; byDate: Map<string, SalesDay>; date: string; today: string; onPick: (d: string) => void }

/** Mon–Sun tiles: green amount once entered, amber dash for a missed day, greyed out ahead of today. */
function DayStrip({ days, byDate, date, today, onPick }: WeekProps) {
  return (
    <div className="mt-3 grid grid-cols-7 gap-1.5">
      {days.map((d) => {
        const row = byDate.get(d), future = d > today, sel = d === date
        return (
          <button key={d} type="button" disabled={future} aria-pressed={sel} onClick={() => onPick(d)}
            className={`flex min-w-0 flex-col items-center gap-0.5 rounded-[10px] border px-0.5 py-2 disabled:cursor-default disabled:opacity-45 ${
              sel ? 'border-accent bg-accent-tint' : 'border-line bg-surface hover:bg-hover'}`}>
            <span className={`text-[11px] font-medium uppercase tracking-[0.04em] ${sel ? 'text-accent' : 'text-muted'}`}>{dow(d)}</span>
            <span className={`num text-[17px] font-semibold ${sel ? 'text-accent' : ''}`}>{Number(d.slice(8))}</span>
            <span className={`num max-w-full truncate text-[11px] ${row ? 'text-good' : 'text-warn-ink'}`}>
              {future ? ' ' : row ? audRound(dayTotal(row)) : '—'}
            </span>
          </button>
        )
      })}
    </div>
  )
}

function WeekSoFar({ days, byDate, date, today, onPick, simple }: WeekProps & { simple: boolean }) {
  const rows = days.map((d) => byDate.get(d)).filter((r): r is SalesDay => !!r)
  const total = cents(rows.reduce((s, r) => s + dayTotal(r), 0))
  const trading = rows.filter((r) => dayTotal(r) > 0).length
  return (
    <aside className="card min-w-0 flex-[1_1_260px] p-4 desk:p-5">
      <div className="text-[13px] font-medium text-muted">Week so far</div>
      <div className="num mt-1 text-[28px] font-semibold tracking-[-0.02em]">{aud(total)}</div>
      <div className="text-xs text-muted">
        {trading ? `${trading} trading day${trading === 1 ? '' : 's'} · avg ${audRound(total / trading)} a day` : 'Nothing entered yet this week'}
      </div>
      <div className="mt-3.5 border-t border-line-2">
        {days.map((d) => {
          const row = byDate.get(d), future = d > today
          return (
            <button key={d} type="button" disabled={future} onClick={() => onPick(d)}
              className="num flex w-full items-center gap-2.5 border-b border-line-2 py-[9px] text-left disabled:cursor-default disabled:opacity-45">
              <span className="h-2 w-2 shrink-0 rounded-full" style={{ background: row ? PILL_DOT('success') : future ? 'var(--input-line)' : PILL_DOT('warn') }} />
              <span className={`flex-1 text-[13px] text-ink-2 ${d === date ? 'font-semibold' : ''}`}>{fDayLong.format(toDate(d))}</span>
              <span className={`text-[13px] font-semibold ${row ? 'text-good' : future ? 'text-faint' : 'text-warn-ink'}`}>
                {future ? 'Upcoming' : row ? aud(dayTotal(row)) : 'Not entered'}
              </span>
            </button>
          )
        })}
      </div>
      {simple && (
        <div className="num mt-3 flex justify-between text-[13px] text-muted">
          <span>Cash collected</span>
          <span className="font-semibold text-ink">{aud(cents(rows.reduce((s, r) => s + (r.cash_collected ?? 0), 0)))}</span>
        </div>
      )}
    </aside>
  )
}

// ---------------- One day ----------------

function DayForm({ date, existing, nextMissing, stillToEnter, justSaved, onSaved }: {
  date: string; existing?: SalesDay; nextMissing: string | null; stillToEnter: string[]; justSaved: string
  onSaved: (goTo: string | null) => void
}) {
  const mode = useMode()
  const [amounts, setAmounts] = useState<Amounts>(toInputs(existing))
  const [notes, setNotes] = useState(existing?.notes ?? '')
  const upsert = useUpsertSales()
  const remove = useRemove('sales_days')
  const set = (k: keyof Amounts, v: string) => setAmounts({ ...amounts, [k]: v })

  const row = rowFor(mode, date, amounts, existing, notes.trim() || null)
  const sum = splitSum(channelValues(amounts))
  const dirty = isDirty(mode, amounts, existing) || (notes.trim() || null) !== (existing?.notes ?? null)

  async function save(e: React.FormEvent) {
    e.preventDefault()
    if (!dirty) return
    await upsert.mutateAsync([row])
    onSaved(nextMissing)
  }

  const hint = justSaved && !dirty ? justSaved
    : dirty ? 'Changes not saved yet.'
    : stillToEnter.length ? `Still to enter: ${stillToEnter.map(dow).join(', ')}`
    : 'Every day this week is in.'

  return (
    <form onSubmit={save} className="card min-w-0 flex-[999_1_420px] p-4 desk:p-5">
      <div className="flex items-center justify-between gap-3">
        <h2 className="text-lg font-semibold">{fTitle.format(toDate(date))}</h2>
        {dirty ? <Pill tone="warn">Unsaved</Pill> : existing ? <Pill tone="success">Saved</Pill> : <Pill tone="neutral">Not entered</Pill>}
      </div>
      <div className="mt-3"><ErrorBox error={upsert.error || remove.error} /></div>

      <div className={`mt-2 grid gap-4 ${mode === 'simple' ? 'grid-cols-[repeat(auto-fit,minmax(200px,1fr))]' : 'grid-cols-2'}`}>
        {fieldsFor(mode).map((f) => (
          <div key={f.key} className="flex flex-col gap-1.5">
            <label className="text-[13px] font-medium text-ink-2" htmlFor={`amt-${f.key}`}>{f.label}</label>
            <MoneyInput id={`amt-${f.key}`} value={amounts[f.key]} onChange={(v) => set(f.key, v)} />
            {f.hint && <span className="text-xs text-muted">{f.hint}</span>}
          </div>
        ))}
      </div>

      {mode === 'channels' && (
        <>
          <div className="mt-4 flex items-baseline justify-between rounded-[10px] bg-surface-2 px-4 py-3">
            <span className="text-sm font-medium text-ink-2">Day total</span>
            <span className="num text-2xl font-semibold">{aud(row.total_recorded ?? sum)}</span>
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
      <textarea id="notes" rows={2} className="field resize-y" value={notes} onChange={(e) => setNotes(e.target.value)}
        placeholder="e.g. cash banked, short-staffed" />

      <div className="mt-5 flex flex-wrap items-center gap-2.5">
        <span className={`min-w-36 flex-1 text-[13px] ${justSaved && !dirty ? 'text-good' : 'text-muted'}`}>{hint}</span>
        {existing && <DeleteButton label="Delete day" busy={remove.isPending} onConfirm={() => remove.mutate(existing.id)} />}
        <button className={`btn h-11 px-5 text-[15px] ${dirty ? 'btn-primary' : 'btn-saved'}`} disabled={!dirty || upsert.isPending}>
          {upsert.isPending ? 'Saving…' : dirty ? (nextMissing ? `Save and go to ${dow(nextMissing)}` : 'Save day') : existing ? 'Saved' : 'Save day'}
        </button>
      </div>
    </form>
  )
}

// ---------------- Week grid ----------------

function WeekForm({ days, byDate, today }: { days: string[]; byDate: Map<string, SalesDay>; today: string }) {
  const mode = useMode()
  const fields = fieldsFor(mode)
  const [grid, setGrid] = useState<Record<string, { a: Amounts; notes: string }>>(() =>
    Object.fromEntries(days.map((d) => [d, { a: toInputs(byDate.get(d)), notes: byDate.get(d)?.notes ?? '' }])))
  const upsert = useUpsertSales()
  const setField = (d: string, k: keyof Amounts, v: string) => setGrid({ ...grid, [d]: { ...grid[d], a: { ...grid[d].a, [k]: v } } })

  const info = days.map((d) => {
    const existing = byDate.get(d)
    const notes = grid[d].notes.trim() || null
    const row = rowFor(mode, d, grid[d].a, existing, notes)
    const total = row.total_recorded ?? splitSum(row)
    const mismatch = mode === 'channels' && row.total_recorded != null && Math.abs(row.total_recorded - splitSum(row)) >= 0.01
    return { d, existing, row, total, mismatch, changed: isDirty(mode, grid[d].a, existing) || notes !== (existing?.notes ?? null) }
  })
  const dirty = info.filter((x) => x.changed)
  const fieldTotal = (k: keyof Amounts) => cents(days.reduce((s, d) => s + parseMoney(grid[d].a[k]), 0))
  // Day | one column per figure | notes. On a phone the day spans the row and notes are hidden.
  const cols = `minmax(130px,1fr) repeat(${fields.length}, minmax(100px,1fr)) minmax(0,1.4fr)`

  return (
    <>
      <div className="card mt-4 overflow-hidden">
        <ErrorBox error={upsert.error} />
        <div className="hidden gap-3 border-b border-line bg-hover px-5 py-2.5 text-xs font-medium text-muted desk:grid" style={{ gridTemplateColumns: cols }}>
          <span>Day</span>{fields.map((f) => <span key={f.key}>{f.label}</span>)}<span>Notes</span>
        </div>
        {info.map((x) => {
          const future = x.d > today
          return (
            <div key={x.d} className={`grid grid-cols-2 items-center gap-3 border-b border-line-2 px-3.5 py-3 desk:grid-cols-[var(--cols)] desk:px-5 ${
              x.changed ? 'bg-[#FFFCF5] dark:bg-[#1F1A10]' : ''} ${future ? 'opacity-50' : ''}`} style={{ '--cols': cols } as React.CSSProperties}>
              <div className="col-span-full flex min-w-0 items-center gap-2 desk:col-span-1">
                <span className="h-2 w-2 shrink-0 rounded-full" style={{ background: x.existing ? PILL_DOT('success') : future ? 'var(--input-line)' : PILL_DOT('warn') }} />
                <span className="whitespace-nowrap font-medium">{fGridDay.format(toDate(x.d))}</span>
                <span className="truncate text-xs text-faint">
                  {future ? 'upcoming' : x.changed ? 'edited' : ''}
                  {mode === 'channels' && x.total ? <span className="num ml-1 text-muted">{aud(x.total)}{x.mismatch && <span className="text-warn-ink" title={`Old sheet total; channels add up to ${aud(splitSum(x.row))}`}> ≠</span>}</span> : null}
                </span>
              </div>
              {fields.map((f) => (
                <MoneyInput key={f.key} size="sm" aria-label={`${f.label} ${fGridDay.format(toDate(x.d))}`} placeholder={f.label.split(' ')[0]}
                  disabled={future} value={grid[x.d].a[f.key]} onChange={(v) => setField(x.d, f.key, v)} />
              ))}
              <input aria-label={`Notes ${fGridDay.format(toDate(x.d))}`} placeholder="Notes" disabled={future}
                className="field hidden !h-[38px] !py-0 !text-[13px] desk:block" value={grid[x.d].notes}
                onChange={(e) => setGrid({ ...grid, [x.d]: { ...grid[x.d], notes: e.target.value } })} />
            </div>
          )
        })}
        <div className="num grid grid-cols-2 items-center gap-3 bg-hover px-3.5 py-3 font-semibold desk:grid-cols-[var(--cols)] desk:px-5" style={{ '--cols': cols } as React.CSSProperties}>
          <span className="col-span-full desk:col-span-1">Week total{mode === 'channels' && <span className="ml-2 font-normal text-muted">{aud(cents(info.reduce((s, x) => s + x.total, 0)))}</span>}</span>
          {fields.map((f) => <span key={f.key} className="pl-2.5">{aud(fieldTotal(f.key))}</span>)}
          <span className="hidden desk:block" />
        </div>
      </div>
      {mode === 'channels' && info.some((x) => x.mismatch) && (
        <p className="mt-2 text-xs text-muted">≠ = total written in the old sheet differs from the channels. Editing that day’s numbers switches it to the sum.</p>
      )}
      <SaveBar dirty={dirty.length > 0} message={dirty.length ? `Unsaved changes to ${dirty.length} day${dirty.length > 1 ? 's' : ''}` : 'Week is saved'}>
        <button type="button" className={`btn h-10 px-[18px] ${dirty.length ? 'btn-primary' : 'btn-saved'}`} disabled={!dirty.length || upsert.isPending}
          onClick={() => upsert.mutate(dirty.map((x) => x.row))}>
          {upsert.isPending ? 'Saving…' : dirty.length ? 'Save week' : 'Saved'}
        </button>
      </SaveBar>
    </>
  )
}
