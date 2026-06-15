// api/auth/login.js
// Agent password login (Sara, James).
// Body: { email, password }
// Returns: { success, session: { access_token, refresh_token, expires_at, user, profile } }
//
// Buyers/sellers use the magic-link flow at /api/auth/magic-link instead.

import { adminClient, userClient } from '../_lib/supabase.js';
import { handleOptions, readJson, ok, fail } from '../_lib/cors.js';

export default async function handler(req, res) {
  if (handleOptions(req, res)) return;
  if (req.method !== 'POST') return fail(res, 405, 'method_not_allowed');

  try {
    const { email, password } = await readJson(req);
    if (!email || !password) return fail(res, 400, 'email and password required');

    // Use anon-key client to perform the password grant (RLS-aware).
    const supa = userClient(null);
    const { data, error } = await supa.auth.signInWithPassword({ email, password });
    if (error) return fail(res, 401, error.message);

    // Fetch profile (role, display name, etc.) via service-role.
    const { data: profile } = await adminClient()
      .from('users').select('*').eq('id', data.user.id).maybeSingle();

    return ok(res, {
      session: {
        access_token:  data.session.access_token,
        refresh_token: data.session.refresh_token,
        expires_at:    data.session.expires_at,
        user:          { id: data.user.id, email: data.user.email },
        profile:       profile || null
      }
    });
  } catch (e) {
    return fail(res, 500, e.message);
  }
}
