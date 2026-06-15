// api/_lib/supabase.js
// Server-side Supabase clients for Vercel serverless functions.
//
// - `adminClient()` uses the service role key and BYPASSES RLS. Use for trusted
//   server-side writes (lead intake, AI drafts, sequence cron, etc.).
// - `userClient(accessToken)` uses the anon key + a user JWT and RESPECTS RLS.
//   Use when echoing data back to an authenticated end user.

import { createClient } from '@supabase/supabase-js';

const SUPABASE_URL          = process.env.SUPABASE_URL
                           || process.env.NEXT_PUBLIC_SUPABASE_URL;

// Anon / publishable key (safe for browser use)
const SUPABASE_ANON_KEY     = process.env.SUPABASE_ANON_KEY
                           || process.env.SUPABASE_PUBLISHABLE_KEY
                           || process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY
                           || process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY;

// Service role / secret key (server only — bypasses RLS)
const SUPABASE_SERVICE_KEY  = process.env.SUPABASE_SERVICE_KEY
                           || process.env.SUPABASE_SERVICE_ROLE_KEY
                           || process.env.SUPABASE_SECRET_KEY;

function assertEnv() {
  if (!SUPABASE_URL || !SUPABASE_ANON_KEY || !SUPABASE_SERVICE_KEY) {
    throw new Error('Supabase env vars not configured (SUPABASE_URL / SUPABASE_ANON_KEY / SUPABASE_SERVICE_KEY)');
  }
}

let _admin = null;
export function adminClient() {
  assertEnv();
  if (!_admin) {
    _admin = createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY, {
      auth: { persistSession: false, autoRefreshToken: false }
    });
  }
  return _admin;
}

export function userClient(accessToken) {
  assertEnv();
  return createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
    auth: { persistSession: false, autoRefreshToken: false },
    global: accessToken ? { headers: { Authorization: `Bearer ${accessToken}` } } : {}
  });
}

export function publicEnv() {
  return {
    url: SUPABASE_URL || null,
    anonKey: SUPABASE_ANON_KEY || null
  };
}
