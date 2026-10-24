import { useEffect, useState, type ReactNode } from 'react'
import { Link } from 'react-router-dom'
import { CAT_COLOR, CAT_LABEL } from '../lib/categories'
import type { CategoryCode } from '../lib/types'

export function PageHeader({ title, subtitle, action }: { title: string; subtitle?: ReactNode; action?: ReactNode }) {
  return (
    <div className="mb-5 flex flex-wrap items-end justify-between gap-3">
      <div className="min-w-0">
        <h1 className="text-2xl font-semibold tracking-[-0.02em]">{title}</h1>
        {subtitle && <p className="mt-1 text-sm text-muted">{subtitle}</p>}
      </div>
      {action}
    </div>
  )
}

export function CatDot({ code, size = 10 }: { code: CategoryCode; size?: number }) {
  return <span className="inline-block shrink-0 rounded-full" style={{ width: size, height: size, background: CAT_COLOR[code] }} />
}

export function CatName({ code }: { code: CategoryCode }) {
  return (
    <span className="inline-flex items-center gap-1.5">
      <CatDot code={code} />
      {CAT_LABEL[code]}
    </span>
  )
}

export function Loading({ label = 'Loading…' }: { label?: string }) {
  return <div className="py-10 text-center text-sm text-muted">{label}</div>
}

export function ErrorBox({ error }: { error: unknown }) {
  if (!error) return null
  return (
    <div role="alert" className="mb-3 rounded-lg border border-bad/40 bg-bad/10 px-3 py-2 text-sm text-bad">
      {error instanceof Error ? error.message : String(error)}
    </div>
  )
}

/** Brief "Saved" confirmation that fades out. Change `signal` to show it again. */
export function Flash({ signal, children = 'Saved' }: { signal: number; children?: ReactNode }) {
  const [show, setShow] = useState(false)
  useEffect(() => {
    if (!signal) return
    setShow(true)
    const t = setTimeout(() => setShow(false), 2200)
    return () => clearTimeout(t)
  }, [signal])
  return (
    <span role="status" className={`text-sm font-semibold text-good transition-opacity ${show ? 'opacity-100' : 'opacity-0'}`}>
      ✓ {children}
    </span>
  )
}

/** Two-step delete: first tap arms it, second tap confirms. No browser dialogs. */
export function DeleteButton({ onConfirm, label = 'Delete', busy }: { onConfirm: () => void; label?: string; busy?: boolean }) {
  const [armed, setArmed] = useState(false)
  useEffect(() => {
    if (!armed) return
    const t = setTimeout(() => setArmed(false), 4000)
    return () => clearTimeout(t)
  }, [armed])
  if (armed)
    return (
      <span className="inline-flex gap-1">
        <button type="button" className="btn btn-sm border-bad bg-bad text-white hover:bg-bad" disabled={busy} onClick={onConfirm}>
          Confirm delete
        </button>
        <button type="button" className="btn btn-sm" onClick={() => setArmed(false)}>
          Cancel
        </button>
      </span>
    )
  return (
    <button type="button" className="btn btn-sm btn-danger" onClick={() => setArmed(true)}>
      {label}
    </button>
  )
}

export function Segmented<T extends string>({
  value, onChange, options, ariaLabel,
}: { value: T; onChange: (v: T) => void; options: { value: T; label: string }[]; ariaLabel: string }) {
  return (
    <div role="group" aria-label={ariaLabel} className="seg">
      {options.map((o) => (
        <button key={o.value} type="button" aria-pressed={value === o.value} onClick={() => onChange(o.value)}>
          {o.label}
        </button>
      ))}
    </div>
  )
}

export function Empty({ children }: { children: ReactNode }) {
  return <div className="card px-4 py-8 text-center text-sm text-muted">{children}</div>
}

/** A money field with a "$" in front. `lg` is the big close-of-trade style input. */
export function MoneyInput({ value, onChange, size = 'lg', className = '', ...rest }: {
  value: string; onChange: (v: string) => void; size?: 'lg' | 'sm'; className?: string
  id?: string; placeholder?: string; disabled?: boolean; 'aria-label'?: string; autoFocus?: boolean
}) {
  const lg = size === 'lg'
  return (
    <div className={`flex items-center gap-1.5 border border-input-line bg-surface focus-within:border-accent focus-within:shadow-[0_0_0_3px_color-mix(in_srgb,var(--accent)_20%,transparent)] has-[:disabled]:opacity-45 ${
      lg ? 'h-14 rounded-[10px] px-3.5' : 'h-[38px] rounded-lg px-2.5'} ${className}`}>
      <span className={lg ? 'text-[22px] text-faint' : 'text-faint'}>$</span>
      <input inputMode="decimal" autoComplete="off" placeholder={rest.placeholder ?? '0.00'} {...rest} value={value} onChange={(e) => onChange(e.target.value)}
        className={`num min-w-0 flex-1 bg-transparent text-ink outline-none focus-visible:outline-none disabled:cursor-not-allowed ${lg ? 'text-2xl font-semibold' : 'text-base font-semibold desk:text-sm'}`} />
    </div>
  )
}

export type PillTone = 'success' | 'warn' | 'neutral' | 'info' | 'danger'
const PILL: Record<PillTone, { cls: string; dot: string }> = {
  success: { cls: 'bg-[#ECFDF3] text-[#067647] dark:bg-[#053321] dark:text-[#75E0A7]', dot: '#17B26A' },
  warn: { cls: 'bg-[#FFFAEB] text-[#B54708] dark:bg-[#4E1D09] dark:text-[#FEC84B]', dot: '#F79009' },
  neutral: { cls: 'bg-surface-2 text-ink-2', dot: '#98A2B3' },
  info: { cls: 'bg-[#EFF8FF] text-[#175CD3] dark:bg-[#102A56] dark:text-[#84CAFF]', dot: '#2E90FA' },
  danger: { cls: 'bg-[#FEF3F2] text-[#B42318] dark:bg-[#55160C] dark:text-[#FDA29B]', dot: '#D92D20' },
}
export const PILL_DOT = (tone: PillTone) => PILL[tone].dot

/** Rounded status label with a coloured dot: Saved, Unsaved, Received, Draft… */
export function Pill({ tone, children }: { tone: PillTone; children: ReactNode }) {
  return (
    <span className={`inline-flex shrink-0 items-center gap-1.5 whitespace-nowrap rounded-full py-0.5 pl-[7px] pr-[9px] text-xs font-medium ${PILL[tone].cls}`}>
      <span className="h-1.5 w-1.5 rounded-full" style={{ background: PILL[tone].dot }} />
      {children}
    </span>
  )
}

/**
 * Floats at the bottom of the page while there is something to save: above the tab bar
 * on a phone, 16px off the bottom on a computer.
 */
export function SaveBar({ dirty, message, children }: { dirty: boolean; message: ReactNode; children: ReactNode }) {
  return (
    <div className="sticky bottom-[calc(env(safe-area-inset-bottom)+76px)] z-10 mt-3 flex flex-wrap items-center gap-2.5 rounded-xl border border-line bg-surface py-2.5 pl-4 pr-3 shadow-[var(--shadow-float)] desk:bottom-4">
      <span className="flex min-w-40 flex-1 items-center gap-2 text-[13px] text-ink-2">
        <span className="h-2 w-2 shrink-0 rounded-full" style={{ background: dirty ? PILL.warn.dot : PILL.success.dot }} />
        {message}
      </span>
      {children}
    </div>
  )
}

/** A headline figure: label, big value, one line of context. `to` makes the whole card a link. */
export function Kpi({ label, value, note, tone, small, to }: {
  label: string; value: string; note?: ReactNode; tone?: 'good' | 'bad'; small?: boolean; to?: string
}) {
  const body = (
    <>
      <div className="text-[13px] font-medium text-muted">{label}</div>
      <div className={`num mt-1.5 truncate font-semibold tracking-[-0.02em] ${small ? 'text-base desk:text-base' : 'text-xl desk:text-[26px] desk:leading-8'} ${
        tone === 'bad' ? 'text-bad' : tone === 'good' ? 'text-good' : ''}`}>{value}</div>
      {note && <div className="mt-1 truncate text-xs text-muted">{note}</div>}
    </>
  )
  if (to) return <Link to={to} className="card min-w-0 p-3 hover:bg-hover desk:p-4">{body}</Link>
  return <div className="card min-w-0 p-3 desk:p-4">{body}</div>
}

/** Two KPIs a row on a phone; as many as fit on a computer. */
export const KPI_GRID = 'grid grid-cols-2 gap-3 desk:grid-cols-[repeat(auto-fit,minmax(180px,1fr))]'

/** A search field with a magnifier, sized to sit in a toolbar. */
export function SearchBox({ value, onChange, placeholder }: { value: string; onChange: (v: string) => void; placeholder: string }) {
  return (
    <label className="flex h-9 min-w-40 flex-1 items-center gap-2 rounded-lg border border-input-line bg-surface px-2.5 focus-within:border-accent desk:max-w-[260px]">
      <svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" className="shrink-0 text-faint" aria-hidden>
        <path d="m21 21-4.3-4.3M11 19a8 8 0 1 0 0-16 8 8 0 0 0 0 16z" />
      </svg>
      <input type="search" value={value} onChange={(e) => onChange(e.target.value)} placeholder={placeholder} aria-label={placeholder}
        className="min-w-0 flex-1 bg-transparent text-base outline-none focus-visible:outline-none desk:text-[13px]" />
    </label>
  )
}
