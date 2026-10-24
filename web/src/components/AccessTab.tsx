import { useState } from 'react'
import { useAddPerson, useBusinessUsers, useRemove, useRemovePerson, useSave, useSecurityGroups, useSetPersonPassword, useSetUserGroup } from '../lib/api'
import { useBusiness } from '../lib/business'
import { PERMS } from '../lib/payroll'
import type { Perm, SecurityGroup } from '../lib/types'
import { DeleteButton, ErrorBox, Loading, Pill } from './ui'

/** Security groups, and who can sign in to this business under which one. Admins only. */
export function AccessTab() {
  const groups = useSecurityGroups()
  const users = useBusinessUsers()
  if (groups.isLoading || users.isLoading) return <Loading />
  const list = groups.data ?? []
  return (
    <div className="grid gap-4">
      <SignIns groups={list} />
      <section className="card overflow-hidden">
        <div className="border-b border-line px-4 py-3 desk:px-5">
          <h2 className="text-base font-semibold">Security groups</h2>
          <p className="mt-0.5 text-[13px] text-muted">
            Each person who signs in belongs to one group, and the group decides which parts of the app they can open. The
            database enforces it too, so hidden data stays hidden however it's asked for.
          </p>
        </div>
        <ErrorBox error={groups.error} />
        {list.map((g) => <GroupRow key={g.id} g={g} members={(users.data ?? []).filter((u) => u.group_id === g.id).length} />)}
        <NewGroup sort={(list.reduce((m, g) => Math.max(m, g.sort), 0) || 0) + 10} />
      </section>
    </div>
  )
}

function GroupRow({ g, members }: { g: SecurityGroup; members: number }) {
  const save = useSave('security_groups')
  const remove = useRemove('security_groups')
  const has = (p: Perm) => g.is_owner || g.perms.includes(p)
  const toggle = (p: Perm) => save.mutate({ id: g.id, perms: has(p) ? g.perms.filter((x) => x !== p) : [...g.perms, p] })
  return (
    <div className="border-b border-line-2 px-4 py-4 desk:px-5">
      <div className="flex flex-wrap items-center gap-2.5">
        <h3 className="font-semibold">{g.name}</h3>
        {g.is_owner && <Pill tone="info">Everything, always</Pill>}
        <span className="text-xs text-muted">{members} {members === 1 ? 'person' : 'people'}</span>
        <span className="ml-auto">
          {!g.is_owner && members === 0 && <DeleteButton label="Remove group" busy={remove.isPending} onConfirm={() => remove.mutate(g.id)} />}
        </span>
      </div>
      {g.description && <p className="mt-0.5 text-[13px] text-muted">{g.description}</p>}
      <ErrorBox error={save.error || remove.error} />
      <div className="mt-3 grid gap-2 desk:grid-cols-3">
        {PERMS.map((p) => (
          <label key={p.key} className={`flex items-start gap-2.5 rounded-[10px] border px-3 py-2.5 ${has(p.key) ? 'border-accent-tint-line bg-accent-tint' : 'border-line'} ${g.is_owner ? '' : 'cursor-pointer'}`}>
            <input type="checkbox" className="mt-0.5 h-4 w-4 accent-[var(--accent)]" checked={has(p.key)} disabled={g.is_owner || save.isPending}
              onChange={() => toggle(p.key)} />
            <span className="min-w-0">
              <span className="block text-[13px] font-medium">{p.label}{p.key === 'sensitive' && <span className="ml-1.5 text-[11px] text-warn-ink">sensitive</span>}</span>
              <span className="block text-xs text-muted">{p.sub}</span>
            </span>
          </label>
        ))}
      </div>
    </div>
  )
}

function NewGroup({ sort }: { sort: number }) {
  const save = useSave('security_groups')
  const [name, setName] = useState('')
  return (
    <form className="flex flex-wrap items-end gap-2 px-4 py-4 desk:px-5"
      onSubmit={(e) => { e.preventDefault(); if (name.trim()) save.mutate({ name: name.trim(), perms: [], sort }, { onSuccess: () => setName('') }) }}>
      <ErrorBox error={save.error} />
      <div className="min-w-48 flex-1">
        <label className="label" htmlFor="new-group">New group</label>
        <input id="new-group" className="field" value={name} onChange={(e) => setName(e.target.value)} placeholder="e.g. Shift supervisor" />
      </div>
      <button className="btn" disabled={!name.trim() || save.isPending}>Add group</button>
    </form>
  )
}

function SignIns({ groups }: { groups: SecurityGroup[] }) {
  const { business } = useBusiness()
  const users = useBusinessUsers()
  const addPerson = useAddPerson()
  const setGroup = useSetUserGroup()
  // New sign-ins start in the group with the least access, never more.
  const least = [...groups].filter((g) => !g.is_owner).sort((a, b) => a.perms.length - b.perms.length || a.sort - b.sort)[0]
  const [email, setEmail] = useState('')
  const [name, setName] = useState('')
  const [group, setGroupId] = useState('')
  const groupId = group || least?.id || groups[0]?.id || ''

  return (
    <section className="card overflow-hidden">
      <div className="border-b border-line px-4 py-3 desk:px-5">
        <h2 className="text-base font-semibold">Who can sign in</h2>
        <p className="mt-0.5 text-[13px] text-muted">
          Only these addresses can open <b>{business?.name}</b>. Add someone, choose their group, set them a password and tell
          them — they can change it themselves once they're in.
        </p>
      </div>
      <ErrorBox error={users.error || addPerson.error || setGroup.error} />
      <ul>
        {(users.data ?? []).map((u) => (
          <SignInRow key={u.email} email={u.email} displayName={u.display_name} groupId={u.group_id} groups={groups}
            onGroup={(id) => setGroup.mutate({ email: u.email, group_id: id })} />
        ))}
      </ul>
      <form className="flex flex-wrap items-end gap-2 border-t border-line px-4 py-4 desk:px-5"
        onSubmit={(e) => {
          e.preventDefault()
          if (!email.trim() || !groupId) return
          addPerson.mutate({ email, display_name: name.trim() || null, group_id: groupId }, { onSuccess: () => { setEmail(''); setName('') } })
        }}>
        <div className="min-w-48 flex-[2]">
          <label className="label" htmlFor="p-email">Email</label>
          <input id="p-email" type="email" className="field" value={email} onChange={(e) => setEmail(e.target.value)} placeholder="them@example.com" />
        </div>
        <div className="min-w-32 flex-1">
          <label className="label" htmlFor="p-name">Name <span className="font-normal text-faint">(optional)</span></label>
          <input id="p-name" className="field" value={name} onChange={(e) => setName(e.target.value)} />
        </div>
        <div className="min-w-32 flex-1">
          <label className="label" htmlFor="p-group">Group</label>
          <select id="p-group" className="field" value={groupId} onChange={(e) => setGroupId(e.target.value)}>
            {groups.map((g) => <option key={g.id} value={g.id}>{g.name}</option>)}
          </select>
        </div>
        <button className="btn" disabled={!email.trim() || addPerson.isPending}>Add</button>
      </form>
    </section>
  )
}

function SignInRow({ email, displayName, groupId, groups, onGroup }: {
  email: string; displayName: string | null; groupId: string; groups: SecurityGroup[]; onGroup: (id: string) => void
}) {
  const removePerson = useRemovePerson()
  const setPassword = useSetPersonPassword()
  const [open, setOpen] = useState(false)
  const [pw, setPw] = useState('')
  const [done, setDone] = useState<'set' | 'created' | null>(null)
  const tooShort = pw.length > 0 && pw.length < 8

  return (
    <li className="border-b border-line-2 px-4 py-3 desk:px-5">
      <div className="flex flex-wrap items-center gap-2">
        <span className="min-w-0 flex-1">
          <span className="block truncate font-medium">{displayName || email}</span>
          {displayName && <span className="block truncate text-xs text-muted">{email}</span>}
        </span>
        <select aria-label={`Group for ${email}`} className="field !h-9 !w-auto !py-0 !text-[13px]" value={groupId} onChange={(e) => onGroup(e.target.value)}>
          {groups.map((g) => <option key={g.id} value={g.id}>{g.name}</option>)}
        </select>
        <button type="button" className="btn btn-sm h-9" onClick={() => { setOpen((v) => !v); setDone(null) }}>{open ? 'Cancel' : 'Set password'}</button>
        <DeleteButton label="Remove" busy={removePerson.isPending} onConfirm={() => removePerson.mutate(email)} />
      </div>
      <ErrorBox error={removePerson.error || setPassword.error} />
      {done && (
        <p className="mt-1 text-sm font-semibold text-good">
          ✓ {done === 'created' ? 'Login created.' : 'Password changed.'} Tell {displayName || email} what it is — they can change it
          themselves from their account.
        </p>
      )}
      {open && (
        <form className="mt-2 flex flex-wrap items-end gap-2 rounded-xl bg-surface-2 p-3"
          onSubmit={async (e) => {
            e.preventDefault()
            if (pw.length < 8) return
            const r = await setPassword.mutateAsync({ email, password: pw })
            setPw(''); setOpen(false); setDone(r.created ? 'created' : 'set')
          }}>
          <div className="min-w-48 flex-1">
            <label className="label" htmlFor={`pw-${email}`}>New password for {displayName || email}</label>
            <input id={`pw-${email}`} type="text" className="field" value={pw} onChange={(e) => setPw(e.target.value)} placeholder="At least 8 characters" autoComplete="off" autoFocus />
            <p className="mt-1 text-xs text-muted">Shown as you type, because you have to pass it on.</p>
          </div>
          <button className="btn btn-primary" disabled={tooShort || !pw || setPassword.isPending}>{setPassword.isPending ? 'Saving…' : 'Set it'}</button>
        </form>
      )}
      {open && tooShort && <p className="mt-1 text-xs text-bad">A bit longer — 8 characters or more.</p>}
    </li>
  )
}
