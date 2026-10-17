import { useEffect, useRef, useState, type ReactNode } from 'react'
import { NavLink, Outlet, useLocation } from 'react-router-dom'
import { supabase } from '../lib/supabase'
import { useBusiness } from '../lib/business'

const icon = (d: string) => (
  <svg viewBox="0 0 24 24" width="22" height="22" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
    <path d={d} />
  </svg>
)

interface NavItem { to: string; label: string; short: string; icon: ReactNode; end?: boolean }

/** The six that earn a place in the bar on a phone. */
const NAV: NavItem[] = [
  { to: '/', label: 'Dashboard', short: 'Home', end: true, icon: icon('M3 13h4v8H3zM10 8h4v13h-4zM17 3h4v18h-4z') },
  { to: '/sales', label: 'Enter sales', short: 'Sales', icon: icon('M12 3v18M17 7.5c0-1.9-2.2-3-5-3s-5 1.1-5 3 2.2 2.7 5 3.3 5 1.4 5 3.5-2.2 3.2-5 3.2-5-1.3-5-3.2') },
  { to: '/expenses/new', label: 'Add expense', short: 'Add', end: true, icon: icon('M12 5v14M5 12h14') },
  { to: '/orders', label: 'Purchase orders', short: 'Orders', icon: icon('M6 2h9l5 5v15H6zM15 2v5h5M9 13h7M9 17h7') },
  { to: '/stock', label: 'Stock counts', short: 'Stock', icon: icon('M3 7l9-4 9 4v10l-9 4-9-4zM3 7l9 4 9-4M12 11v10') },
  { to: '/food', label: 'Food', short: 'Food', icon: icon('M5 3v8a3 3 0 0 0 6 0V3M8 11v10M19 3c-1.7 1.4-2.5 3.3-2.5 5.5 0 1.6.6 2.6 1.5 3.1V21') },
]

/** Reached from the “More” button: needed regularly, but not every day. */
const MORE: NavItem[] = [
  { to: '/expenses', label: 'Expenses', short: 'Expenses', end: true, icon: icon('M8 6h13M8 12h13M8 18h13M3.5 6h.01M3.5 12h.01M3.5 18h.01') },
  { to: '/recurring', label: 'Standard expenses', short: 'Standard', icon: icon('M4 12a8 8 0 0 1 14-5.3L20 9M20 4v5h-5M20 12a8 8 0 0 1-14 5.3L4 15M4 20v-5h5') },
  { to: '/settings', label: 'Settings', short: 'Settings', icon: icon('M12 15a3 3 0 1 0 0-6 3 3 0 0 0 0 6zM19.4 15a1.7 1.7 0 0 0 .3 1.8l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.7 1.7 0 0 0-2.8 1.2V21a2 2 0 1 1-4 0v-.1a1.7 1.7 0 0 0-2.8-1.2l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.7 1.7 0 0 0-1.2-2.8H3a2 2 0 1 1 0-4h.1a1.7 1.7 0 0 0 1.2-2.8l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.7 1.7 0 0 0 2.8-1.2V3a2 2 0 1 1 4 0v.1a1.7 1.7 0 0 0 2.8 1.2l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.7 1.7 0 0 0 1.2 2.8H21a2 2 0 1 1 0 4h-.1a1.7 1.7 0 0 0-1.5 1.1z') },
]

const MORE_ICON = icon('M4 6h16M4 12h16M4 18h16')

/**
 * The rest of the pages. Closes on a click outside, on Escape, and whenever the route
 * changes — otherwise tapping a link would leave the panel hanging over the new page.
 */
function MoreMenu({ variant }: { variant: 'bar' | 'tab' }) {
  const [open, setOpen] = useState(false)
  const wrap = useRef<HTMLDivElement>(null)
  const { pathname } = useLocation()

  useEffect(() => setOpen(false), [pathname])
  useEffect(() => {
    if (!open) return
    const onDown = (e: MouseEvent) => { if (!wrap.current?.contains(e.target as Node)) setOpen(false) }
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') setOpen(false) }
    document.addEventListener('mousedown', onDown)
    document.addEventListener('keydown', onKey)
    return () => { document.removeEventListener('mousedown', onDown); document.removeEventListener('keydown', onKey) }
  }, [open])

  const active = MORE.some((m) => (m.end ? pathname === m.to : pathname.startsWith(m.to)))

  return (
    <div ref={wrap} className={variant === 'tab' ? 'relative' : 'relative shrink-0'}>
      <button
        type="button"
        aria-expanded={open}
        aria-haspopup="menu"
        onClick={() => setOpen((v) => !v)}
        className={
          variant === 'tab'
            ? `flex w-full flex-col items-center gap-0.5 py-2 text-[11px] font-medium ${active || open ? 'text-accent' : 'text-muted'}`
            : `whitespace-nowrap rounded-lg px-2 py-1.5 text-sm font-medium lg:px-3 ${active || open ? 'bg-surface-2 text-ink' : 'text-ink-2 hover:text-ink'}`
        }
      >
        {variant === 'tab' ? MORE_ICON : null}
        More
      </button>
      {open && (
        <div
          role="menu"
          className={`absolute z-30 min-w-48 overflow-hidden rounded-xl border border-line bg-surface py-1 shadow-lg ${
            variant === 'tab' ? 'bottom-full right-0 mb-1' : 'right-0 top-full mt-1'
          }`}
        >
          {MORE.map((m) => (
            <NavLink
              key={m.to}
              to={m.to}
              end={m.end}
              role="menuitem"
              className={({ isActive }) => `flex items-center gap-2.5 px-3 py-2.5 text-sm font-medium ${isActive ? 'bg-surface-2 text-ink' : 'text-ink-2'}`}
            >
              {m.icon}
              {m.label}
            </NavLink>
          ))}
        </div>
      )}
    </div>
  )
}

/** Which business every page is showing. Hidden while there is only one. */
function BusinessSwitcher() {
  const { businesses, businessId, setBusinessId } = useBusiness()
  if (businesses.length < 2)
    return <span className="hidden max-w-40 truncate text-sm font-semibold text-ink-2 sm:inline">{businesses[0]?.name}</span>
  return (
    <select
      aria-label="Business"
      className="field !w-auto max-w-40 shrink-0 truncate !py-1.5 !text-sm font-semibold"
      value={businessId}
      onChange={(e) => setBusinessId(e.target.value)}
    >
      {businesses.map((b) => <option key={b.id} value={b.id}>{b.name}</option>)}
    </select>
  )
}

function ThemeToggle() {
  const [theme, setTheme] = useState(() => document.documentElement.dataset.theme ?? '')
  const isDark = theme ? theme === 'dark' : window.matchMedia('(prefers-color-scheme: dark)').matches
  const toggle = () => {
    const next = isDark ? 'light' : 'dark'
    document.documentElement.dataset.theme = next
    try { localStorage.setItem('theme', next) } catch { /* private mode */ }
    setTheme(next)
  }
  return (
    <button type="button" className="btn btn-sm" onClick={toggle} aria-label={`Switch to ${isDark ? 'light' : 'dark'} mode`}>
      {isDark ? '☀︎' : '☾'}
    </button>
  )
}

export function Layout({ email }: { email?: string }) {
  return (
    <div className="min-h-dvh pb-24 md:pb-10">
      <header className="sticky top-0 z-20 border-b border-line bg-page/90 backdrop-blur">
        <div className="mx-auto flex max-w-6xl items-center gap-2 px-4 py-2.5 lg:gap-3">
          <NavLink to="/" className="flex shrink-0 items-center font-bold" aria-label="Dashboard">
            <img src={`${import.meta.env.BASE_URL}favicon.svg`} alt="" className="h-7 w-7" />
          </NavLink>
          <BusinessSwitcher />
          {/* One line, always: short labels until there is room for the full ones. */}
          <nav className="hidden min-w-0 flex-1 items-center justify-center gap-0.5 md:flex lg:gap-1" aria-label="Main">
            {NAV.map((n) => (
              <NavLink key={n.to} to={n.to} end={n.end}
                className={({ isActive }) => `whitespace-nowrap rounded-lg px-2 py-1.5 text-sm font-medium lg:px-3 ${isActive ? 'bg-surface-2 text-ink' : 'text-ink-2 hover:text-ink'}`}>
                <span className="xl:hidden">{n.short}</span>
                <span className="hidden xl:inline">{n.label}</span>
              </NavLink>
            ))}
            <MoreMenu variant="bar" />
          </nav>
          <div className="ml-auto flex shrink-0 items-center gap-2">
            <span className="hidden max-w-48 truncate text-xs text-muted xl:inline">{email}</span>
            <ThemeToggle />
            <button type="button" className="btn btn-sm" onClick={() => supabase.auth.signOut()}>Sign out</button>
          </div>
        </div>
      </header>

      <main className="mx-auto max-w-6xl px-4 pt-5">
        <Outlet />
      </main>

      <nav aria-label="Main" className="fixed inset-x-0 bottom-0 z-20 grid grid-cols-7 border-t border-line bg-surface pb-[env(safe-area-inset-bottom)] md:hidden">
        {NAV.map((n) => (
          <NavLink key={n.to} to={n.to} end={n.end}
            className={({ isActive }) => `flex flex-col items-center gap-0.5 py-2 text-center text-[10px] font-medium leading-tight ${isActive ? 'text-accent' : 'text-muted'}`}>
            {n.icon}
            {n.short}
          </NavLink>
        ))}
        <MoreMenu variant="tab" />
      </nav>
    </div>
  )
}
