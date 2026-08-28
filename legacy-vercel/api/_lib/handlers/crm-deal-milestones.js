// api/_lib/handlers/crm-deal-milestones.js
// SPEC · Supabase-as-master, Phase 2 — edit the portal "road to closing".
//
//   GET  /api/crm/deal-milestones?deal=<source_key>[&side=seller|buyer]
//        → { items:[{date,label,desc,status,badge,col}], source:'agent'|'cowork', side }
//   POST /api/crm/deal-milestones { source_key, side?, items:[...] }
//        → sets the agent overlay (agent_milestones / agent_buyer_milestones).
//          An empty items array CLEARS it (revert to the daily brief). Agent-only.
//
// The overlay WINS over deals.json milestones in the portal (db/093) and survives
// the hourly sync (mapDeal never writes these columns). The item shape matches
// deals.json milestones exactly, so the portal renders them with no other change.
// Every write is audited to deal_audit.

import { adminClient } from '../supabase.js';
import { getCallerProfile, isAgent } from '../auth.js';
import { handleOptions, readJson, ok, fail } from '../cors.js';

const MISSING = (m) => /agent_milestones|agent_buyer_milestones|deal_audit|schema cache|column/i.test(m || '');
const agentKey = (role) => (role === 'agent_james' ? 'james' : 'sara');
const colFor = (side) => (side === 'buyer' ? 'agent_buyer_milestones' : 'agent_milestones');
const baseColFor = (side) => (side === 'buyer' ? 'buyer_milestones' : 'milestones');

const STATUSES = new Set(['done', 'next', 'upcoming', 'key']);
const COLS     = new Set(['marketing', 'paperwork', 'inspection', 'money', 'closing']);

// Normalise incoming rows into the milestone shape the portal already renders.
function cleanItems(raw) {
  if (!Array.isArray(raw)) return [];
  return raw.map((it) => {
    it = it || {};
    const date = String(it.date || '').trim().slice(0, 10);
    const row = {
      date:   /^\d{4}-\d{2}-\d{2}$/.test(date) ? date : '',
      label:  String(it.label || '').trim().slice(0, 140),
      desc:   String(it.desc || it.description || '').trim().slice(0, 600),
      status: STATUSES.has(it.status) ? it.status : 'upcoming'
    };
    const badge = String(it.badge || '').trim().slice(0, 40);
    if (badge) row.badge = badge;
    if (COLS.has(it.col)) row.col = it.col;
    return row;
  }).filter((it) => it.label).slice(0, 24);
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
      // Normalise `description`→`desc` so the editor gets one field name either way.
      const shaped = (items || []).map((m) => ({
        date: (m && m.date) || '', label: (m && m.label) || '',
        desc: (m && (m.desc || m.description)) || '',
        status: (m && m.status) || 'upcoming', badge: (m && m.badge) || '', col: (m && m.col) || ''
      }));
      return ok(res, { items: shaped, source: agentList != null ? 'agent' : 'cowork', side });
    }

    if (req.method === 'POST') {
      const body = await readJson(req);
      const sourceKey = String(body?.source_key || '').trim();
      if (!sourceKey) return fail(res, 400, 'source_key required');
      const side = body?.side === 'buyer' ? 'buyer' : 'seller';
      const col = colFor(side);

      const { data: row, error: e0 } = await supa.from('deals').select(`id, ${col}`).eq('source_key', sourceKey).maybeSingle();
      if (e0) return MISSING(e0.message) ? fail(res, 409, 'run db/093_deal_agent_milestones.sql') : fail(res, 500, e0.message);
      if (!row) return fail(res, 404, `deal not found (${sourceKey})`);

      const items = cleanItems(body?.items);
      const next = items.length ? items : null;   // empty → clear (revert to Cowork)

      const { error: e1 } = await supa.from('deals').update({ [col]: next }).eq('source_key', sourceKey);
      if (e1) return MISSING(e1.message) ? fail(res, 409, 'run db/093_deal_agent_milestones.sql') : fail(res, 500, e1.message);

      await supa.from('deal_audit').insert({
        deal_id: row.id, field: col,
        old_value: Array.isArray(row[col]) ? `${row[col].length} items` : null,
        new_value: next ? `${next.length} items` : null,
        changed_by: agentKey(profile.role), source: 'crm',
        note: next ? `edited ${side} road-to-closing` : `cleared ${side} road (back to Cowork)`
      }).then(() => {}, () => {});

      return ok(res, { saved: true, items: items, source: next ? 'agent' : 'cowork', side });
    }

    return fail(res, 405, 'method_not_allowed');
  } catch (e) {
    return fail(res, 500, e.message);
  }
}
