// api/_lib/handlers/crm-lead-detail.js
// GET /api/crm/lead?id=<uuid>
//
// Returns the full picture for one lead: the row itself + all messages,
// recent events, saved properties, tours, and open offers. Used by the
// CRM lead-detail panel.

import { adminClient } from '../supabase.js';
import { getCallerProfile, isAgent } from '../auth.js';
import { handleOptions, ok, fail } from '../cors.js';

export default async function handler(req, res) {
  if (handleOptions(req, res)) return;
  if (req.method !== 'GET') return fail(res, 405, 'method_not_allowed');

  try {
    const { profile } = await getCallerProfile(req);
    if (!isAgent(profile)) return fail(res, 401, 'agents only');

    const id = req.query?.id;
    if (!id) return fail(res, 400, 'id required');

    const supa = adminClient();

    const [lead, messages, events, saved, tours, offers] = await Promise.all([
      supa.from('leads').select('*').eq('id', id).single(),
      supa.from('messages').select('*').eq('lead_id', id).order('created_at'),
      supa.from('lead_events').select('*').eq('lead_id', id).order('created_at', { ascending: false }).limit(50),
      supa.from('saved_properties').select('*, properties(*)').eq('lead_id', id).order('last_viewed_at', { ascending: false }),
      supa.from('tours').select('*, properties(address,city,mls_number)').eq('lead_id', id).order('scheduled_at', { ascending: false }),
      supa.from('offers').select('*, properties(address,city,mls_number)').eq('buyer_lead_id', id)
    ]);

    if (lead.error || !lead.data) return fail(res, 404, 'lead not found');

    return ok(res, {
      lead:              lead.data,
      messages:          messages.data || [],
      events:            events.data   || [],
      saved_properties:  saved.data    || [],
      tours:             tours.data    || [],
      offers:            offers.data   || []
    });
  } catch (e) {
    return fail(res, 500, e.message);
  }
}
