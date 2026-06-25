// api/auth/session.js
// GET  → returns the current user + profile (or 401)
// POST → sets session cookies from a posted { access_token, refresh_token } pair
//        (used by the fragment-flow magic-link shim)
// DELETE → clears the cookies

import { adminClient } from '../supabase.js';
import { getCallerProfile } from '../auth.js';
import { handleOptions, readJson, ok, fail } from '../cors.js';

const COOKIE_OPTS = 'Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=3600';

function setCookies(res, access_token, refresh_token) {
  const cookies = [];
  if (access_token) {
    cookies.push(`sb-access-token=${encodeURIComponent(access_token)}; ${COOKIE_OPTS}`);
  }
  if (refresh_token) {
    cookies.push(`sb-refresh-token=${encodeURIComponent(refresh_token)}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=2592000`);
  }
  if (cookies.length) res.setHeader('Set-Cookie', cookies);
}

function clearCookies(res) {
  res.setHeader('Set-Cookie', [
    'sb-access-token=; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=0',
    'sb-refresh-token=; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=0'
  ]);
}

export default async function handler(req, res) {
  if (handleOptions(req, res)) return;

  if (req.method === 'GET') {
    const { user, profile } = await getCallerProfile(req, res);
    if (!user) return fail(res, 401, 'not authenticated');
    return ok(res, { user: { id: user.id, email: user.email }, profile });
  }

  if (req.method === 'POST') {
    try {
      const { access_token, refresh_token } = await readJson(req);
      if (!access_token) return fail(res, 400, 'access_token required');

      // Verify the token actually maps to a user before storing it.
      const supa = adminClient();
      const { data: { user }, error } = await supa.auth.getUser(access_token);
      if (error || !user) return fail(res, 401, 'invalid token');

      setCookies(res, access_token, refresh_token);
      return ok(res, { user: { id: user.id, email: user.email } });
    } catch (e) {
      return fail(res, 500, e.message);
    }
  }

  if (req.method === 'DELETE') {
    clearCookies(res);
    return ok(res, { signed_out: true });
  }

  return fail(res, 405, 'method_not_allowed');
}
