// api/_lib/handlers/crm-deal-client-tasks.js
// SPEC · Supabase-as-master, Phase 2 — edit the portal "What I need from you" list.
//
//   GET  /api/crm/deal-client-tasks?deal=<source_key>[&side=seller|buyer]
//        → { items:[{label,when}], source:'agent'|'cowork', side }
//   POST /api/crm/deal-client-tasks { source_key, side?, items:[{label,when}] }
//        → sets the agent overlay (agent_client_tasks / agent_buyer_tasks). An empty
//          items array CLEARS it (revert to Cowork's deals.json list). Agent-only.
//
// The overlay wins over Cowork's deals.json list on the portal (db/094) and survives
// the hourly sync (mapDeal never writes these). Every write is audited. This is the
// base client to-do list; individually-tracked agent tasks (§4.1) render alongside.

import { adminClient } from '../supabase.js';
import { getCallerProfile, isAgent } from '../auth.js';
import { handleOptions, readJson, ok, fail } from '../cors.js';

const MISSING = (m) => /agent_client_tasks|agent_buyer_tasks|deal_audit|schema cache|column/i.test(m || '');
const agentKey = (role) => (role === 'agent_james' ? 'james' : 'sara');
const colFor = (side) => (side === 'buyer' ? 'agent_buyer_tasks' : 'agent_client_tasks');
const baseColFor = (side) => (side === 'buyer' ? 'buyer_tasks' : 'client_tasks');

function cleanItems(raw) {
  if (!Array.isArray(raw)) return [];
  return raw
    .map((it) => ({
      label: String((it && it.label) || '').trim().slice(0, 160),
      when:  String((it && it.when)  || '').trim().slice(0, 60) || 'Open'
    }))
    .filter((it) => it.label)
    .slice(0, 20);
}

export default async function handler(req, res) {
  if (handleOptions(req, res)) return;

  const { user, profile } = await getCallerProfile(req, res);
  if (!user)             return fail(res, 401, 'not authenticated');
  if (!isAgent(profile)) return fail(res, 403, 'agents only');

  const supa = adminClient();

  try {
    if (req.method === 'GET') {
      const sourceKey = String(req.query?.deal || '').trim();
      if (!sourceKey) return fail(res, 400, 'deal (source_key) required');
      const side = req.query?.side === 'buyer' ? 'buyer' : 'seller';
      const { data, error } = await supa.from('deals')
        .select(`${colFor(side)}, ${baseColFor(side)}`).eq('source_key', sourceKey).maybeSingle();
      if (error) return MISSING(error.message) ? ok(res, { items: [], source: 'cowork', side, needs_migration: true }) : fail(res, 500, error.message);
      const agentList = Array.isArray(data?.[colFor(side)]) ? data[colFor(side)] : null;
      const items = agentList != null ? agentList : (Array.isArray(data?.[baseColFor(side)]) ? data[baseColFor(side)] : []);
      return ok(res, { items, source: agentList != null ? 'agent' : 'cowork', side });
    }

    if (req.method === 'POST') {
      const body = await readJson(req);
      const sourceKey = String(body?.source_key || '').trim();
      if (!sourceKey) return fail(res, 400, 'source_key required');
      const side = body?.side === 'buyer' ? 'buyer' : 'seller';
      const col = colFor(side);

      const { data: row, error: e0 } = await supa.from('deals').select(`id, ${col}`).eq('source_key', sourceKey).maybeSingle();
      if (e0) return MISSING(e0.message) ? fail(res, 409, 'run db/094_deal_agent_client_tasks.sql') : fail(res, 500, e0.message);
      if (!row) return fail(res, 404, `deal not found (${sourceKey})`);

      const items = cleanItems(body?.items);
      const next = items.length ? items : null;

      const { error: e1 } = await supa.from('deals').update({ [col]: next }).eq('source_key', sourceKey);
      if (e1) return MISSING(e1.message) ? fail(res, 409, 'run db/094_deal_agent_client_tasks.sql') : fail(res, 500, e1.message);

      await supa.from('deal_audit').insert({
        deal_id: row.id, field: col,
        old_value: Array.isArray(row[col]) ? `${row[col].length} items` : null,
        new_value: next ? `${next.length} items` : null,
        changed_by: agentKey(profile.role), source: 'crm',
        note: next ? `edited ${side} client to-do list` : `cleared ${side} client to-do list (back to Cowork)`
      }).then(() => {}, () => {});

      return ok(res, { saved: true, items: next || [], source: next ? 'agent' : 'cowork', side });
    }

    return fail(res, 405, 'method_not_allowed');
  } catch (e) {
    return fail(res, 500, e.message);
  }
}
