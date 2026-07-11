// api/_lib/handlers/seller-messages.js
// The seller portal's conversation thread (channel='portal').
//   GET  /api/seller/messages?t=<portal_token>          → the client's thread
//   POST /api/seller/messages?t=<portal_token> {body}   → client sends a message
// Also accepts a signed-in seller session (no token), or an agent session with
// ?lead_id= for the CRM side. Identity comes from the token/session — a client
// can only ever see their own portal-channel thread; SMS and email history is
// never exposed here.

import { adminClient } from '../supabase.js';
import { getCallerProfile, isAgent, isSeller } from '../auth.js';
import { handleOptions, readJson, ok, fail } from '../cors.js';
import { sendSMS } from '../twilio.js';
import { agentIdentity } from '../collection-render.js';

async function resolveLead(supa, req, res) {
  const token = req.query?.t ? String(req.query.t).trim() : null;
  if (token) {
    const { data: lead } = await supa.from('leads')
      .select('id, first_name, assigned_agent').eq('portal_token', token).maybeSingle();
    return lead || null;
  }
  const { user, profile } = await getCallerProfile(req, res);
  if (!user) return null;
  if (isAgent(profile) && req.query?.lead_id) {
    const { data: lead } = await supa.from('leads')
      .select('id, first_name, assigned_agent').eq('id', req.query.lead_id).maybeSingle();
    return lead || null;
  }
  if (isSeller(profile) || profile?.lead_id) {
    if (profile?.lead_id) {
      const { data: lead } = await supa.from('leads').select('id, first_name, assigned_agent').eq('id', profile.lead_id).maybeSingle();
      if (lead) return lead;
    }
    if (user.email) {
      const { data: lead } = await supa.from('leads')
        .select('id, first_name, assigned_agent').eq('email', user.email.toLowerCase()).maybeSingle();
      return lead || null;
    }
  }
  return null;
}

export default async function handler(req, res) {
  if (handleOptions(req, res)) return;
  const supa = adminClient();
  try {
    const lead = await resolveLead(supa, req, res);
    if (!lead) return fail(res, 401, 'not recognized');

    if (req.method === 'GET') {
      const { data, error } = await supa.from('messages')
        .select('id, direction, body, created_at')
        .eq('lead_id', lead.id).eq('channel', 'portal')
        .order('created_at', { ascending: true }).limit(80);
      if (error) return fail(res, 500, error.message);
      return ok(res, { thread: data || [], client_name: lead.first_name || '' });
    }

    if (req.method === 'POST') {
      const b = await readJson(req);
      const text = (b?.body || '').toString().trim().slice(0, 2000);
      if (!text) return fail(res, 400, 'message body required');
      const { data: row, error } = await supa.from('messages').insert({
        lead_id: lead.id, direction: 'inbound', channel: 'portal',
        body: text, status: 'delivered', ai_generated: false
      }).select('id, created_at').single();
      if (error) return fail(res, 500, error.message);
      // Signals + alert — fail-soft, the client's send always succeeds.
      supa.from('lead_events').insert({
        lead_id: lead.id, event_type: 'portal_message', source: 'portal',
        event_data: { preview: text.slice(0, 120) }
      }).then(() => {}, () => {});
      supa.from('leads').update({ last_contact_at: new Date().toISOString() }).eq('id', lead.id).then(() => {}, () => {});
      try {
        const agent = await agentIdentity(supa, lead.assigned_agent === 'james' ? 'james' : 'sara');
        if (agent.phone) await sendSMS({ to: agent.phone, body: `${lead.first_name || 'A client'} messaged you on their portal: “${text.slice(0, 140)}” Reply from the desk: legacycalifornia.vercel.app/crm.html — Legacy` });
      } catch (_) {}
      return ok(res, { sent: true, id: row.id, created_at: row.created_at });
    }

    return fail(res, 405, 'method_not_allowed');
  } catch (e) {
    return fail(res, 500, e.message);
  }
}
