// api/_lib/handlers/speed-to-lead.js
// sendSpeedToLead(supa, lead) — the instant auto-reply for a brand-new website
// lead. Called inline from /api/leads/intake so the acknowledgement goes out the
// moment the form is submitted (not on the hourly cron). This is a SOLICITED
// reply to someone who just contacted us, so it uses the warm branded wrapper
// (bodyToHtml: signature, no cold "not a solicitation" disclaimer).
//
// Safe by construction:
//   * once per lead ever (idempotent via a speed_to_lead_sent lead_event),
//   * never to a staff/internal address or an opted-out lead,
//   * copy comes from the editable 'speed_to_lead' sequence row (so Sara can
//     edit it + AI-suggest it in the CRM, exactly like the other sequences),
//   * fully fail-soft — any error is logged as a lead_event and swallowed so a
//     hiccup here can never break lead capture.

import { bodyToHtml, unsubscribeFooter } from '../email-html.js';
import { sendEmail, resendConfigured } from '../resend.js';

const INTERNAL_ADDRESSES = new Set(['sarasellscalifornia@gmail.com', 'jamessellscalifornia@gmail.com']);
const INTERNAL_DOMAINS = ['legacycalifornia.com'];
function isInternalAddress(email) {
  const e = String(email || '').toLowerCase().trim();
  if (!e) return false;
  if (INTERNAL_ADDRESSES.has(e)) return true;
  const d = e.split('@')[1] || '';
  return INTERNAL_DOMAINS.some((x) => d === x || d.endsWith('.' + x));
}
function fillTemplate(tpl, vars) {
  if (!tpl) return '';
  return String(tpl).replace(/\{\{(\w+)\}\}/g, (_, k) => (vars[k] != null ? String(vars[k]) : ''));
}

export async function sendSpeedToLead(supa, lead) {
  try {
    if (!lead || !lead.email)          return { skipped: 'no email' };
    if (isInternalAddress(lead.email)) return { skipped: 'internal address' };
    if (lead.email_opt_out)            return { skipped: 'opted out' };

    // Idempotent — only ever once per lead.
    const { data: prior } = await supa
      .from('lead_events').select('id').eq('lead_id', lead.id).eq('event_type', 'speed_to_lead_sent').limit(1);
    if (prior && prior.length) return { skipped: 'already sent' };

    // Editable copy lives in the 'speed_to_lead' sequence row.
    const { data: seq } = await supa
      .from('sequences').select('steps, active').eq('name', 'speed_to_lead').maybeSingle();
    if (!seq || seq.active === false) return { skipped: 'sequence inactive' };
    const steps = Array.isArray(seq.steps) ? seq.steps : [];
    const step = steps.find((s) => Number(s.step_number) === 1) || steps[0];
    if (!step || !step.body_template) return { skipped: 'no step copy' };

    const first = (lead.first_name || '').trim();
    const vars = { first_name: first, greeting: first ? `Hi ${first},` : 'Hi,' };
    const subject  = fillTemplate(step.subject_template || 'Thanks for reaching out to Legacy Properties', vars).trim();
    const bodyText = fillTemplate(step.body_template, vars).trim();
    if (!bodyText) return { skipped: 'empty body' };

    const agent = { name: 'Sara Cooper & James Beyersdorf', title: 'Legacy Properties', phone: '(209) 559-4966' };
    const html = bodyToHtml(bodyText, agent, { footerHtml: unsubscribeFooter(lead.unsubscribe_token) });

    if (!resendConfigured()) return { skipped: 'email provider not configured' };
    const toName = [lead.first_name, lead.last_name].filter(Boolean).join(' ') || undefined;
    const sent = await sendEmail({ to: lead.email, toName, subject, html, text: bodyText });

    // Record the outbound message (so it shows in the lead thread) + the
    // idempotency marker. Best-effort: the email already went out.
    try {
      await supa.from('messages').insert({
        lead_id: lead.id, direction: 'outbound', channel: 'email', status: 'sent',
        subject, body: bodyText, ai_generated: false
      });
    } catch (_) { /* recording is best-effort */ }
    try {
      await supa.from('lead_events').insert({
        lead_id: lead.id, event_type: 'speed_to_lead_sent', source: 'system',
        event_data: { subject, provider_id: (sent && sent.id) || null }
      });
    } catch (_) { /* marker is best-effort */ }

    return { sent: true, id: (sent && sent.id) || null };
  } catch (e) {
    // Fail-soft — never break lead capture. Leave a breadcrumb in the CRM.
    try {
      await supa.from('lead_events').insert({
        lead_id: lead && lead.id, event_type: 'notification_failed', source: 'system',
        event_data: { kind: 'speed_to_lead', error: (e && e.message) || String(e) }
      });
    } catch (_) { /* last-resort: swallow */ }
    return { error: (e && e.message) || String(e) };
  }
}
