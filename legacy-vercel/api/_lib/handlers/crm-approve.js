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

    const { message_id, edited_body, edited_subject } = await readJson(req);
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
        html:    bodyToHtml(updated.body)
      });
      r.via = provider.name;
      return r;
    }

    let providerResult, sentPatch, usedChannel = msg.channel;
    try {
      if (msg.channel === 'sms') {
        try {
          if (!twilioConfigured()) throw new Error('Twilio not configured');
          if (!lead.phone)         throw new Error('lead has no phone number');
          providerResult = await sendSMS({ to: lead.phone, body: updated.body });
          if (providerResult.skipped) throw new Error(providerResult.reason || 'sms skipped');
          providerResult.via = 'twilio';
          sentPatch = { status: 'sent', twilio_sid: providerResult.sid || null };
        } catch (smsErr) {
          // SMS unavailable — fall back to email when we can.
          if (!lead.email) throw smsErr;
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
        source:     usedChannel === 'sms' ? 'twilio' : 'mailerlite',
        event_data: { message_id, channel: usedChannel, approved_by: patch.approved_by, fell_back_from: providerResult.fell_back_from || null }
      });
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
