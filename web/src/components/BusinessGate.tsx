import type { ReactNode } from 'react'
import { Route, Routes } from 'react-router-dom'
import { supabase } from '../lib/supabase'
import { useIsPlatformAdmin } from '../lib/api'
import { BusinessProvider, useBusinesses } from '../lib/business'
import Businesses, { NewBusiness } from '../pages/Businesses'
import { Centered } from './Auth'
import { ErrorBox, Loading } from './ui'

/** Decides which businesses this person can open. No businesses = no access. */
export function BusinessGate({ email, children }: { email?: string; children: ReactNode }) {
  const { data, isLoading, error } = useBusinesses()
  const admin = useIsPlatformAdmin()

  if (isLoading || admin.isLoading) return <Loading label="Checking access…" />
  if (error)
    return (
      <Centered>
        <h1 className="text-xl font-bold">Couldn’t load your businesses</h1>
        <ErrorBox error={error} />
        <button className="btn mt-3 w-full" onClick={() => location.reload()}>Try again</button>
      </Centered>
    )
  // A platform admin who belongs to no business can still set them up.
  if (!data?.length && admin.data)
    return (
      <main className="mx-auto w-full max-w-[1280px] px-4 py-6 desk:px-8">
        <Routes>
          <Route path="admin/businesses/new" element={<NewBusiness />} />
          <Route path="*" element={<Businesses />} />
        </Routes>
        <button className="btn btn-sm mt-6" onClick={() => supabase.auth.signOut()}>Sign out</button>
      </main>
    )
  if (!data?.length)
    return (
      <Centered>
        <h1 className="text-xl font-bold">No access yet</h1>
        <p className="mt-2 text-sm text-ink-2">
          <b>{email}</b> isn’t part of a business yet. Ask the business’s owner to add this address in People → Access, then sign in again.
        </p>
        <button className="btn mt-5 w-full" onClick={() => supabase.auth.signOut()}>Sign out</button>
      </Centered>
    )
  return <BusinessProvider businesses={data}>{children}</BusinessProvider>
}
