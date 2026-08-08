// api/ledger-subscribe.js — POST /api/ledger-subscribe
//
// Public endpoint. Captures a Ledger subscriber into the leads table (tagged
// 'ledger') and sends an immediate welcome with the latest published issue.
// Future issues go out automatically via api/cron/ledger-send.js.
//
// Replaces the old mailto: handler on ledger.html — nothing was stored before.

import { adminClient } from './_lib/supabase.js';
import { handleOptions, readJson, ok, fail } from './_lib/cors.js';
import { pickEmailProvider, bodyToHtml, unsubscribeFooter } from './_lib/email-html.js';

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export default async function handler(req, res) {
  if (handleOptions(req, res)) return;
  if (req.method !== 'POST') return fail(res, 405, 'method_not_allowed');

  const body = await readJson(req);
  // Honeypot — bots fill hidden fields. Pretend success, do nothing.
  if (body.company || body.website) return ok(res, { subscribed: true });

  const email = String(body.email || '').trim().toLowerCase();
  const name  = String(body.name || '').trim();
  const interest = String(body.interest || '').trim().slice(0, 120);
  if (!EMAIL_RE.test(email)) return fail(res, 400, 'A valid email is required.');

  const [first_name, ...rest] = name.split(/\s+/).filter(Boolean);
  const last_name = rest.join(' ') || null;

  const supa = adminClient();
  let lead_id, firstForEmail = first_name;

  const { data: existing } = await supa
    .from('leads').select('id, first_name').eq('email', email).maybeSingle();

  if (existing) {
    // Core update uses only long-standing columns so it can't fail if the
    // 057 migration (tags) hasn't been applied yet.
    const patch = { email_opt_out: false, updated_at: new Date().toISOString() };
    if (!existing.first_name && first_name) { patch.first_name = first_name; patch.last_name = last_name; }
    await supa.from('leads').update(patch).eq('id', existing.id);
    lead_id = existing.id;
    firstForEmail = existing.first_name || first_name;
    // Tag as a ledger subscriber — best-effort (needs migration 057). Read +
    // merge inside try so it's a no-op until the tags column exists.
    try {
      const { data: cur } = await supa.from('leads').select('tags').eq('id', existing.id).single();
      const tags = Array.from(new Set([...((cur && cur.tags) || []), 'ledger']));
      await supa.from('leads').update({ tags }).eq('id', existing.id);
    } catch (_) { /* pre-migration */ }
  } else {
    const { data: ins, error } = await supa.from('leads').insert({
      first_name: first_name || null,
      last_name,
      email,
      source:         'website_form',
      contact_type:   'nurture',
      pipeline_stage: 'nurture',
      assigned_agent: 'sara',
      status:         'active',
      notes:          interest ? `Ledger signup — interested in: ${interest}` : 'Ledger signup'
    }).select('id').single();
    if (error) return fail(res, 500, error.message);
    lead_id = ins.id;
    // Tag as a ledger subscriber — best-effort (needs migration 057).
    await supa.from('leads').update({ tags: ['ledger'] }).eq('id', lead_id).then(() => {}, () => {});
    await supa.from('lead_events')
      .insert({ lead_id, event_type: 'form_submitted', source: 'website_form', event_data: { form: 'ledger_subscribe', interest } })
      .then(() => {}, () => {});   // best-effort
  }

  // Welcome email — best-effort; never let a send failure fail the subscribe.
  try {
    const provider = pickEmailProvider();
    if (provider) {
      const { data: issue } = await supa.from('ledger_issues')
        .select('slug, title').eq('status', 'published')
        .order('send_date', { ascending: false }).limit(1).maybeSingle();
      const { data: lead } = await supa.from('leads').select('unsubscribe_token').eq('id', lead_id).single();
      const fn   = firstForEmail || 'there';
      const link = issue
        ? `https://legacycalifornia.com/ledger.html?slug=${encodeURIComponent(issue.slug)}`
        : 'https://legacycalifornia.com/ledger.html';
      const text = `Hi ${fn},\n\nYou're on the list for The Ledger — our monthly letter on the foothills: what's moving in the market, what's happening around town, and the occasional recipe worth keeping.\n\n`
        + (issue ? `The latest issue, "${issue.title}," is ready to read:\n${link}\n\n` : '')
        + `It arrives the second Tuesday of each month. No spam, ever — and you can unsubscribe any time.\n\n— Sara`;
      await provider.send({
        agent:  'sara',
        to:     email,
        toName: name || null,
        subject: 'Welcome to The Ledger',
        text,
        html:   bodyToHtml(text, { name: 'Sara Cooper · Legacy Properties' }, { footerHtml: unsubscribeFooter(lead?.unsubscribe_token) })
      });
    }
  } catch (_) { /* welcome is best-effort */ }

  return ok(res, { subscribed: true, lead_id });
}
