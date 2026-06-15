// api/auth/magic-link.js
// Sends a magic-link email to a buyer or seller. No password.
// Body: { email, redirect?: string }
// Returns: { success: true }

import { userClient } from '../supabase.js';
import { handleOptions, readJson, ok, fail } from '../cors.js';

export default async function handler(req, res) {
  if (handleOptions(req, res)) return;
  if (req.method !== 'POST') return fail(res, 405, 'method_not_allowed');

  try {
    const { email, redirect } = await readJson(req);
    if (!email) return fail(res, 400, 'email required');

    const origin = `${req.headers['x-forwarded-proto'] || 'https'}://${req.headers['x-forwarded-host'] || req.headers.host}`;
    const emailRedirectTo = redirect || `${origin}/api/auth/callback`;

    const supa = userClient(null);
    const { error } = await supa.auth.signInWithOtp({
      email,
      options: { emailRedirectTo }
    });
    if (error) return fail(res, 400, error.message);

    return ok(res, { sent: true });
  } catch (e) {
    return fail(res, 500, e.message);
  }
}
