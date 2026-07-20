// api/_lib/handlers/crm-deal-portal-notes.js
// Agent-only. Manages the seller-portal task state + the note-for-Cowork on a
// deal (db/040). Called from the seller portal when an AGENT is previewing it.
//
//   GET  /api/crm/deal-portal-notes?deal=<source_key>
//        → { done: [labels], note: {...}|null, note_seen: bool }
//   POST /api/crm/deal-portal-notes { source_key, action, ... }
//        action 'toggle-task' { label, done } → add/remove label in client_task_done
//        action 'save-note'   { body }        → set portal_seller_note
//
// Crucially, saving a note (or ticking a task complete) also files an
// agent_updates entry tagged to the deal. That's the SAME log the morning
// briefing (Cowork) pulls via ?op=feed — which marks it read as it reads it — so
// the note actually reaches the briefing, gets folded into deals.json, and stops
// showing as pending. Without this the note just sat on the portal, stale.

import { adminClient } from '../supabase.js';
import { getCallerProfile, isAgent } from '../auth.js';
import { handleOptions, readJson, ok, fail } from '../cors.js';

const MIGRATE = 'portal task columns missing — run db/040_portal_task_state.sql';
const colMissing = (msg) => /client_task_done|portal_seller_note|schema cache|column|does not exist|could not find/i.test(msg || '');

// File a note into the shared agent_updates log (the briefing's input feed).
// Fail-soft: a logging hiccup must never block saving the portal state itself.
async function fileBriefingUpdate(supa, { who, dealId, sourceKey, address, content }) {
  try {
    const row = { agent: who, deal: sourceKey || null, content };
    if (dealId) row.deal_id = dealId;
    const { data, error } = await supa.from('agent_updates').insert(row).select('id').single();
    if (error) return null;
    return data?.id || null;
  } catch (_) { return null; }
}

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
      if (error) return colMissing(error.message) ? ok(res, { done: [], note: null, note_seen: false, needs_migration: true }) : fail(res, 500, error.message);
      const note = data?.portal_seller_note || null;
      let note_seen = false;
      if (note && note.update_id) {
        const { data: up } = await supa.from('agent_updates').select('read_by_briefing').eq('id', note.update_id).maybeSingle();
        note_seen = !!(up && up.read_by_briefing);
      }
      return ok(res, { done: Array.isArray(data?.client_task_done) ? data.client_task_done : [], note, note_seen });
    }

    if (req.method === 'POST') {
      const body = await readJson(req);
      const sourceKey = typeof body?.source_key === 'string' ? body.source_key.trim() : '';
      if (!sourceKey) return fail(res, 400, 'source_key required');

      const { data: row, error: e1 } = await supa.from('deals').select('id, address, client_task_done, portal_seller_note').eq('source_key', sourceKey).maybeSingle();
      if (e1)   return colMissing(e1.message) ? fail(res, 409, MIGRATE) : fail(res, 500, e1.message);
      if (!row) return fail(res, 404, `deal not found (${sourceKey})`);
      const where = row.address ? ` — ${row.address}` : '';

      if (body.action === 'toggle-task') {
        const label = typeof body.label === 'string' ? body.label.trim() : '';
        if (!label) return fail(res, 400, 'label required');
        const cur = new Set(Array.isArray(row.client_task_done) ? row.client_task_done : []);
        const wasDone = cur.has(label);
        const makeDone = body.done !== false;
        if (makeDone) cur.add(label); else cur.delete(label);
        const next = [...cur];
        const { error: e2 } = await supa.from('deals').update({ client_task_done: next }).eq('source_key', sourceKey);
        if (e2) return colMissing(e2.message) ? fail(res, 409, MIGRATE) : fail(res, 500, e2.message);
        // Tell the briefing to drop it from this deal's tasks (only on the
        // open → done transition, so re-ticks don't spam the log).
        if (makeDone && !wasDone) {
          await fileBriefingUpdate(supa, { who, dealId: row.id, sourceKey, content: `Seller portal${where}: I marked "${label}" complete — please drop it from this deal's tasks.` });
        }
        return ok(res, { saved: true, done: next });
      }

      if (body.action === 'save-note') {
        const noteBody = typeof body.body === 'string' ? body.body.trim() : '';
        const prev = row.portal_seller_note && typeof row.portal_seller_note === 'object' ? row.portal_seller_note : null;
        const unchanged = prev && String(prev.body || '').trim() === noteBody;
        if (!noteBody) {
          const { error: e2 } = await supa.from('deals').update({ portal_seller_note: null }).eq('source_key', sourceKey);
          if (e2) return colMissing(e2.message) ? fail(res, 409, MIGRATE) : fail(res, 500, e2.message);
          return ok(res, { saved: true, note: null, note_seen: false });
        }
        // Only file a fresh briefing update when the note actually changed —
        // otherwise re-saving the same text would re-notify the briefing.
        let updateId = prev && unchanged ? (prev.update_id || null) : null;
        if (!unchanged) {
          updateId = await fileBriefingUpdate(supa, { who, dealId: row.id, sourceKey, content: `Seller-portal note${where}: ${noteBody}` });
        }
        const note = { body: noteBody, updated_at: new Date().toISOString(), by: who, update_id: updateId };
        const { error: e2 } = await supa.from('deals').update({ portal_seller_note: note }).eq('source_key', sourceKey);
        if (e2) return colMissing(e2.message) ? fail(res, 409, MIGRATE) : fail(res, 500, e2.message);
        return ok(res, { saved: true, note, note_seen: false });
      }

      return fail(res, 400, "action must be 'toggle-task' or 'save-note'");
    }

    return fail(res, 405, 'method_not_allowed');
  } catch (e) {
    return fail(res, 500, e.message);
  }
}
