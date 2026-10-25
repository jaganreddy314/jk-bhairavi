import { useState } from 'react'
import { Link } from 'react-router-dom'
import { useStaff, useXeroImport, useXeroImportPreview } from '../lib/api'
import { usePerms } from '../lib/access'
import type { XeroImportResult } from '../lib/types'
import { fmtDate } from './people'
import { Drawer, ErrorBox, Loading, Pill, type PillTone } from './ui'

const MATCH_BY = { xero: 'Linked', email: 'Same email', name: 'Same name' } as const
const RESULT: Record<XeroImportResult['status'], [PillTone, string]> = {
  created: ['success', 'Added'], updated: ['info', 'Filled in'], unchanged: ['neutral', 'Nothing new'], failed: ['danger', 'Failed'],
}

/** Bring Xero's employees into People: new ones are added, people already here only get the blanks filled. */
export function XeroImport({ onClose }: { onClose: () => void }) {
  const { can } = usePerms()
  const preview = useXeroImportPreview()
  const staff = useStaff()
  const run = useXeroImport()
  const [showFormer, setShowFormer] = useState(false)
  // Per Xero employee: picked or not, and who they become ('new' or a staff id).
  const [picked, setPicked] = useState<Record<string, boolean>>({})
  const [target, setTarget] = useState<Record<string, string>>({})

  const all = preview.data ?? []
  const shown = all.filter((e) => showFormer || e.status === 'active')
  const formerN = all.length - all.filter((e) => e.status === 'active').length
  const isPicked = (id: string, status: string) => picked[id] ?? status === 'active'
  const targetOf = (e: (typeof all)[number]) => target[e.id] ?? e.match?.staff_id ?? 'new'
  const chosen = shown.filter((e) => isPicked(e.id, e.status))
  const people = (staff.data ?? []).filter((p) => p.kind === 'employee')
  // Two Xero employees pointed at the same person would fight over the link.
  const doubled = new Set(chosen.map(targetOf).filter((t, i, a) => t !== 'new' && a.indexOf(t) !== i))

  async function submit() {
    if (!chosen.length || doubled.size) return
    await run.mutateAsync(chosen.map((e) => ({ xero_id: e.id, staff_id: targetOf(e) === 'new' ? null : targetOf(e) })))
  }

  if (run.data) {
    const r = run.data
    const count = (s: XeroImportResult['status']) => r.filter((x) => x.status === s).length
    return (
      <Drawer title="Imported from Xero" sub={`${count('created')} added · ${count('updated')} filled in · ${count('failed')} failed`} onClose={onClose}
        footer={<button type="button" className="btn btn-primary" onClick={onClose}>Done</button>}>
        <ul className="grid gap-2.5">
          {r.map((x, i) => (
            <li key={i} className="rounded-[10px] border border-line p-3">
              <div className="flex items-center justify-between gap-2">
                {x.staff_id ? <Link to={`/people/${x.staff_id}`} className="font-medium hover:underline" onClick={onClose}>{x.name}</Link> : <span className="font-medium">{x.name}</span>}
                <Pill tone={RESULT[x.status][0]}>{RESULT[x.status][1]}</Pill>
              </div>
              {x.filled.length > 0 && <p className="mt-1 text-[13px] text-ink-2">From Xero: {x.filled.join(', ')}</p>}
              {x.notes.map((n) => <p key={n} className="mt-1 text-[13px] text-warn-ink">{n}</p>)}
            </li>
          ))}
        </ul>
      </Drawer>
    )
  }

  return (
    <Drawer title="Import from Xero" onClose={onClose} onSubmit={submit}
      sub="New people are added. For people already here, only details that are blank get filled in; nothing is overwritten."
      footer={<>
        <button type="button" className="btn" onClick={onClose}>Cancel</button>
        <button className="btn btn-primary" disabled={!chosen.length || doubled.size > 0 || run.isPending}>
          {run.isPending ? 'Importing…' : `Import ${chosen.length || ''}`.trim()}
        </button>
      </>}>
      <ErrorBox error={preview.error || run.error} />
      {preview.isLoading ? <Loading label="Asking Xero…" /> : (
        <>
          {!can('sensitive') && <p className="rounded-[10px] bg-warn-bg px-3 py-2 text-[13px] text-warn-ink">You don’t have the Sensitive area, so tax, bank and super details won’t come across. Someone who does can import again later to fill them in.</p>}
          <div className="flex items-center justify-between gap-3 text-[13px] text-muted">
            <span>{all.length} in Xero · {chosen.length} picked</span>
            {formerN > 0 && (
              <label className="flex items-center gap-2">
                <input type="checkbox" className="h-4 w-4 accent-[var(--accent)]" checked={showFormer} onChange={(e) => setShowFormer(e.target.checked)} />
                Show {formerN} former
              </label>
            )}
          </div>
          {shown.length === 0 && <p className="text-sm text-ink-2">No employees in Xero{formerN ? ' who are current' : ''}.</p>}
          <ul className="grid gap-2">
            {shown.map((e) => {
              const on = isPicked(e.id, e.status)
              const t = targetOf(e)
              return (
                <li key={e.id} className={`rounded-[10px] border p-3 ${on ? 'border-line' : 'border-line opacity-60'}`}>
                  <label className="flex items-start gap-3">
                    <input type="checkbox" className="mt-0.5 h-4 w-4 accent-[var(--accent)]" checked={on}
                      onChange={(ev) => setPicked({ ...picked, [e.id]: ev.target.checked })} />
                    <span className="min-w-0 flex-1">
                      <span className="flex items-center justify-between gap-2">
                        <span className="truncate font-medium">{e.name}</span>
                        {e.status === 'former' ? <Pill tone="neutral">Former</Pill> : e.match ? <Pill tone="info">{MATCH_BY[e.match.by]}</Pill> : <Pill tone="success">New</Pill>}
                      </span>
                      <span className="block truncate text-xs text-muted">{[e.email, e.start && `started ${fmtDate(e.start)}`].filter(Boolean).join(' · ') || '—'}</span>
                    </span>
                  </label>
                  {on && (
                    <select className="field mt-2" aria-label={`Who ${e.name} is here`} value={t} onChange={(ev) => setTarget({ ...target, [e.id]: ev.target.value })}>
                      <option value="new">Add as a new person</option>
                      {people.map((p) => <option key={p.id} value={p.id}>Fill in {p.name}{p.id === e.match?.staff_id ? ' (match)' : ''}</option>)}
                    </select>
                  )}
                  {on && doubled.has(t) && <p className="mt-1 text-xs text-bad">Another Xero employee is going to this person too.</p>}
                </li>
              )
            })}
          </ul>
          <p className="text-xs text-muted">Xero doesn’t know award classifications: choose one for each new person afterwards, or their pay can’t be worked out.</p>
        </>
      )}
    </Drawer>
  )
}
