import type { ReactNode } from 'react'
import { supabase } from '../lib/supabase'
import { BusinessProvider, useBusinesses } from '../lib/business'
import { Centered } from './Auth'
import { ErrorBox, Loading } from './ui'

/** Decides which businesses this person can open. No businesses = no access. */
export function BusinessGate({ email, children }: { email?: string; children: ReactNode }) {
  const { data, isLoading, error } = useBusinesses()

  if (isLoading) return <Loading label="Checking access…" />
  if (error)
    return (
      <Centered>
        <h1 className="text-xl font-bold">Couldn’t load your businesses</h1>
        <ErrorBox error={error} />
        <button className="btn mt-3 w-full" onClick={() => location.reload()}>Try again</button>
      </Centered>
    )
  if (!data?.length)
    return (
      <Centered>
        <h1 className="text-xl font-bold">No access yet</h1>
        <p className="mt-2 text-sm text-ink-2">
          <b>{email}</b> hasn’t been added to a business yet. Ask an owner to add this address in Settings.
        </p>
        <button className="btn mt-5 w-full" onClick={() => supabase.auth.signOut()}>Sign out</button>
      </Centered>
    )
  return <BusinessProvider businesses={data}>{children}</BusinessProvider>
}
