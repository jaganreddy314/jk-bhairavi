import { useEffect, useState, type ReactNode } from 'react'
import { CAT_COLOR, CAT_LABEL } from '../lib/categories'
import type { CategoryCode } from '../lib/types'

export function PageHeader({ title, subtitle, action }: { title: string; subtitle?: ReactNode; action?: ReactNode }) {
  return (
    <div className="mb-4 flex items-end justify-between gap-3">
      <div className="min-w-0">
        <h1 className="text-2xl font-bold tracking-tight">{title}</h1>
        {subtitle && <p className="mt-0.5 text-sm text-muted">{subtitle}</p>}
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
    <div role="group" aria-label={ariaLabel} className="flex flex-wrap gap-1.5">
      {options.map((o) => (
        <button key={o.value} type="button" className="chip" aria-pressed={value === o.value} onClick={() => onChange(o.value)}>
          {o.label}
        </button>
      ))}
    </div>
  )
}

export function Empty({ children }: { children: ReactNode }) {
  return <div className="card px-4 py-8 text-center text-sm text-muted">{children}</div>
}
