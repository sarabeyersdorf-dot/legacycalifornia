// api/_lib/handlers/crm-deal-notes.js
// GET  /api/crm/deal-notes?deal=<source_key>   → { notes }
// POST /api/crm/deal-notes  { source_key, notes } → save internal notes
//
// Agent-only internal notes on a deal (deals.agent_notes, db/029). INTERNAL —
// never shown to a client; independent of the deals.json sync, so Cowork never
// overwrites it. Kept separate from deals.notes (which is client-facing).

import { adminClient } from '../supabase.js';
import { getCallerProfile, isAgent } from '../auth.js';
import { handleOptions, readJson, ok, fail } from '../cors.js';

const MAX = 8000;
const MIGRATE = 'internal notes column missing — run db/029_deal_agent_notes.sql';
const colMissing = (msg) => /agent_notes|schema cache|column|does not exist|could not find/i.test(msg || '');

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
      const { data, error } = await supa.from('deals').select('agent_notes').eq('source_key', sourceKey).maybeSingle();
      if (error) return colMissing(error.message) ? ok(res, { notes: null, needs_migration: true }) : fail(res, 500, error.message);
      return ok(res, { notes: (data && data.agent_notes) || '' });
    }

    if (req.method === 'POST') {
      const body = await readJson(req);
      const sourceKey = typeof body?.source_key === 'string' ? body.source_key.trim() : '';
      const notes = typeof body?.notes === 'string' ? body.notes : '';
      if (!sourceKey) return fail(res, 400, 'source_key required');
      if (notes.length > MAX) return fail(res, 413, `notes exceed ${MAX} chars`);
      const value = notes.trim() || null;
      const { data, error } = await supa.from('deals').update({ agent_notes: value }).eq('source_key', sourceKey).select('source_key').maybeSingle();
      if (error) return colMissing(error.message) ? fail(res, 409, MIGRATE) : fail(res, 500, error.message);
      if (!data)  return fail(res, 404, `deal not found (${sourceKey})`);
      return ok(res, { saved: true, notes: value || '' });
    }

    return fail(res, 405, 'method_not_allowed');
  } catch (e) {
    return fail(res, 500, e.message);
  }
}
