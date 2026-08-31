// api/_lib/handlers/crm-recently-active.js
// GET /api/crm/recently-active?minutes=60   (agent-only)
//
// The "who's on the site right now" feed for the CRM's Live panel. Rolls up
// identified engagement (collection opens, listing views, portal opens, saves,
// reactions, form submits) from lead_events in a short recent window, grouped by
// person, newest first, with their contact info so an agent can call/text with
// one tap. Complements the real-time browsing alert (push) and the daily digest
// (pull) — this is the at-a-glance live view.

import { adminClient } from '../supabase.js';
import { getCallerProfile, isAgent } from '../auth.js';
import { handleOptions, ok, fail } from '../cors.js';

const ENGAGEMENT = ['property_viewed', 'property_saved', 'collection_opened', 'collection_reaction', 'portal_message', 'valuation_interest', 'form_submitted'];

const LABEL = {
  property_viewed: 'viewed a listing',
  property_saved: 'saved a listing',
  collection_opened: 'opened their collection',
  collection_reaction: 'reacted to a property',
  portal_message: 'messaged from their portal',
  valuation_interest: 'opened a home valuation',
  form_submitted: 'submitted a form'
};

export default async function handler(req, res) {
  if (handleOptions(req, res)) return;
  if (req.method !== 'GET') return fail(res, 405, 'method_not_allowed');
  const { user, profile } = await getCallerProfile(req, res);
  if (!user)             return fail(res, 401, 'not authenticated');
  if (!isAgent(profile)) return fail(res, 403, 'agents only');
  const supa = adminClient();

  const minutes = Math.min(Math.max(parseInt(req.query?.minutes, 10) || 60, 5), 1440);
  const since = new Date(Date.now() - minutes * 60000).toISOString();

  try {
    const { data: events, error } = await supa.from('lead_events')
      .select('lead_id, event_type, event_data, created_at')
      .in('event_type', ENGAGEMENT).gte('created_at', since)
      .order('created_at', { ascending: false }).limit(400);
    if (error) return fail(res, 500, error.message);

    const rows = (events || []).filter((e) => e.lead_id);
    const ids = [...new Set(rows.map((r) => r.lead_id))];
    const byId = new Map();
    if (ids.length) {
      const { data: leads } = await supa.from('leads')
        .select('id, first_name, last_name, email, phone, assigned_agent, pipeline_stage, temperature').in('id', ids);
      for (const l of (leads || [])) byId.set(l.id, l);
    }

    const groups = new Map();
    for (const e of rows) {
      if (!groups.has(e.lead_id)) groups.set(e.lead_id, []);
      groups.get(e.lead_id).push(e);
    }

    const people = [...groups.entries()].map(([id, evs]) => {
      const l = byId.get(id) || {};
      const d = (evs[0].event_data && typeof evs[0].event_data === 'object') ? evs[0].event_data : {};
      const detail = d.address || d.property || d.title || d.property_address || '';
      return {
        lead_id: id,
        name: [l.first_name, l.last_name].filter(Boolean).join(' ') || l.email || l.phone || 'A contact',
        email: l.email || null,
        phone: l.phone || null,
        agent: l.assigned_agent || null,
        stage: l.pipeline_stage || null,
        temperature: l.temperature || null,
        last_at: evs[0].created_at,
        last_action: LABEL[evs[0].event_type] || evs[0].event_type,
        last_detail: detail || null,
        action_count: evs.length
      };
    }).sort((a, b) => Date.parse(b.last_at) - Date.parse(a.last_at));

    return ok(res, { window_minutes: minutes, count: people.length, people, generated_at: new Date().toISOString() });
  } catch (e) {
    return fail(res, 500, e.message);
  }
}
