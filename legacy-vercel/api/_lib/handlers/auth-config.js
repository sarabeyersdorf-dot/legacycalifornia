// api/auth/config.js
// Returns the public Supabase URL + anon key so client JS can boot the
// Supabase JS client. These values are public by design — never the service
// role key.

import { publicEnv } from '../supabase.js';
import { handleOptions, ok, fail } from '../cors.js';

export default async function handler(req, res) {
  if (handleOptions(req, res)) return;
  if (req.method !== 'GET') return fail(res, 405, 'method_not_allowed');
  const env = publicEnv();
  if (!env.url || !env.anonKey) return fail(res, 503, 'supabase not configured');
  return ok(res, env);
}
