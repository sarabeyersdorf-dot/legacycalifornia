// api/_lib/handlers/curate-preview.js
// GET /api/curate/preview?id=<collection_id>   (agent-only)
//
// Returns EXACTLY what the client will see and be sent — same code path as the
// live client route and the push sender (via api/_lib/collection-render.js), so
// the preview can never drift from reality. Works on draft collections and never
// writes anything (no 'open' event, no status change).
//
// Response = the client page payload (collection/agent/listings/disclaimer/…)
// PLUS: { preview:true, share_link, client_name, client_phone, client_email,
//         messages: { sms:{to,body}, email:{to,subject,text,html} } }

import { adminClient } from '../supabase.js';
import { getCallerProfile, isAgent } from '../auth.js';
import { handleOptions, ok, fail } from '../cors.js';
import { buildClientPayload, buildPushMessage, SITE } from '../collection-render.js';

const agentKey = (profile) => (profile.role === 'agent_james' ? 'james' : 'sara');

export default async function handler(req, res) {
  if (handleOptions(req, res)) return;
  if (req.method !== 'GET') return fail(res, 405, 'method_not_allowed');

  const { user, profile } = await getCallerProfile(req, res);
  if (!user)             return fail(res, 401, 'not authenticated');
  if (!isAgent(profile)) return fail(res, 403, 'agents only');

  const supa  = adminClient();
  const agent = agentKey(profile);
  const id = req.query?.id;
  if (!id) return fail(res, 400, 'id required');

  try {
    const { data: coll, error } = await supa
      .from('curated_collections')
      .select('*, leads(id,first_name,last_name,email,phone)')
      .eq('id', id).eq('agent', agent).maybeSingle();
    if (error) return fail(res, 500, error.message);
    if (!coll) return fail(res, 404, 'collection not found');

    const payload = await buildClientPayload(supa, coll);
    const agentRow = payload._agent;
    delete payload._agent;

    const lead = coll.leads || null;
    const firstName = lead?.first_name || '';
    const sms   = buildPushMessage({ coll, agent: agentRow, channel: 'sms',   firstName });
    const email = buildPushMessage({ coll, agent: agentRow, channel: 'email', firstName });

    return ok(res, {
      ...payload,
      preview: true,
      status: coll.status,
      share_link: `${SITE}/c/${coll.share_token}`,
      client_name: lead ? [lead.first_name, lead.last_name].filter(Boolean).join(' ') : null,
      client_phone: lead?.phone || null,
      client_email: lead?.email || null,
      messages: {
        sms:   { to: lead?.phone || null, body: sms.body },
        email: { to: lead?.email || null, subject: email.subject, text: email.text, html: email.html }
      }
    });
  } catch (e) {
    return fail(res, 500, e.message);
  }
}
