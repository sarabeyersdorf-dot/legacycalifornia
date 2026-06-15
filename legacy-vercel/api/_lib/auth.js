// api/_lib/auth.js
// Extracts and validates the Supabase user from an incoming request.
// Looks for a Bearer token in `Authorization` header (preferred) or `sb-access-token` cookie.

import { adminClient } from './supabase.js';

export function readBearerToken(req) {
  const h = req.headers.authorization || req.headers.Authorization;
  if (h && h.startsWith('Bearer ')) return h.slice(7);

  // Cookie fallback
  const cookie = req.headers.cookie || '';
  const match = cookie.match(/sb-access-token=([^;]+)/);
  if (match) return decodeURIComponent(match[1]);

  return null;
}

/**
 * Resolves the calling Supabase user (if any) and the matching public.users row.
 * Returns { user, profile } or { user: null, profile: null } if unauthenticated.
 */
export async function getCallerProfile(req) {
  const token = readBearerToken(req);
  if (!token) return { user: null, profile: null, token: null };

  const supa = adminClient();
  const { data: { user }, error } = await supa.auth.getUser(token);
  if (error || !user) return { user: null, profile: null, token };

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
