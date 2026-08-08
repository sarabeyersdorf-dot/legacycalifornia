// api/_lib/handlers/crm-bulk-send.js — POST /api/crm/bulk-send
//
// Bulk / newsletter email to a segment of contacts. Two modes:
//
//   { mode:'resolve', segment }
//     → { count, ids:[...], sample:[names] }   (contactable recipients only)
//
//   { mode:'send', lead_ids:[...], subject, body }
//     → { sent, failed, skipped:[{id,reason}] }
//
// The frontend resolves a segment once, then streams the ids back in batches of
// ≤40 (Vercel's ~10s budget) so it can show progress. Every recipient is
// re-checked server-side against the opt-out gates, and every email carries an
// unsubscribe link (leads.unsubscribe_token → /api/unsubscribe). Each send is
// recorded in messages + lead_events, mirroring the single-message path.

import { adminClient } from '../supabase.js';
import { getCallerProfile, isAgent } from '../auth.js';
import { handleOptions, readJson, ok, fail } from '../cors.js';
import { pickEmailProvider, bodyToHtml, unsubscribeFooter } from '../email-html.js';

const MAX_BATCH = 40;
const MAX_SUBJECT = 200;
const MAX_BODY = 20000;

// Base "contactable" gate shared by resolve + send.
function contactable(q) {
  return q.eq('email_opt_out', false).eq('not_interested', false)
          .eq('status', 'active').not('email', 'is', null);
}

function applySegment(q, segment) {
  switch (segment) {
    case 'ledger':   return q.contains('tags', ['ledger']);
    case 'buyers':   return q.in('lead_type', ['buyer', 'both']);
    case 'sellers':  return q.in('lead_type', ['seller', 'both']);
    case 'sphere':   return q.or('pipeline_stage.eq.sphere,contact_type.eq.sphere');
    case 'past':     return q.eq('contact_type', 'past_client');
    case 'everyone':
    default:         return q;
  }
}

export default async function handler(req, res) {
  if (handleOptions(req, res)) return;
  if (req.method !== 'POST') return fail(res, 405, 'method_not_allowed');

  const { user, profile } = await getCallerProfile(req, res);
  if (!user)             return fail(res, 401, 'not authenticated');
  if (!isAgent(profile)) return fail(res, 403, 'agents only');

  const b = await readJson(req);
  const supa = adminClient();
  const mode = b.mode === 'send' ? 'send' : 'resolve';

  // ---- resolve: count + ids for a segment ----
  if (mode === 'resolve') {
    const segment = String(b.segment || 'everyone');
    let q = supa.from('leads').select('id, first_name, last_name').limit(5000);
    q = applySegment(contactable(q), segment);
    const { data, error } = await q;
    if (error) return fail(res, 500, error.message);
    const rows = data || [];
    return ok(res, {
      segment,
      count: rows.length,
      ids: rows.map((r) => r.id),
      sample: rows.slice(0, 5).map((r) => [r.first_name, r.last_name].filter(Boolean).join(' ') || 'Contact')
    });
  }

  // ---- send: one batch ----
  const subject = String(b.subject || '').trim().slice(0, MAX_SUBJECT);
  const body    = String(b.body || '').trim().slice(0, MAX_BODY);
  const ids     = Array.isArray(b.lead_ids) ? b.lead_ids.filter(Boolean).slice(0, MAX_BATCH) : [];
  if (!subject)     return fail(res, 400, 'subject required');
  if (!body)        return fail(res, 400, 'body required');
  if (!ids.length)  return fail(res, 400, 'no recipients in this batch');

  const provider = pickEmailProvider();
  if (!provider) return fail(res, 500, 'no email provider configured — set RESEND_API_KEY');

  const sentBy = profile.role === 'agent_james' ? 'james' : 'sara';
  const agent  = { name: sentBy === 'james' ? 'James Beyersdorf · Legacy Properties' : 'Sara Cooper · Legacy Properties' };
  const nowIso = new Date().toISOString();

  const { data: leads } = await supa.from('leads')
    .select('id, first_name, last_name, email, email_opt_out, not_interested, status, unsubscribe_token')
    .in('id', ids);

  const results = { sent: 0, failed: 0, skipped: [] };
  const found = new Set();

  for (const l of (leads || [])) {
    found.add(l.id);
    const reason = !l.email ? 'no email'
      : l.email_opt_out ? 'unsubscribed'
      : l.not_interested ? 'not interested'
      : (l.status !== 'active') ? l.status
      : null;
    if (reason) { results.skipped.push({ id: l.id, reason }); continue; }
    try {
      const r = await provider.send({
        agent: sentBy,
        to: l.email,
        toName: [l.first_name, l.last_name].filter(Boolean).join(' ') || null,
        subject,
        text: body,
        html: bodyToHtml(body, agent, { footerHtml: unsubscribeFooter(l.unsubscribe_token) })
      });
      if (r && r.skipped) { results.failed++; continue; }
      await supa.from('messages').insert({
        lead_id: l.id, direction: 'outbound', channel: 'email',
        subject, body, status: 'sent', ai_generated: false,
        approved_by: sentBy, approved_at: nowIso, mailerlite_id: (r && r.id) || null
      }).then(() => {}, () => {});
      await supa.from('leads').update({ last_contact_at: nowIso }).eq('id', l.id).then(() => {}, () => {});
      await supa.from('lead_events').insert({
        lead_id: l.id, event_type: 'message_sent', source: 'mailerlite',
        event_data: { bulk: true, subject }
      }).then(() => {}, () => {});
      results.sent++;
    } catch (_) { results.failed++; }
  }
  for (const id of ids) if (!found.has(id)) results.skipped.push({ id, reason: 'not found' });

  return ok(res, results);
}
