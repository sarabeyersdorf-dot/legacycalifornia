// api/_lib/handlers/crm-agent-updates.js
// GET   /api/crm/agent-updates                 → recent log entries (agent-session auth, shared — both agents see everything)
// POST  /api/crm/agent-updates { content, deal? } → log a new update (agent-session auth, server stamps who)
// GET   /api/crm/agent-updates?op=feed&key=<SYNC_SECRET> → unread entries for the morning briefing;
//         marks them read_by_briefing=true as a side effect of this same GET (no separate ack call,
//         since the briefing environment is GET-only and never issues POSTs).
//
// A chronological "notes to Claude" log — quick free-text updates Sara or James
// log from the CRM (texts they received, verbal updates, anything Claude has no
// other visibility into) so the daily briefing can read them and fold them into
// deals.json / the day's agenda. Different from deal-notes (db/029): that's ONE
// overwritable note per deal shown in the Command Center. This is append-only
// and never overwritten — nothing here is ever deleted or edited after saving.
// Agent-only, no client access, matching agent_tasks' visibility pattern.

import { adminClient } from '../supabase.js';
import { getCallerProfile, isAgent } from '../auth.js';
import { handleOptions, readJson, ok, fail } from '../cors.js';

const agentKey = (role) => (role === 'agent_james' ? 'james' : 'sara');

export default async function handler(req, res) {
  if (handleOptions(req, res)) return;
  if (req.method === 'GET' && req.query?.op === 'feed') return feed(req, res);

  const { user, profile } = await getCallerProfile(req, res);
  if (!user)             return fail(res, 401, 'not authenticated');
  if (!isAgent(profile)) return fail(res, 403, 'agents only');
  if (req.method === 'GET')  return list(req, res);
  if (req.method === 'POST') return create(req, res, profile);
  return fail(res, 405, 'method_not_allowed');
}

// GET — shared log, no scoping: the whole point is continuity between Sara,
// James, and the briefing, so either agent sees every entry either logged.
async function list(req, res) {
  try {
    const supa = adminClient();
    const limit = Math.min(parseInt(req.query?.limit, 10) || 100, 300);
    const { data, error } = await supa.from('agent_updates')
      .select('id, agent, deal, content, created_at, read_by_briefing, read_by_briefing_at')
      .order('created_at', { ascending: false })
      .limit(limit);
    if (error) return fail(res, 500, error.message);
    return ok(res, { updates: data || [] });
  } catch (e) {
    return fail(res, 500, e.message);
  }
}

async function create(req, res, profile) {
  try {
    const body = await readJson(req);
    const content = (body?.content || '').toString().trim().slice(0, 2000);
    if (!content) return fail(res, 400, 'content required');
    const deal = (body?.deal || '').toString().trim().slice(0, 120) || null;

    const supa = adminClient();
    const row = { agent: agentKey(profile.role), deal, content };
    const { data, error } = await supa.from('agent_updates').insert(row).select('id, agent, deal, content, created_at').maybeSingle();
    if (error) return fail(res, 500, error.message);
    return ok(res, { update: data });
  } catch (e) {
    return fail(res, 500, e.message);
  }
}

// GET /api/crm/agent-updates?op=feed&key=<SYNC_SECRET> — the briefing's read-back
// channel. Key-authenticated (headless, GET-only, same contract as
// briefing-feedback). Returns everything not yet seen by a briefing run, and
// marks it read in the same call — nothing is ever deleted, so entries stay
// visible in the CRM log regardless of read state.
export async function feed(req, res) {
  res.setHeader('Cache-Control', 'private, no-store, no-cache, must-revalidate');
  res.setHeader('CDN-Cache-Control', 'no-store');
  res.setHeader('Vercel-CDN-Cache-Control', 'no-store');

  const secret = process.env.SYNC_SECRET || process.env.BRIEFING_FEEDBACK_SECRET;
  if (!secret || req.query?.key !== secret) return fail(res, 401, 'bad key');

  try {
    const supa = adminClient();
    const { data, error } = await supa.from('agent_updates')
      .select('id, agent, deal, content, created_at')
      .eq('read_by_briefing', false)
      .order('created_at', { ascending: true })
      .limit(100);
    if (error) return fail(res, 500, error.message);
    const updates = data || [];

    if (updates.length) {
      const ids = updates.map((u) => u.id);
      const { error: uErr } = await supa.from('agent_updates')
        .update({ read_by_briefing: true, read_by_briefing_at: new Date().toISOString() })
        .in('id', ids);
      if (uErr) return fail(res, 500, uErr.message);
    }

    return ok(res, { generated_at: new Date().toISOString(), count: updates.length, updates });
  } catch (e) {
    return fail(res, 500, e.message);
  }
}
