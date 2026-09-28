import { createContext, useContext, useEffect, useState, type ReactNode } from 'react'
import { useQuery } from '@tanstack/react-query'
import { supabase } from './supabase'
import type { Business } from './types'

interface Ctx {
  businessId: string
  business: Business | undefined
  businesses: Business[]
  setBusinessId: (id: string) => void
}

const BusinessContext = createContext<Ctx | null>(null)
const KEY = 'businessId'

/** The businesses this person belongs to. Row-level security returns only those. */
export function useBusinesses() {
  return useQuery({
    queryKey: ['businesses'],
    queryFn: async () => {
      const { data, error } = await supabase.from('businesses').select('*').order('name')
      if (error) throw new Error(error.message)
      return (data ?? []) as Business[]
    },
  })
}

export function BusinessProvider({ businesses, children }: { businesses: Business[]; children: ReactNode }) {
  const [businessId, setId] = useState(() => {
    let saved: string | null = null
    try { saved = localStorage.getItem(KEY) } catch { /* storage unavailable */ }
    return businesses.some((b) => b.id === saved) ? saved! : businesses[0].id
  })

  // If the chosen business disappears (access removed elsewhere), fall back to the first one.
  useEffect(() => {
    if (!businesses.some((b) => b.id === businessId)) setId(businesses[0].id)
  }, [businesses, businessId])

  const setBusinessId = (id: string) => {
    setId(id)
    try { localStorage.setItem(KEY, id) } catch { /* storage unavailable */ }
  }

  return (
    <BusinessContext.Provider value={{ businessId, business: businesses.find((b) => b.id === businessId), businesses, setBusinessId }}>
      {children}
    </BusinessContext.Provider>
  )
}

export function useBusiness() {
  const ctx = useContext(BusinessContext)
  if (!ctx) throw new Error('useBusiness must be used inside BusinessProvider')
  return ctx
}

/** The id every query and insert is scoped to. */
export const useBusinessId = () => useBusiness().businessId
