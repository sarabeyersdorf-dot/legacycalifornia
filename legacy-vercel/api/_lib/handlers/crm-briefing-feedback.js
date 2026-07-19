// api/_lib/handlers/crm-briefing-feedback.js
// GET /api/crm/briefing-feedback?key=<SYNC_SECRET>
//
// The read-back channel for the daily briefing (Cowork). Returns every briefing
// task with what the agents did to it: done state, the note they wrote back,
// and whether they flagged it for attention. Cowork fetches this at the start
// of its run and tunes the next agenda in deals.json.
//
// Key-protected (not agent-session auth) so Cowork can pull it headlessly.
// Reuses SYNC_SECRET; if no secret is configured the endpoint is open.

import { adminClient } from '../supabase.js';
import { handleOptions, ok, fail } from '../cors.js';

export default async function handler(req, res) {
  if (handleOptions(req, res)) return;
  // This feeds a morning-briefing agent and must ALWAYS reflect live data —
  // never let Vercel's edge/CDN (or any intermediary) serve a stale payload.
  res.setHeader('Cache-Control', 'private, no-store, no-cache, must-revalidate');
  res.setHeader('CDN-Cache-Control', 'no-store');
  res.setHeader('Vercel-CDN-Cache-Control', 'no-store');
  if (req.method !== 'GET') return fail(res, 405, 'method_not_allowed');

  const secret = process.env.SYNC_SECRET || process.env.BRIEFING_FEEDBACK_SECRET;
  if (secret && req.query?.key !== secret) return fail(res, 401, 'bad key');

  try {
    const supa = adminClient();
    const COLS = 'agent, client, title, sub, due_label, done, agent_note, attention, agent_note_by, agent_note_at, source_key, created_at';
    let { data, error } = await supa.from('agent_tasks').select(COLS)
      .eq('source', 'briefing')
      .order('created_at', { ascending: true });
    // Fall back gracefully if migration 017 hasn't run yet.
    if (error) {
      ({ data, error } = await supa.from('agent_tasks')
        .select('agent, client, title, sub, due_label, done, source_key, created_at')
        .eq('source', 'briefing').order('created_at', { ascending: true }));
    }
    if (error) return fail(res, 500, error.message);

    const tasks = (data || []).map((t) => ({
      agent:      t.agent,
      client:     t.client || null,
      title:      t.title,
      done:       !!t.done,
      needs_attention: !!t.attention,
      agent_note: t.agent_note || null,
      note_by:    t.agent_note_by || null,
      note_at:    t.agent_note_at || null,
      deal:       t.source_key || null
    }));

    // Seller-portal feedback (db/040): the note the agent wrote for the briefing
    // and the client-tasks they ticked complete on the portal, per deal. Cowork
    // acts on these — reword/answer the note, and drop the completed tasks from
    // deals.json clientTasks. Fail-soft if migration 040 hasn't run.
    let deal_portal_notes = [];
    try {
      const { data: dRows, error: dErr } = await supa.from('deals')
        .select('source_key, agent, address, portal_seller_note, client_task_done')
        .or('portal_seller_note.not.is.null,client_task_done.not.is.null');
      if (!dErr && Array.isArray(dRows)) {
        deal_portal_notes = dRows
          .map((d) => {
            const note = d.portal_seller_note && typeof d.portal_seller_note === 'object' ? d.portal_seller_note : null;
            const completed = Array.isArray(d.client_task_done) ? d.client_task_done : [];
            if (!note && !completed.length) return null;
            return {
              deal: d.source_key, agent: d.agent || null, address: d.address || null,
              note: note ? (note.body || null) : null,
              note_by: note ? (note.by || null) : null,
              note_at: note ? (note.updated_at || null) : null,
              completed_tasks: completed
            };
          })
          .filter(Boolean);
      }
    } catch (_) { /* migration 040 not run yet */ }

    return ok(res, {
      generated_at: new Date().toISOString(),
      counts: {
        total:      tasks.length,
        done:       tasks.filter((t) => t.done).length,
        open:       tasks.filter((t) => !t.done).length,
        with_notes: tasks.filter((t) => t.agent_note).length,
        attention:  tasks.filter((t) => t.needs_attention).length
      },
      // The list Cowork should act on first: flagged or annotated.
      needs_review: tasks.filter((t) => t.needs_attention || t.agent_note),
      tasks,
      deal_portal_notes
    });
  } catch (e) {
    return fail(res, 500, e.message);
  }
}
