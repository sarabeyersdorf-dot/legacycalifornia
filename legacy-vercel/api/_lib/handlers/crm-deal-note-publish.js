// api/_lib/handlers/crm-deal-note-publish.js
// GET  /api/crm/deal-note-publish?deal=<source_key>  → { note, agent }
// POST /api/crm/deal-note-publish { source_key, action: 'publish'|'unpublish' }
//
// The client-facing agent note (deals.agent_note jsonb, db/038) is written from
// deals.json as a DRAFT. A client only ever sees it once Sara or James clicks
// Publish here — this flips agent_note.status to 'published' (or back to 'draft').
// sync-deals preserves a 'published' status across re-syncs as long as the note
// body is unchanged, so a routine sync never silently un-publishes a live note.
//
// Agent-only. Separate from crm-deal-notes.js (deals.agent_notes text = INTERNAL).

import { adminClient } from '../supabase.js';
import { getCallerProfile, isAgent } from '../auth.js';
import { handleOptions, readJson, ok, fail } from '../cors.js';

const MIGRATE = 'client-note column missing — run db/038_deal_milestones_notes.sql';
const colMissing = (msg) => /agent_note|schema cache|column|does not exist|could not find/i.test(msg || '');

export default async function handler(req, res) {
  if (handleOptions(req, res)) return;

  const { user, profile } = await getCallerProfile(req, res);
  if (!user)             return fail(res, 401, 'not authenticated');
  if (!isAgent(profile)) return fail(res, 403, 'agents only');

  const supa = adminClient();

  try {
    if (req.method === 'GET') {
      const sourceKey = typeof req.query?.deal === 'string' ? req.query.deal.trim() : '';
      if (!sourceKey) return fail(res, 400, 'deal (source_key) is required');
      const { data, error } = await supa.from('deals').select('agent_note, agent').eq('source_key', sourceKey).maybeSingle();
      if (error) return colMissing(error.message) ? ok(res, { note: null, needs_migration: true }) : fail(res, 500, error.message);
      return ok(res, { note: (data && data.agent_note) || null, agent: (data && data.agent) || 'sara' });
    }

    if (req.method === 'POST') {
      const body = await readJson(req);
      const sourceKey = typeof body?.source_key === 'string' ? body.source_key.trim() : '';
      const action = body?.action === 'unpublish' ? 'unpublish' : (body?.action === 'publish' ? 'publish' : null);
      if (!sourceKey) return fail(res, 400, 'source_key required');
      if (!action)    return fail(res, 400, "action must be 'publish' or 'unpublish'");

      const { data: row, error: e1 } = await supa.from('deals').select('agent_note').eq('source_key', sourceKey).maybeSingle();
      if (e1)   return colMissing(e1.message) ? fail(res, 409, MIGRATE) : fail(res, 500, e1.message);
      if (!row) return fail(res, 404, `deal not found (${sourceKey})`);

      const note = (row.agent_note && typeof row.agent_note === 'object' && !Array.isArray(row.agent_note)) ? row.agent_note : null;
      if (!note || !note.body || !String(note.body).trim()) {
        return fail(res, 400, 'no client note to publish for this deal yet');
      }

      const nextStatus = action === 'publish' ? 'published' : 'draft';
      const updated = {
        ...note,
        status: nextStatus,
        published_at: action === 'publish' ? new Date().toISOString() : null,
        published_by: action === 'publish' ? (profile.role === 'agent_james' ? 'james' : 'sara') : null
      };
      const { error: e2 } = await supa.from('deals').update({ agent_note: updated }).eq('source_key', sourceKey);
      if (e2) return colMissing(e2.message) ? fail(res, 409, MIGRATE) : fail(res, 500, e2.message);
      return ok(res, { saved: true, status: nextStatus, note: updated });
    }

    return fail(res, 405, 'method_not_allowed');
  } catch (e) {
    return fail(res, 500, e.message);
  }
}
