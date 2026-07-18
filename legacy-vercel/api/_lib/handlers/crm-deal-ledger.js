// api/_lib/handlers/crm-deal-ledger.js
// GET   /api/crm/deal-ledger   → deals in motion, shaped for the Ledger table
// PATCH /api/crm/deal-ledger   → update the Ledger's own fields on one deal
//
// This is the read/write side for the crm.html "Deals in motion" section
// (formerly a plain strip, now the full Ledger table). It does NOT replace
// shapeDealsInMotion() in crm-morning-brief.js — that still feeds the
// lighter-weight card view used elsewhere. This endpoint adds the columns
// the Ledger needs that shapeDealsInMotion doesn't compute:
//
//   next_contingency — read from deal_timeline_items (kind='contingency',
//     status='upcoming'), NOT from deal_contingencies (that table exists but
//     is unused — deal_timeline_items is what the daily briefing's
//     contract-reading pipeline actually populates, via deals.json →
//     api/cron/sync-deals.js). Earliest due_date per deal.
//
//   next_inspection — read from public.appointments (kind='inspection').
//     Matching an appointment to a deal is NOT yet done via the "official"
//     lead_id -> deal_parties chain in practice (no appointment in the
//     database has lead_id set today) — instead agents have been tagging
//     appointment notes with "[deal:<source_key>" by hand (see the calendar
//     handler, crm-calendar.js, which reads the same convention for its
//     deal-colour matching). We match on that tag first, and fall back to
//     the lead_id/deal_parties chain so this keeps working as that data
//     improves. Earliest upcoming starts_at per deal.
//
//   client_label, portal_shared — new, agent-set fields from db/036. See
//     that migration's comments for why client_label is separate from the
//     deal_parties/leads client-linking chain. (db/036 also added
//     waiting_on — the UI dropped it as too fiddly to use in practice, but
//     the column/API support is left in place rather than ripped out, in
//     case that changes.)
//
//   ledger_hidden — db/037. "Remove from Ledger" is a soft hide, not a row
//     delete — see that migration's comments for why (deals.json would just
//     resurrect a hard-deleted row on the next sync, and a cascade delete
//     would destroy real child records). Hidden deals are filtered out of
//     the default GET; nothing else in the app reads this column.
//
// Agent-only, same auth pattern as every other CRM handler.

import { adminClient } from '../supabase.js';
import { getCallerProfile, isAgent } from '../auth.js';
import { handleOptions, readJson, ok, fail } from '../cors.js';
import { escrowStageSentence, sideKey } from '../deal-shape.js';

// Deals considered "in motion" for the Ledger — mirrors the stage list
// crm-calendar.js already uses for its deal picker, so the Ledger and the
// Calendar agree on what counts as an active deal.
const ACTIVE_STAGES = ['pending', 'offer', 'listing', 'preparing'];
// Still validated/settable via PATCH even though the Ledger UI no longer
// shows a "waiting on" control — see the file header note.
const WAITING_ON_VALUES = ['you', 'lender', 'inspector', 'coagent', 'client', 'escrowco'];

const DEAL_TAG_RE = /\[deal:([a-z0-9-]+)/i;

// Both the short chip key and the stage sentence now come from the shared
// deal-shape.js helper (see that file's header) — 'preparing' is the one
// stage the Ledger can see that the morning brief's query never returns, so
// it's still handled locally rather than in the shared function.
const sideLabel = sideKey;

function stageLabel(d) {
  if (d.stage === 'preparing') return 'Preparing';
  return escrowStageSentence(d);
}

export default async function handler(req, res) {
  if (handleOptions(req, res)) return;

  const { user, profile } = await getCallerProfile(req, res);
  if (!user)             return fail(res, 401, 'not authenticated');
  if (!isAgent(profile)) return fail(res, 403, 'agents only');

  const supa = adminClient();

  try {
    if (req.method === 'GET')   return await listLedger(req, res, supa);
    if (req.method === 'PATCH') return await patchLedger(req, res, supa);
    return fail(res, 405, 'method_not_allowed');
  } catch (e) {
    return fail(res, 500, e.message);
  }
}

async function listLedger(req, res, supa) {
  const includeClosed = req.query?.include_closed === '1';

  let dq = supa.from('deals').select(
    'id, source_key, address, city, side, stage, agent, co_agent, list_price, sale_price, ' +
    'coe_date, client_label, portal_shared, updated_at'
  ).eq('ledger_hidden', false);
  dq = includeClosed ? dq : dq.in('stage', ACTIVE_STAGES);
  const { data: deals, error: dealErr } = await dq.order('address', { ascending: true });
  if (dealErr) return fail(res, 500, `deals: ${dealErr.message}`);
  if (!deals || !deals.length) return ok(res, { deals: [] });

  const dealIds = deals.map((d) => d.id);
  const bySourceKey = new Map(deals.filter((d) => d.source_key).map((d) => [d.source_key, d.id]));

  // ---- Contingencies: deal_timeline_items, kind='contingency', upcoming ---
  const contByDeal = new Map();
  {
    const { data: rows, error } = await supa
      .from('deal_timeline_items')
      .select('deal_id, title, plain, due_date, status')
      .in('deal_id', dealIds)
      .eq('kind', 'contingency')
      .eq('status', 'upcoming')
      .order('due_date', { ascending: true });
    if (error) return fail(res, 500, `deal_timeline_items: ${error.message}`);
    for (const r of (rows || [])) {
      if (!contByDeal.has(r.deal_id)) {
        contByDeal.set(r.deal_id, { label: r.title || r.plain || 'Contingency', due_date: r.due_date || null });
      }
    }
  }

  // ---- Inspections: appointments, kind='inspection' ------------------------
  // Resolve the lead_id -> deal_id chain too (deal_parties), as a fallback
  // for once that data is actually populated (see file header).
  const leadToDeal = new Map();
  {
    const { data: parties } = await supa.from('deal_parties').select('lead_id, deal_id').in('deal_id', dealIds);
    for (const p of (parties || [])) if (p.lead_id) leadToDeal.set(p.lead_id, p.deal_id);
  }

  const inspByDeal = new Map();
  {
    const since = new Date(Date.now() - 24 * 3600 * 1000).toISOString(); // include "today"
    const { data: appts, error } = await supa
      .from('appointments')
      .select('id, title, sub_kind, starts_at, duration_minutes, lead_id, notes')
      .eq('kind', 'inspection')
      .gte('starts_at', since)
      .order('starts_at', { ascending: true });
    if (error && !/relation .*appointments.* does not exist/i.test(error.message || '')) {
      return fail(res, 500, `appointments: ${error.message}`);
    }
    for (const a of (appts || [])) {
      let dealId = a.lead_id ? leadToDeal.get(a.lead_id) : null;
      if (!dealId) {
        const m = DEAL_TAG_RE.exec(a.notes || '');
        if (m) dealId = bySourceKey.get(m[1]) || null;
      }
      if (!dealId) continue;
      if (!inspByDeal.has(dealId)) {
        inspByDeal.set(dealId, {
          id: a.id,
          label: a.title || (a.sub_kind ? `${a.sub_kind} inspection` : 'Inspection'),
          starts_at: a.starts_at,
          duration_minutes: a.duration_minutes || null
        });
      }
    }
  }

  const shaped = deals.map((d) => {
    const price = d.sale_price || d.list_price || null;
    return {
      id: d.id,
      source_key: d.source_key,
      address: d.address,
      city: d.city,
      side: sideLabel(d.side),
      agent: d.agent,
      co_agent: d.co_agent || null,
      stage: d.stage,
      stage_label: stageLabel(d),
      price,
      coe_date: d.coe_date,
      client_label: d.client_label || null,
      portal_shared: d.portal_shared === true,
      last_touch: d.updated_at,
      next_contingency: contByDeal.get(d.id) || null,
      next_inspection: inspByDeal.get(d.id) || null
    };
  });

  return ok(res, { deals: shaped, waiting_on_values: WAITING_ON_VALUES });
}

async function patchLedger(req, res, supa) {
  const body = await readJson(req);
  const sourceKey = typeof body?.source_key === 'string' ? body.source_key.trim() : '';
  const dealId    = typeof body?.deal_id === 'string' ? body.deal_id.trim() : '';
  if (!sourceKey && !dealId) return fail(res, 400, 'deal_id or source_key is required');

  const patch = {};
  if (body.client_label !== undefined) {
    patch.client_label = typeof body.client_label === 'string' ? (body.client_label.trim() || null) : null;
  }
  if (body.waiting_on !== undefined) {
    if (body.waiting_on !== null && !WAITING_ON_VALUES.includes(body.waiting_on)) {
      return fail(res, 400, `waiting_on must be one of: ${WAITING_ON_VALUES.join(', ')}`);
    }
    patch.waiting_on = body.waiting_on;
  }
  if (body.portal_shared !== undefined) patch.portal_shared = body.portal_shared === true;
  if (body.ledger_hidden !== undefined) patch.ledger_hidden = body.ledger_hidden === true;
  if (!Object.keys(patch).length) return fail(res, 400, 'no updatable fields provided');

  let q = supa.from('deals').update(patch);
  q = dealId ? q.eq('id', dealId) : q.eq('source_key', sourceKey);
  const { data, error } = await q.select('id, source_key, client_label, waiting_on, portal_shared, ledger_hidden');
  if (error) return fail(res, 500, error.message);
  if (!data || !data.length) return fail(res, 404, `no deal with ${dealId ? 'id ' + dealId : 'source_key ' + sourceKey}`);

  return ok(res, { updated: true, deal: data[0] });
}
