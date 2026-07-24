// api/_lib/cal-feed.js
// Per-agent private calendar-feed token — the secret in the .ics subscription
// URL. Derived by HMAC from a stable server secret (the service-role key) so
// there's no token column to migrate and no per-request DB read; forging a
// token needs the server secret. Rotate the secret to revoke all feeds.

import crypto from 'node:crypto';

const AGENTS = ['sara', 'james'];
function secret() {
  return process.env.CAL_FEED_SECRET
    || process.env.SUPABASE_SERVICE_ROLE_KEY
    || process.env.SYNC_SECRET
    || 'legacy-calendar-feed';
}

// Stable, unguessable token for an agent (40 hex chars).
export function feedToken(agentKey) {
  const k = agentKey === 'james' ? 'james' : 'sara';
  return crypto.createHmac('sha256', secret()).update('cal-feed:' + k).digest('hex').slice(0, 40);
}

// Reverse: which agent (if any) does this token belong to? Constant-time-ish
// compare against each agent's expected token. Tolerates a trailing ".ics".
export function feedAgent(token) {
  const t = String(token || '').replace(/\.ics$/i, '').trim().toLowerCase();
  if (!/^[a-f0-9]{40}$/.test(t)) return null;
  for (const a of AGENTS) {
    const expected = feedToken(a);
    if (t.length === expected.length && crypto.timingSafeEqual(Buffer.from(t), Buffer.from(expected))) return a;
  }
  return null;
}

// The public feed URL (https) for an agent, given the request's own origin.
export function feedUrl(agentKey, origin) {
  const base = (origin || (process.env.PUBLIC_SITE_URL || 'https://legacycalifornia.vercel.app')).replace(/\/+$/, '');
  return `${base}/api/cal/${feedToken(agentKey)}.ics`;
}
