// api/_lib/handlers/curate-push.js
// POST /api/curate/push   (agent-only)
//
// Body: { collection_id, channel:'sms'|'email', to?, to_name?, message?, subject? }
//   - Resolves recipient from the collection's client lead unless `to` is given.
//   - Flips the collection to status='active' so the share link works.
//   - Sends via Twilio (sms) or Resend (email) with a branded link.
//   - Logs the outbound to public.messages (when a client lead exists) so it
//     lands in the inbox / morning brief, mirroring crm-message-send.js.

import { adminClient } from '../supabase.js';
import { getCallerProfile, isAgent } from '../auth.js';
import { sendSMS } from '../twilio.js';
import { sendEmail as sendEmailResend, resendConfigured } from '../resend.js';
import { sendEmail as sendEmailSendgrid, sendgridConfigured } from '../sendgrid.js';
import { handleOptions, readJson, ok, fail } from '../cors.js';
import { buildPushMessage, agentIdentity, buildClientPayload } from '../collection-render.js';

const agentKey = (profile) => (profile.role === 'agent_james' ? 'james' : 'sara');

function pickEmailProvider() {
  if (resendConfigured())   return { name: 'resend',   send: sendEmailResend };
  if (sendgridConfigured()) return { name: 'sendgrid', send: sendEmailSendgrid };
  return null;
}

export default async function handler(req, res) {
  if (handleOptions(req, res)) return;
  if (req.method !== 'POST') return fail(res, 405, 'method_not_allowed');

  const { user, profile } = await getCallerProfile(req, res);
  if (!user)             return fail(res, 401, 'not authenticated');
  if (!isAgent(profile)) return fail(res, 403, 'agents only');

  const supa  = adminClient();
  const agent = agentKey(profile);

  try {
    const b = await readJson(req);
    const channel = b?.channel;
    if (!b?.collection_id) return fail(res, 400, 'collection_id required');
    if (!['sms', 'email'].includes(channel)) return fail(res, 400, "channel must be 'sms' or 'email'");

    // Collection must belong to this agent
    const { data: coll, error: cErr } = await supa
      .from('curated_collections')
      .select('*, leads(id,first_name,last_name,email,phone)')
      .eq('id', b.collection_id).eq('agent', agent).maybeSingle();
    if (cErr)  return fail(res, 500, cErr.message);
    if (!coll) return fail(res, 404, 'collection not found');

    // Must have at least one included listing before pushing
    const { count: includedCount } = await supa
      .from('collection_listings')
      .select('id', { count: 'exact', head: true })
      .eq('collection_id', coll.id).eq('included', true);
    if (!includedCount) return fail(res, 409, 'add at least one listing before pushing');

    // Agent identity for the signature (shared with the preview)
    const agentRow = await agentIdentity(supa, agent);

    const lead = coll.leads || null;
    const firstName = lead?.first_name || '';
    const to = b?.to || (channel === 'sms' ? lead?.phone : lead?.email);
    if (!to) return fail(res, 422, channel === 'sms' ? 'no phone on file for this client' : 'no email on file for this client');

    // Build the EXACT message the preview shows — one source of truth. The
    // client payload supplies the shaped listings for the email's photo cards.
    const payload = channel === 'email' ? await buildClientPayload(supa, coll) : null;
    const msg = buildPushMessage({ coll, agent: agentRow, channel, firstName, message: b?.message, subject: b?.subject, listings: payload?.listings || [] });
    const link = msg.link;

    // Flip to active so the link is live
    if (coll.status !== 'active') await supa.from('curated_collections').update({ status: 'active' }).eq('id', coll.id);

    // ---- Send ----------------------------------------------------------
    let providerResult, sentOk = false, bodyText = '';
    if (channel === 'sms') {
      bodyText = msg.body;
      providerResult = await sendSMS({ to, body: bodyText });
      sentOk = !providerResult.skipped;
      providerResult.via = 'twilio';
    } else {
      const provider = pickEmailProvider();
      if (!provider) return fail(res, 502, 'no email provider configured — set RESEND_API_KEY');
      bodyText = msg.text;
      providerResult = await provider.send({
        agent: agent,
        to,
        toName: lead ? [lead.first_name, lead.last_name].filter(Boolean).join(' ') || null : (b?.to_name || null),
        subject: msg.subject,
        text: msg.text,
        html: msg.html
      });
      sentOk = !providerResult.skipped;
      providerResult.via = provider.name;
    }

    // ---- Log to messages (only when we have a client lead) -------------
    let message_id = null;
    if (lead?.id) {
      const nowIso = new Date().toISOString();
      const { data: row } = await supa.from('messages').insert({
        lead_id: lead.id,
        direction: 'outbound',
        channel,
        body: channel === 'sms' ? bodyText : `Collection pushed: ${link}`,
        subject: channel === 'email' ? `Collection: ${coll.title || 'homes for you'}` : null,
        status: sentOk ? 'sent' : 'failed',
        ai_generated: false,
        approved_by: agent,
        approved_at: nowIso,
        twilio_sid: channel === 'sms' ? (providerResult.sid || null) : null
      }).select('id').single();
      message_id = row?.id || null;
      if (sentOk) {
        await supa.from('leads').update({ last_contact_at: nowIso }).eq('id', lead.id);
        await supa.from('lead_events').insert({
          lead_id: lead.id, event_type: 'message_sent',
          source: channel === 'sms' ? 'twilio' : 'mailerlite',
          event_data: { collection_id: coll.id, channel, kind: 'curated_collection_push' }
        });
      }
    }

    return ok(res, {
      pushed: sentOk, channel, to, link, message_id,
      provider: providerResult,
      note: providerResult.skipped ? 'Provider not configured — link generated but message not delivered.' : undefined
    });
  } catch (e) {
    return fail(res, 500, e.message);
  }
}
