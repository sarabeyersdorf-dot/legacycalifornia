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

  const { user, profile } = await getCallerProfile(req, res);
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

    // A note that reads like an instruction becomes a task on the Tasks list
    // (deduped per note), so "set up a curated search for her" doesn't die in
    // the lead's file. Fail-soft — the note itself always saves.
    let task_created = false;
    try {
      const ACTION_RE = /^task:|\b(set ?up|create|schedule|send|follow ?up|todo|to-do|need to|remind me|prepare|draft|order|book|call her|call him|call them|curated search|saved search)\b/i;
      if (!insErr && ACTION_RE.test(text)) {
        const { data: leadRow } = await supa.from('leads').select('first_name,last_name,assigned_agent').eq('id', lead_id).maybeSingle();
        const who = leadRow ? [leadRow.first_name, leadRow.last_name].filter(Boolean).join(' ') : 'Lead';
        const sourceKey = `note:${note.id}`;
        const { count } = await supa.from('agent_tasks').select('id', { count: 'exact', head: true }).eq('source_key', sourceKey);
        if (!count) {
          const title = text.replace(/^task:\s*/i, '').split('\n')[0].slice(0, 140);
          const { error: tErr } = await supa.from('agent_tasks').insert({
            agent: (leadRow?.assigned_agent === 'james') ? 'james' : (profile.role === 'agent_james' ? 'james' : 'sara'),
            client: who, title, sub: 'From your note', note: text.length > 140 ? text.slice(0, 500) : null,
            due_label: 'Today', done: false, source_key: sourceKey
          });
          task_created = !tErr;
        }
      }
    } catch (_) { /* never block the note */ }
    if (insErr) return fail(res, 500, `lead_notes insert: ${insErr.message}`);

    return ok(res, { task_created, note });
  } catch (e) {
    return fail(res, 500, e.message);
  }
}
