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
import { sendSMS } from '../twilio.js';
import { sendEmail } from '../mailerlite.js';
import { handleOptions, readJson, ok, fail } from '../cors.js';

export default async function handler(req, res) {
  if (handleOptions(req, res)) return;
  if (req.method !== 'POST') return fail(res, 405, 'method_not_allowed');

  try {
    const { profile } = await getCallerProfile(req);
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

    // 3. Send via the appropriate channel
    let providerResult, sentPatch;
    try {
      if (msg.channel === 'sms') {
        if (!lead.phone) throw new Error('lead has no phone number');
        providerResult = await sendSMS({ to: lead.phone, body: updated.body });
        sentPatch = { status: providerResult.skipped ? 'failed' : 'sent', twilio_sid: providerResult.sid || null };
      } else if (msg.channel === 'email') {
        if (!lead.email) throw new Error('lead has no email address');
        providerResult = await sendEmail({
          to:      lead.email,
          toName:  [lead.first_name, lead.last_name].filter(Boolean).join(' ') || null,
          subject: updated.subject || '(no subject)',
          text:    updated.body,
          html:    bodyToHtml(updated.body)
        });
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
        source:     msg.channel === 'sms' ? 'twilio' : 'mailerlite',
        event_data: { message_id, channel: msg.channel, approved_by: patch.approved_by }
      });
    }

    return ok(res, {
      message_id,
      status:    sentPatch.status,
      provider:  providerResult
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
