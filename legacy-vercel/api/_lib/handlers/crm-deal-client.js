// api/_lib/handlers/crm-deal-client.js
// GET /api/crm/deal-client?deal=<source_key>   (or ?deal_id=<uuid>)
//
// The Command Center's in-console messaging needs the *actual* linked client —
// a `leads` row we can text/email — not just the display name carried in
// deals.json (`listing_meta.client`), which has no id to message. This walks
// the deal's deal_parties links to their leads and returns:
//   - `client`  : the primary linked party (principal beats a co-party)
//   - `parties` : every linked party (name, role, phone, email, consent)
//   - `thread`  : the primary client's recent message history (chronological)
//
// Sending is NOT here — it reuses POST /api/crm/message (by lead_id). This is
// the read side that lets Sara see who's on the deal and their thread without
// leaving the Command Center. Agent-only.

import { adminClient } from '../supabase.js';
import { getCallerProfile, isAgent } from '../auth.js';
import { handleOptions, ok, fail } from '../cors.js';

// Prefer the principal over a co-party when choosing the "primary" client.
const ROLE_RANK = { seller: 0, buyer: 0, 'co-seller': 1, 'co-buyer': 1 };
const THREAD_LIMIT = 40;

function fullName(lead) {
  return [lead.first_name, lead.last_name].filter(Boolean).join(' ') || lead.email || 'Client';
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

    // 1. Resolve the deal (by source_key or id).
    let dq = supa.from('deals').select('id, source_key, address, side, agent');
    dq = dealId ? dq.eq('id', dealId) : dq.eq('source_key', sourceKey);
    const { data: deal, error: dealErr } = await dq.maybeSingle();
    if (dealErr) return fail(res, 500, `deal lookup: ${dealErr.message}`);
    if (!deal)   return fail(res, 404, `deal not found (${dealId || sourceKey})`);

    // 2. Linked parties. Two steps (no embed alias) — resolve lead_ids, then the
    //    leads — so a PostgREST relationship hiccup can't blank the panel.
    const { data: partyRows, error: partyErr } = await supa
      .from('deal_parties').select('role, lead_id').eq('deal_id', deal.id);
    if (partyErr) return fail(res, 500, `deal_parties: ${partyErr.message}`);

    const leadIds = [...new Set((partyRows || []).map((r) => r.lead_id).filter(Boolean))];
    let leadsById = new Map();
    if (leadIds.length) {
      const { data: leadRows, error: leadErr } = await supa
        .from('leads')
        .select('id, first_name, last_name, email, phone, status, sms_opt_out, email_opt_out, portal_token')
        .in('id', leadIds);
      if (leadErr) return fail(res, 500, `leads: ${leadErr.message}`);
      leadsById = new Map((leadRows || []).map((l) => [l.id, l]));
    }

    const parties = (partyRows || [])
      .map((r) => ({ role: r.role, lead: leadsById.get(r.lead_id) }))
      .filter((p) => p.lead)
      .map((p) => ({
        role:          p.role,
        lead_id:       p.lead.id,
        name:          fullName(p.lead),
        first_name:    p.lead.first_name || null,
        last_name:     p.lead.last_name || null,
        email:         p.lead.email || null,
        phone:         p.lead.phone || null,
        status:        p.lead.status || null,
        sms_opt_out:   p.lead.sms_opt_out === true,
        email_opt_out: p.lead.email_opt_out === true,
        portal_token:  p.lead.portal_token || null
      }))
      .sort((a, b) => (ROLE_RANK[a.role] ?? 2) - (ROLE_RANK[b.role] ?? 2));

    const client = parties[0] || null;

    // 3. The primary client's recent thread, oldest → newest for display.
    let thread = [];
    if (client) {
      const { data: msgs, error: msgErr } = await supa
        .from('messages')
        .select('id, direction, channel, body, subject, status, created_at')
        .eq('lead_id', client.lead_id)
        .order('created_at', { ascending: false })
        .limit(THREAD_LIMIT);
      if (msgErr) return fail(res, 500, `messages: ${msgErr.message}`);
      thread = (msgs || []).slice().reverse();
    }

    return ok(res, {
      deal:    { id: deal.id, source_key: deal.source_key, address: deal.address, side: deal.side, agent: deal.agent },
      client,
      parties,
      thread
    });
  } catch (e) {
    return fail(res, 500, e.message);
  }
}
