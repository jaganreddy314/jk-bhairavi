import { useEffect, useState, type ReactNode } from 'react'
import type { Session } from '@supabase/supabase-js'
import { supabase } from '../lib/supabase'
import { ErrorBox, Loading } from './ui'

/** Magic-link sign-in. Which businesses (if any) the person can open is decided by BusinessGate. */
export function AuthGate({ children }: { children: (session: Session) => ReactNode }) {
  const [session, setSession] = useState<Session | null | undefined>(undefined)

  useEffect(() => {
    supabase.auth.getSession().then(({ data }) => setSession(data.session))
    const { data } = supabase.auth.onAuthStateChange((_e, s) => setSession(s))
    return () => data.subscription.unsubscribe()
  }, [])

  if (session === undefined) return <Loading />
  if (!session) return <SignIn />
  return <>{children(session)}</>
}

function SignIn() {
  const [email, setEmail] = useState('')
  const [sent, setSent] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<unknown>(null)

  async function submit(e: React.FormEvent) {
    e.preventDefault()
    setBusy(true)
    setError(null)
    const { error } = await supabase.auth.signInWithOtp({
      email: email.trim(),
      options: { emailRedirectTo: window.location.origin + import.meta.env.BASE_URL, shouldCreateUser: true },
    })
    setBusy(false)
    if (error) setError(error)
    else setSent(true)
  }

  return (
    <Centered>
      <div className="mb-5 flex items-center gap-2.5">
        <img src={`${import.meta.env.BASE_URL}favicon.svg`} alt="" className="h-9 w-9" />
        <div>
          <h1 className="text-xl font-bold leading-tight">JK Bhairavi</h1>
          <p className="text-sm text-muted">Sales &amp; expenses</p>
        </div>
      </div>
      {sent ? (
        <div>
          <p className="text-ink-2">Check <b>{email}</b> for a sign-in link. Open it on this device.</p>
          <button className="btn mt-5 w-full" onClick={() => setSent(false)}>Use a different email</button>
        </div>
      ) : (
        <form onSubmit={submit}>
          <ErrorBox error={error} />
          <label className="label" htmlFor="email">Email</label>
          <input id="email" type="email" required autoComplete="email" className="field" value={email}
            onChange={(e) => setEmail(e.target.value)} placeholder="you@example.com" />
          <button className="btn btn-primary mt-4 w-full" disabled={busy}>{busy ? 'Sending…' : 'Email me a sign-in link'}</button>
        </form>
      )}
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
