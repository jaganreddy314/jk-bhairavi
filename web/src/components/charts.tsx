import { useEffect, useState, type ReactNode } from 'react'
import { audShort } from '../lib/format'

// Recharts writes colours into SVG attributes, where CSS var() isn't reliable, so resolve the
// theme tokens to real colours and re-resolve whenever light/dark changes.
const TOKENS = ['c-sales', 'c-cash', 'c-expenses', 'c-profit', 'c-food', 'ink', 'ink-2', 'muted', 'line', 'axis', 'surface', 'bad', 'good'] as const
export type Palette = Record<(typeof TOKENS)[number], string>

function read(): Palette {
  const cs = getComputedStyle(document.documentElement)
  return Object.fromEntries(TOKENS.map((t) => [t, cs.getPropertyValue(`--${t}`).trim()])) as Palette
}

export function usePalette(): Palette {
  const [p, setP] = useState(read)
  useEffect(() => {
    const update = () => setP(read())
    const mq = window.matchMedia('(prefers-color-scheme: dark)')
    mq.addEventListener('change', update)
    const mo = new MutationObserver(update)
    mo.observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme'] })
    return () => { mq.removeEventListener('change', update); mo.disconnect() }
  }, [])
  return p
}

export const axisProps = (p: Palette) => ({
  tick: { fill: p.muted, fontSize: 12 },
  tickLine: false,
  axisLine: { stroke: p.axis },
})

export function ChartCard({ title, subtitle, legend, children, className = '' }: {
  title: string; subtitle?: ReactNode; legend?: ReactNode; children: ReactNode; className?: string
}) {
  return (
    <section className={`card min-w-0 p-4 desk:p-5 ${className}`}>
      <div className="mb-3 flex flex-wrap items-start justify-between gap-3">
        <div>
          <h2 className="text-base font-semibold">{title}</h2>
          {subtitle && <p className="mt-0.5 text-[13px] text-muted">{subtitle}</p>}
        </div>
        {legend}
      </div>
      {children}
    </section>
  )
}

export function Legend({ items }: { items: { label: string; color: string; line?: boolean }[] }) {
  return (
    <div className="flex flex-wrap gap-4 text-[13px] text-ink-2">
      {items.map((i) => (
        <span key={i.label} className="inline-flex items-center gap-1.5">
          <span className={i.line ? 'h-0.5 w-3.5 rounded' : 'h-2.5 w-2.5 rounded-[3px]'} style={{ background: i.color }} />
          {i.label}
        </span>
      ))}
    </div>
  )
}

/** Tooltip body shared by every chart. */
export function TipBox({ title, rows, footer }: {
  title: ReactNode; rows: { label: string; value: string; color?: string; strong?: boolean }[]; footer?: ReactNode
}) {
  return (
    <div className="min-w-44 rounded-lg border border-line bg-surface px-3 py-2 text-xs shadow-lg">
      <div className="mb-1 font-semibold text-ink">{title}</div>
      {rows.map((r) => (
        <div key={r.label} className="flex items-center justify-between gap-4 py-0.5">
          <span className="inline-flex items-center gap-1.5 text-ink-2">
            {r.color && <span className="h-2 w-2 rounded-sm" style={{ background: r.color }} />}
            {r.label}
          </span>
          <span className={`num text-ink ${r.strong ? 'font-bold' : 'font-medium'}`}>{r.value}</span>
        </div>
      ))}
      {footer && <div className="mt-1 border-t border-line pt-1 text-muted">{footer}</div>}
    </div>
  )
}

const isDeskQuery = '(min-width: 47.5rem)'
function useIsDesk() {
  const [desk, setDesk] = useState(() => window.matchMedia(isDeskQuery).matches)
  useEffect(() => {
    const mq = window.matchMedia(isDeskQuery)
    const update = () => setDesk(mq.matches)
    mq.addEventListener('change', update)
    return () => mq.removeEventListener('change', update)
  }, [])
  return desk
}

/** The smallest of 1, 2, 2.5, 5 × 10ⁿ that is at least `raw`: tidy axis steps like $1.5K, $2.5K, $5K. */
function niceStep(raw: number) {
  if (!(raw > 0)) return 1
  const p = 10 ** Math.floor(Math.log10(raw))
  return ([1, 2, 2.5, 5, 10].find((m) => m * p >= raw) ?? 10) * p
}

/** One column per week, shared by the bar and line charts so they line up and click the same. */
export interface WeekCol {
  week: string
  label: string
  /** In the selected period. Weeks outside it are drawn faded. */
  on: boolean
}

interface WeekChartProps<C extends WeekCol> {
  cols: C[]
  selected: string
  /** Tint the selected column (single-week view). */
  highlight: boolean
  onPick: (week: string) => void
  tip: (c: C) => ReactNode
  ariaLabel: (c: C) => string
  height: number
}

/** Week labels: every 2nd on a computer, every 4th on a phone, and always the selected week. */
function WeekTicks({ cols, selected }: { cols: WeekCol[]; selected: string }) {
  const desk = useIsDesk()
  const every = Math.max(1, Math.ceil(cols.length / (desk ? 10 : 4)))
  const sel = cols.findIndex((c) => c.week === selected)
  return (
    <div className="num grid text-[11px] text-faint" style={{ gridTemplateColumns: `repeat(${cols.length}, minmax(0, 1fr))` }}>
      {cols.map((c, i) => {
        const show = i === sel || ((cols.length - 1 - i) % every === 0 && (sel < 0 || Math.abs(i - sel) >= Math.ceil(every / 2) + (desk ? 0 : 1)))
        return (
          <span key={c.week} className={`overflow-visible whitespace-nowrap text-center ${i === sel ? 'font-semibold text-accent' : ''}`}>
            {show ? c.label : ''}
          </span>
        )
      })}
    </div>
  )
}

/** Plot area with y labels, gridlines, a hover tooltip and one clickable column per week. */
function WeekPlot<C extends WeekCol>({ cols, selected, highlight, onPick, tip, ariaLabel, height, ticks, children, border, overlay }: WeekChartProps<C> & {
  ticks: number[]; children: (c: C) => ReactNode; border: 'top' | 'bottom'; overlay?: ReactNode
}) {
  const [hover, setHover] = useState<number | null>(null)
  const hi = ticks[0], lo = ticks[ticks.length - 1]
  const y = (v: number) => ((hi - v) / (hi - lo || 1)) * 100
  const n = cols.length
  const hc = hover == null ? null : cols[hover]
  const center = hover == null ? 0 : ((hover + 0.5) / n) * 100
  return (
    <div className="grid grid-cols-[44px_minmax(0,1fr)] gap-2">
      <div className="num relative text-right text-[11px] text-faint" style={{ height }}>
        {ticks.map((t) => <span key={t} className="absolute right-0 -translate-y-1/2 whitespace-nowrap" style={{ top: `${y(t)}%` }}>{audShort(t)}</span>)}
      </div>
      <div className={`relative ${border === 'bottom' ? 'border-b' : 'border-t'} border-input-line`} style={{ height }} onMouseLeave={() => setHover(null)}>
        {ticks.map((t) => <div key={t} className="absolute inset-x-0 h-px bg-track" style={{ top: `${y(t)}%` }} />)}
        {overlay}
        <div className="absolute inset-0 grid" style={{ gridTemplateColumns: `repeat(${n}, minmax(0, 1fr))` }}>
          {cols.map((c, i) => (
            <button key={c.week} type="button" aria-label={ariaLabel(c)} aria-pressed={c.week === selected}
              onClick={() => onPick(c.week)} onMouseEnter={() => setHover(i)} onFocus={() => setHover(i)} onBlur={() => setHover(null)}
              className={`relative h-full rounded-t-md px-[2px] ${highlight && c.week === selected ? 'bg-accent-tint' : hover === i ? 'bg-surface-2/70' : ''}`}
              style={{ opacity: c.on ? 1 : 0.35 }}>
              {children(c)}
            </button>
          ))}
        </div>
        {hc && (
          <div className="pointer-events-none absolute top-1 z-10"
            style={{ left: `${center}%`, transform: `translateX(${center < 20 ? '-10%' : center > 80 ? '-90%' : '-50%'})` }}>
            {tip(hc)}
          </div>
        )}
      </div>
    </div>
  )
}

/** Paired bars per week (sales beside expenses). Clicking a week selects it. */
export function WeekBars<C extends WeekCol & { values: number[] }>({ colors, ...props }: WeekChartProps<C> & { colors: string[] }) {
  const max = Math.max(0, ...props.cols.flatMap((c) => c.values))
  // Three or four gridlines, topping out just above the tallest bar.
  const step = niceStep(max / 4)
  const count = Math.max(1, Math.ceil(max / step))
  const top = step * count
  return (
    <>
      <WeekPlot {...props} border="bottom" ticks={Array.from({ length: count + 1 }, (_, k) => (count - k) * step)}>
        {(c) => (
          <span className="absolute inset-x-0 bottom-0 flex h-full items-end justify-center gap-[3px]">
            {c.values.map((v, k) => (
              <span key={k} className="w-[34%] max-w-[14px] rounded-t-[3px]" style={{ height: `${(Math.max(0, v) / top) * 100}%`, background: colors[k] }} />
            ))}
          </span>
        )}
      </WeekPlot>
      <div className="grid grid-cols-[44px_minmax(0,1fr)] gap-2 pt-1.5"><span /><WeekTicks cols={props.cols} selected={props.selected} /></div>
    </>
  )
}

/**
 * One value per week as a line, green above $0 and red below. Weeks with nothing
 * entered (null) break the line rather than plotting a fake $0.
 */
export function WeekLine<C extends WeekCol & { value: number | null }>({ good, bad, surface, ...props }: WeekChartProps<C> & { good: string; bad: string; surface: string }) {
  const vals = props.cols.map((c) => c.value).filter((v): v is number => v != null)
  const hi0 = Math.max(0, ...vals), lo0 = Math.min(0, ...vals)
  const step = niceStep((hi0 - lo0) / 2)
  const hi = Math.ceil(hi0 / step) * step, lo = Math.floor(lo0 / step) * step
  const ticks: number[] = []
  for (let t = hi; t >= lo - step / 2; t -= step) ticks.push(Math.round(t * 100) / 100 || 0)
  const n = props.cols.length
  const y = (v: number) => ((hi - v) / (hi - lo || 1)) * 100
  const x = (i: number) => ((i + 0.5) / n) * 1000
  const zero = y(0)

  // Runs of consecutive weeks that have a value.
  const runs: { i: number; v: number }[][] = []
  props.cols.forEach((c, i) => {
    if (c.value == null) return
    const last = runs[runs.length - 1]
    if (last && last[last.length - 1].i === i - 1) last.push({ i, v: c.value })
    else runs.push([{ i, v: c.value }])
  })
  // Stroke and fill switch colour exactly where the line crosses $0.
  const id = `wl-${props.cols[0]?.week ?? 'x'}-${n}`
  const overlay = (
    <svg viewBox="0 0 1000 100" preserveAspectRatio="none" className="pointer-events-none absolute inset-0 h-full w-full overflow-visible" aria-hidden>
      <defs>
        <linearGradient id={id} gradientUnits="userSpaceOnUse" x1="0" y1="0" x2="0" y2="100">
          <stop offset={zero / 100} stopColor={good} />
          <stop offset={zero / 100} stopColor={bad} />
        </linearGradient>
      </defs>
      {runs.map((r) => {
        const pts = r.map((p) => `${x(p.i)},${y(p.v)}`).join(' ')
        return (
          <g key={r[0].i}>
            <polygon points={`${x(r[0].i)},${zero} ${pts} ${x(r[r.length - 1].i)},${zero}`} fill={`url(#${id})`} opacity={0.08} />
            <polyline points={pts} fill="none" stroke={`url(#${id})`} strokeWidth={2} strokeLinejoin="round" vectorEffect="non-scaling-stroke" />
          </g>
        )
      })}
    </svg>
  )

  return (
    <WeekPlot {...props} border="top" ticks={ticks} overlay={overlay}>
      {(c) => c.value != null && (
        <span className="absolute left-1/2 h-2 w-2 -translate-x-1/2 -translate-y-1/2 rounded-full border-2"
          style={{ top: `${y(c.value)}%`, background: surface, borderColor: c.value < 0 ? bad : good }} />
      )}
    </WeekPlot>
  )
}
