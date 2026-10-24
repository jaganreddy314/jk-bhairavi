import { useState } from 'react'
import {
  useAddShifts, useAvailability, usePayrollSettings, usePublicHolidays, usePublishWeek, useRemove, useRosterPeople, useRosterWeek,
  useSales, useSave, useSavePayrollSettings, useShifts,
} from '../lib/api'
import { usePerms } from '../lib/access'
import { useBusiness } from '../lib/business'
import { addDays, fmtShort, toDate, todayStr, weekStart } from '../lib/dates'
import { aud, audRound, cents } from '../lib/format'
import { dayTotal } from '../lib/logic'
import {
  ageOn, DOW_SHORT, employmentLabel, fmtHours, fmtTime, payRates, rateOn, ruleSetOn, shiftCost, type PayRates,
} from '../lib/payroll'
import type { PublicHoliday, RosterPerson, Shift, StaffAvailability } from '../lib/types'
import { fmtDate, usePayLookup } from '../components/people'
import { Drawer, ErrorBox, Field, Kpi, KPI_GRID, Loading, Pill } from '../components/ui'

const fLong = new Intl.DateTimeFormat('en-AU', { timeZone: 'UTC', weekday: 'long', day: 'numeric', month: 'long' })
const fDay = new Intl.DateTimeFormat('en-AU', { timeZone: 'UTC', weekday: 'short', day: 'numeric' })
const fStamp = new Intl.DateTimeFormat('en-AU', { day: 'numeric', month: 'short' })
const AVATAR = ['#0F766E', '#444CE7', '#C11574', '#B54708', '#026AA2', '#475467']
const colourOf = (id: string) => AVATAR[[...id].reduce((h, c) => (h * 31 + c.charCodeAt(0)) >>> 0, 7) % AVATAR.length]
const hrs = (s: Pick<Shift, 'start_minute' | 'end_minute' | 'break_minutes'>) => (s.end_minute - s.start_minute - s.break_minutes) / 60

/** Times offered in the editor: 5am to midnight, every half hour. */
const TIMES = Array.from({ length: 39 }, (_, i) => 300 + i * 30)

export default function Schedule() {
  const { can } = usePerms()
  const { business } = useBusiness()
  const thisWeek = weekStart(todayStr())
  // Rosters are made for the week ahead, so that's where the page opens.
  const [ws, setWs] = useState(addDays(thisWeek, 7))
  const days = Array.from({ length: 7 }, (_, i) => addDays(ws, i))
  const people = useRosterPeople()
  const shifts = useShifts(addDays(ws, -7), addDays(ws, 6))
  const week = useRosterWeek(ws)
  const avail = useAvailability()
  const settings = usePayrollSettings()
  const holidays = usePublicHolidays()
  const sales = useSales(addDays(thisWeek, -28), addDays(thisWeek, -1))
  const pay = usePayLookup()
  const addShifts = useAddShifts()
  const publish = usePublishWeek()
  const [editing, setEditing] = useState<Partial<Shift> | null>(null)
  const [mDay, setMDay] = useState(0)
  const [toast, setToast] = useState('')
  const [hoursOpen, setHoursOpen] = useState(false)
  const edit = can('roster')

  if (people.isLoading || shifts.isLoading || !pay.ready || settings.isLoading) return <Loading />
  const open = settings.data?.store_open ?? 360, close = settings.data?.store_close ?? 1320
  const region = settings.data?.holiday_region ?? 'QLD-BNE'
  const holidayOn = (d: string): PublicHoliday | null =>
    (holidays.data ?? []).find((h) => h.holiday_date === d && (h.region === 'QLD' || h.region === region)) ?? null

  const all = shifts.data ?? []
  const mine = all.filter((s) => s.shift_date >= ws)
  const prev = all.filter((s) => s.shift_date < ws)
  // On the roster: current staff who haven't finished before the week, and anyone with a shift in it.
  const roster = (people.data ?? []).filter((p) =>
    mine.some((s) => s.staff_id === p.id) || (p.status === 'active' && (!p.end_date || p.end_date >= ws)))
  const byId = new Map((people.data ?? []).map((p) => [p.id, p]))

  // Each person's rates for the week (junior rates follow their age on the Monday).
  const ratesOf = new Map<string, PayRates | null>()
  for (const p of people.data ?? []) {
    const c = pay.classes.find((x) => x.id === p.classification_id)
    ratesOf.set(p.id, c ? payRates(p, rateOn(pay.rates, c.id, ws), ruleSetOn(pay.rules, c.award_code, c.rule_set_key, ws), ws) : null)
  }
  const costOf = (s: Pick<Shift, 'staff_id' | 'shift_date' | 'start_minute' | 'end_minute' | 'break_minutes'>) => {
    const r = ratesOf.get(s.staff_id)
    return r ? shiftCost(r, s.shift_date, s.start_minute, s.end_minute, s.break_minutes, holidayOn(s.shift_date)) : null
  }
  const issues = (s: Pick<Shift, 'id' | 'staff_id' | 'shift_date' | 'start_minute' | 'end_minute'>) =>
    shiftIssues(s, byId.get(s.staff_id), (avail.data ?? []).filter((a) => a.staff_id === s.staff_id), mine, pay.classes.find((c) => c.id === byId.get(s.staff_id)?.classification_id)?.award_code)

  // ---- warnings ----
  const warnings: { who: string; text: string; shift?: Shift; day?: number }[] = []
  for (const p of roster) {
    const ps = mine.filter((s) => s.staff_id === p.id)
    const h = ps.reduce((t, s) => t + hrs(s), 0)
    for (const s of ps) for (const t of issues(s)) warnings.push({ who: firstName(p), text: `${DOW_SHORT[days.indexOf(s.shift_date)]} ${fmtTime(s.start_minute)}: ${t}.`, shift: s })
    if (p.fortnight_hour_limit) {
      const ph = prev.filter((s) => s.staff_id === p.id).reduce((t, s) => t + hrs(s), 0)
      if (ph + h > p.fortnight_hour_limit) warnings.push({ who: firstName(p), text: `has ${fmtHours(ph + h)} over this fortnight. Their visa allows ${p.fortnight_hour_limit} hours a fortnight.`, shift: ps[0] })
    }
    if (p.employment_type === 'full_time' && h > 38) warnings.push({ who: firstName(p), text: `is rostered ${fmtHours(h)}. Hours over 38 are overtime.`, shift: ps[0] })
    if (p.employment_type === 'part_time' && p.ordinary_hours && h > p.ordinary_hours) warnings.push({ who: firstName(p), text: `is rostered ${fmtHours(h)}, more than their agreed ${p.ordinary_hours} hours. The extra is overtime unless they agree in writing.`, shift: ps[0] })
    if (ps.length && !ratesOf.get(p.id)) warnings.push({ who: firstName(p), text: 'has no award classification, so their shifts aren’t costed. Set it in People.' })
  }
  const dayInfo = days.map((d, i) => {
    const ds = mine.filter((s) => s.shift_date === d)
    const cover = coverage(ds, open, close)
    // An empty week is just not started yet; gaps only mean something once there's a roster.
    if (mine.length && cover.gaps.length) warnings.push({ who: fLong.format(toDate(d)).split(' ')[0], text: `has no one rostered ${cover.gaps.map(([a, b]) => `${fmtTime(a)} – ${fmtTime(b)}`).join(', ')}.`, day: i })
    return { d, ds, cover, hours: ds.reduce((t, s) => t + hrs(s), 0), cost: cents(ds.reduce((t, s) => t + (costOf(s)?.cost ?? 0), 0)), holiday: holidayOn(d) }
  })

  const totH = mine.reduce((t, s) => t + hrs(s), 0)
  const totC = cents(mine.reduce((t, s) => t + (costOf(s)?.cost ?? 0), 0))
  const superRate = settings.data?.super_rate ?? 12
  // Labour against what a usual week sells: the last four full weeks of sales.
  const salesWeeks = new Set((sales.data ?? []).map((d) => weekStart(d.sale_date))).size
  const usualSales = salesWeeks ? cents((sales.data ?? []).reduce((t, d) => t + dayTotal(d), 0) / salesWeeks) : 0
  const peopleN = new Set(mine.map((s) => s.staff_id)).size
  const published = !!week.data?.published_at
  const dirty = !!week.data?.changed_since_publish
  const status = published && !dirty ? { tone: 'success' as const, label: `Published ${fStamp.format(new Date(week.data!.published_at!))}` }
    : published ? { tone: 'warn' as const, label: 'Published · changes not sent' } : { tone: 'neutral' as const, label: 'Draft' }
  const tag = ws === thisWeek ? 'This week' : ws === addDays(thisWeek, 7) ? 'Next week' : ws < thisWeek ? 'Past week' : `In ${Math.round((toDate(ws).getTime() - toDate(thisWeek).getTime()) / 6048e5)} weeks`

  async function copyLast() {
    if (!prev.length) { setToast('Nothing rostered last week to copy.'); return }
    const taken = new Set(mine.map((s) => `${s.staff_id}|${s.shift_date}|${s.start_minute}`))
    const rows = prev.map((s) => ({ staff_id: s.staff_id, shift_date: addDays(s.shift_date, 7), start_minute: s.start_minute, end_minute: s.end_minute, break_minutes: s.break_minutes, note: s.note }))
      .filter((s) => !taken.has(`${s.staff_id}|${s.shift_date}|${s.start_minute}`))
    if (rows.length) await addShifts.mutateAsync(rows)
    setToast(`Copied ${rows.length} shift${rows.length === 1 ? '' : 's'} from last week.`)
  }
  async function doPublish() {
    await publish.mutateAsync(ws)
    setToast(`Roster published for ${peopleN} ${peopleN === 1 ? 'person' : 'people'}. Use “Copy roster” to send it to them.`)
  }
  async function copyText() {
    await navigator.clipboard.writeText(rosterText(business?.name ?? '', ws, roster, mine))
    setToast('Roster copied — paste it into your team chat, a text or an email.')
  }
  const openNew = (staffId: string, day: number) => {
    const has = mine.some((s) => s.shift_date === days[day])
    setEditing({ staff_id: staffId, shift_date: days[day], start_minute: has ? 840 : open, end_minute: has ? close : 840, break_minutes: 30 })
  }

  return (
    <div>
      <div className="flex flex-wrap items-end justify-between gap-4">
        <div>
          <div className="flex flex-wrap items-center gap-2.5">
            <h1 className="text-2xl font-semibold tracking-[-0.02em]">Schedule</h1>
            <Pill tone={status.tone}>{status.label}</Pill>
          </div>
          <p className="mt-1 text-sm text-muted">
            Weekly roster, Monday to Sunday. Store open {fmtTime(open)} – {fmtTime(close)}.
            {can('payroll') && <button type="button" className="ml-1.5 font-medium text-accent" onClick={() => setHoursOpen(true)}>Change</button>}
          </p>
        </div>
        <div className="flex flex-wrap gap-2">
          {mine.length > 0 && <button type="button" className="btn h-[38px] font-medium" onClick={copyText}>Copy roster</button>}
          {edit && <button type="button" className="btn h-[38px] font-medium" disabled={addShifts.isPending} onClick={copyLast}>Copy last week</button>}
          {edit && (
            <button type="button" className={`btn h-[38px] ${published && !dirty ? 'btn-saved' : 'btn-primary'}`} disabled={(published && !dirty) || !mine.length || publish.isPending} onClick={doPublish}>
              {published && !dirty ? 'Published' : published ? 'Publish changes' : 'Publish'}
            </button>
          )}
        </div>
      </div>

      <div className="mt-4 flex flex-wrap items-center gap-2">
        <div className="flex h-[38px] items-center overflow-hidden rounded-lg border border-input-line bg-surface">
          <button type="button" aria-label="Previous week" className="grid h-full w-9 place-items-center border-r border-line text-ink-2 hover:bg-hover" onClick={() => { setWs(addDays(ws, -7)); setToast('') }}>‹</button>
          <span className="num whitespace-nowrap px-3.5 text-[13px] font-medium text-ink-2">{fmtShort(ws)} – {fmtShort(addDays(ws, 6))} {addDays(ws, 6).slice(0, 4)}</span>
          <button type="button" aria-label="Next week" className="grid h-full w-9 place-items-center border-l border-line text-ink-2 hover:bg-hover" onClick={() => { setWs(addDays(ws, 7)); setToast('') }}>›</button>
        </div>
        <span className="text-[13px] text-muted">{tag}</span>
        {ws !== addDays(thisWeek, 7) && <button type="button" className="btn btn-sm h-[38px] font-medium" onClick={() => setWs(addDays(thisWeek, 7))}>Next week</button>}
      </div>

      {toast && <div role="status" className="mt-3 rounded-[10px] border border-[#ABEFC6] bg-[#ECFDF3] px-3.5 py-2.5 text-sm text-[#067647] dark:border-[#085D3A] dark:bg-[#053321] dark:text-[#75E0A7]">{toast}</div>}
      <div className="mt-3"><ErrorBox error={shifts.error || addShifts.error || publish.error} /></div>

      <div className={`${KPI_GRID} mt-1`}>
        <Kpi label="Rostered hours" value={fmtHours(totH)} note={`${mine.length} shifts · ${peopleN} ${peopleN === 1 ? 'person' : 'people'}`} />
        <Kpi label="Wage cost" value={audRound(totC)} note="Award rates incl. casual, weekend and holiday rates" />
        <Kpi label="Super" value={audRound(cents(totC * superRate / 100))} note={`${superRate}%, paid with wages (Payday Super)`} />
        <Kpi label="Labour vs sales" value={usualSales ? `${((totC / usualSales) * 100).toFixed(1)}%` : '—'}
          note={usualSales ? `Against a usual week’s sales of ${audRound(usualSales)}` : 'No recent sales to compare with'} />
      </div>

      {mine.length === 0 && (
        <div className="mt-4 rounded-xl border border-line bg-surface px-4 py-3 text-sm text-muted">
          Nothing rostered for this week yet. {edit ? 'Tap + in a day to add a shift, or copy last week’s roster.' : ''}
        </div>
      )}

      {warnings.length > 0 && (
        <div className="mt-4 rounded-xl border border-warn-line bg-warn-bg px-4 py-3 text-warn-ink">
          <div className="text-sm font-semibold">{warnings.length} thing{warnings.length === 1 ? '' : 's'} to check{published ? '' : ' before publishing'}</div>
          <div className="mt-2 flex flex-col gap-1.5">
            {warnings.map((w, i) => (
              <button key={i} type="button" className="flex items-start gap-2 text-left text-[13px]"
                onClick={() => (w.shift && edit ? setEditing(w.shift) : w.day != null ? setMDay(w.day) : undefined)}>
                <span className="mt-1.5 h-1.5 w-1.5 shrink-0 rounded-full bg-[#F79009]" />
                <span><strong className="font-semibold">{w.who}</strong> {w.text}</span>
              </button>
            ))}
          </div>
        </div>
      )}

      {/* Computer: people down the side, days across. */}
      <div className="card mt-4 hidden overflow-x-auto desk:block">
        <div className="min-w-[980px]">
          <div className="grid grid-cols-[200px_repeat(7,minmax(108px,1fr))] border-b border-line bg-hover">
            <div className="flex items-end px-3.5 py-2.5 text-xs font-medium text-muted">Person</div>
            {dayInfo.map((d, i) => <DayHead key={d.d} d={d} i={i} />)}
          </div>
          {roster.map((p) => {
            const ps = mine.filter((s) => s.staff_id === p.id)
            const h = ps.reduce((t, s) => t + hrs(s), 0)
            const c = cents(ps.reduce((t, s) => t + (costOf(s)?.cost ?? 0), 0))
            const pa = (avail.data ?? []).filter((a) => a.staff_id === p.id)
            return (
              <div key={p.id} className="grid grid-cols-[200px_repeat(7,minmax(108px,1fr))] border-b border-line-2">
                <div className="flex min-w-0 items-center gap-2.5 px-3.5 py-2.5">
                  <Initials p={p} size={32} />
                  <div className="min-w-0">
                    <div className="truncate text-[13px] font-semibold">{p.name}</div>
                    <div className="num truncate text-xs text-muted">{employmentLabel(p.employment_type)} · {fmtHours(h)} · {audRound(c)}</div>
                  </div>
                </div>
                {days.map((d, i) => {
                  const notYet = !!p.start_date && d < p.start_date
                  const gone = !!p.end_date && d > p.end_date
                  const av = pa.find((a) => a.dow === i + 1)
                  const cs = ps.filter((s) => s.shift_date === d)
                  return (
                    <div key={d} className={`flex min-h-16 flex-col gap-1 border-l border-line-2 p-1.5 ${notYet || gone ? 'bg-[repeating-linear-gradient(135deg,var(--hover)_0_6px,var(--surface-2)_6px_12px)]' : av && !av.available ? 'bg-hover' : ''}`}>
                      {cs.map((s) => <ShiftChip key={s.id} s={s} cost={costOf(s)?.cost ?? null} issue={issues(s)[0]} colour={colourOf(p.id)} onClick={edit ? () => setEditing(s) : undefined} />)}
                      {edit && !notYet && !gone && (
                        <button type="button" aria-label={`Add a shift for ${p.name} on ${fDay.format(toDate(d))}`} onClick={() => openNew(p.id, i)}
                          className="min-h-7 flex-1 rounded-lg border border-dashed border-transparent text-base text-faint hover:border-input-line hover:bg-hover hover:text-ink-2">+</button>
                      )}
                      {!cs.length && (notYet && i === 0 ? <span className="px-1 text-[11px] text-faint">Starts {fmtShort(p.start_date!)}</span>
                        : av && !av.available ? <span className="px-1 text-[11px] text-faint">{av.note || 'Not available'}</span>
                        : av?.from_minute != null ? <span className="px-1 text-[11px] text-faint">After {fmtTime(av.from_minute)}</span> : null)}
                    </div>
                  )
                })}
              </div>
            )
          })}
          {roster.length === 0 && <p className="py-10 text-center text-muted">No one on the team yet. Add people first.</p>}
          <div className="num grid grid-cols-[200px_repeat(7,minmax(108px,1fr))] bg-hover">
            <div className="px-3.5 py-2.5 text-xs font-semibold text-ink-2">Wage cost</div>
            {dayInfo.map((d) => <div key={d.d} className="border-l border-line-2 p-2.5 text-[13px] font-semibold">{audRound(d.cost)}</div>)}
          </div>
        </div>
      </div>

      {/* Phone: one day at a time. */}
      <div className="desk:hidden">
        <div className="mt-4 grid grid-cols-7 gap-1.5">
          {dayInfo.map((d, i) => (
            <button key={d.d} type="button" onClick={() => setMDay(i)}
              className={`flex min-w-0 flex-col items-center gap-0.5 rounded-[10px] border px-0.5 py-2 ${i === mDay ? 'border-accent bg-accent-tint' : 'border-line bg-surface'}`}>
              <span className="text-[11px] font-medium uppercase text-muted">{DOW_SHORT[i]}</span>
              <span className={`num text-[17px] font-semibold ${i === mDay ? 'text-accent' : ''}`}>{Number(d.d.slice(8))}</span>
              <span className="h-1.5 w-1.5 rounded-full" style={{ background: d.cover.gaps.length ? '#F04438' : '#17B26A' }} />
            </button>
          ))}
        </div>
        <div className="card mt-3 overflow-hidden">
          <div className="border-b border-line-2 px-3.5 py-3">
            <div className="flex justify-between gap-2">
              <strong className="font-semibold">{fLong.format(toDate(dayInfo[mDay].d))}</strong>
              <span className="num text-[13px] text-muted">{fmtHours(dayInfo[mDay].hours)} · {audRound(dayInfo[mDay].cost)}</span>
            </div>
            {dayInfo[mDay].holiday && <div className="mt-0.5 text-xs font-medium text-accent">{dayInfo[mDay].holiday!.name}</div>}
            <CoverBar segs={dayInfo[mDay].cover.segs} />
            <div className={`mt-1 text-xs ${dayInfo[mDay].cover.gaps.length ? 'text-bad' : 'text-good'}`}>{dayInfo[mDay].cover.text}</div>
          </div>
          {dayInfo[mDay].ds.map((s) => {
            const p = byId.get(s.staff_id)
            const iss = issues(s)[0]
            return (
              <button key={s.id} type="button" disabled={!edit} onClick={() => setEditing(s)}
                className="flex w-full items-center gap-3 border-b border-line-2 px-3.5 py-3 text-left" style={{ boxShadow: `inset 3px 0 0 ${iss ? '#F79009' : colourOf(s.staff_id)}` }}>
                {p && <Initials p={p} size={36} />}
                <span className="min-w-0 flex-1">
                  <span className="block font-semibold">{p?.name}</span>
                  <span className={`block text-xs ${iss ? 'text-warn-ink' : 'text-muted'}`}>{iss ?? `${fmtHours(hrs(s))} · ${costOf(s) ? aud(costOf(s)!.cost) : 'not costed'}`}</span>
                </span>
                <span className="num whitespace-nowrap font-semibold">{fmtTime(s.start_minute)} – {fmtTime(s.end_minute)}</span>
              </button>
            )
          })}
          {edit && roster[0] && (
            <button type="button" className="h-12 w-full font-semibold text-accent" onClick={() => openNew(roster[0].id, mDay)}>+ Add shift</button>
          )}
        </div>
      </div>

      {editing && (
        <ShiftEditor key={editing.id ?? 'new'} shift={editing} days={days} people={roster} onClose={() => setEditing(null)}
          costOf={costOf} issues={issues} />
      )}
      {hoursOpen && <StoreHours open={open} close={close} region={region} onClose={() => setHoursOpen(false)} />}
    </div>
  )
}

const firstName = (p: RosterPerson) => p.first_name || p.name.split(' ')[0]

function Initials({ p, size }: { p: RosterPerson; size: number }) {
  const c = colourOf(p.id)
  return (
    <span style={{ width: size, height: size, color: c, background: `color-mix(in srgb, ${c} 13%, var(--surface))`, fontSize: size * 0.36 }}
      className="grid shrink-0 place-items-center rounded-full font-semibold">
      {((p.first_name?.[0] ?? p.name[0] ?? '?') + (p.last_name?.[0] ?? '')).toUpperCase()}
    </span>
  )
}

/** What the store is short of: merged shift cover inside opening hours, and the gaps left. */
function coverage(ds: Shift[], open: number, close: number) {
  const iv = ds.map((s) => [Math.max(open, s.start_minute), Math.min(close, s.end_minute)] as [number, number]).filter(([a, b]) => b > a).sort((a, b) => a[0] - b[0])
  const merged: [number, number][] = []
  for (const [a, b] of iv) {
    const l = merged[merged.length - 1]
    if (l && a <= l[1]) l[1] = Math.max(l[1], b)
    else merged.push([a, b])
  }
  const gaps: [number, number][] = []
  let c = open
  for (const [a, b] of merged) { if (a > c) gaps.push([c, a]); c = Math.max(c, b) }
  if (c < close) gaps.push([c, close])
  const span = close - open || 1
  return {
    segs: merged.map(([a, b]) => ({ left: ((a - open) / span) * 100, width: ((b - a) / span) * 100 })),
    gaps,
    text: gaps.length ? `Gap ${gaps.map(([a, b]) => `${fmtTime(a)} – ${fmtTime(b)}`).join(', ')}` : 'Covered all day',
  }
}

function CoverBar({ segs }: { segs: { left: number; width: number }[] }) {
  return (
    <div className="relative mt-2 h-1.5 overflow-hidden rounded-[3px] bg-[#FEE4E2] dark:bg-[#55160C]">
      {segs.map((g, i) => <span key={i} className="absolute inset-y-0 bg-accent" style={{ left: `${g.left}%`, width: `${g.width}%` }} />)}
    </div>
  )
}

function DayHead({ d, i }: { d: { d: string; hours: number; cover: ReturnType<typeof coverage>; holiday: PublicHoliday | null }; i: number }) {
  return (
    <div className={`border-l border-line-2 px-2.5 pb-2 pt-2.5 ${i >= 5 ? 'bg-[color-mix(in_srgb,var(--hover)_60%,var(--surface-2))]' : ''}`}>
      <div className="flex items-baseline justify-between gap-1.5">
        <span className="text-[13px] font-semibold">{fDay.format(toDate(d.d))}</span>
        <span className="num text-[11px] text-muted">{fmtHours(d.hours)}</span>
      </div>
      {d.holiday && <div className="truncate text-[11px] font-medium text-accent" title={d.holiday.name}>{d.holiday.name}</div>}
      <div title={d.cover.text}><CoverBar segs={d.cover.segs} /></div>
      <div className={`mt-1 truncate text-[11px] ${d.cover.gaps.length ? 'text-bad' : 'text-good'}`}>{d.cover.text}</div>
    </div>
  )
}

function ShiftChip({ s, cost, issue, colour, onClick }: { s: Shift; cost: number | null; issue?: string; colour: string; onClick?: () => void }) {
  return (
    <button type="button" onClick={onClick} disabled={!onClick}
      className={`flex w-full flex-col items-start gap-px rounded-lg border px-2 py-1.5 text-left ${issue ? 'border-[#FEC84B] bg-[#FFFCF5] dark:bg-[#1F1A10]' : 'border-line bg-surface'}`}
      style={{ boxShadow: `inset 3px 0 0 ${issue ? '#F79009' : colour}` }}>
      <span className="num whitespace-nowrap text-xs font-semibold">{fmtTime(s.start_minute)} – {fmtTime(s.end_minute)}</span>
      <span className={`max-w-full truncate text-[11px] ${issue ? 'text-warn-ink' : 'text-muted'}`}>
        {issue ?? `${fmtHours(hrs(s))} · ${cost != null ? audRound(cost) : 'not costed'}`}
      </span>
    </button>
  )
}

/** Everything about one shift that breaks a rule or someone's availability. */
function shiftIssues(s: Pick<Shift, 'id' | 'staff_id' | 'shift_date' | 'start_minute' | 'end_minute'>, p: RosterPerson | undefined, avail: StaffAvailability[], week: Shift[], awardCode: string | undefined): string[] {
  if (!p) return []
  const out: string[] = []
  const dow = ((toDate(s.shift_date).getUTCDay() + 6) % 7) + 1
  if (p.start_date && s.shift_date < p.start_date) out.push(`starts ${fmtDate(p.start_date)}`)
  if (p.end_date && s.shift_date > p.end_date) out.push(`finished ${fmtDate(p.end_date)}`)
  const a = avail.find((x) => x.dow === dow)
  if (a && !a.available) out.push(`marked unavailable${a.note ? ` (${a.note})` : ''}`)
  if (a?.available && a.from_minute != null && s.start_minute < a.from_minute) out.push(`only available after ${fmtTime(a.from_minute)}`)
  if (a?.available && a.to_minute != null && s.end_minute > a.to_minute) out.push(`only available until ${fmtTime(a.to_minute)}`)
  if (p.employment_type === 'part_time' && p.agreed_dows?.length && !p.agreed_dows.includes(dow)) out.push('outside their agreed part-time days')
  const age = ageOn(p.date_of_birth, s.shift_date)
  if (awardCode === 'MA000089' && age != null && age < 18 && (s.end_minute > 1260 || s.start_minute < 390)) out.push('under 18 can’t work 9pm – 6:30am under this award')
  if (week.some((o) => o.id !== s.id && o.staff_id === s.staff_id && o.shift_date === s.shift_date && o.start_minute < s.end_minute && s.start_minute < o.end_minute)) out.push('overlaps another of their shifts')
  return out
}

function ShiftEditor({ shift, days, people, onClose, costOf, issues }: {
  shift: Partial<Shift>; days: string[]; people: RosterPerson[]; onClose: () => void
  costOf: (s: Pick<Shift, 'staff_id' | 'shift_date' | 'start_minute' | 'end_minute' | 'break_minutes'>) => ReturnType<typeof shiftCost> | null
  issues: (s: Pick<Shift, 'id' | 'staff_id' | 'shift_date' | 'start_minute' | 'end_minute'>) => string[]
}) {
  const save = useSave('shifts')
  const remove = useRemove('shifts')
  const [v, setV] = useState({
    staff_id: shift.staff_id ?? people[0]?.id ?? '', shift_date: shift.shift_date ?? days[0],
    start_minute: shift.start_minute ?? 360, end_minute: shift.end_minute ?? 840, break_minutes: shift.break_minutes ?? 30, note: shift.note ?? '',
  })
  const bad = v.end_minute <= v.start_minute ? 'Finish must be after start.' : v.break_minutes >= v.end_minute - v.start_minute ? 'The break is longer than the shift.' : null
  const c = bad ? null : costOf(v)
  const iss = bad ? [] : issues({ id: shift.id ?? '', ...v })
  const person = people.find((p) => p.id === v.staff_id)
  async function submit() {
    if (bad) return
    await save.mutateAsync({ ...(shift.id ? { id: shift.id } : {}), ...v, note: v.note.trim() || null })
    onClose()
  }
  return (
    <Drawer title={shift.id ? 'Edit shift' : 'Add shift'} onClose={onClose} onSubmit={submit}
      footer={<>
        {shift.id && <button type="button" className="btn mr-auto border-[#FDA29B] text-[#B42318]" disabled={remove.isPending} onClick={async () => { await remove.mutateAsync(shift.id!); onClose() }}>Delete</button>}
        <button type="button" className="btn" onClick={onClose}>Cancel</button>
        <button className="btn btn-primary" disabled={!!bad || save.isPending}>{save.isPending ? 'Saving…' : 'Save shift'}</button>
      </>}>
      <ErrorBox error={save.error || remove.error} />
      <Field label="Person">
        <select className="field" value={v.staff_id} onChange={(e) => setV({ ...v, staff_id: e.target.value })}>
          {people.map((p) => <option key={p.id} value={p.id}>{p.name} · {employmentLabel(p.employment_type)}</option>)}
        </select>
      </Field>
      <Field label="Day">
        <select className="field" value={v.shift_date} onChange={(e) => setV({ ...v, shift_date: e.target.value })}>
          {days.map((d) => <option key={d} value={d}>{fLong.format(toDate(d))}</option>)}
        </select>
      </Field>
      <div className="grid grid-cols-2 gap-3">
        <Field label="Start">
          <select className="field" value={v.start_minute} onChange={(e) => setV({ ...v, start_minute: Number(e.target.value) })}>
            {TIMES.map((t) => <option key={t} value={t}>{fmtTime(t)}</option>)}
          </select>
        </Field>
        <Field label="Finish">
          <select className="field" value={v.end_minute} onChange={(e) => setV({ ...v, end_minute: Number(e.target.value) })}>
            {TIMES.map((t) => <option key={t} value={t}>{fmtTime(t)}</option>)}
          </select>
        </Field>
      </div>
      <Field label="Unpaid break">
        <select className="field" value={v.break_minutes} onChange={(e) => setV({ ...v, break_minutes: Number(e.target.value) })}>
          <option value={0}>None</option><option value={30}>30 min</option><option value={45}>45 min</option><option value={60}>1 hour</option>
        </select>
      </Field>
      <Field label="Note"><input className="field" value={v.note} onChange={(e) => setV({ ...v, note: e.target.value })} placeholder="e.g. delivery at 7am" /></Field>
      <div className="num grid gap-1 rounded-[10px] border border-line bg-hover p-3 text-sm">
        <div className="flex justify-between"><span className="text-ink-2">Paid hours</span><strong className="font-semibold">{bad ? '—' : fmtHours(hrs(v))}</strong></div>
        <div className="flex justify-between"><span className="text-ink-2">Rate · {person ? employmentLabel(person.employment_type).toLowerCase() : ''}{c ? `, ${c.mainLabel}` : ''}</span><strong className="font-semibold">{c ? `${aud(c.mainRate)}/hr` : '—'}</strong></div>
        <div className="flex justify-between"><span className="text-ink-2">Shift cost</span><strong className="font-semibold">{c ? aud(c.cost) : bad ? '—' : 'No award rate set'}</strong></div>
        {c?.holiday && <div className="text-xs text-accent">{c.holiday}</div>}
      </div>
      {(bad ? [bad] : iss.map((t) => `${person ? firstName(person) : 'They'} ${t}.`)).map((w) => (
        <div key={w} className="rounded-[10px] bg-warn-bg px-3 py-2.5 text-[13px] text-warn-ink">{w}</div>
      ))}
    </Drawer>
  )
}

function StoreHours({ open, close, region, onClose }: { open: number; close: number; region: string; onClose: () => void }) {
  const save = useSavePayrollSettings()
  const [v, setV] = useState({ store_open: open, store_close: close, holiday_region: region as 'QLD' | 'QLD-BNE' })
  const times = Array.from({ length: 49 }, (_, i) => i * 30)
  return (
    <Drawer title="Store hours" sub="The roster flags any time the store is open with no one on." onClose={onClose}
      onSubmit={async () => { if (v.store_close > v.store_open) { await save.mutateAsync(v); onClose() } }}
      footer={<><button type="button" className="btn" onClick={onClose}>Cancel</button><button className="btn btn-primary" disabled={v.store_close <= v.store_open || save.isPending}>Save</button></>}>
      <ErrorBox error={save.error} />
      <div className="grid grid-cols-2 gap-3">
        <Field label="Opens"><select className="field" value={v.store_open} onChange={(e) => setV({ ...v, store_open: Number(e.target.value) })}>{times.map((t) => <option key={t} value={t}>{fmtTime(t)}</option>)}</select></Field>
        <Field label="Closes"><select className="field" value={v.store_close} onChange={(e) => setV({ ...v, store_close: Number(e.target.value) })}>{times.map((t) => <option key={t} value={t}>{fmtTime(t)}</option>)}</select></Field>
      </div>
      <Field label="Public holidays" hint="The Royal Queensland Show day is a holiday in the Brisbane area only.">
        <select className="field" value={v.holiday_region} onChange={(e) => setV({ ...v, holiday_region: e.target.value as 'QLD' })}>
          <option value="QLD-BNE">Queensland, Brisbane area</option>
          <option value="QLD">Queensland, outside Brisbane</option>
        </select>
      </Field>
    </Drawer>
  )
}

/** The week as plain text, one person at a time, to paste into a chat or a message. */
function rosterText(business: string, ws: string, people: RosterPerson[], shifts: Shift[]) {
  const out = [`${business} roster · ${fmtShort(ws)} – ${fmtShort(addDays(ws, 6))}`, '']
  for (const p of people) {
    const ps = shifts.filter((s) => s.staff_id === p.id).sort((a, b) => a.shift_date.localeCompare(b.shift_date) || a.start_minute - b.start_minute)
    if (!ps.length) continue
    out.push(`${p.name} — ${fmtHours(ps.reduce((t, s) => t + hrs(s), 0))}`)
    for (const s of ps) out.push(`  ${fDay.format(toDate(s.shift_date))}  ${fmtTime(s.start_minute)} – ${fmtTime(s.end_minute)}${s.break_minutes ? ` (${s.break_minutes} min break)` : ''}${s.note ? ` · ${s.note}` : ''}`)
    out.push('')
  }
  return out.join('\n').trim()
}
