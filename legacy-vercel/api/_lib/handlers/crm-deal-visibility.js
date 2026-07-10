// api/_lib/handlers/crm-deal-visibility.js
// GET /api/crm/deal-visibility?deal=<source_key>   (or ?deal_id=<uuid>)
//
// The Command Center's "Client portal visibility" panel. Returns the items on a
// deal that CAN be toggled between internal and client-visible — the tasks,
// showings, and appointments tied to the deal's client LEAD. Those are exactly
// the rows public.portal_items() surfaces to the seller/buyer portal (it joins
// on lead_id + visibility='client').
//
// Deliberately scoped to lead-linked rows only:
//   - Briefing tasks (deals.json "tasks") are rebuilt by the daily sync with no
//     lead_id, so they carry lead_id = null and never appear here — a toggle on
//     them would be wiped on the next sync anyway. They + documents stay
//     Cowork-managed via deals.json (see data/BRIEFING-INSTRUCTIONS.md).
//
// Toggling itself reuses POST /api/crm/visibility (with its wire-fraud guard);
// this endpoint is read-only. Agent-only.

import { adminClient } from '../supabase.js';
import { getCallerProfile, isAgent } from '../auth.js';
import { handleOptions, ok, fail } from '../cors.js';

function shortDate(d) {
  if (!d) return null;
  try { const x = new Date(d); return isNaN(x) ? null : x.toLocaleDateString('en-US', { month: 'short', day: 'numeric' }); }
  catch (_) { return null; }
}

export default async function handler(req, res) {
  if (handleOptions(req, res)) return;
  if (req.method !== 'GET') return fail(res, 405, 'method_not_allowed');

  const { user, profile } = await getCallerProfile(req, res);
  if (!user)             return fail(res, 401, 'not authenticated');
  if (!isAgent(profile)) return fail(res, 403, 'agents only');

  try {
    const sourceKey = typeof req.query?.deal === 'string' ? req.query.deal.trim() : '';
    const dealId    = typeof req.query?.deal_id === 'string' ? req.query.deal_id.trim() : '';
    if (!sourceKey && !dealId) return fail(res, 400, 'deal (source_key) or deal_id is required');

    const supa = adminClient();

    // 1. Resolve the deal.
    let dq = supa.from('deals').select('id, source_key, address, side, agent');
    dq = dealId ? dq.eq('id', dealId) : dq.eq('source_key', sourceKey);
    const { data: deal, error: dealErr } = await dq.maybeSingle();
    if (dealErr) return fail(res, 500, `deal lookup: ${dealErr.message}`);
    if (!deal)   return fail(res, 404, `deal not found (${dealId || sourceKey})`);

    // 2. The deal's client lead(s).
    const { data: partyRows, error: partyErr } = await supa
      .from('deal_parties').select('lead_id').eq('deal_id', deal.id);
    if (partyErr) return fail(res, 500, `deal_parties: ${partyErr.message}`);
    const leadIds = [...new Set((partyRows || []).map((r) => r.lead_id).filter(Boolean))];

    // 3. Toggleable items tied to those leads. Each query is fail-soft — if a
    //    table/column is missing, that group is just empty (never a 500).
    const items = [];
    if (leadIds.length) {
      const [taskRes, tourRes, apptRes] = await Promise.all([
        supa.from('agent_tasks').select('id, title, sub, done, visibility, client_label, created_at')
          .in('lead_id', leadIds).order('created_at', { ascending: false }),
        supa.from('tours').select('id, tour_type, scheduled_at, status, visibility, client_label')
          .in('lead_id', leadIds).order('scheduled_at', { ascending: false }),
        supa.from('appointments').select('id, title, starts_at, location, visibility, client_label')
          .in('lead_id', leadIds).order('starts_at', { ascending: false })
      ]);

      for (const t of (taskRes.data || [])) {
        items.push({ kind: 'task', id: t.id, label: t.client_label || t.title || 'Task',
          sub: t.done ? 'Done' : (t.sub || null), visibility: t.visibility === 'client' ? 'client' : 'internal' });
      }
      for (const e of (tourRes.data || [])) {
        items.push({ kind: 'tour', id: e.id, label: e.client_label || (e.tour_type === 'video' ? 'Video tour' : 'In-person tour'),
          sub: shortDate(e.scheduled_at), visibility: e.visibility === 'client' ? 'client' : 'internal' });
      }
      for (const a of (apptRes.data || [])) {
        items.push({ kind: 'appointment', id: a.id, label: a.client_label || a.title || 'Appointment',
          sub: shortDate(a.starts_at) || a.location || null, visibility: a.visibility === 'client' ? 'client' : 'internal' });
      }
    }

    return ok(res, {
      deal:       { id: deal.id, source_key: deal.source_key, address: deal.address, side: deal.side },
      has_client: leadIds.length > 0,
      items
    });
  } catch (e) {
    return fail(res, 500, e.message);
  }
}
