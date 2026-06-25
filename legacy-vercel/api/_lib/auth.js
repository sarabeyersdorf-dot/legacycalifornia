// api/_lib/auth.js
// Extracts and validates the Supabase user from an incoming request.
// Looks for a Bearer token in `Authorization` header (preferred) or `sb-access-token` cookie.
// If the access token is expired, transparently exchanges the long-lived
// `sb-refresh-token` cookie for a fresh access token and rotates the cookie
// on the response so the user never gets unexpectedly logged out.

import { adminClient } from './supabase.js';

const ACCESS_COOKIE_OPTS  = 'Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=3600';
const REFRESH_COOKIE_OPTS = 'Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=2592000';

function readCookie(req, name) {
  const cookie = req.headers.cookie || '';
  const match = cookie.match(new RegExp(`(?:^|;\\s*)${name}=([^;]+)`));
  return match ? decodeURIComponent(match[1]) : null;
}

export function readBearerToken(req) {
  const h = req.headers.authorization || req.headers.Authorization;
  if (h && h.startsWith('Bearer ')) return h.slice(7);
  return readCookie(req, 'sb-access-token');
}

/**
 * Resolves the calling Supabase user (if any) and the matching public.users row.
 * Returns { user, profile } or { user: null, profile: null } if unauthenticated.
 *
 * If the access token is expired/invalid but a valid refresh token is present,
 * we transparently refresh the session and set new cookies on `res` (when
 * provided) so the next request has a working access token again.
 */
export async function getCallerProfile(req, res) {
  const supa = adminClient();
  let token = readBearerToken(req);
  let user = null;

  if (token) {
    const { data, error } = await supa.auth.getUser(token);
    if (!error && data?.user) user = data.user;
  }

  // Access token missing or expired — try the refresh token.
  if (!user) {
    const refreshToken = readCookie(req, 'sb-refresh-token');
    if (refreshToken) {
      const { data, error } = await supa.auth.refreshSession({ refresh_token: refreshToken });
      if (!error && data?.session && data?.user) {
        user = data.user;
        token = data.session.access_token;
        if (res && typeof res.setHeader === 'function') {
          res.setHeader('Set-Cookie', [
            `sb-access-token=${encodeURIComponent(data.session.access_token)}; ${ACCESS_COOKIE_OPTS}`,
            `sb-refresh-token=${encodeURIComponent(data.session.refresh_token)}; ${REFRESH_COOKIE_OPTS}`
          ]);
        }
      }
    }
  }

  if (!user) return { user: null, profile: null, token: null };

  const { data: profile } = await supa
    .from('users')
    .select('*')
    .eq('id', user.id)
    .maybeSingle();

  return { user, profile: profile || null, token };
}

export function isAgent(profile) {
  return !!profile && ['agent_sara', 'agent_james', 'admin'].includes(profile.role);
}

export function isSeller(profile) {
  return !!profile && profile.role === 'seller';
}
