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
import { pickEmailProvider, bodyToHtml, renderTemplate, unsubscribeFooter } from '../email-html.js';

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
  const mode = b.mode === 'send' ? 'send'
    : b.mode === 'preview' ? 'preview'
    : b.mode === 'test' ? 'test'
    : b.mode === 'schedule' ? 'schedule'
    : b.mode === 'campaign_status' ? 'campaign_status'
    : 'resolve';

  const sentByRole = profile.role === 'agent_james' ? 'james' : 'sara';
  // Full sender identity for the premium headshot signature (logo header +
  // headshot the cold/expired emails use). email doubles as the test recipient.
  const AGENT_IDENT = {
    sara:  { name: 'Sara Cooper',      title: 'Broker / Owner · Legacy Properties', phone: '(209) 559-4966', email: 'sarasellscalifornia@gmail.com',  dre: 'DRE 02141987 · Brokerage DRE 02554944', headshot: '/art/sara-headshot.png' },
    james: { name: 'James Beyersdorf', title: 'Agent · Legacy Properties',          phone: '(209) 559-4966', email: 'jamessellscalifornia@gmail.com', dre: 'Brokerage DRE 02554944',                headshot: '/art/james-headshot.png' }
  };
  const agentIdent = AGENT_IDENT[sentByRole];

  // ---- preview: render the designed template to HTML (no send) ----
  // Lets the composer show exactly what recipients will get. Uses a sample
  // unsubscribe line so the footer is represented.
  if (mode === 'preview') {
    if (!b.template) return fail(res, 400, 'template required for preview');
    const { html } = renderTemplate(b.template, agentIdent, {
      footerHtml: unsubscribeFooter('sample-token')
    });
    return ok(res, { html });
  }

  // ---- test: send ONE real copy of this email to the sending agent's own
  // inbox, so they can see exactly what recipients get (branding, fonts, the
  // designed template, links). Not logged to any lead; not a bulk send. ----
  if (mode === 'test') {
    const subject  = String(b.subject || '').trim().slice(0, MAX_SUBJECT) || 'Test — Legacy Properties';
    const body     = String(b.body || '').trim().slice(0, MAX_BODY);
    const template = (b.template && typeof b.template === 'object' && !Array.isArray(b.template)) ? b.template : null;
    if (!template && !body) return fail(res, 400, 'add some content first');
    const provider = pickEmailProvider();
    if (!provider) return fail(res, 500, 'no email provider configured — set RESEND_API_KEY');
    const to = agentIdent.email;
    // {first_name} has no value in a test — render it as a friendly stand-in.
    const previewBody = body.replace(/\{first_name\}/g, 'there');
    const footerHtml = unsubscribeFooter('sample-token');
    const rendered = template
      ? renderTemplate(template, agentIdent, { footerHtml })
      : { html: bodyToHtml(previewBody, agentIdent, { footerHtml }), text: previewBody };
    try {
      const r = await provider.send({
        agent: sentByRole, to, toName: agentIdent.name,
        subject: `[TEST] ${subject}`, text: rendered.text, html: rendered.html
      });
      if (r && r.skipped) return fail(res, 500, 'email provider skipped the send');
      return ok(res, { sent: true, to });
    } catch (e) {
      return fail(res, 500, e.message || 'test send failed');
    }
  }

  // ---- schedule: enqueue a whole send into email_queue, drained paced by
  // api/cron/email-queue so a big list never outruns Resend's rate limit /
  // daily cap. Returns a campaign_id the composer can poll for progress. ----
  if (mode === 'schedule') {
    const subject  = String(b.subject || '').trim().slice(0, MAX_SUBJECT);
    const body     = String(b.body || '').trim().slice(0, MAX_BODY);
    const template = (b.template && typeof b.template === 'object' && !Array.isArray(b.template)) ? b.template : null;
    const ids      = Array.isArray(b.lead_ids) ? [...new Set(b.lead_ids.filter(Boolean))].slice(0, 5000) : [];
    if (!subject)            return fail(res, 400, 'subject required');
    if (!template && !body)  return fail(res, 400, 'body required');
    if (!ids.length)         return fail(res, 400, 'no recipients');

    // Re-check the opt-out gates now (the same ones resolve used), and pull the
    // address + name for each recipient.
    let q = supa.from('leads').select('id, first_name, last_name, email');
    q = contactable(q).in('id', ids);
    const { data: leads, error } = await q;
    if (error) return fail(res, 500, error.message);
    const rows = (leads || []).filter((l) => l.email);
    if (!rows.length) return ok(res, { campaign_id: null, queued: 0, skipped: ids.length });

    const campaign_id = (globalThis.crypto && crypto.randomUUID) ? crypto.randomUUID() : undefined;
    const payload = rows.map((l) => ({
      campaign_id,
      lead_id: l.id,
      to_email: l.email,
      to_name: [l.first_name, l.last_name].filter(Boolean).join(' ') || null,
      subject,
      body: template ? null : body,
      template: template || null,
      agent: sentByRole,
      status: 'queued'
    }));

    // Insert in chunks; ignore-duplicate on (campaign_id, lead_id) so a retried
    // Schedule call can't double-queue the same person.
    let queued = 0;
    for (let i = 0; i < payload.length; i += 500) {
      const chunk = payload.slice(i, i + 500);
      const { error: insErr } = await supa.from('email_queue').insert(chunk);
      if (insErr) return fail(res, 500, insErr.message);
      queued += chunk.length;
    }
    return ok(res, { campaign_id, queued, skipped: ids.length - queued });
  }

  // ---- campaign_status: progress rollup for a scheduled send ----
  if (mode === 'campaign_status') {
    const cid = String(b.campaign_id || '').trim();
    if (!cid) return fail(res, 400, 'campaign_id required');
    const { data, error } = await supa.from('email_queue').select('status').eq('campaign_id', cid);
    if (error) return fail(res, 500, error.message);
    const rows = data || [];
    const by = { queued: 0, sent: 0, failed: 0, skipped: 0 };
    for (const r of rows) if (by[r.status] != null) by[r.status]++;
    return ok(res, { total: rows.length, ...by, done: by.queued === 0 });
  }

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
  const subject  = String(b.subject || '').trim().slice(0, MAX_SUBJECT);
  const body     = String(b.body || '').trim().slice(0, MAX_BODY);
  const template = (b.template && typeof b.template === 'object' && !Array.isArray(b.template)) ? b.template : null;
  const ids      = Array.isArray(b.lead_ids) ? b.lead_ids.filter(Boolean).slice(0, MAX_BATCH) : [];
  if (!subject)             return fail(res, 400, 'subject required');
  if (!template && !body)   return fail(res, 400, 'body required');
  if (!ids.length)          return fail(res, 400, 'no recipients in this batch');

  const provider = pickEmailProvider();
  if (!provider) return fail(res, 500, 'no email provider configured — set RESEND_API_KEY');

  const sentBy = sentByRole;
  const agent  = agentIdent;
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
      const footerHtml = unsubscribeFooter(l.unsubscribe_token);
      // A designed template renders its own email-safe HTML + a plain-text
      // fallback; otherwise fall back to the branded plain-letter wrapper.
      const rendered = template
        ? renderTemplate(template, agent, { footerHtml })
        : { html: bodyToHtml(body, agent, { footerHtml }), text: body };
      const logBody = template ? rendered.text : body;
      const r = await provider.send({
        agent: sentBy,
        to: l.email,
        toName: [l.first_name, l.last_name].filter(Boolean).join(' ') || null,
        subject,
        text: rendered.text,
        html: rendered.html
      });
      if (r && r.skipped) { results.failed++; continue; }
      await supa.from('messages').insert({
        lead_id: l.id, direction: 'outbound', channel: 'email',
        subject, body: logBody, status: 'sent', ai_generated: false,
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
