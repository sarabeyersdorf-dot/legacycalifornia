// api/cron/email-queue.js — GET /api/cron/email-queue?key=<PUBLISH_SECRET>
//
// Drains the bulk-email send queue (email_queue) at a safe pace so a large
// send never outruns Resend's rate limit or daily cap. The CRM "Schedule"
// button enqueues one row per recipient; this cron (runs every minute) sends a
// small paced batch each run and marks each row sent/failed. Idempotent +
// resumable — if the run dies mid-batch, the un-sent rows are still 'queued'
// and picked up next run.
//
// Two throttles, both env-tunable:
//   EMAIL_PER_RUN   (default 25)  — how many to attempt per run.
//   EMAIL_SEND_GAP  (default 700) — ms between sends (Resend allows ~2/sec, so
//                                   keep this >= 500).
//   EMAIL_DAILY_CAP (default 200) — stop once this many emails have gone out in
//                                   the last 24h (across ALL send paths, since
//                                   they share one Resend account). The rest
//                                   stay queued and go out tomorrow. Raise this
//                                   once Resend raises the account's daily
//                                   sending limit.
//
// On a 429 (rate-limit / daily cap hit on Resend's side) the row is left
// 'queued' with attempts++ and the run stops early — we've hit a wall, so
// there's no point hammering. A row that fails MAX_ATTEMPTS times is marked
// 'failed' with the last error, so it can't wedge the queue forever.

import { adminClient } from '../_lib/supabase.js';
import { pickEmailProvider, bodyToHtml, renderTemplate, unsubscribeFooter } from '../_lib/email-html.js';

const PER_RUN     = Math.max(1, parseInt(process.env.EMAIL_PER_RUN  || '25', 10));
const SEND_GAP    = Math.max(0, parseInt(process.env.EMAIL_SEND_GAP || '700', 10));
const DAILY_CAP   = Math.max(1, parseInt(process.env.EMAIL_DAILY_CAP || '200', 10));
const MAX_ATTEMPTS = 8;

const AGENT_IDENT = {
  sara:  { name: 'Sara Cooper',      title: 'Broker / Owner · Legacy Properties', phone: '(209) 559-4966', email: 'sarasellscalifornia@gmail.com',  dre: 'DRE 02141987 · Brokerage DRE 02554944', headshot: '/art/sara-headshot.png' },
  james: { name: 'James Beyersdorf', title: 'Agent · Legacy Properties',          phone: '(209) 559-4966', email: 'jamessellscalifornia@gmail.com', dre: 'Brokerage DRE 02554944',                headshot: '/art/james-headshot.png' }
};

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const isRateLimit = (msg) => /\b429\b|rate.?limit|too many|quota|daily.*limit|limit.*reach/i.test(String(msg || ''));

export default async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');
  if (!process.env.PUBLISH_SECRET || req.query.key !== process.env.PUBLISH_SECRET) {
    return res.status(401).json({ success: false, error: 'unauthorized' });
  }

  const supa = adminClient();
  const provider = pickEmailProvider();
  if (!provider) return res.status(200).json({ success: true, note: 'no email provider configured' });

  // Daily cap: count everything sent (any path) in the last 24h. The queue and
  // the single/sequence senders all log an outbound email message, so this is a
  // faithful proxy for the shared Resend daily usage.
  const dayAgo = new Date(Date.now() - 24 * 3600 * 1000).toISOString();
  const { count: usedToday } = await supa.from('messages')
    .select('id', { count: 'exact', head: true })
    .eq('direction', 'outbound').eq('channel', 'email').gte('created_at', dayAgo);
  const remainingToday = DAILY_CAP - (usedToday || 0);
  if (remainingToday <= 0) {
    const { count: pending } = await supa.from('email_queue')
      .select('id', { count: 'exact', head: true }).eq('status', 'queued');
    return res.status(200).json({ success: true, note: 'daily cap reached', used_today: usedToday || 0, daily_cap: DAILY_CAP, still_queued: pending || 0 });
  }

  const limit = Math.min(PER_RUN, remainingToday);
  const { data: rows, error } = await supa.from('email_queue')
    .select('id, campaign_id, lead_id, to_email, to_name, subject, body, template, agent, attempts')
    .eq('status', 'queued').order('created_at', { ascending: true }).limit(limit);
  if (error) return res.status(200).json({ success: false, error: error.message });
  if (!rows || !rows.length) return res.status(200).json({ success: true, note: 'queue empty', used_today: usedToday || 0 });

  let sent = 0, failed = 0, skipped = 0, hitLimit = false;
  const nowIso = () => new Date().toISOString();

  for (let i = 0; i < rows.length; i++) {
    const q = rows[i];
    // Re-check the recipient's opt-out state at send time — they may have
    // unsubscribed after being queued. Fail closed on opt-out.
    if (q.lead_id) {
      const { data: lead } = await supa.from('leads')
        .select('email, email_opt_out, not_interested, status, unsubscribe_token')
        .eq('id', q.lead_id).maybeSingle();
      if (!lead || lead.email_opt_out || lead.not_interested || lead.status !== 'active' || !lead.email) {
        await supa.from('email_queue').update({ status: 'skipped', error: 'opted out / inactive', sent_at: nowIso() }).eq('id', q.id);
        skipped++; continue;
      }
      q.to_email = lead.email; q._unsub = lead.unsubscribe_token;
    }

    const agent = AGENT_IDENT[q.agent === 'james' ? 'james' : 'sara'];
    const footerHtml = unsubscribeFooter(q._unsub);
    const tpl = (q.template && typeof q.template === 'object' && !Array.isArray(q.template)) ? q.template : null;
    const bodyText = String(q.body || '').replace(/\{first_name\}/g, 'there');
    const rendered = tpl
      ? renderTemplate(tpl, agent, { footerHtml })
      : { html: bodyToHtml(bodyText, agent, { footerHtml }), text: bodyText };

    try {
      const r = await provider.send({
        agent: q.agent === 'james' ? 'james' : 'sara',
        to: q.to_email, toName: q.to_name || null,
        subject: q.subject, text: rendered.text, html: rendered.html
      });
      if (r && r.skipped) throw new Error('provider skipped');
      await supa.from('email_queue').update({ status: 'sent', sent_at: nowIso(), attempts: (q.attempts || 0) + 1 }).eq('id', q.id);
      if (q.lead_id) {
        await supa.from('messages').insert({
          lead_id: q.lead_id, direction: 'outbound', channel: 'email',
          subject: q.subject, body: rendered.text, status: 'sent', ai_generated: false,
          approved_by: q.agent === 'james' ? 'james' : 'sara', approved_at: nowIso(),
          mailerlite_id: (r && r.id) || null
        }).then(() => {}, () => {});
        await supa.from('leads').update({ last_contact_at: nowIso() }).eq('id', q.lead_id).then(() => {}, () => {});
        await supa.from('lead_events').insert({
          lead_id: q.lead_id, event_type: 'message_sent', source: 'mailerlite',
          event_data: { bulk: true, campaign_id: q.campaign_id, subject: q.subject }
        }).then(() => {}, () => {});
      }
      sent++;
    } catch (e) {
      const msg = e && e.message ? e.message : String(e);
      const attempts = (q.attempts || 0) + 1;
      if (isRateLimit(msg)) {
        // Hit Resend's rate limit / daily cap — leave it queued, stop the run.
        await supa.from('email_queue').update({ attempts, error: msg.slice(0, 300) }).eq('id', q.id);
        hitLimit = true; break;
      }
      if (attempts >= MAX_ATTEMPTS) {
        await supa.from('email_queue').update({ status: 'failed', attempts, error: msg.slice(0, 300), sent_at: nowIso() }).eq('id', q.id);
        failed++;
      } else {
        await supa.from('email_queue').update({ attempts, error: msg.slice(0, 300) }).eq('id', q.id);
      }
    }
    if (SEND_GAP && i < rows.length - 1) await sleep(SEND_GAP);
  }

  const { count: stillQueued } = await supa.from('email_queue')
    .select('id', { count: 'exact', head: true }).eq('status', 'queued');

  return res.status(200).json({
    success: true, sent, failed, skipped,
    hit_rate_limit: hitLimit,
    used_today: (usedToday || 0) + sent, daily_cap: DAILY_CAP,
    still_queued: stillQueued || 0
  });
}
