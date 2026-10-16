import { useEffect, useState, type ReactNode } from 'react'
import type { Session } from '@supabase/supabase-js'
import { supabase } from '../lib/supabase'
import { ErrorBox, Loading } from './ui'

/**
 * Sign-in with an email and password. Which businesses (if any) the person can then
 * open is decided by BusinessGate.
 *
 * Signing in lasts: the session lives in this device's localStorage and renews itself,
 * so the shop's phone stays signed in until someone signs out.
 */
export function AuthGate({ children }: { children: (session: Session) => ReactNode }) {
  const [session, setSession] = useState<Session | null | undefined>(undefined)
  // Arriving from a password-reset email: there *is* a session, but the only thing to
  // do with it is choose a new password, so that screen takes over until it's done.
  const [recovering, setRecovering] = useState(false)

  useEffect(() => {
    supabase.auth.getSession().then(({ data }) => setSession(data.session))
    const { data } = supabase.auth.onAuthStateChange((event, s) => {
      setSession(s)
      if (event === 'PASSWORD_RECOVERY') setRecovering(true)
    })
    return () => data.subscription.unsubscribe()
  }, [])

  if (session === undefined) return <Loading />
  if (!session) return <SignIn />
  if (recovering) return <ChooseNewPassword onDone={() => setRecovering(false)} />
  return <>{children(session)}</>
}

function Branding() {
  return (
    <div className="mb-5 flex items-center gap-2.5">
      <img src={`${import.meta.env.BASE_URL}favicon.svg`} alt="" className="h-9 w-9" />
      <div>
        <h1 className="text-xl font-bold leading-tight">JK Bhairavi</h1>
        <p className="text-sm text-muted">Sales &amp; expenses</p>
      </div>
    </div>
  )
}

/** Where the emailed links come back to — this build's own address. */
const redirectTo = () => window.location.origin + import.meta.env.BASE_URL

type Mode = 'password' | 'link' | 'reset'

function SignIn() {
  const [mode, setMode] = useState<Mode>('password')
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [sent, setSent] = useState<'link' | 'reset' | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<unknown>(null)

  async function submit(e: React.FormEvent) {
    e.preventDefault()
    setBusy(true)
    setError(null)
    const addr = email.trim().toLowerCase()

    if (mode === 'password') {
      const { error } = await supabase.auth.signInWithPassword({ email: addr, password })
      setBusy(false)
      // Supabase answers a wrong password and an unknown address the same way, on purpose.
      if (error) setError(new Error(error.message === 'Invalid login credentials'
        ? 'That email and password don’t match. Check them, or ask an owner to set your password again.'
        : error.message))
      return
    }

    if (mode === 'link') {
      // Kept so a forgotten password never locks anyone out of entering the day's takings.
      const { error } = await supabase.auth.signInWithOtp({
        email: addr,
        options: { emailRedirectTo: redirectTo(), shouldCreateUser: false },
      })
      setBusy(false)
      if (error) setError(error)
      else setSent('link')
      return
    }

    const { error } = await supabase.auth.resetPasswordForEmail(addr, { redirectTo: redirectTo() })
    setBusy(false)
    if (error) setError(error)
    else setSent('reset')
  }

  if (sent)
    return (
      <Centered>
        <Branding />
        <p className="text-ink-2">
          {sent === 'link' ? 'A sign-in link is on its way to ' : 'A link to choose a new password is on its way to '}
          <b>{email.trim().toLowerCase()}</b>. Open it on this device.
        </p>
        <p className="mt-2 text-xs text-muted">
          Nothing arrived? The address has to be one an owner has already added in Settings.
        </p>
        <button className="btn mt-5 w-full" onClick={() => { setSent(null); setMode('password') }}>Back to sign in</button>
      </Centered>
    )

  const heading = mode === 'password' ? null : mode === 'link' ? 'Email me a sign-in link' : 'Reset your password'

  return (
    <Centered>
      <Branding />
      <form onSubmit={submit}>
        <ErrorBox error={error} />
        {heading && <h2 className="mb-3 font-semibold">{heading}</h2>}

        <label className="label" htmlFor="email">Email</label>
        <input id="email" type="email" required autoComplete="username" className="field" value={email}
          onChange={(e) => setEmail(e.target.value)} placeholder="you@example.com" />

        {mode === 'password' && (
          <div className="mt-3">
            <label className="label" htmlFor="password">Password</label>
            <input id="password" type="password" required autoComplete="current-password" className="field"
              value={password} onChange={(e) => setPassword(e.target.value)} placeholder="••••••••" />
          </div>
        )}

        <button className="btn btn-primary mt-4 w-full" disabled={busy}>
          {busy ? 'Just a moment…' : mode === 'password' ? 'Sign in' : mode === 'link' ? 'Send me a link' : 'Send reset link'}
        </button>
      </form>

      <div className="mt-4 space-y-1.5 border-t border-line pt-3 text-sm">
        {mode !== 'password' && (
          <button type="button" className="font-medium text-accent" onClick={() => { setMode('password'); setError(null) }}>
            ← Sign in with a password
          </button>
        )}
        {mode !== 'reset' && (
          <button type="button" className="block font-medium text-accent" onClick={() => { setMode('reset'); setError(null) }}>
            Forgot your password?
          </button>
        )}
        {mode !== 'link' && (
          <button type="button" className="block font-medium text-accent" onClick={() => { setMode('link'); setError(null) }}>
            Email me a sign-in link instead
          </button>
        )}
      </div>
    </Centered>
  )
}

/** Shown when a password-reset link brings someone back. */
function ChooseNewPassword({ onDone }: { onDone: () => void }) {
  const [password, setPassword] = useState('')
  const [again, setAgain] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<unknown>(null)
  const tooShort = password.length > 0 && password.length < 8
  const mismatch = again.length > 0 && again !== password

  return (
    <Centered>
      <Branding />
      <h2 className="mb-1 font-semibold">Choose a new password</h2>
      <p className="mb-3 text-sm text-muted">At least 8 characters. You'll stay signed in on this device afterwards.</p>
      <form
        onSubmit={async (e) => {
          e.preventDefault()
          if (tooShort || mismatch || !password) return
          setBusy(true)
          setError(null)
          const { error } = await supabase.auth.updateUser({ password })
          setBusy(false)
          if (error) setError(error)
          else onDone()
        }}
      >
        <ErrorBox error={error} />
        <label className="label" htmlFor="np">New password</label>
        <input id="np" type="password" required autoComplete="new-password" className="field" value={password}
          onChange={(e) => setPassword(e.target.value)} />
        <div className="mt-3">
          <label className="label" htmlFor="np2">Again</label>
          <input id="np2" type="password" required autoComplete="new-password" className="field" value={again}
            onChange={(e) => setAgain(e.target.value)} />
        </div>
        {tooShort && <p className="mt-1 text-xs text-bad">A bit longer — 8 characters or more.</p>}
        {mismatch && <p className="mt-1 text-xs text-bad">These two don't match.</p>}
        <button className="btn btn-primary mt-4 w-full" disabled={busy || tooShort || mismatch || !password}>
          {busy ? 'Saving…' : 'Save password'}
        </button>
      </form>
    </Centered>
  )
}

export function Centered({ children }: { children: ReactNode }) {
  return (
    <div className="flex min-h-dvh items-center justify-center px-4">
      <div className="card w-full max-w-sm p-6">{children}</div>
    </div>
  )
}
