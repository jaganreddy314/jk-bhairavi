import { createClient } from '@supabase/supabase-js'

const url = import.meta.env.VITE_SUPABASE_URL as string | undefined
const key = import.meta.env.VITE_SUPABASE_ANON_KEY as string | undefined

export const isConfigured = Boolean(url && key)

// Placeholder values keep the import safe; App shows a setup screen when not configured.
export const supabase = createClient(url || 'http://localhost', key || 'missing-key', {
  auth: {
    // Signing in once should last. The session is kept in this device's localStorage and
    // the access token is renewed in the background, so the shop's phone stays signed in
    // across restarts indefinitely — nobody has to log in again before entering a day's
    // takings. Access itself is still checked on every request: losing your place in
    // business_users means the queries return nothing, whatever the session says.
    persistSession: true,
    autoRefreshToken: true,
    // Needed for the two links that still arrive by email: the sign-in link kept as a
    // fallback, and the password-reset link.
    detectSessionInUrl: true,
    flowType: 'pkce',
  },
})
