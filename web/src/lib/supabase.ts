import { createClient } from '@supabase/supabase-js'

const url = import.meta.env.VITE_SUPABASE_URL as string | undefined
const key = import.meta.env.VITE_SUPABASE_ANON_KEY as string | undefined

export const isConfigured = Boolean(url && key)

// Placeholder values keep the import safe; App shows a setup screen when not configured.
export const supabase = createClient(url || 'http://localhost', key || 'missing-key')
