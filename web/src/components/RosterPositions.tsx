import { useState } from 'react'
import { useArrangeRoster, useRemove, useSaveRosterPositions } from '../lib/api'
import type { RosterPerson, RosterPosition } from '../lib/types'
import { DeleteButton, Drawer, ErrorBox } from './ui'

export interface RosterGroup {
  /** The position's id, or 'none' for people without one. */
  key: string
  position: RosterPosition | null
  people: RosterPerson[]
}

const byOrder = (a: RosterPerson, b: RosterPerson) =>
  (a.roster_sort ?? Number.MAX_SAFE_INTEGER) - (b.roster_sort ?? Number.MAX_SAFE_INTEGER) || a.name.localeCompare(b.name)

/** People in roster order: each position's group in turn, then anyone without a position. */
export function groupRoster(people: RosterPerson[], positions: RosterPosition[]): RosterGroup[] {
  const known = new Set(positions.map((p) => p.id))
  const groups: RosterGroup[] = [...positions]
    .sort((a, b) => a.sort - b.sort || a.name.localeCompare(b.name))
    .map((pos) => ({ key: pos.id, position: pos, people: people.filter((p) => p.position_id === pos.id).sort(byOrder) }))
  groups.push({ key: 'none', position: null, people: people.filter((p) => !p.position_id || !known.has(p.position_id)).sort(byOrder) })
  return groups
}

/**
 * Move someone to a place in a group. `index` is a gap in the group as it is now (0 = top),
 * so dropping between the 2nd and 3rd person is index 2 whichever way they came from.
 * Returns the rows to save: everyone in the groups that changed, renumbered.
 */
export function moveTo(groups: RosterGroup[], staffId: string, key: string, index: number) {
  const from = groups.find((g) => g.people.some((p) => p.id === staffId))
  const to = groups.find((g) => g.key === key)
  if (!from || !to) return []
  const ids = to.people.map((p) => p.id)
  const at = ids.indexOf(staffId)
  if (at >= 0) {
    ids.splice(at, 1)
    if (at < index) index -= 1
  }
  ids.splice(Math.max(0, Math.min(index, ids.length)), 0, staffId)
  const pos = to.position?.id ?? null
  const rows = ids.map((id, i) => ({ staff_id: id, position_id: pos, sort: (i + 1) * 10 }))
  if (from !== to) {
    from.people.filter((p) => p.id !== staffId).forEach((p, i) => rows.push({ staff_id: p.id, position_id: from.position?.id ?? null, sort: (i + 1) * 10 }))
  }
  return rows
}

const Arrow = ({ up, label, onClick, disabled }: { up?: boolean; label: string; onClick: () => void; disabled?: boolean }) => (
  <button type="button" aria-label={label} disabled={disabled} onClick={onClick}
    className="grid h-8 w-8 shrink-0 place-items-center rounded-lg border border-line text-ink-2 hover:bg-hover disabled:opacity-35">
    <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <path d={up ? 'M6 15l6-6 6 6' : 'M6 9l6 6 6-6'} />
    </svg>
  </button>
)

/** Set up the positions, their order, and who's in each. Works the same on a phone. */
export function PositionsDrawer({ groups, onClose }: { groups: RosterGroup[]; onClose: () => void }) {
  const savePositions = useSaveRosterPositions()
  const remove = useRemove('roster_positions')
  const arrange = useArrangeRoster()
  const [name, setName] = useState('')
  const positions = groups.flatMap((g) => (g.position ? [g.position] : []))

  // Renumber the whole list so the order is exact, whatever the old numbers were.
  const reorder = (list: RosterPosition[]) => savePositions.mutate(list.map((p, i) => ({ id: p.id, name: p.name, sort: (i + 1) * 10 })))
  const swap = (i: number, j: number) => {
    const list = [...positions]
    ;[list[i], list[j]] = [list[j], list[i]]
    reorder(list)
  }
  async function add() {
    const n = name.trim()
    if (!n) return
    await savePositions.mutateAsync([{ id: crypto.randomUUID(), name: n, sort: (positions.length + 1) * 10 }])
    setName('')
  }
  const rename = (p: RosterPosition, n: string) => {
    if (n.trim() && n.trim() !== p.name) savePositions.mutate([{ id: p.id, name: n.trim(), sort: p.sort }])
  }
  const move = (staffId: string, key: string, index: number) => {
    const rows = moveTo(groups, staffId, key, index)
    if (rows.length) arrange.mutate(rows)
  }

  return (
    <Drawer title="Positions" sub="Group the roster by the jobs people do, in the order you want them. On a computer you can also drag people on the roster itself."
      onClose={onClose} onSubmit={add}
      footer={<button type="button" className="btn btn-primary" onClick={onClose}>Done</button>}>
      <ErrorBox error={savePositions.error || remove.error || arrange.error} />
      <section className="grid gap-2">
        <h3 className="text-[13px] font-semibold text-ink-2">Positions, top to bottom</h3>
        {positions.length === 0 && <p className="text-[13px] text-muted">None yet. Add one for each job, e.g. Console, Driveway, Kitchen, Front counter.</p>}
        {positions.map((p, i) => (
          <div key={p.id} className="flex items-center gap-1.5">
            <input className="field min-w-0 flex-1" defaultValue={p.name} aria-label="Position name" maxLength={40}
              onBlur={(e) => rename(p, e.target.value)} onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); e.currentTarget.blur() } }} />
            <Arrow up label={`Move ${p.name} up`} disabled={i === 0 || savePositions.isPending} onClick={() => swap(i, i - 1)} />
            <Arrow label={`Move ${p.name} down`} disabled={i === positions.length - 1 || savePositions.isPending} onClick={() => swap(i, i + 1)} />
            <DeleteButton label="Remove" busy={remove.isPending} onConfirm={() => remove.mutate(p.id)} />
          </div>
        ))}
        <div className="flex gap-1.5">
          <input className="field min-w-0 flex-1" value={name} onChange={(e) => setName(e.target.value)} placeholder="New position" maxLength={40} aria-label="New position" />
          <button className="btn" disabled={!name.trim() || savePositions.isPending}>Add</button>
        </div>
      </section>

      <section className="grid gap-3">
        <h3 className="text-[13px] font-semibold text-ink-2">People</h3>
        {groups.filter((g) => g.people.length || g.position).map((g) => (
          <div key={g.key}>
            <div className="mb-1 text-xs font-semibold uppercase tracking-[0.04em] text-muted">{g.position?.name ?? 'No position'}</div>
            {g.people.length === 0 && <p className="text-[13px] text-faint">No one yet.</p>}
            <ul className="grid gap-1.5">
              {g.people.map((p, i) => (
                <li key={p.id} className="flex items-center gap-1.5">
                  <span className="min-w-0 flex-1 truncate text-sm">{p.name}</span>
                  {positions.length > 0 && (
                    <select className="field w-[9.5rem] shrink-0" aria-label={`${p.name}'s position`} value={g.key}
                      onChange={(e) => move(p.id, e.target.value, Number.MAX_SAFE_INTEGER)}>
                      {positions.map((x) => <option key={x.id} value={x.id}>{x.name}</option>)}
                      <option value="none">No position</option>
                    </select>
                  )}
                  <Arrow up label={`Move ${p.name} up`} disabled={i === 0} onClick={() => move(p.id, g.key, i - 1)} />
                  <Arrow label={`Move ${p.name} down`} disabled={i === g.people.length - 1} onClick={() => move(p.id, g.key, i + 2)} />
                </li>
              ))}
            </ul>
          </div>
        ))}
      </section>
    </Drawer>
  )
}
