import { useState } from 'react'
import { addDays, monthStart, todayStr, weekStart } from '../lib/dates'

export type Preset = 'week' | '4weeks' | 'month' | 'all' | 'custom'
export interface Range { preset: Preset; from: string; to: string }

const PRESETS: { value: Preset; label: string }[] = [
  { value: 'week', label: 'This week' },
  { value: '4weeks', label: 'Last 4 weeks' },
  { value: 'month', label: 'This month' },
  { value: 'all', label: 'All' },
  { value: 'custom', label: 'Custom' },
]

/** Resolve a preset into dates. "All" starts at the first recorded day. */
export function rangeFor(preset: Preset, earliest: string | null, current?: Range): Range {
  const today = todayStr()
  switch (preset) {
    case 'week': return { preset, from: weekStart(today), to: today }
    case '4weeks': return { preset, from: addDays(weekStart(today), -21), to: today }
    case 'month': return { preset, from: monthStart(today), to: today }
    case 'all': return { preset, from: earliest ?? addDays(today, -365), to: today }
    case 'custom': return { preset, from: current?.from ?? addDays(today, -27), to: current?.to ?? today }
  }
}

export function RangeFilter({ range, onChange, earliest }: { range: Range; onChange: (r: Range) => void; earliest: string | null }) {
  return (
    <div className="flex flex-wrap items-center gap-1.5">
      {PRESETS.map((p) => (
        <button
          key={p.value}
          type="button"
          className="chip"
          aria-pressed={range.preset === p.value}
          onClick={() => onChange(rangeFor(p.value, earliest, range))}
        >
          {p.label}
        </button>
      ))}
      {range.preset === 'custom' && (
        <span className="flex items-center gap-1.5">
          <input type="date" aria-label="From" className="field !w-auto !py-1.5 !text-sm" value={range.from} max={range.to}
            onChange={(e) => e.target.value && onChange({ ...range, from: e.target.value })} />
          <span className="text-muted">–</span>
          <input type="date" aria-label="To" className="field !w-auto !py-1.5 !text-sm" value={range.to} min={range.from}
            onChange={(e) => e.target.value && onChange({ ...range, to: e.target.value })} />
        </span>
      )}
    </div>
  )
}

/** Range state for a page. Remembered per viewer so the dashboard opens where it was left. */
export function useRange(storageKey: string, fallback: Preset, earliest: string | null) {
  const [range, setRangeState] = useState<Range>(() => {
    try {
      const saved = JSON.parse(localStorage.getItem(storageKey) ?? 'null') as Range | null
      if (saved?.preset) return saved.preset === 'custom' ? saved : rangeFor(saved.preset, earliest)
    } catch { /* storage unavailable */ }
    return rangeFor(fallback, earliest)
  })
  // "All" starts at the first recorded date, which arrives after the first render.
  const effective = range.preset === 'all' && earliest && range.from !== earliest ? rangeFor('all', earliest) : range
  const setRange = (r: Range) => {
    setRangeState(r)
    try { localStorage.setItem(storageKey, JSON.stringify(r)) } catch { /* storage unavailable */ }
  }
  return [effective, setRange] as const
}
