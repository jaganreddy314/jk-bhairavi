import { useEffect, useState, type ReactNode } from 'react'

// Recharts writes colours into SVG attributes, where CSS var() isn't reliable, so resolve the
// theme tokens to real colours and re-resolve whenever light/dark changes.
const TOKENS = ['c-sales', 'c-expenses', 'c-profit', 'ink', 'ink-2', 'muted', 'line', 'axis', 'surface', 'bad'] as const
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
    <section className={`card p-4 ${className}`}>
      <div className="mb-3 flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1">
        <div>
          <h2 className="font-semibold">{title}</h2>
          {subtitle && <p className="text-xs text-muted">{subtitle}</p>}
        </div>
        {legend}
      </div>
      {children}
    </section>
  )
}

export function Legend({ items }: { items: { label: string; color: string; line?: boolean }[] }) {
  return (
    <div className="flex flex-wrap gap-3 text-xs text-ink-2">
      {items.map((i) => (
        <span key={i.label} className="inline-flex items-center gap-1.5">
          <span className={i.line ? 'h-0.5 w-3.5 rounded' : 'h-2.5 w-2.5 rounded-sm'} style={{ background: i.color }} />
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
