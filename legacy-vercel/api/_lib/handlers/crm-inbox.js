// api/_lib/handlers/crm-inbox.js
// GET /api/crm/inbox?filter=all|hot|warm|new|awaiting_reply&limit=50
//
// Returns the message stream joined with lead context, newest first.
// Default filter = all. Pagination via &before=<iso-timestamp>.

import { adminClient } from '../supabase.js';
import { getCallerProfile, isAgent } from '../auth.js';
import { handleOptions, ok, fail } from '../cors.js';

const VALID_FILTERS = new Set(['all', 'hot', 'warm', 'new', 'awaiting_reply']);

export default async function handler(req, res) {
  if (handleOptions(req, res)) return;
  if (req.method !== 'GET') return fail(res, 405, 'method_not_allowed');

  try {
    const { profile } = await getCallerProfile(req, res);
    if (!isAgent(profile)) return fail(res, 401, 'agents only');

    const filter = req.query?.filter || 'all';
    const limit  = Math.min(parseInt(req.query?.limit || '50', 10) || 50, 200);
    const before = req.query?.before || null;

    if (!VALID_FILTERS.has(filter)) return fail(res, 400, `invalid filter: ${filter}`);

    const supa = adminClient();

    // Build query
    let q = supa.from('messages')
      .select(`
        id, lead_id, direction, channel, subject, body, status, ai_generated,
        ai_draft_reasoning, approved_by, approved_at, created_at,
        leads (id, first_name, last_name, email, phone, temperature, score,
               journey_stage, lead_type, pipeline_stage)
      `)
      .order('created_at', { ascending: false })
      .limit(limit);

    if (before) q = q.lt('created_at', before);

    // Apply filter at the lead level
    if (filter === 'hot')   q = q.eq('leads.temperature', 'hot');
    if (filter === 'warm')  q = q.eq('leads.temperature', 'warm');
    if (filter === 'new')   q = q.eq('leads.temperature', 'new');
    if (filter === 'awaiting_reply') q = q.eq('status', 'pending_approval');

    const { data, error } = await q;
    if (error) return fail(res, 500, error.message);

    // Drop messages whose lead inner-join filtered them out
    const rows = (data || []).filter(m => m.leads);
    const nextBefore = rows.length === limit ? rows[rows.length - 1].created_at : null;

    return ok(res, { messages: rows, next_before: nextBefore, filter, limit });
  } catch (e) {
    return fail(res, 500, e.message);
  }
}
