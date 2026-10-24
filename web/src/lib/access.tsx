import type { ReactNode } from 'react'
import { Link, Navigate } from 'react-router-dom'
import { useMyAccess } from './api'
import type { Perm } from './types'
import { Loading } from '../components/ui'

/**
 * What the signed-in person can open in the selected business, from their security group.
 * Row-level security enforces the same rules in the database; this only decides what to show.
 */
export function usePerms() {
  const q = useMyAccess()
  const g = q.data
  const can = (...any: Perm[]) => !!g && (g.is_owner || any.some((p) => g.perms.includes(p)))
  return { can, group: g, isLoading: q.isLoading }
}

/** Where each page lives and the areas that open it. The first one a person has is their home. */
export const PAGES: { to: string; perms: Perm[] }[] = [
  { to: '/', perms: ['finance'] },
  { to: '/sales', perms: ['sales'] },
  { to: '/orders', perms: ['purchasing'] },
  { to: '/stock', perms: ['stock'] },
  { to: '/food/catalogue', perms: ['catalogue'] },
  { to: '/schedule', perms: ['roster'] },
  { to: '/people', perms: ['people', 'payroll'] },
  { to: '/settings', perms: ['admin'] },
]

/** Shows the page only to people whose group includes one of these areas. */
export function Need({ perms, children }: { perms: Perm[]; children: ReactNode }) {
  const { can, isLoading } = usePerms()
  if (isLoading) return <Loading />
  if (can(...perms)) return <>{children}</>
  return (
    <div className="card mx-auto mt-10 max-w-md p-6 text-center">
      <h1 className="text-lg font-semibold">Not part of your access</h1>
      <p className="mt-1 text-sm text-muted">Your security group doesn't include this page. An owner can change that in People → Access.</p>
      <Link to="/" className="btn mt-4">Go to my first page</Link>
    </div>
  )
}

/** The landing page: the dashboard if you can see it, otherwise the first page you can. */
export function Home({ dashboard }: { dashboard: ReactNode }) {
  const { can, isLoading } = usePerms()
  if (isLoading) return <Loading />
  if (can('finance')) return <>{dashboard}</>
  const first = PAGES.find((p) => p.to !== '/' && can(...p.perms))
  if (first) return <Navigate to={first.to} replace />
  return (
    <div className="card mx-auto mt-10 max-w-md p-6 text-center">
      <h1 className="text-lg font-semibold">Nothing to open yet</h1>
      <p className="mt-1 text-sm text-muted">Your security group has no pages in this business. Ask an owner to add some in People → Access.</p>
    </div>
  )
}
