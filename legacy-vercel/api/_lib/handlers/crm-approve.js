// api/_lib/handlers/crm-approve.js
// POST /api/crm/approve
//
// Body: { message_id, edited_body?, edited_subject? }
// Effect:
//   1. Updates the message row: status='approved', approved_by, approved_at,
//      and (if edited) the new body / subject.
//   2. Sends the message via Twilio (sms) or MailerLite (email).
//   3. Stamps status='sent' + provider id (twilio_sid / mailerlite_id).
//   4. Updates the lead's last_contact_at.
//   5. Writes a message_sent lead_event.
//
// If the send fails, status is rolled back to 'failed' and the lead is NOT
// re-stamped.

import { adminClient } from '../supabase.js';
import { getCallerProfile, isAgent } from '../auth.js';
import { sendSMS, twilioConfigured } from '../twilio.js';
import { sendEmail as sendEmailResend,   resendConfigured }   from '../resend.js';
import { sendEmail as sendEmailSendgrid, sendgridConfigured } from '../sendgrid.js';
import { coldEmailHtml } from '../email-html.js';
import { handleOptions, readJson, ok, fail } from '../cors.js';

/**
 * Picks the configured email provider. Resend wins — it has the simplest
 * deliverability story and the cleanest API. SendGrid kept as a fallback for
 * accounts that have it already wired (e.g. shared with other properties).
 */
function pickEmailProvider() {
  if (resendConfigured())   return { name: 'resend',   send: sendEmailResend };
  if (sendgridConfigured()) return { name: 'sendgrid', send: sendEmailSendgrid };
  return null;
}

export default async function handler(req, res) {
  if (handleOptions(req, res)) return;
  if (req.method !== 'POST') return fail(res, 405, 'method_not_allowed');

  try {
    const { profile } = await getCallerProfile(req, res);
    if (!isAgent(profile)) return fail(res, 401, 'agents only');

    const b = await readJson(req);
    const { message_id, edited_body, edited_subject } = b;
    if (!message_id) return fail(res, 400, 'message_id required');

    const supa = adminClient();

    // 1. Load the message + lead
    const { data: msg, error: msgErr } = await supa
      .from('messages').select('*, leads(*)').eq('id', message_id).single();
    if (msgErr || !msg) return fail(res, 404, 'message not found');
    if (msg.status === 'sent') return fail(res, 409, 'already sent');
    if (msg.direction !== 'outbound') return fail(res, 400, 'cannot approve inbound message');

    const lead = msg.leads;
    if (!lead) return fail(res, 404, 'lead not found for message');

    // An approved draft is still an automated message — it was written by the
    // AI and is going out under a sequence — so an opt-out blocks it. Approving
    // a queued draft is a one-click action on a busy day and nothing else on
    // this path checks. Portal messages are exempt: that thread is the client's
    // own page in their transaction, not a channel they unsubscribed from.
    if (msg.channel !== 'portal') {
      const blocked = lead.not_interested                       ? 'marked not interested'
                    : (lead.status && lead.status !== 'active') ? `status is ${lead.status}`
                    : (msg.channel === 'email' && lead.email_opt_out) ? 'unsubscribed from email'
                    : (msg.channel === 'sms'   && lead.sms_opt_out)   ? 'opted out of texts'
                    : null;
      if (blocked) {
        const who = [lead.first_name, lead.last_name].filter(Boolean).join(' ') || lead.email || 'This contact';
        // Mark the draft so it stops sitting in the approval queue waiting to
        // be clicked again. `messages` has no error column and its status check
        // admits only draft/pending_approval/approved/sent/delivered/failed —
        // so the reason goes in the reasoning field, where the card shows it.
        await supa.from('messages')
          .update({
            status: 'failed',
            ai_draft_reasoning: `Not sent: ${blocked}. ${msg.ai_draft_reasoning || ''}`.trim().slice(0, 2000)
          })
          .eq('id', message_id).then(() => {}, () => {});
        return fail(res, 409, `${who} is ${blocked} — nothing sent. The draft is marked failed so it stops waiting for approval.`);
      }
    }

    // Cold-sequence context: a message tied to a sequence (messages.sequence_id)
    // whose send_mode is auto_after_first is COLD outreach — it must carry the
    // CAN-SPAM footer (unsubscribe + business + physical address), and approving
    // step 1 ARMS the auto-send of the rest.
    let seq = null;
    if (msg.sequence_id) {
      const { data } = await supa.from('sequences').select('id, steps, send_mode').eq('id', msg.sequence_id).maybeSingle();
      seq = data || null;
    }
    const isColdSeq = !!(seq && seq.send_mode === 'auto_after_first');

    // Preview: render the email exactly as the recipient will see it (branded
    // wrapper + any cold footer) WITHOUT approving or sending. Powers the
    // lead-page "Preview email" button.
    if (b.preview === true) {
      const pv = (typeof edited_body === 'string' && edited_body.trim()) ? edited_body.trim() : (msg.body || '');
      const html = (msg.channel === 'email')
        ? (isColdSeq
            ? coldEmailHtml(pv, lead.unsubscribe_token)
            : bodyToHtml(pv))
        : `<pre style="font:14px/1.6 -apple-system,sans-serif;white-space:pre-wrap;padding:22px;color:#1A1714;">${(pv || '').replace(/[&<>]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c]))}</pre>`;
      return ok(res, { preview: true, subject: msg.subject || null, html });
    }

    // 2. Apply edits + flip to approved
    const patch = {
      status:       'approved',
      approved_by:  profile.role === 'agent_james' ? 'james' : 'sara',
      approved_at:  new Date().toISOString()
    };
    if (typeof edited_body === 'string'    && edited_body.trim())    patch.body    = edited_body.trim();
    if (typeof edited_subject === 'string' && edited_subject.trim()) patch.subject = edited_subject.trim();

    const { data: updated, error: updErr } = await supa
      .from('messages').update(patch).eq('id', message_id).select().single();
    if (updErr) return fail(res, 500, `update: ${updErr.message}`);

    // 3. Send via the appropriate channel.
    //    SMS falls back to email automatically: if Twilio isn't configured (or
    //    rejects auth) and the lead has an email address, the note still goes
    //    out — so approving a draft never dead-ends on a broken SMS provider.
    async function sendEmailNow() {
      if (!lead.email) throw new Error('lead has no email address');
      const provider = pickEmailProvider();
      if (!provider) throw new Error('no email provider configured — set RESEND_API_KEY or SENDGRID_API_KEY');
      const r = await provider.send({
        agent:   (profile.role === 'agent_james' ? 'james' : 'sara'),
        to:      lead.email,
        toName:  [lead.first_name, lead.last_name].filter(Boolean).join(' ') || null,
        subject: updated.subject || 'A note from Legacy Properties',
        text:    updated.body,
        // Cold sequence → cold wrapper (body's own signature + CAN-SPAM footer:
        // unsubscribe + physical address). Everything else keeps the plain wrapper.
        html:    isColdSeq
                   ? coldEmailHtml(updated.body, lead.unsubscribe_token)
                   : bodyToHtml(updated.body)
      });
      r.via = provider.name;
      return r;
    }

    let providerResult, sentPatch, usedChannel = msg.channel;
    try {
      if (msg.channel === 'portal') {
        // Portal messages have no external provider — the row IS the
        // delivery. The client's page polls the thread and shows it within
        // seconds (same as a manual portal send via /api/crm/message).
        providerResult = { via: 'portal' };
        sentPatch = { status: 'sent' };
      } else if (msg.channel === 'sms') {
        try {
          if (!twilioConfigured()) throw new Error('Twilio not configured');
          if (!lead.phone)         throw new Error('lead has no phone number');
          providerResult = await sendSMS({ to: lead.phone, body: updated.body, signAs: patch.approved_by });
          if (providerResult.skipped) throw new Error(providerResult.reason || 'sms skipped');
          providerResult.via = 'twilio';
          sentPatch = { status: 'sent', twilio_sid: providerResult.sid || null };
        } catch (smsErr) {
          // SMS unavailable — fall back to email when we can. The guard above
          // cleared them for SMS, which says nothing about email: someone can
          // be textable and unsubscribed at the same time, and silently
          // rerouting to the channel they opted out of is the one way this
          // fallback could do harm.
          if (!lead.email || lead.email_opt_out) throw smsErr;
          providerResult = await sendEmailNow();
          providerResult.fell_back_from = 'sms';
          providerResult.fallback_reason = smsErr.message;
          usedChannel = 'email';
          sentPatch = { status: providerResult.skipped ? 'failed' : 'sent', channel: 'email', mailerlite_id: providerResult.id || null };
        }
      } else if (msg.channel === 'email') {
        providerResult = await sendEmailNow();
        sentPatch = { status: providerResult.skipped ? 'failed' : 'sent', mailerlite_id: providerResult.id || null };
      } else {
        throw new Error(`unsupported channel: ${msg.channel}`);
      }
    } catch (sendErr) {
      await supa.from('messages').update({ status: 'failed' }).eq('id', message_id);
      return fail(res, 502, `send failed: ${sendErr.message}`);
    }

    // 4. Stamp sent + update lead
    await supa.from('messages').update(sentPatch).eq('id', message_id);

    if (sentPatch.status === 'sent') {
      await supa.from('leads')
        .update({ last_contact_at: new Date().toISOString() })
        .eq('id', lead.id);

      await supa.from('lead_events').insert({
        lead_id:    lead.id,
        event_type: 'message_sent',
        source:     usedChannel === 'sms' ? 'twilio' : usedChannel === 'portal' ? 'portal' : 'mailerlite',
        event_data: { message_id, channel: usedChannel, approved_by: patch.approved_by, fell_back_from: providerResult.fell_back_from || null }
      });

      // Approving step 1 of an auto_after_first sequence ARMS the auto-send of
      // the rest: advance to step 2 and schedule it (absolute from enrollment).
      // The hourly cron then sends steps 2..n automatically, halting on reply.
      if (isColdSeq && lead.sequence_id === msg.sequence_id && (lead.sequence_step || 0) === 0) {
        const steps = Array.isArray(seq.steps) ? seq.steps : [];
        if (steps.length >= 2) {
          const base = lead.sequence_started_at ? new Date(lead.sequence_started_at).getTime() : Date.now();
          const nextDue = new Date(base + (Number(steps[1].delay_hours) || 0) * 3600_000).toISOString();
          await supa.from('leads').update({
            sequence_autosend: true, sequence_step: 1, sequence_next_due_at: nextDue
          }).eq('id', lead.id);
        } else {
          await supa.from('leads').update({ sequence_id: null, sequence_next_due_at: null }).eq('id', lead.id);
        }
      }
    }

    return ok(res, {
      message_id,
      status:       sentPatch.status,
      sent_channel: usedChannel,
      fell_back:    providerResult.fell_back_from || null,
      provider:     providerResult
    });
  } catch (e) {
    return fail(res, 500, e.message);
  }
}

// Convert plain-text email body into a minimal branded HTML wrapper that
// matches Sara's editorial aesthetic.
function bodyToHtml(text) {
  const safe = (text || '').replace(/[&<>]/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;'}[c]));
  const paragraphs = safe.split(/\n\s*\n/).map(p =>
    `<p style="font-size:15px;line-height:1.6;color:#3A332B;margin:0 0 16px;">${p.replace(/\n/g, '<br>')}</p>`
  ).join('');
  return `<div style="font-family:Georgia,'Cormorant Garamond',serif;color:#1A1714;max-width:560px;margin:0 auto;padding:32px 28px;background:#FAF6EC;">
    <div style="font-family:'Courier New',monospace;font-size:10px;letter-spacing:.22em;text-transform:uppercase;color:#7C6A4D;margin-bottom:18px;">Legacy Properties</div>
    ${paragraphs}
    <hr style="border:none;border-top:1px solid #D9CFB7;margin:24px 0 16px;">
    <p style="font-size:13px;line-height:1.55;color:#7C6A4D;margin:0;">Sara Cooper · Broker-Owner · DRE #02141987 · 209-559-4966<br><a href="https://legacycalifornia.com" style="color:#7C6A4D;">legacycalifornia.com</a></p>
  </div>`;
}
