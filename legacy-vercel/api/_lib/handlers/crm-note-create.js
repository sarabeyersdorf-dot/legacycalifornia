// api/_lib/handlers/crm-note-create.js
// POST /api/crm/note
//
// Writes a note to the lead_notes table. Agent-only (server-side check) —
// matches the RLS policy in db/005_lead_notes.sql which grants ALL only
// when public.current_role_is_agent() is true.
//
// Body:
//   { lead_id: uuid, body: string (1-8000 chars), is_internal?: boolean }
//
// Notes are immutable in v1 — no edit/update endpoint.

import { adminClient } from '../supabase.js';
import { getCallerProfile, isAgent } from '../auth.js';
import { handleOptions, readJson, ok, fail } from '../cors.js';

const MAX_BODY = 8000;

export default async function handler(req, res) {
  if (handleOptions(req, res)) return;
  if (req.method !== 'POST') return fail(res, 405, 'method_not_allowed');

  const { user, profile } = await getCallerProfile(req);
  if (!user)              return fail(res, 401, 'not authenticated');
  if (!isAgent(profile))  return fail(res, 403, 'agents only');

  try {
    const body = await readJson(req);
    const lead_id    = body?.lead_id;
    const text       = typeof body?.body === 'string' ? body.body.trim() : '';
    const isInternal = !!body?.is_internal;

    if (!lead_id) return fail(res, 400, 'lead_id required');
    if (!text)    return fail(res, 400, 'body is required');
    if (text.length > MAX_BODY) return fail(res, 413, `body exceeds ${MAX_BODY} chars`);

    const supa = adminClient();

    // Verify lead exists (defence in depth — RLS would reject anyway).
    const { data: lead, error: leadErr } = await supa
      .from('leads').select('id, status').eq('id', lead_id).maybeSingle();
    if (leadErr) return fail(res, 500, leadErr.message);
    if (!lead)   return fail(res, 404, 'lead not found');

    const { data: note, error: insErr } = await supa.from('lead_notes').insert({
      lead_id,
      body:        text,
      is_internal: isInternal,
      created_by:  user.id
    }).select().single();
    if (insErr) return fail(res, 500, `lead_notes insert: ${insErr.message}`);

    return ok(res, { note });
  } catch (e) {
    return fail(res, 500, e.message);
  }
}
