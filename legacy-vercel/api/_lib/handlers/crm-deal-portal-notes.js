// api/_lib/handlers/crm-deal-portal-notes.js
// Agent-only. Manages the seller-portal task state + the note-for-Cowork on a
// deal (db/040). Called from the seller portal when an AGENT is previewing it.
//
//   GET  /api/crm/deal-portal-notes?deal=<source_key>
//        → { done: [labels], note: { body, updated_at, by } | null }
//   POST /api/crm/deal-portal-notes { source_key, action, ... }
//        action 'toggle-task' { label, done:true|false } → add/remove label in client_task_done
//        action 'save-note'   { body }                   → set portal_seller_note

import { adminClient } from '../supabase.js';
import { getCallerProfile, isAgent } from '../auth.js';
import { handleOptions, readJson, ok, fail } from '../cors.js';

const MIGRATE = 'portal task columns missing — run db/040_portal_task_state.sql';
const colMissing = (msg) => /client_task_done|portal_seller_note|schema cache|column|does not exist|could not find/i.test(msg || '');

export default async function handler(req, res) {
  if (handleOptions(req, res)) return;

  const { user, profile } = await getCallerProfile(req, res);
  if (!user)             return fail(res, 401, 'not authenticated');
  if (!isAgent(profile)) return fail(res, 403, 'agents only');

  const supa = adminClient();
  const who = profile.role === 'agent_james' ? 'james' : 'sara';

  try {
    if (req.method === 'GET') {
      const sourceKey = typeof req.query?.deal === 'string' ? req.query.deal.trim() : '';
      if (!sourceKey) return fail(res, 400, 'deal (source_key) is required');
      const { data, error } = await supa.from('deals').select('client_task_done, portal_seller_note').eq('source_key', sourceKey).maybeSingle();
      if (error) return colMissing(error.message) ? ok(res, { done: [], note: null, needs_migration: true }) : fail(res, 500, error.message);
      return ok(res, { done: Array.isArray(data?.client_task_done) ? data.client_task_done : [], note: data?.portal_seller_note || null });
    }

    if (req.method === 'POST') {
      const body = await readJson(req);
      const sourceKey = typeof body?.source_key === 'string' ? body.source_key.trim() : '';
      if (!sourceKey) return fail(res, 400, 'source_key required');

      const { data: row, error: e1 } = await supa.from('deals').select('client_task_done, portal_seller_note').eq('source_key', sourceKey).maybeSingle();
      if (e1)   return colMissing(e1.message) ? fail(res, 409, MIGRATE) : fail(res, 500, e1.message);
      if (!row) return fail(res, 404, `deal not found (${sourceKey})`);

      if (body.action === 'toggle-task') {
        const label = typeof body.label === 'string' ? body.label.trim() : '';
        if (!label) return fail(res, 400, 'label required');
        const cur = new Set(Array.isArray(row.client_task_done) ? row.client_task_done : []);
        if (body.done === false) cur.delete(label); else cur.add(label);
        const next = [...cur];
        const { error: e2 } = await supa.from('deals').update({ client_task_done: next }).eq('source_key', sourceKey);
        if (e2) return colMissing(e2.message) ? fail(res, 409, MIGRATE) : fail(res, 500, e2.message);
        return ok(res, { saved: true, done: next });
      }

      if (body.action === 'save-note') {
        const noteBody = typeof body.body === 'string' ? body.body.trim() : '';
        const note = noteBody ? { body: noteBody, updated_at: new Date().toISOString(), by: who } : null;
        const { error: e2 } = await supa.from('deals').update({ portal_seller_note: note }).eq('source_key', sourceKey);
        if (e2) return colMissing(e2.message) ? fail(res, 409, MIGRATE) : fail(res, 500, e2.message);
        return ok(res, { saved: true, note });
      }

      return fail(res, 400, "action must be 'toggle-task' or 'save-note'");
    }

    return fail(res, 405, 'method_not_allowed');
  } catch (e) {
    return fail(res, 500, e.message);
  }
}
