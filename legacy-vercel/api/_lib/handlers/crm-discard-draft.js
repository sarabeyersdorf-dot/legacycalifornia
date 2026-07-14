// api/_lib/handlers/crm-discard-draft.js
// POST /api/crm/discard-draft
//
// Deletes an AI-suggested reply Sara/James doesn't want to send. Only ever
// touches a message that is still status='pending_approval' AND
// ai_generated=true — never a real (manually written or already-sent)
// message, so this can't be used to erase conversation history.
//
// Body: { message_id: uuid }

import { adminClient } from '../supabase.js';
import { getCallerProfile, isAgent } from '../auth.js';
import { handleOptions, readJson, ok, fail } from '../cors.js';

export default async function handler(req, res) {
  if (handleOptions(req, res)) return;
  if (req.method !== 'POST') return fail(res, 405, 'method_not_allowed');

  const { user, profile } = await getCallerProfile(req, res);
  if (!user)             return fail(res, 401, 'not authenticated');
  if (!isAgent(profile)) return fail(res, 403, 'agents only');

  try {
    const { message_id } = await readJson(req);
    if (!message_id) return fail(res, 400, 'message_id required');

    const supa = adminClient();
    const { data: msg, error: getErr } = await supa
      .from('messages').select('id, status, ai_generated').eq('id', message_id).maybeSingle();
    if (getErr) return fail(res, 500, getErr.message);
    if (!msg)   return fail(res, 404, 'message not found');
    if (msg.status !== 'pending_approval' || !msg.ai_generated) {
      return fail(res, 409, 'only a pending AI draft can be discarded');
    }

    const { error: delErr } = await supa.from('messages').delete().eq('id', message_id);
    if (delErr) return fail(res, 500, delErr.message);

    return ok(res, { discarded: message_id });
  } catch (e) {
    return fail(res, 500, e.message);
  }
}
