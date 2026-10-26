// Give a new business's owner a login, so a platform admin can hand the business over.
//
// The admin creates the business in the setup wizard (create_business), then this makes
// the owner's login with a temporary password and returns it, for the admin to send by
// whatever means suits (text, WhatsApp, email). The app asks the owner to choose their own
// password the first time they sign in. Nothing is emailed: the project has no mail
// service of its own, and Supabase's built-in one only reaches the project's own team.
//
// Someone who already has a login keeps it: the new business simply appears in their
// switcher. Calling again for an owner who hasn't signed in yet issues a fresh temporary
// password, for when the first one was lost.
//
// Deployed with: supabase functions deploy setup-owner-login --use-api --project-ref <ref>
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2'

const URL_ = Deno.env.get('SUPABASE_URL')!
const ANON = Deno.env.get('SUPABASE_ANON_KEY')!
const SERVICE = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!

// See set-password for why every header supabase-js sends is named here.
const cors = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, content-type, apikey, x-client-info',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
}

const reply = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { ...cors, 'Content-Type': 'application/json' } })

// No 0/O, 1/l/I: it will be read off a phone and typed in by hand.
const ALPHABET = 'abcdefghjkmnpqrstuvwxyz23456789'
function tempPassword() {
  const bytes = crypto.getRandomValues(new Uint8Array(12))
  const s = [...bytes].map((b) => ALPHABET[b % ALPHABET.length]).join('')
  return `${s.slice(0, 4)}-${s.slice(4, 8)}-${s.slice(8)}`
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: cors })
  if (req.method !== 'POST') return reply({ error: 'Use POST' }, 405)

  const auth = req.headers.get('Authorization')
  if (!auth) return reply({ error: 'Not signed in' }, 401)

  let email = ''
  let businessId = ''
  try {
    const body = await req.json()
    email = String(body.email ?? '').trim().toLowerCase()
    businessId = String(body.business_id ?? '')
  } catch {
    return reply({ error: 'Expected JSON' }, 400)
  }
  if (!email || !businessId) return reply({ error: 'Which business, and whose login?' }, 400)

  // Only platform admins, asked as the caller so the database's own rule decides.
  const asCaller = createClient(URL_, ANON, { global: { headers: { Authorization: auth } } })
  const { data: isAdmin, error: adminErr } = await asCaller.rpc('is_platform_admin')
  if (adminErr) return reply({ error: adminErr.message }, 400)
  if (isAdmin !== true) return reply({ error: 'Only platform admins can set up owner logins.' }, 403)

  const admin = createClient(URL_, SERVICE, { auth: { persistSession: false } })

  // Only for someone who really is an owner of that business, so this can't be used to
  // reset an arbitrary person's password.
  const { data: owner, error: ownerErr } = await admin
    .from('business_users')
    .select('email, security_groups!inner(is_owner)')
    .eq('business_id', businessId)
    .eq('email', email)
    .eq('security_groups.is_owner', true)
    .maybeSingle()
  if (ownerErr) return reply({ error: ownerErr.message }, 500)
  if (!owner) return reply({ error: 'That person is not an owner of this business.' }, 404)

  // Logins number in the tens, so one page is all of them.
  const { data: list, error: listErr } = await admin.auth.admin.listUsers({ page: 1, perPage: 1000 })
  if (listErr) return reply({ error: listErr.message }, 500)
  const existing = list.users.find((u) => u.email?.toLowerCase() === email)

  // Already using the app with their own password: leave it alone.
  if (existing && !existing.user_metadata?.needs_password)
    return reply({ ok: true, existing: true, email })

  const password = tempPassword()
  const { error } = existing
    ? await admin.auth.admin.updateUserById(existing.id, { password })
    : await admin.auth.admin.createUser({
        email,
        password,
        // The admin vouched for them by making them the owner.
        email_confirm: true,
        user_metadata: { needs_password: true },
      })
  if (error) return reply({ error: error.message }, 500)
  return reply({ ok: true, existing: false, email, password })
})
