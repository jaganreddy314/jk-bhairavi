import { useState } from 'react'
import { useRemove, useSave } from '../lib/api'
import { aud, parseMoney } from '../lib/format'
import { DeleteButton, ErrorBox } from './ui'

export interface Field {
  key: string
  label: string
  type: 'text' | 'money' | 'number' | 'date' | 'select' | 'bool'
  options?: { value: string; label: string }[]
  required?: boolean
  /** Tailwind width for the column on wide screens */
  width?: string
}

type Row = Record<string, unknown> & { id: string }

const toInput = (f: Field, v: unknown) => (f.type === 'bool' ? (v ? 'true' : '') : v == null ? '' : String(v))
function fromInput(f: Field, s: string): unknown {
  if (f.type === 'bool') return s === 'true'
  if (f.type === 'money' || f.type === 'number') return s.trim() === '' ? null : parseMoney(s)
  return s.trim() === '' ? null : s.trim()
}

function display(f: Field, v: unknown) {
  if (v == null || v === '') return <span className="text-muted">—</span>
  if (f.type === 'money') return <span className="num">{aud(Number(v))}</span>
  if (f.type === 'bool') return v ? 'Yes' : 'No'
  if (f.type === 'select') return f.options?.find((o) => o.value === v)?.label ?? String(v)
  return String(v)
}

function Input({ f, value, onChange, id }: { f: Field; value: string; onChange: (v: string) => void; id: string }) {
  const common = { id, 'aria-label': f.label, className: 'field !py-2 !text-[15px]' }
  if (f.type === 'select')
    return (
      <select {...common} value={value} onChange={(e) => onChange(e.target.value)}>
        {!f.required && <option value="">—</option>}
        {f.options!.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
      </select>
    )
  if (f.type === 'bool')
    return (
      <label className="flex items-center gap-2 py-2 text-sm">
        <input id={id} type="checkbox" className="h-5 w-5" checked={value === 'true'} onChange={(e) => onChange(e.target.checked ? 'true' : '')} />
        {f.label}
      </label>
    )
  return (
    <input {...common} type={f.type === 'date' ? 'date' : 'text'} inputMode={f.type === 'money' || f.type === 'number' ? 'decimal' : undefined}
      value={value} onChange={(e) => onChange(e.target.value)} />
  )
}

/** A small list you can add to, edit in place and delete from. Used for every Settings table. */
export function TableEditor({
  table, rows, fields, addLabel, canDelete = true, defaults = {},
}: { table: string; rows: { id: string }[]; fields: Field[]; addLabel: string; canDelete?: boolean; defaults?: Record<string, unknown> }) {
  const [editing, setEditing] = useState<string | null>(null)
  const save = useSave(table)
  const remove = useRemove(table)

  return (
    <div>
      <ErrorBox error={save.error || remove.error} />
      <ul className="divide-y divide-line">
        {(rows as Row[]).map((r) =>
          editing === r.id ? (
            <li key={r.id} className="py-3">
              <RowForm fields={fields} initial={r} busy={save.isPending} onCancel={() => setEditing(null)}
                onSave={async (vals) => { await save.mutateAsync({ id: r.id, ...vals }); setEditing(null) }} />
            </li>
          ) : (
            <li key={r.id} className="flex flex-wrap items-center gap-x-4 gap-y-1 py-2.5">
              {fields.map((f, i) => (
                <span key={f.key} className={`${i === 0 ? 'min-w-0 flex-1 font-medium' : `text-sm text-ink-2 ${f.width ?? ''}`}`}>
                  {i > 0 && f.type !== 'money' && <span className="text-xs text-muted md:hidden">{f.label}: </span>}
                  {display(f, r[f.key])}
                </span>
              ))}
              <span className="ml-auto flex gap-1">
                <button type="button" className="btn btn-sm" onClick={() => setEditing(r.id)}>Edit</button>
                {canDelete && <DeleteButton busy={remove.isPending} onConfirm={() => remove.mutate(r.id)} />}
              </span>
            </li>
          ),
        )}
      </ul>
      {editing === 'new' ? (
        <div className="mt-2 rounded-xl bg-surface-2 p-3">
          <RowForm fields={fields} initial={defaults} busy={save.isPending} onCancel={() => setEditing(null)}
            onSave={async (vals) => { await save.mutateAsync(vals); setEditing(null) }} />
        </div>
      ) : (
        <button type="button" className="btn btn-sm mt-2" onClick={() => setEditing('new')}>+ {addLabel}</button>
      )}
    </div>
  )
}

function RowForm({
  fields, initial, onSave, onCancel, busy,
}: { fields: Field[]; initial: Record<string, unknown>; onSave: (v: Record<string, unknown>) => void; onCancel: () => void; busy: boolean }) {
  const [vals, setVals] = useState<Record<string, string>>(() => Object.fromEntries(fields.map((f) => [f.key, toInput(f, initial[f.key])])))
  const valid = fields.every((f) => !f.required || vals[f.key].trim() !== '')
  return (
    <form
      className="grid gap-2 sm:grid-cols-[repeat(auto-fit,minmax(9rem,1fr))] sm:items-end"
      onSubmit={(e) => {
        e.preventDefault()
        if (valid) onSave(Object.fromEntries(fields.map((f) => [f.key, fromInput(f, vals[f.key])])))
      }}
    >
      {fields.map((f) => (
        <div key={f.key}>
          {f.type !== 'bool' && <label className="mb-1 block text-xs font-semibold text-ink-2" htmlFor={`rf-${f.key}`}>{f.label}</label>}
          <Input f={f} id={`rf-${f.key}`} value={vals[f.key]} onChange={(v) => setVals({ ...vals, [f.key]: v })} />
        </div>
      ))}
      <div className="flex gap-1.5">
        <button className="btn btn-primary btn-sm !py-2.5" disabled={!valid || busy}>Save</button>
        <button type="button" className="btn btn-sm !py-2.5" onClick={onCancel}>Cancel</button>
      </div>
    </form>
  )
}
