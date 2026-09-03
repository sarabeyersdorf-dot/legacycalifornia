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
//     cc_lead_ids: uuid[]    optional — related contacts (a spouse, a co-buyer)
//               to bring along on this message. The composer fills these from
//               lead_relationships.include_on_comms, so a couple is reached as a
//               couple by default instead of the agent remembering every send.
//   }
//
// How cc behaves differs by channel because the channels differ:
//   • EMAIL — a real cc on one message, so a reply-all keeps the household in a
//     single thread.
//   • SMS  — there is no cc in SMS. Each cc'd person gets their OWN text and
//     their OWN messages row, which is also what an agent does by hand. Without
//     the separate row the spouse's card would show no record of being told.
// Either way each cc'd person is re-checked against the channel they're being
// reached on: their own opt-out and a missing address/number drop them from the
// send silently rather than failing the whole message. The response lists who
// actually received it (`cc`) so the composer can say so.
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
// enough not to warrant a shared helper at this scale). Signs with the SENDING
// agent's own identity (name · title · DRE · phone) — never a hard-coded name —
// so James's emails are signed James, not Sara.
function bodyToHtml(text, agent) {
  const safe = (text || '').replace(/[&<>]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c]));
  const paragraphs = safe.split(/\n\s*\n/).map((p) =>
    `<p style="font-size:15px;line-height:1.6;color:#3A332B;margin:0 0 16px;">${p.replace(/\n/g, '<br>')}</p>`
  ).join('');
  const a = agent || {};
  const esc = (s) => String(s == null ? '' : s).replace(/[&<>]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c]));
  const sig = [
    esc(a.name || 'Legacy Properties'),
    a.title ? esc(a.title) : null,
    a.dre_number ? `DRE #${esc(a.dre_number)}` : null,
    a.phone ? esc(a.phone) : null
  ].filter(Boolean).join(' · ');
  return `<div style="font-family:Georgia,'Cormorant Garamond',serif;color:#1A1714;max-width:560px;margin:0 auto;padding:32px 28px;background:#FAF6EC;">
    <div style="font-family:'Courier New',monospace;font-size:10px;letter-spacing:.22em;text-transform:uppercase;color:#7C6A4D;margin-bottom:18px;">Legacy Properties</div>
    ${paragraphs}
    <hr style="border:none;border-top:1px solid #D9CFB7;margin:24px 0 16px;">
    <p style="font-size:13px;line-height:1.55;color:#7C6A4D;margin:0;">${sig}<br><a href="https://legacycalifornia.com" style="color:#7C6A4D;">legacycalifornia.com</a></p>
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
    const ccLeadIds = Array.isArray(body?.cc_lead_ids)
      ? [...new Set(body.cc_lead_ids.filter((x) => typeof x === 'string' && x))].slice(0, 5)
      : [];

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

    // ---- Resolve the cc'd related contacts ----------------------------
    // Only people actually linked to this contact can be cc'd — the ids come
    // from the browser, so trusting them blind would let any lead be added as a
    // recipient on any other lead's mail.
    let ccContacts = [];
    if (ccLeadIds.length && channel !== 'portal') {
      const { data: links } = await supa.from('lead_relationships')
        .select('related_lead_id').eq('lead_id', lead_id).in('related_lead_id', ccLeadIds)
        .then((r) => r, () => ({ data: [] }));
      const allowed = new Set((links || []).map((r) => r.related_lead_id));
      if (allowed.size) {
        const { data: people } = await supa.from('leads')
          .select('id, first_name, last_name, email, phone, status, email_opt_out, sms_opt_out')
          .in('id', [...allowed])
          .then((r) => r, () => ({ data: [] }));
        ccContacts = (people || []).filter((c) => {
          if (c.status !== 'active') return false;
          if (c.id === lead_id) return false;
          // Their own opt-out governs their own copy, independent of the primary's.
          return channel === 'sms'
            ? (!!c.phone && !c.sms_opt_out)
            : (!!c.email && !c.email_opt_out);
        });
      }
    }

    const sentBy = profile.role === 'agent_james' ? 'james' : 'sara';
    const nowIso = new Date().toISOString();

    // The sending agent's own identity, for the email signature (so James's
    // emails sign James). Fail-soft: if the lookup errors, sign with the brand.
    let senderAgent = null;
    if (channel === 'email') {
      const { data: ag } = await supa.from('agents').select('name, title, dre_number, phone, email').eq('agent_key', sentBy).maybeSingle();
      senderAgent = ag || null;
    }

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
          cc:      ccContacts.map((c) => c.email),
          subject,
          text,
          html:    bodyToHtml(text, senderAgent)
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

    // ---- SMS has no cc: give each related contact their own text ------
    // Their own message, their own row, so their card shows they were told.
    // Best-effort per person: one failure must not fail the primary send, which
    // has already gone out by this point.
    const ccDelivered = [];
    if (sentPatch.status === 'sent' && ccContacts.length) {
      if (channel === 'sms') {
        for (const c of ccContacts) {
          try {
            const { data: ccRow } = await supa.from('messages').insert({
              lead_id: c.id, direction: 'outbound', channel: 'sms', body: text,
              subject: null, status: 'draft', ai_generated: false,
              approved_by: sentBy, approved_at: nowIso
            }).select('id').single();
            let ccStatus = 'sent', ccSid = null;
            if (!logOnly) {
              const r2 = await sendSMS({ to: c.phone, body: text, signAs: sentBy });
              ccStatus = r2.skipped ? 'failed' : 'sent';
              ccSid = r2.sid || null;
            }
            if (ccRow) await supa.from('messages').update({ status: ccStatus, twilio_sid: ccSid }).eq('id', ccRow.id);
            if (ccStatus === 'sent') {
              ccDelivered.push(c);
              await supa.from('leads').update({ last_contact_at: nowIso }).eq('id', c.id);
            }
          } catch { /* one spouse's text failing must not fail the primary send */ }
        }
      } else {
        // Email: they were cc'd on the ONE message that already went out, so
        // there is nothing more to send. Deliberately no row and no
        // last_contact_at stamp for them: a cc is a copy on someone else's
        // thread, not a conversation we've had with them, and the message is
        // already visible on the primary's thread where it belongs. (A text is
        // different — that one really is addressed to them, hence the row above.)
        // Not stamping also keeps a couple's emails out of the bulk-send
        // detector, which counts distinct recipients per two-minute window.
        ccDelivered.push(...ccContacts);
      }
    }

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
      logged:     logOnly,
      // Who actually got it besides the primary, so the composer can say so
      // rather than the agent having to trust that the toggle did something.
      cc: ccDelivered.map((c) => ({
        id: c.id,
        name: [c.first_name, c.last_name].filter(Boolean).join(' ') || c.email || c.phone,
        via: channel === 'sms' ? 'text' : 'cc'
      }))
    });
  } catch (e) {
    return fail(res, 500, e.message);
  }
}
