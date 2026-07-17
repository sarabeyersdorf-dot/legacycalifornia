// api/_lib/handlers/crm-message-send.js
// POST /api/crm/message
//
// Manual outbound message from an agent — bypasses the AI-draft / approval
// workflow. Writes to messages with status='sent', sends via Resend (email)
// or Twilio (SMS), updates leads.last_contact_at, logs lead_events.
//
// Body:
//   {
//     lead_id:  uuid,        required
//     channel:  'email' | 'sms', required
//     body:     string,      required (trimmed, max 4000 chars)
//     subject:  string       required for email; ignored for sms
//     log_only: boolean      optional — record a message the agent already sent
//               from their OWN phone/email (Command Center "text from my phone"
//               bridge). No provider dispatch; the row lands 'sent' so the deal
//               thread keeps the record even while the Twilio line is pending.
//   }
//
// Auth: server-side. Only Sara/James/admin can send.

import { adminClient } from '../supabase.js';
import { getCallerProfile, isAgent } from '../auth.js';
import { sendSMS } from '../twilio.js';
import { sendEmail as sendEmailResend,   resendConfigured }   from '../resend.js';
import { sendEmail as sendEmailSendgrid, sendgridConfigured } from '../sendgrid.js';
import { handleOptions, readJson, ok, fail } from '../cors.js';

const MAX_BODY = 4000;
const MAX_SUBJECT = 200;
const SMS_HARD_CAP = 320;        // 2 segments — gives a little headroom

function pickEmailProvider() {
  if (resendConfigured())   return { name: 'resend',   send: sendEmailResend };
  if (sendgridConfigured()) return { name: 'sendgrid', send: sendEmailSendgrid };
  return null;
}

// Same minimal branded wrapper used by /api/crm/approve. Kept inline (small
// enough not to warrant a shared helper at this scale).
function bodyToHtml(text) {
  const safe = (text || '').replace(/[&<>]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c]));
  const paragraphs = safe.split(/\n\s*\n/).map((p) =>
    `<p style="font-size:15px;line-height:1.6;color:#3A332B;margin:0 0 16px;">${p.replace(/\n/g, '<br>')}</p>`
  ).join('');
  return `<div style="font-family:Georgia,'Cormorant Garamond',serif;color:#1A1714;max-width:560px;margin:0 auto;padding:32px 28px;background:#FAF6EC;">
    <div style="font-family:'Courier New',monospace;font-size:10px;letter-spacing:.22em;text-transform:uppercase;color:#7C6A4D;margin-bottom:18px;">Legacy Properties</div>
    ${paragraphs}
    <hr style="border:none;border-top:1px solid #D9CFB7;margin:24px 0 16px;">
    <p style="font-size:13px;line-height:1.55;color:#7C6A4D;margin:0;">Sara Cooper · Broker-Owner · DRE #02141987 · 209-559-4966<br><a href="https://legacycalifornia.com" style="color:#7C6A4D;">legacycalifornia.com</a></p>
  </div>`;
}

export default async function handler(req, res) {
  if (handleOptions(req, res)) return;
  if (req.method !== 'POST') return fail(res, 405, 'method_not_allowed');

  // Auth — agents only, enforced server-side
  const { user, profile } = await getCallerProfile(req, res);
  if (!user)              return fail(res, 401, 'not authenticated');
  if (!isAgent(profile))  return fail(res, 403, 'agents only');

  try {
    const body = await readJson(req);
    const lead_id = body?.lead_id;
    const channel = body?.channel;
    const text    = typeof body?.body    === 'string' ? body.body.trim()    : '';
    const subject = typeof body?.subject === 'string' ? body.subject.trim() : '';
    const logOnly = body?.log_only === true;

    // ---- Validation ----------------------------------------------------
    if (!lead_id) return fail(res, 400, 'lead_id required');
    if (!['email', 'sms', 'portal'].includes(channel)) return fail(res, 400, "channel must be 'email', 'sms', or 'portal'");
    if (!text) return fail(res, 400, 'body is required');
    if (text.length > MAX_BODY) return fail(res, 413, `body exceeds ${MAX_BODY} chars`);
    if (channel === 'email' && !subject) return fail(res, 400, 'subject is required for email');
    if (channel === 'email' && subject.length > MAX_SUBJECT) return fail(res, 413, `subject exceeds ${MAX_SUBJECT} chars`);
    if (channel === 'sms'   && text.length > SMS_HARD_CAP)   return fail(res, 413, `sms body exceeds ${SMS_HARD_CAP} chars`);

    const supa = adminClient();

    // ---- Lead must exist and have a deliverable address ---------------
    const { data: lead, error: leadErr } = await supa
      .from('leads').select('id, first_name, last_name, email, phone, status').eq('id', lead_id).maybeSingle();
    if (leadErr) return fail(res, 500, leadErr.message);
    if (!lead)   return fail(res, 404, 'lead not found');
    if (lead.status !== 'active') return fail(res, 409, 'lead is not active');
    if (channel === 'sms'   && !lead.phone) return fail(res, 422, 'lead has no phone number');
    if (channel === 'email' && !lead.email) return fail(res, 422, 'lead has no email address');

    const sentBy = profile.role === 'agent_james' ? 'james' : 'sara';
    const nowIso = new Date().toISOString();

    // ---- Insert the messages row (transient status while we await provider)
    // Must be a value in the messages.status CHECK ('draft' | 'pending_approval'
    // | 'approved' | 'sent' | 'delivered' | 'failed') — 'queued' is NOT allowed
    // and would 500 the insert. We land it 'draft' (the column default) and
    // immediately stamp it 'sent'/'failed' below once the provider responds.
    const { data: row, error: insErr } = await supa.from('messages').insert({
      lead_id,
      direction:    'outbound',
      channel,
      body:         text,
      subject:      channel === 'email' ? subject : null,
      status:       'draft',
      ai_generated: false,
      approved_by:  sentBy,
      approved_at:  nowIso
    }).select().single();
    if (insErr) return fail(res, 500, `messages insert: ${insErr.message}`);

    // ---- Dispatch via the right provider (or, for log_only, skip it) --
    // log_only records a message the agent ALREADY sent from their own
    // phone/email — the Command Center "text from my phone" bridge. There's
    // nothing to dispatch, so it lands 'sent' directly. Keeps the deal thread
    // complete while the business Twilio line is in compliance review.
    let providerResult, sentPatch;
    if (channel === 'portal') {
      // Portal messages have no external provider — the row IS the delivery.
      // The client's page polls the thread and shows it within seconds.
      sentPatch = { status: 'sent' };
      providerResult = { via: 'portal' };
    } else if (logOnly) {
      sentPatch = { status: 'sent' };
      providerResult = { logged: true, via: 'personal' };
    } else {
    try {
      if (channel === 'sms') {
        providerResult = await sendSMS({ to: lead.phone, body: text, signAs: sentBy });
        sentPatch = {
          status:     providerResult.skipped ? 'failed' : 'sent',
          twilio_sid: providerResult.sid || null
        };
        providerResult.via = 'twilio';
      } else {
        const provider = pickEmailProvider();
        if (!provider) throw new Error('no email provider configured — set RESEND_API_KEY or SENDGRID_API_KEY');
        providerResult = await provider.send({
        agent: sentBy,
          to:      lead.email,
          toName:  [lead.first_name, lead.last_name].filter(Boolean).join(' ') || null,
          subject,
          text,
          html:    bodyToHtml(text)
        });
        sentPatch = {
          status:        providerResult.skipped ? 'failed' : 'sent',
          mailerlite_id: providerResult.id || null   // column name is a legacy artifact — stores any provider's id
        };
        providerResult.via = provider.name;
      }
    } catch (sendErr) {
      await supa.from('messages').update({ status: 'failed' }).eq('id', row.id);
      return fail(res, 502, `send failed: ${sendErr.message}`);
    }
    }

    // ---- Stamp status + update lead.last_contact_at -------------------
    await supa.from('messages').update(sentPatch).eq('id', row.id);

    if (sentPatch.status === 'sent') {
      await supa.from('leads')
        .update({ last_contact_at: nowIso })
        .eq('id', lead_id);

      await supa.from('lead_events').insert({
        lead_id,
        event_type: 'message_sent',
        source:     channel === 'sms' ? 'twilio' : 'mailerlite',
        event_data: { message_id: row.id, channel, manual: true, sent_by: sentBy, ...(logOnly ? { logged: true, via: 'personal_phone' } : {}) }
      });
    }

    return ok(res, {
      message_id: row.id,
      status:     sentPatch.status,
      provider:   providerResult,
      logged:     logOnly
    });
  } catch (e) {
    return fail(res, 500, e.message);
  }
}
