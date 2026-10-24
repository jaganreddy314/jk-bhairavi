import { useEffect, useState, type ReactNode } from 'react'
import { NavLink, Outlet, useLocation, useNavigate } from 'react-router-dom'
import { supabase } from '../lib/supabase'
import { useBusiness } from '../lib/business'
import { usePerms } from '../lib/access'
import type { Perm } from '../lib/types'

/** Lucide icons, drawn from their own paths so the app needs no icon library. */
const Icon = ({ size = 18, stroke = 1.8, children }: { size?: number; stroke?: number; children: ReactNode }) => (
  <svg viewBox="0 0 24 24" width={size} height={size} fill="none" stroke="currentColor" strokeWidth={stroke} strokeLinecap="round" strokeLinejoin="round" aria-hidden className="shrink-0">
    {children}
  </svg>
)

const GLYPH = {
  dashboard: <><rect width="7" height="9" x="3" y="3" rx="1" /><rect width="7" height="5" x="14" y="3" rx="1" /><rect width="7" height="9" x="14" y="12" rx="1" /><rect width="7" height="5" x="3" y="16" rx="1" /></>,
  sales: <><path d="M4 2v20l2-1 2 1 2-1 2 1 2-1 2 1 2-1 2 1V2l-2 1-2-1-2 1-2-1-2 1-2-1-2 1Z" /><path d="M16 8h-6a2 2 0 1 0 0 4h4a2 2 0 1 1 0 4H8" /><path d="M12 17.5v-11" /></>,
  expense: <><path d="M19 7V4a1 1 0 0 0-1-1H5a2 2 0 0 0 0 4h15a1 1 0 0 1 1 1v4h-3a2 2 0 0 0 0 4h3a1 1 0 0 0 1-1v-2a1 1 0 0 0-1-1" /><path d="M3 5v14a2 2 0 0 0 2 2h15a1 1 0 0 0 1-1v-4" /></>,
  orders: <><circle cx="8" cy="21" r="1" /><circle cx="19" cy="21" r="1" /><path d="M2.05 2.05h2l2.66 12.42a2 2 0 0 0 2 1.58h9.78a2 2 0 0 0 1.95-1.57l1.65-7.43H5.12" /></>,
  stock: <><rect width="8" height="4" x="8" y="2" rx="1" /><path d="M16 4h2a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2h2" /><path d="M12 11h4" /><path d="M12 16h4" /><path d="M8 11h.01" /><path d="M8 16h.01" /></>,
  food: <><path d="M3 2v7c0 1.1.9 2 2 2h4a2 2 0 0 0 2-2V2" /><path d="M7 2v20" /><path d="M21 15V2a5 5 0 0 0-5 5v6c0 1.1.9 2 2 2h3Zm0 0v7" /></>,
  list: <><path d="M8 6h13M8 12h13M8 18h13M3.5 6h.01M3.5 12h.01M3.5 18h.01" /></>,
  repeat: <><path d="m17 2 4 4-4 4" /><path d="M3 11v-1a4 4 0 0 1 4-4h14" /><path d="m7 22-4-4 4-4" /><path d="M21 13v1a4 4 0 0 1-4 4H3" /></>,
  settings: <><path d="M12.22 2h-.44a2 2 0 0 0-2 2v.18a2 2 0 0 1-1 1.73l-.43.25a2 2 0 0 1-2 0l-.15-.08a2 2 0 0 0-2.73.73l-.22.38a2 2 0 0 0 .73 2.73l.15.1a2 2 0 0 1 1 1.72v.51a2 2 0 0 1-1 1.74l-.15.09a2 2 0 0 0-.73 2.73l.22.38a2 2 0 0 0 2.73.73l.15-.08a2 2 0 0 1 2 0l.43.25a2 2 0 0 1 1 1.73V20a2 2 0 0 0 2 2h.44a2 2 0 0 0 2-2v-.18a2 2 0 0 1 1-1.73l.43-.25a2 2 0 0 1 2 0l.15.08a2 2 0 0 0 2.73-.73l.22-.39a2 2 0 0 0-.73-2.73l-.15-.08a2 2 0 0 1-1-1.74v-.5a2 2 0 0 1 1-1.74l.15-.09a2 2 0 0 0 .73-2.73l-.22-.38a2 2 0 0 0-2.73-.73l-.15.08a2 2 0 0 1-2 0l-.43-.25a2 2 0 0 1-1-1.73V4a2 2 0 0 0-2-2z" /><circle cx="12" cy="12" r="3" /></>,
  moon: <path d="M12 3a6 6 0 0 0 9 9 9 9 0 1 1-9-9Z" />,
  sun: <><circle cx="12" cy="12" r="4" /><path d="M12 2v2M12 20v2M4.93 4.93l1.41 1.41M17.66 17.66l1.41 1.41M2 12h2M20 12h2M6.34 17.66l-1.41 1.41M19.07 4.93l-1.41 1.41" /></>,
  plus: <><path d="M5 12h14" /><path d="M12 5v14" /></>,
  chevronsUpDown: <><path d="m7 15 5 5 5-5" /><path d="m7 9 5-5 5 5" /></>,
  chevronDown: <path d="m6 9 6 6 6-6" />,
  logOut: <><path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4" /><path d="m16 17 5-5-5-5" /><path d="M21 12H9" /></>,
  calendar: <><rect width="18" height="18" x="3" y="4" rx="2" /><path d="M16 2v4M8 2v4M3 10h18" /></>,
  people: <><path d="M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2" /><circle cx="9" cy="7" r="4" /><path d="M22 21v-2a4 4 0 0 0-3-3.87" /><path d="M16 3.13a4 4 0 0 1 0 7.75" /></>,
}

/** A page in the navigation, and the areas (any one of them) that open it. */
interface NavItem { to: string; label: string; glyph: ReactNode; end?: boolean; perms: Perm[] }

const OVERVIEW: NavItem[] = [
  { to: '/', label: 'Dashboard', end: true, glyph: GLYPH.dashboard, perms: ['finance'] },
  { to: '/sales', label: 'Enter sales', glyph: GLYPH.sales, perms: ['sales'] },
  { to: '/expenses/new', label: 'Add expense', end: true, glyph: GLYPH.expense, perms: ['finance'] },
]

const INVENTORY: NavItem[] = [
  { to: '/orders', label: 'Purchase orders', glyph: GLYPH.orders, perms: ['purchasing'] },
  { to: '/stock', label: 'Stock counts', glyph: GLYPH.stock, perms: ['stock'] },
  { to: '/food', label: 'Food', glyph: GLYPH.food, perms: ['finance', 'catalogue'] },
]

const TEAM: NavItem[] = [
  { to: '/people', label: 'People', glyph: GLYPH.people, perms: ['people', 'payroll', 'admin'] },
  { to: '/schedule', label: 'Schedule', glyph: GLYPH.calendar, perms: ['roster'] },
]

/** Needed regularly, but not every day: under “Manage” on a computer, in the account sheet on a phone. */
const MORE: NavItem[] = [
  { to: '/expenses', label: 'Expenses', end: true, glyph: GLYPH.list, perms: ['finance'] },
  { to: '/recurring', label: 'Standard expenses', glyph: GLYPH.repeat, perms: ['finance'] },
  { to: '/settings', label: 'Settings', glyph: GLYPH.settings, perms: ['admin'] },
]

/** The phone's bottom bar, either side of the raised + button. */
const TABS: NavItem[] = [
  { to: '/', label: 'Home', end: true, glyph: GLYPH.dashboard, perms: ['finance'] },
  { to: '/orders', label: 'Orders', glyph: GLYPH.orders, perms: ['purchasing'] },
  { to: '/stock', label: 'Stock', glyph: GLYPH.stock, perms: ['stock'] },
  { to: '/food', label: 'Food', glyph: GLYPH.food, perms: ['finance', 'catalogue'] },
]

/** What the + button offers: the three things entered most. */
const QUICK_ADD = [
  { to: '/sales', label: 'Enter sales', sub: "Today's totals and cash", glyph: '$', tone: 'bg-accent-tint text-accent', perms: ['sales'] as Perm[] },
  { to: '/expenses/new', label: 'Add expense', sub: 'Wages, rent, bills and more', glyph: '−', tone: 'bg-[#EEF4FF] text-[#444CE7] dark:bg-[#1F2A5C] dark:text-[#A4BCFD]', perms: ['finance'] as Perm[] },
  { to: '/orders/new', label: 'New purchase order', sub: 'Order from a supplier', glyph: '+', tone: 'bg-[#FFFAEB] text-[#DC6803] dark:bg-[#2B1E07] dark:text-[#FEC84B]', perms: ['purchasing'] as Perm[] },
]

const isOn = (pathname: string, item: { to: string; end?: boolean }) =>
  item.end ? pathname === item.to : pathname === item.to || pathname.startsWith(item.to + '/')

/**
 * The navigation a person's group allows. Food opens on the catalogue for someone who
 * can see the catalogue but not the money side of it.
 */
function useAllowed() {
  const { can } = usePerms()
  return (items: NavItem[]) => items.filter((n) => can(...n.perms))
    .map((n) => (n.to === '/food' && !can('finance') ? { ...n, to: '/food/catalogue' } : n))
}

/** "Caltex Kedron" → "CK": the business's tile in the sidebar and top bar. */
const initials = (name = '') =>
  name.split(/\s+/).filter(Boolean).slice(0, 2).map((w) => w[0]!.toUpperCase()).join('') || '·'

function BusinessTile() {
  const { business } = useBusiness()
  return (
    <span className="grid h-[30px] w-[30px] shrink-0 place-items-center rounded-lg bg-accent text-[13px] font-semibold text-accent-ink">
      {initials(business?.name)}
    </span>
  )
}

/**
 * Which business every page is showing. With more than one, an invisible native select
 * covers the name, so tapping it opens the phone's own picker.
 */
function BusinessSwitcher({ compact }: { compact?: boolean }) {
  const { business, businesses, businessId, setBusinessId } = useBusiness()
  const many = businesses.length > 1
  return (
    <div className="relative flex min-w-0 flex-1 items-center gap-2.5">
      <BusinessTile />
      <div className="min-w-0 flex-1">
        <div className={`truncate font-semibold ${compact ? 'text-[15px]' : 'text-sm'}`}>{business?.name}</div>
        {many && !compact && <div className="text-xs text-muted">Switch store</div>}
      </div>
      {many && (
        <>
          <span className="text-muted"><Icon size={compact ? 14 : 16} stroke={2}>{compact ? GLYPH.chevronDown : GLYPH.chevronsUpDown}</Icon></span>
          <select
            aria-label="Switch store"
            className="absolute inset-0 cursor-pointer opacity-0"
            value={businessId}
            onChange={(e) => setBusinessId(e.target.value)}
          >
            {businesses.map((b) => <option key={b.id} value={b.id}>{b.name}</option>)}
          </select>
        </>
      )}
    </div>
  )
}

function useTheme() {
  const [theme, setTheme] = useState(() => document.documentElement.dataset.theme ?? '')
  const isDark = theme ? theme === 'dark' : window.matchMedia('(prefers-color-scheme: dark)').matches
  const toggle = () => {
    const next = isDark ? 'light' : 'dark'
    document.documentElement.dataset.theme = next
    try { localStorage.setItem('theme', next) } catch { /* private mode */ }
    setTheme(next)
  }
  return { isDark, toggle }
}

function ThemeButton({ className }: { className: string }) {
  const { isDark, toggle } = useTheme()
  return (
    <button type="button" onClick={toggle} aria-label={`Switch to ${isDark ? 'light' : 'dark'} mode`}
      className={`grid shrink-0 place-items-center border border-line bg-surface text-ink-2 hover:bg-surface-2 ${className}`}>
      <Icon size={15} stroke={2}>{isDark ? GLYPH.sun : GLYPH.moon}</Icon>
    </button>
  )
}

const Avatar = ({ email, size }: { email?: string; size: number }) => (
  <span style={{ width: size, height: size }} className="grid shrink-0 place-items-center rounded-full bg-accent-tint text-[13px] font-semibold text-accent">
    {(email?.[0] ?? '?').toUpperCase()}
  </span>
)

const navClass = ({ isActive }: { isActive: boolean }) =>
  `flex items-center gap-2.5 rounded-lg px-2.5 py-2 font-medium ${isActive ? 'bg-accent-tint text-accent' : 'text-ink-2 hover:bg-surface-2'}`

const GroupLabel = ({ children, first }: { children: ReactNode; first?: boolean }) => (
  <div className={`px-2.5 pb-1 text-[11px] font-medium uppercase tracking-[0.04em] text-faint ${first ? 'pt-2' : 'pt-3.5'}`}>{children}</div>
)

function Sidebar({ email }: { email?: string }) {
  const allowed = useAllowed()
  return (
    <aside className="sticky top-0 hidden h-dvh flex-col gap-1 overflow-y-auto border-r border-line bg-surface px-3 py-4 desk:flex">
      <div className="px-2 pb-3.5 pt-1.5">
        <BusinessSwitcher />
      </div>
      <nav aria-label="Main" className="flex flex-col gap-1">
        {([['Overview', OVERVIEW], ['Inventory', INVENTORY], ['Team', TEAM], ['Manage', MORE]] as const)
          .map(([label, items]) => [label, allowed([...items])] as const)
          .filter(([, items]) => items.length > 0)
          .map(([label, items], i) => (
            <div key={label} className="flex flex-col gap-1">
              <GroupLabel first={i === 0}>{label}</GroupLabel>
              {items.map((n) => <NavLink key={n.to} to={n.to} end={n.end} className={navClass}><Icon>{n.glyph}</Icon>{n.label}</NavLink>)}
            </div>
          ))}
      </nav>
      <div className="mt-auto flex items-center gap-2.5 border-t border-line px-1.5 pt-3">
        <Avatar email={email} size={32} />
        <div className="min-w-0 flex-1">
          <NavLink to="/account" className="block truncate text-[13px] font-medium hover:text-accent" title="Your account">{email}</NavLink>
          <button type="button" className="text-xs text-muted hover:text-ink" onClick={() => supabase.auth.signOut()}>Sign out</button>
        </div>
        <ThemeButton className="h-8 w-8 rounded-lg" />
      </div>
    </aside>
  )
}

/** A panel that rises from the bottom of a phone screen. Escape or the backdrop closes it. */
function Sheet({ open, onClose, children }: { open: boolean; onClose: () => void; children: ReactNode }) {
  useEffect(() => {
    if (!open) return
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose() }
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  }, [open, onClose])
  if (!open) return null
  return (
    <>
      <div className="fixed inset-0 z-40 bg-[rgba(16,24,40,0.4)]" onClick={onClose} />
      <div role="dialog" aria-modal="true"
        className="fixed inset-x-2 bottom-[calc(env(safe-area-inset-bottom)+8px)] z-41 rounded-2xl bg-surface p-2 shadow-[0_-8px_32px_rgba(16,24,40,0.2)]">
        <div className="mx-auto mb-2 mt-1 h-1 w-9 rounded-sm bg-input-line" />
        {children}
        <button type="button" onClick={onClose} className="mt-1 h-12 w-full rounded-xl bg-surface-2 text-[15px] font-semibold text-ink-2">Cancel</button>
      </div>
    </>
  )
}

const sheetRow = 'flex w-full items-center gap-3.5 rounded-xl p-3 text-left hover:bg-hover'

function PhoneChrome({ email }: { email?: string }) {
  const navigate = useNavigate()
  const { pathname } = useLocation()
  const [sheet, setSheet] = useState<'add' | 'account' | null>(null)
  const close = () => setSheet(null)
  // Also closes on Back, which changes the page without a tap in the sheet.
  useEffect(() => setSheet(null), [pathname])
  const go = (to: string) => { setSheet(null); navigate(to) }
  const allowed = useAllowed()
  const { can } = usePerms()
  const tabs = allowed(TABS)
  const quick = QUICK_ADD.filter((a) => can(...a.perms))
  const half = Math.ceil(tabs.length / 2)

  return (
    <>
      <header className="sticky top-0 z-20 flex items-center gap-2.5 border-b border-line bg-surface/95 px-4 pb-2.5 pt-[calc(env(safe-area-inset-top)+10px)] backdrop-blur-md desk:hidden">
        <BusinessSwitcher compact />
        <ThemeButton className="h-9 w-9 rounded-[10px]" />
        <button type="button" aria-label="Account and more" onClick={() => setSheet('account')} className="rounded-full">
          <Avatar email={email} size={36} />
        </button>
      </header>

      <nav aria-label="Main" style={{ gridTemplateColumns: `repeat(${tabs.length + (quick.length ? 1 : 0)}, minmax(0, 1fr))` }}
        className="fixed inset-x-0 bottom-0 z-30 grid items-end border-t border-line bg-surface/95 px-1 pb-[calc(env(safe-area-inset-bottom)+6px)] pt-1.5 backdrop-blur-md desk:hidden">
        {tabs.slice(0, half).map((t) => <Tab key={t.to} {...t} />)}
        {quick.length > 0 && <div className="flex justify-center">
          <button type="button" aria-label="Add" onClick={() => setSheet('add')}
            className="-mt-[22px] grid h-[52px] w-[52px] place-items-center rounded-full border-4 border-page bg-accent text-accent-ink shadow-[0_6px_16px_rgba(15,118,110,0.35)]">
            <Icon size={24} stroke={2.4}>{GLYPH.plus}</Icon>
          </button>
        </div>}
        {tabs.slice(half).map((t) => <Tab key={t.to} {...t} />)}
      </nav>

      <Sheet open={sheet === 'add'} onClose={close}>
        {quick.map((a) => (
          <button key={a.to} type="button" className={sheetRow} onClick={() => go(a.to)}>
            <span className={`grid h-10 w-10 shrink-0 place-items-center rounded-[10px] font-semibold ${a.tone}`}>{a.glyph}</span>
            <span className="flex-1">
              <span className="block text-[15px] font-semibold">{a.label}</span>
              <span className="block text-[13px] text-muted">{a.sub}</span>
            </span>
          </button>
        ))}
      </Sheet>

      <Sheet open={sheet === 'account'} onClose={close}>
        <button type="button" onClick={() => go('/account')} className="flex w-full items-center gap-3 rounded-xl px-3 pb-3 pt-1 text-left">
          <Avatar email={email} size={36} />
          <span className="min-w-0 flex-1">
            <span className="block truncate text-sm font-medium">{email}</span>
            <span className="block text-xs text-muted">Your account and password</span>
          </span>
        </button>
        {allowed([...OVERVIEW.slice(1), ...TEAM, ...MORE]).map((m) => (
          <button key={m.to} type="button" onClick={() => go(m.to)}
            className={`${sheetRow} font-medium ${isOn(pathname, m) ? 'text-accent' : 'text-ink-2'}`}>
            <Icon size={20}>{m.glyph}</Icon>
            <span className="text-[15px]">{m.label}</span>
          </button>
        ))}
        <button type="button" onClick={() => supabase.auth.signOut()} className={`${sheetRow} font-medium text-bad`}>
          <Icon size={20}>{GLYPH.logOut}</Icon>
          <span className="text-[15px]">Sign out</span>
        </button>
      </Sheet>
    </>
  )
}

function Tab({ to, label, glyph, end }: { to: string; label: string; glyph: ReactNode; end?: boolean }) {
  return (
    <NavLink to={to} end={end}
      className={({ isActive }) => `flex flex-col items-center gap-[3px] py-1.5 text-[11px] font-medium ${isActive ? 'text-accent' : 'text-muted'}`}>
      <Icon size={22}>{glyph}</Icon>
      {label}
    </NavLink>
  )
}

export function Layout({ email }: { email?: string }) {
  return (
    <div className="min-h-dvh desk:grid desk:grid-cols-[232px_minmax(0,1fr)]">
      <Sidebar email={email} />
      <PhoneChrome email={email} />
      <main className="mx-auto w-full min-w-0 max-w-[1280px] px-4 pb-[calc(env(safe-area-inset-bottom)+96px)] pt-4 desk:px-8 desk:pb-10 desk:pt-7">
        <Outlet />
      </main>
    </div>
  )
}
