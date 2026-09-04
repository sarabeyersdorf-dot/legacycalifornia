// api/_lib/handlers/crm-push-to-idx.js
// POST /api/crm/push-to-idx   (agent-only)
//
// The "Send to iHomefinder alerts" button on a contact card. Pushes an existing
// CRM contact across as a lead so iHomefinder's Listing Alerts can reach them.
//
// The push itself lives in ../ihomefinder.js, shared with website lead intake —
// a form submit now registers the visitor automatically, which is the path that
// matters most, and this button is for the contacts already in the book who
// predate it (Bev, Scot, Brian, Kendra, Roger). One implementation so the two
// can't drift.
//
// Body: { lead_id: uuid, market_id?: string, force?: boolean }
//
//   market_id — optional MarketBoost market report to subscribe them to; the
//   ids are the ones already rendering on the town pages.
//   force — push again despite an existing ihf_lead_id. Off by default: their
//   API has no read endpoint, so we cannot check whether a lead still exists and
//   a blind re-push would duplicate the person on their side.

import { adminClient } from '../supabase.js';
import { getCallerProfile, isAgent } from '../auth.js';
import { handleOptions, readJson, ok, fail } from '../cors.js';
import { pushLeadToIdx, idxConfig, idxUnavailable } from '../ihomefinder.js';

export default async function handler(req, res) {
  if (handleOptions(req, res)) return;
  if (req.method !== 'POST') return fail(res, 405, 'method_not_allowed');

  const { user, profile } = await getCallerProfile(req, res);
  if (!user)             return fail(res, 401, 'not authenticated');
  if (!isAgent(profile)) return fail(res, 403, 'agents only');

  try {
    const b = await readJson(req);
    const leadId   = b?.lead_id;
    const marketId = typeof b?.market_id === 'string' ? b.market_id.trim() : '';
    if (!leadId) return fail(res, 400, 'lead_id required');

    // Name the missing setting. An agent clicking a button can act on
    // "IHOMEFINDER_LEAD_PATH is not set"; they cannot act on "not configured".
    const why = idxUnavailable(idxConfig());
    if (why) return fail(res, 503, `iHomefinder is not connected yet — ${why}.`);

    const supa = adminClient();
    const { data: lead, error } = await supa.from('leads')
      .select('id, first_name, last_name, email, phone, status, email_opt_out, ihf_lead_id, ihf_synced_at')
      .eq('id', leadId).maybeSingle();
    if (error) return fail(res, 500, error.message);
    if (!lead)  return fail(res, 404, 'contact not found');
    if (lead.status !== 'active') return fail(res, 409, 'contact is not active');

    const r = await pushLeadToIdx(supa, lead, {
      marketId: marketId || null,
      force: b?.force === true,
      source: 'Legacy Properties CRM'
    });

    // Turn the library's reasons into something an agent reads on a button.
    if (r.error)   return fail(res, 502, r.error);
    if (r.skipped) {
      const msg = r.reason === 'contact has opted out of email'
        ? `${lead.first_name || 'This contact'} has opted out of email — pushing them into listing alerts would email them anyway.`
        : r.reason === 'no email address — iHomefinder alerts are email'
          ? 'This contact has no email address — iHomefinder alerts are email, so there is nothing to send them to.'
          : `Not sent — ${r.reason}.`;
      return fail(res, 422, msg);
    }
    if (r.already) {
      return ok(res, { already: true, ihf_lead_id: r.ihf_lead_id, synced_at: lead.ihf_synced_at,
        message: 'Already in iHomefinder — set their search criteria there.' });
    }

    await supa.from('lead_events').insert({
      lead_id: leadId, event_type: 'pushed_to_ihomefinder', source: 'ihomefinder_idx',
      event_data: { ihf_lead_id: r.ihf_lead_id, market: r.market || null, by: profile.role }
    }).then(() => {}, () => {});

    return ok(res, {
      pushed: true, ihf_lead_id: r.ihf_lead_id, market: r.market,
      message: 'In iHomefinder now. Set their search criteria there to start the alerts.'
    });
  } catch (e) {
    return fail(res, 500, e.message);
  }
}
