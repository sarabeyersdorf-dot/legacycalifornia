// api/_lib/handlers/crm-me.js
// GET /api/crm/me
//
// Returns the signed-in agent's own account + brokerage record for the
// Settings screen. Agent-only. No secrets — just the identity fields the
// agent already sees on their business card.

import { adminClient } from '../supabase.js';
import { getCallerProfile, isAgent } from '../auth.js';
import { handleOptions, ok, fail } from '../cors.js';
import { feedUrl } from '../cal-feed.js';

function agentKeyForRole(role) {
  if (role === 'agent_james') return 'james';
  if (role === 'agent_sara')  return 'sara';
  return null;
}

export default async function handler(req, res) {
  if (handleOptions(req, res)) return;
  if (req.method !== 'GET') return fail(res, 405, 'method_not_allowed');

  const { user, profile } = await getCallerProfile(req, res);
  if (!user)             return fail(res, 401, 'not authenticated');
  if (!isAgent(profile)) return fail(res, 403, 'agents only');

  try {
    const key = agentKeyForRole(profile?.role);
    let agent = null;
    if (key) {
      const supa = adminClient();
      const { data } = await supa
        .from('agents')
        .select('name, title, dre_number, phone, email, photo_url')
        .eq('agent_key', key)
        .maybeSingle();
      agent = data || null;
    }

    // Private calendar subscription link for this agent (for the "sync to your
    // phone" card). Built from the request's own origin so it works on any host.
    let calFeed = null;
    if (key) {
      const proto = (req.headers['x-forwarded-proto'] || 'https').split(',')[0].trim();
      const host  = req.headers['x-forwarded-host'] || req.headers.host;
      const origin = host ? `${proto}://${host}` : null;
      const https = feedUrl(key, origin);
      calFeed = { https, webcal: https.replace(/^https?:\/\//i, 'webcal://') };
    }

    return ok(res, {
      account: {
        id:    user.id,
        email: user.email,
        role:  profile?.role || null,
        name:  profile?.display_name || null
      },
      agent,
      cal_feed: calFeed
    });
  } catch (e) {
    return fail(res, 500, e.message);
  }
}
