import { useState, type ReactNode } from 'react'
import { useSearchParams } from 'react-router-dom'
import { useFridgeReadings, useFridges, useRemove, useSave } from '../lib/api'
import { usePerms } from '../lib/access'
import { addDays, eachDay, fmtDay, fmtLong, fmtShort, todayStr, weekStart } from '../lib/dates'
import type { Fridge, FridgeKind, FridgeReading } from '../lib/types'
import { DeleteButton, Drawer, Empty, ErrorBox, Field, Loading, PageHeader, Pill, Segmented } from '../components/ui'

type Tab = 'today' | 'history'

const KIND: Record<FridgeKind, { label: string; min: number | null; max: number | null }> = {
  fridge: { label: 'Fridge', min: 0, max: 5 },
  freezer: { label: 'Freezer', min: null, max: -15 },
  hot: { label: 'Hot food', min: 60, max: null },
}

const fTime = new Intl.DateTimeFormat('en-AU', { timeZone: 'Australia/Brisbane', hour: 'numeric', minute: '2-digit' })
const timeOf = (r: FridgeReading) => fTime.format(new Date(r.recorded_at))

const deg = (n: number) => `${n.toFixed(1)}°`

/** "0 to 5 °C", "−15 °C or colder", "60 °C or hotter". */
function rangeLabel(f: Pick<Fridge, 'min_temp' | 'max_temp'>) {
  if (f.min_temp != null && f.max_temp != null) return `${f.min_temp} to ${f.max_temp} °C`
  if (f.max_temp != null) return `${f.max_temp} °C or colder`
  if (f.min_temp != null) return `${f.min_temp} °C or hotter`
  return 'No range set'
}

const outOfRange = (f: Fridge | undefined, t: number) =>
  !!f && ((f.min_temp != null && t < f.min_temp) || (f.max_temp != null && t > f.max_temp))

/** What someone typed as a temperature: "-18", "−18", "3,5". Null when it isn't one. */
function parseTemp(s: string): number | null {
  const t = s.trim().replace(/[−–]/g, '-').replace(',', '.').replace(/°c?$/i, '')
  if (!/^-?\d+(\.\d+)?$/.test(t)) return null
  const n = Math.round(Number(t) * 10) / 10
  return n >= -50 && n <= 120 ? n : null
}

/**
 * The daily food-safety log: each fridge and freezer's temperature, read off its thermometer
 * once or more a day. Anything outside its range asks what was done about it.
 */
export default function FridgeTemps() {
  const [params, setParams] = useSearchParams()
  const tab: Tab = params.get('tab') === 'history' ? 'history' : 'today'
  const { can } = usePerms()
  const canAct = can('temps')
  const fridges = useFridges()
  const [editing, setEditing] = useState<Fridge | 'new' | null>(null)

  if (fridges.isLoading) return <Loading />
  const all = fridges.data ?? []

  return (
    <div>
      <PageHeader
        title="Fridge temps"
        subtitle="Check every fridge and freezer each day and log what the thermometer reads."
        action={canAct && (
          <button type="button" className="btn print:hidden" onClick={() => setEditing('new')}>
            <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" aria-hidden><path d="M5 12h14M12 5v14" /></svg>
            Add fridge
          </button>
        )}
      />
      <ErrorBox error={fridges.error} />
      {all.length === 0 ? (
        <Empty>
          No fridges yet. {canAct ? 'Add each fridge, freezer and hot display in the shop, then log their temperatures here every day.' : 'Someone with Fridge temps access can add them.'}
        </Empty>
      ) : (
        <>
          <div className="mb-4 print:hidden">
            <Segmented ariaLabel="View" value={tab} onChange={(t) => setParams(t === 'today' ? {} : { tab: t }, { replace: true })}
              options={[{ value: 'today', label: 'Log' }, { value: 'history', label: 'History' }]} />
          </div>
          {tab === 'today' ? <Today fridges={all} canAct={canAct} onEdit={setEditing} /> : <History fridges={all} />}
        </>
      )}
      {editing && <FridgeDrawer fridge={editing === 'new' ? null : editing} fridges={all} onClose={() => setEditing(null)} />}
    </div>
  )
}

/** A day's checks: every fridge in use, what it read, and a box to log the next reading. */
function Today({ fridges, canAct, onEdit }: { fridges: Fridge[]; canAct: boolean; onEdit: (f: Fridge) => void }) {
  const today = todayStr()
  const [day, setDay] = useState(today)
  const readings = useFridgeReadings(day, day)
  const inUse = fridges.filter((f) => f.active)
  const retired = fridges.filter((f) => !f.active)
  const rows = readings.data ?? []
  const checked = inUse.filter((f) => rows.some((r) => r.fridge_id === f.id)).length
  const bad = rows.filter((r) => outOfRange(fridges.find((f) => f.id === r.fridge_id), r.temp)).length

  return (
    <>
      <div className="mb-3 flex flex-wrap items-center gap-2">
        <div className="flex h-[38px] items-center overflow-hidden rounded-lg border border-input-line bg-surface">
          <button type="button" aria-label="Previous day" className="grid h-full w-9 place-items-center border-r border-line text-ink-2 hover:bg-hover" onClick={() => setDay(addDays(day, -1))}>‹</button>
          <span className="num whitespace-nowrap px-3.5 text-[13px] font-medium text-ink-2">{day === today ? `Today · ${fmtDay(day)}` : fmtLong(day)}</span>
          <button type="button" aria-label="Next day" disabled={day >= today} className="grid h-full w-9 place-items-center border-l border-line text-ink-2 hover:bg-hover disabled:opacity-40" onClick={() => setDay(addDays(day, 1))}>›</button>
        </div>
        {day !== today && <button type="button" className="btn btn-sm h-[38px] font-medium" onClick={() => setDay(today)}>Today</button>}
        {!readings.isLoading && inUse.length > 0 && (
          <span className="flex flex-wrap items-center gap-1.5">
            <Pill tone={checked === inUse.length ? 'success' : 'warn'}>{checked} of {inUse.length} checked</Pill>
            {bad > 0 && <Pill tone="danger">{bad} out of range</Pill>}
          </span>
        )}
      </div>
      {day !== today && canAct && (
        <p className="mb-3 text-sm text-muted">Readings logged now are recorded against {fmtDay(day)}, for a check that was missed.</p>
      )}
      <ErrorBox error={readings.error} />

      {readings.isLoading ? <Loading /> : inUse.length === 0 ? (
        <Empty>Every fridge is retired. Bring one back below, or add a new one.</Empty>
      ) : (
        <section className="card overflow-hidden">
          <ul className="divide-y divide-line-2">
            {inUse.map((f) => (
              <FridgeRow key={f.id} fridge={f} day={day} readings={rows.filter((r) => r.fridge_id === f.id)} canAct={canAct} onEdit={() => onEdit(f)} />
            ))}
          </ul>
        </section>
      )}

      {retired.length > 0 && (
        <p className="mt-3 text-sm text-muted">
          Retired: {retired.map((f, i) => (
            <span key={f.id}>{i > 0 && ', '}{canAct ? <button type="button" className="font-medium text-accent" onClick={() => onEdit(f)}>{f.name}</button> : f.name}</span>
          ))}. Their readings stay in History.
        </p>
      )}
    </>
  )
}

/** One fridge: its range, the day's readings, and the box to log another. */
function FridgeRow({ fridge: f, day, readings, canAct, onEdit }: {
  fridge: Fridge; day: string; readings: FridgeReading[]; canAct: boolean; onEdit: () => void
}) {
  const save = useSave('fridge_readings')
  // A freezer reads below zero, and a phone's number pad has no minus key: start it off.
  const blank = f.max_temp != null && f.max_temp < 0 ? '-' : ''
  const [value, setValue] = useState(blank)
  const [note, setNote] = useState('')
  const [open, setOpen] = useState<FridgeReading | null>(null)
  const temp = parseTemp(value)
  const off = temp != null && outOfRange(f, temp)

  async function log() {
    if (temp == null) return
    await save.mutateAsync({ fridge_id: f.id, reading_date: day, temp, note: note.trim() || null })
    setValue(blank)
    setNote('')
  }

  return (
    <li className="px-3.5 py-3 desk:px-5">
      <div className="flex flex-wrap items-start gap-x-3 gap-y-2">
        <div className="min-w-40 flex-1">
          <div className="flex flex-wrap items-center gap-2">
            {canAct ? <button type="button" className="font-medium hover:text-accent" onClick={onEdit}>{f.name}</button> : <span className="font-medium">{f.name}</span>}
            {readings.length === 0 && <Pill tone="warn">Not checked</Pill>}
          </div>
          <div className="mt-0.5 text-xs text-muted">{KIND[f.kind].label} · {rangeLabel(f)}</div>
          {readings.length > 0 && (
            <div className="mt-2 flex flex-wrap gap-1.5">
              {readings.map((r) => {
                const bad = outOfRange(f, r.temp)
                return (
                  <button key={r.id} type="button" disabled={!canAct} onClick={() => setOpen(r)}
                    title={[r.recorded_by, r.note].filter(Boolean).join(' · ')}
                    className={`num rounded-lg border px-2 py-1 text-[13px] ${bad ? 'border-bad/40 bg-bad/10 text-bad' : 'border-line bg-surface-2 text-ink-2'}`}>
                    <span className="font-semibold">{deg(r.temp)}</span>
                    <span className="ml-1.5 text-xs opacity-75">{timeOf(r)}</span>
                    {bad && !r.note && <span className="ml-1 text-xs">· no action noted</span>}
                  </button>
                )
              })}
            </div>
          )}
        </div>
        {canAct && (
          <form className="flex items-center gap-2" onSubmit={(e) => { e.preventDefault(); log() }}>
            <TempInput value={value} onChange={setValue} label={`Temperature of ${f.name}`} bad={off} />
            <button className="btn btn-primary" disabled={temp == null || save.isPending}>{save.isPending ? 'Saving…' : 'Log'}</button>
          </form>
        )}
      </div>
      {canAct && off && (
        <div className="mt-2.5 rounded-lg border border-bad/40 bg-bad/10 px-3 py-2.5">
          <p className="text-sm font-medium text-bad">{deg(temp!)} is outside {rangeLabel(f)}. Note what you did about it.</p>
          <input className="field mt-2" value={note} onChange={(e) => setNote(e.target.value)} aria-label="What was done"
            placeholder="Door was open, rechecked in 30 min / moved stock to the walk-in / called for repair…" />
        </div>
      )}
      {save.error && <div className="mt-2"><ErrorBox error={save.error} /></div>}
      {open && <ReadingDrawer reading={open} fridge={f} onClose={() => setOpen(null)} />}
    </li>
  )
}

/** A temperature box with a ± key, because a phone's number pad has no minus. */
function TempInput({ value, onChange, label, bad, id }: { value: string; onChange: (v: string) => void; label?: string; bad?: boolean; id?: string }) {
  const flip = () => onChange(value.startsWith('-') ? value.slice(1) : `-${value}`)
  return (
    <div className={`flex h-[38px] items-center rounded-lg border bg-surface focus-within:border-accent ${bad ? 'border-bad' : 'border-input-line'}`}>
      <button type="button" aria-label="Plus or minus" onClick={flip} className="grid h-full w-8 place-items-center border-r border-line text-ink-2 hover:bg-hover">±</button>
      <input id={id} inputMode="decimal" autoComplete="off" placeholder="0.0" aria-label={label} value={value} onChange={(e) => onChange(e.target.value)}
        className="num w-16 min-w-0 bg-transparent px-2 text-right text-base font-semibold text-ink outline-none focus-visible:outline-none desk:text-sm" />
      <span className="pr-2.5 text-faint">°C</span>
    </div>
  )
}

/** Field's layout, but not wrapped in a label: a tap on the label mustn't press the ± key. */
function TempField({ id, label, hint, children }: { id: string; label: string; hint?: string; children: ReactNode }) {
  return (
    <div className="flex flex-col gap-1.5 text-[13px] font-medium text-ink-2">
      <label htmlFor={id}>{label}</label>
      {children}
      {hint && <span className="text-xs font-normal text-muted">{hint}</span>}
    </div>
  )
}

/** Fix or remove one reading: a typo, or the wrong fridge. Who logged it and when stay as they were. */
function ReadingDrawer({ reading, fridge, onClose }: { reading: FridgeReading; fridge: Fridge; onClose: () => void }) {
  const save = useSave('fridge_readings')
  const remove = useRemove('fridge_readings')
  const [value, setValue] = useState(String(reading.temp))
  const [note, setNote] = useState(reading.note ?? '')
  const temp = parseTemp(value)

  async function submit() {
    if (temp == null) return
    await save.mutateAsync({ id: reading.id, temp, note: note.trim() || null })
    onClose()
  }

  return (
    <Drawer title={fridge.name} sub={`${fmtDay(reading.reading_date)} · logged ${timeOf(reading)}${reading.recorded_by ? ` by ${reading.recorded_by}` : ''}`}
      onClose={onClose} onSubmit={submit}
      footer={<>
        <span className="mr-auto"><DeleteButton busy={remove.isPending} onConfirm={async () => { await remove.mutateAsync(reading.id); onClose() }} /></span>
        <button type="button" className="btn" onClick={onClose}>Cancel</button>
        <button className="btn btn-primary" disabled={temp == null || save.isPending}>{save.isPending ? 'Saving…' : 'Save'}</button>
      </>}>
      <ErrorBox error={save.error || remove.error} />
      <TempField id="reading-temp" label="Temperature" hint={rangeLabel(fridge)}>
        <TempInput id="reading-temp" value={value} onChange={setValue} bad={temp != null && outOfRange(fridge, temp)} />
      </TempField>
      <Field label="What was done" hint="When it was out of range: what you did, and the recheck.">
        <textarea className="field min-h-20 py-2" value={note} onChange={(e) => setNote(e.target.value)} />
      </Field>
    </Drawer>
  )
}

/** A week at a time: a row per day, a column per fridge, ready to print for an inspector. */
function History({ fridges }: { fridges: Fridge[] }) {
  const today = todayStr()
  const [ws, setWs] = useState(weekStart(today))
  const end = addDays(ws, 6)
  const readings = useFridgeReadings(ws, end)
  const rows = readings.data ?? []
  const days = eachDay(ws, end < today ? end : today)
  // Fridges in use, and retired ones that were read that week.
  const cols = fridges.filter((f) => f.active || rows.some((r) => r.fridge_id === f.id))
  const byId = new Map(fridges.map((f) => [f.id, f]))
  const flagged = rows.filter((r) => outOfRange(byId.get(r.fridge_id), r.temp))
  const missed = days.reduce((n, d) => n + cols.filter((f) => f.active && !rows.some((r) => r.fridge_id === f.id && r.reading_date === d)).length, 0)

  return (
    <>
      <div className="mb-3 flex flex-wrap items-center gap-2 print:hidden">
        <div className="flex h-[38px] items-center overflow-hidden rounded-lg border border-input-line bg-surface">
          <button type="button" aria-label="Previous week" className="grid h-full w-9 place-items-center border-r border-line text-ink-2 hover:bg-hover" onClick={() => setWs(addDays(ws, -7))}>‹</button>
          <span className="num whitespace-nowrap px-3.5 text-[13px] font-medium text-ink-2">{fmtShort(ws)} – {fmtShort(end)} {end.slice(0, 4)}</span>
          <button type="button" aria-label="Next week" disabled={end >= today} className="grid h-full w-9 place-items-center border-l border-line text-ink-2 hover:bg-hover disabled:opacity-40" onClick={() => setWs(addDays(ws, 7))}>›</button>
        </div>
        {!readings.isLoading && (
          <span className="flex flex-wrap items-center gap-1.5">
            {missed > 0 ? <Pill tone="warn">{missed} {missed === 1 ? 'check' : 'checks'} missed</Pill> : <Pill tone="success">Every day checked</Pill>}
            {flagged.length > 0 && <Pill tone="danger">{flagged.length} out of range</Pill>}
          </span>
        )}
        <button type="button" className="btn btn-sm ml-auto h-[38px]" onClick={() => window.print()}>Print</button>
      </div>
      <h2 className="mb-3 hidden text-lg font-semibold print:block">Temperature log · {fmtShort(ws)} – {fmtShort(end)} {end.slice(0, 4)}</h2>
      <ErrorBox error={readings.error} />

      {readings.isLoading ? <Loading /> : (
        <section className="card overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-line text-left text-xs text-muted">
                <th className="px-3.5 py-2.5 font-medium desk:px-5">Day</th>
                {cols.map((f) => (
                  <th key={f.id} className="px-3 py-2.5 font-medium">
                    <span className="block whitespace-nowrap text-ink-2">{f.name}</span>
                    <span className="block whitespace-nowrap font-normal">{rangeLabel(f)}</span>
                  </th>
                ))}
              </tr>
            </thead>
            <tbody className="divide-y divide-line-2">
              {days.map((d) => (
                <tr key={d}>
                  <td className="whitespace-nowrap px-3.5 py-2.5 font-medium desk:px-5">{fmtDay(d)}</td>
                  {cols.map((f) => {
                    const here = rows.filter((r) => r.fridge_id === f.id && r.reading_date === d)
                    return (
                      <td key={f.id} className="num px-3 py-2.5 align-top">
                        {here.length === 0 ? (
                          <span className={f.active ? 'text-warn-ink' : 'text-faint'}>—</span>
                        ) : here.map((r) => (
                          <span key={r.id} className={`block whitespace-nowrap ${outOfRange(f, r.temp) ? 'font-semibold text-bad' : ''}`}>
                            {deg(r.temp)} <span className="text-xs font-normal text-muted">{timeOf(r)}</span>
                          </span>
                        ))}
                      </td>
                    )
                  })}
                </tr>
              ))}
            </tbody>
          </table>
        </section>
      )}

      {flagged.length > 0 && (
        <section className="card mt-4 overflow-hidden">
          <div className="border-b border-line px-3.5 py-3 font-semibold desk:px-5">Out of range</div>
          <ul className="divide-y divide-line-2">
            {flagged.map((r) => {
              const f = byId.get(r.fridge_id)!
              return (
                <li key={r.id} className="px-3.5 py-2.5 text-sm desk:px-5">
                  <div><span className="num font-semibold text-bad">{deg(r.temp)}</span> · {f.name} · <span className="text-muted">{fmtDay(r.reading_date)} {timeOf(r)}{r.recorded_by ? ` · ${r.recorded_by}` : ''}</span></div>
                  <div className={r.note ? 'text-ink-2' : 'text-warn-ink'}>{r.note ?? 'No action noted'}</div>
                </li>
              )
            })}
          </ul>
        </section>
      )}
    </>
  )
}

/** Add a fridge, or change its name, range or whether it's still in use. */
function FridgeDrawer({ fridge, fridges, onClose }: { fridge: Fridge | null; fridges: Fridge[]; onClose: () => void }) {
  const save = useSave('fridges')
  const remove = useRemove('fridges')
  const [name, setName] = useState(fridge?.name ?? '')
  const [kind, setKind] = useState<FridgeKind>(fridge?.kind ?? 'fridge')
  const [min, setMin] = useState(fridge?.min_temp != null ? String(fridge.min_temp) : fridge ? '' : '0')
  const [max, setMax] = useState(fridge?.max_temp != null ? String(fridge.max_temp) : fridge ? '' : '5')
  const [active, setActive] = useState(fridge?.active ?? true)

  const minT = min.trim() === '' ? null : parseTemp(min)
  const maxT = max.trim() === '' ? null : parseTemp(max)
  const badMin = min.trim() !== '' && minT == null
  const badMax = max.trim() !== '' && maxT == null
  const crossed = minT != null && maxT != null && minT > maxT
  const ok = name.trim() !== '' && !badMin && !badMax && !crossed

  // A new fridge takes the usual range for its kind.
  function pickKind(k: FridgeKind) {
    setKind(k)
    if (!fridge) {
      setMin(KIND[k].min != null ? String(KIND[k].min) : '')
      setMax(KIND[k].max != null ? String(KIND[k].max) : '')
    }
  }

  async function submit() {
    if (!ok) return
    const row = { name: name.trim(), kind, min_temp: minT, max_temp: maxT, active }
    await save.mutateAsync(fridge ? { id: fridge.id, ...row }
      : { ...row, sort: Math.max(0, ...fridges.map((f) => f.sort)) + 10 })
    onClose()
  }

  const removeError = remove.error && /foreign key|violates/i.test(String(remove.error))
    ? new Error('This fridge has readings, which are kept as a record. Untick “In use” to retire it instead.')
    : remove.error

  return (
    <Drawer title={fridge ? fridge.name : 'Add fridge'} sub="Fridges, freezers and hot displays each have the range they should hold."
      onClose={onClose} onSubmit={submit}
      footer={<>
        {fridge && <span className="mr-auto"><DeleteButton busy={remove.isPending} onConfirm={async () => { await remove.mutateAsync(fridge.id); onClose() }} /></span>}
        <button type="button" className="btn" onClick={onClose}>Cancel</button>
        <button className="btn btn-primary" disabled={!ok || save.isPending}>{save.isPending ? 'Saving…' : fridge ? 'Save' : 'Add fridge'}</button>
      </>}>
      <ErrorBox error={save.error || removeError} />
      <Field label="Name"><input className="field" value={name} onChange={(e) => setName(e.target.value)} placeholder="Drinks fridge, Walk-in freezer…" required autoFocus={!fridge} /></Field>
      <div className="flex flex-col gap-1.5 text-[13px] font-medium text-ink-2">
        Kind
        <Segmented ariaLabel="Kind" value={kind} onChange={pickKind}
          options={(Object.keys(KIND) as FridgeKind[]).map((k) => ({ value: k, label: KIND[k].label }))} />
      </div>
      <div className="grid grid-cols-2 gap-3">
        <TempField id="fridge-min" label="Lowest" hint={badMin ? 'Not a temperature' : 'Blank for no limit'}><TempInput id="fridge-min" value={min} onChange={setMin} bad={badMin || crossed} /></TempField>
        <TempField id="fridge-max" label="Highest" hint={badMax ? 'Not a temperature' : 'Blank for no limit'}><TempInput id="fridge-max" value={max} onChange={setMax} bad={badMax || crossed} /></TempField>
      </div>
      {crossed && <p className="text-sm text-bad">The lowest is above the highest.</p>}
      <p className="text-xs text-muted">Cold food is kept at 5 °C or colder, frozen food at −15 °C or colder, and hot food at 60 °C or hotter.</p>
      {fridge && (
        <label className="flex items-start gap-2.5 text-sm">
          <input type="checkbox" className="mt-0.5" checked={active} onChange={(e) => setActive(e.target.checked)} />
          <span>
            <span className="block font-medium">In use</span>
            <span className="block text-xs text-muted">Untick to retire it: it leaves the daily checks, and its readings stay in History.</span>
          </span>
        </label>
      )}
    </Drawer>
  )
}
