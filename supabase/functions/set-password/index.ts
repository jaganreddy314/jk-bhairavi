// Set another person's password, so somebody can be given access without an email
// round-trip: an owner adds their address in Settings, sets a password, and tells them.
//
// The browser can't do this — changing another user's password needs the service-role
// key, which must never reach a browser. So it happens here, and the one question that
// matters is whether the caller is allowed to.
//
// Deployed with: supabase functions deploy set-password --use-api --project-ref <ref>
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2'

const URL_ = Deno.env.get('SUPABASE_URL')!
const ANON = Deno.env.get('SUPABASE_ANON_KEY')!
const SERVICE = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!

// The app is served from a different origin (the worker, GitHub Pages, or localhost).
// Authorisation travels in a header rather than a cookie, so there is no credentialed
// cross-origin request to restrict here.
// supabase-js sends apikey and x-client-info alongside the bearer token; every header
// the browser asks about in its preflight has to be named here or the call is blocked
// before it is ever sent.
const cors = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, content-type, apikey, x-client-info',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
}

const reply = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { ...cors, 'Content-Type': 'application/json' } })

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: cors })
  if (req.method !== 'POST') return reply({ error: 'Use POST' }, 405)

  const auth = req.headers.get('Authorization')
  if (!auth) return reply({ error: 'Not signed in' }, 401)

  let email = ''
  let password = ''
  try {
    const body = await req.json()
    email = String(body.email ?? '').trim().toLowerCase()
    password = String(body.password ?? '')
  } catch {
    return reply({ error: 'Expected JSON' }, 400)
  }

  if (!email) return reply({ error: 'Which person?' }, 400)
  if (password.length < 8) return reply({ error: 'Password must be at least 8 characters' }, 400)

  // Who is asking, and are they allowed? Both answers come from the caller's own token.
  // Reading business_users as *them* means row-level security does the deciding: the query
  // can only return businesses the caller belongs to, so a row coming back means the caller
  // and this person share one. Nobody can set a password for someone outside their own
  // businesses, and this side never has to re-implement that rule.
  const asCaller = createClient(URL_, ANON, { global: { headers: { Authorization: auth } } })

  const { data: caller, error: whoErr } = await asCaller.auth.getUser()
  if (whoErr || !caller?.user) return reply({ error: 'Not signed in' }, 401)

  const { data: shared, error: sharedErr } = await asCaller
    .from('business_users')
    .select('business_id')
    .eq('email', email)
    .limit(1)

  if (sharedErr) return reply({ error: sharedErr.message }, 400)
  if (!shared?.length)
    return reply({ error: 'That person is not in any of your businesses. Add them in Settings first.' }, 403)

  // Allowed. Now the part that needs the service role.
  const admin = createClient(URL_, SERVICE, { auth: { persistSession: false } })

  // Someone added in Settings but who has never signed in has no auth user yet, so this
  // both creates and updates. The user list is only ever a handful of people, so one page
  // is the whole of it.
  const { data: list, error: listErr } = await admin.auth.admin.listUsers({ page: 1, perPage: 1000 })
  if (listErr) return reply({ error: listErr.message }, 500)

  const existing = list.users.find((u) => u.email?.toLowerCase() === email)

  if (existing) {
    const { error } = await admin.auth.admin.updateUserById(existing.id, { password })
    if (error) return reply({ error: error.message }, 500)
    return reply({ ok: true, created: false, email })
  }

  const { error } = await admin.auth.admin.createUser({
    email,
    password,
    // No confirmation email: an owner vouched for them by adding them in Settings.
    email_confirm: true,
  })
  if (error) return reply({ error: error.message }, 500)
  return reply({ ok: true, created: true, email })
})
