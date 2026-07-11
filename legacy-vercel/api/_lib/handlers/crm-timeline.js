// api/_lib/handlers/crm-timeline.js
// Agent-side management of the client-facing deal timeline.
//
//   GET  /api/crm/timeline?deal_id=<uuid> | ?source_key=<key>
//        → { deal, items, proposals } (pending proposals only)
//   GET  /api/crm/timeline?proposals=all → every pending proposal (for the brief)
//   POST ops:
//     { op:'seed', deal_id }                      → seed from the CA template (no-op if items exist)
//     { op:'add-item', deal_id, title, ... }      → custom item (e.g. "Tenant extension in writing")
//     { op:'update-item', id, patch:{...} }       → direct agent edit (the agent IS the approver)
//     { op:'propose', deal_id, item_id|item_key, change:{...}, reason, source }
//     { op:'approve', proposal_id } / { op:'reject', proposal_id }
//
// Approval is the ONLY path by which automated sources change an item.

import { adminClient } from '../supabase.js';
import { getCallerProfile, isAgent } from '../auth.js';
import { handleOptions, readJson, ok, fail } from '../cors.js';
import { buildTimelineItems } from '../timeline-template.js';

const ITEM_FIELDS = ['title', 'plain', 'owner', 'due_date', 'status', 'done_at', 'detail', 'client_visible', 'sort_order', 'kind'];
const pick = (obj, keys) => Object.fromEntries(Object.entries(obj || {}).filter(([k]) => keys.includes(k)));

async function loadDeal(supa, { deal_id, source_key }) {
  let q = supa.from('deals').select('*');
  if (deal_id) q = q.eq('id', deal_id);
  else if (source_key) q = q.eq('source_key', source_key);
  else return null;
  const { data } = await q.maybeSingle();
  return data || null;
}

export async function seedDeal(supa, deal) {
  const { count } = await supa.from('deal_timeline_items')
    .select('id', { count: 'exact', head: true }).eq('deal_id', deal.id);
  if (count > 0) return { seeded: 0, existing: count };
  const rows = buildTimelineItems(deal).map((r) => ({ ...r, deal_id: deal.id }));
  if (!rows.length) return { seeded: 0, existing: 0 };
  const { error } = await supa.from('deal_timeline_items').insert(rows);
  if (error) throw new Error(`seed: ${error.message}`);
  return { seeded: rows.length, existing: 0 };
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
      if (req.query?.proposals === 'all') {
        const { data, error } = await supa.from('deal_timeline_proposals')
          .select('*').eq('status', 'pending').order('created_at', { ascending: true }).limit(50);
        if (error) return fail(res, 500, error.message);
        return ok(res, { proposals: data || [] });
      }
      const deal = await loadDeal(supa, req.query || {});
      if (!deal) return fail(res, 404, 'deal not found');
      const [{ data: items }, { data: proposals }] = await Promise.all([
        supa.from('deal_timeline_items').select('*').eq('deal_id', deal.id)
          .order('sort_order').order('due_date', { ascending: true, nullsFirst: false }),
        supa.from('deal_timeline_proposals').select('*').eq('deal_id', deal.id)
          .eq('status', 'pending').order('created_at')
      ]);
      return ok(res, { deal: { id: deal.id, source_key: deal.source_key, address: deal.address, stage: deal.stage, coe_date: deal.coe_date }, items: items || [], proposals: proposals || [] });
    }

    if (req.method !== 'POST') return fail(res, 405, 'method_not_allowed');
    const b = await readJson(req);
    const op = b?.op;

    if (op === 'seed') {
      const deal = await loadDeal(supa, b);
      if (!deal) return fail(res, 404, 'deal not found');
      return ok(res, await seedDeal(supa, deal));
    }

    if (op === 'add-item') {
      if (!b?.deal_id || !b?.title) return fail(res, 400, 'deal_id and title required');
      const row = {
        deal_id: b.deal_id,
        key: 'custom:' + (b.title.toLowerCase().replace(/[^a-z0-9]+/g, '-').slice(0, 40) || Date.now()),
        kind: ['milestone','contingency','disclosure','task','document'].includes(b.kind) ? b.kind : 'task',
        ...pick(b, ['title', 'plain', 'owner', 'due_date', 'detail', 'sort_order']),
      };
      const { data, error } = await supa.from('deal_timeline_items').insert(row).select().single();
      if (error) return fail(res, 500, error.message);
      return ok(res, { item: data });
    }

    if (op === 'update-item') {
      if (!b?.id) return fail(res, 400, 'id required');
      const patch = pick(b.patch, ITEM_FIELDS);
      if (!Object.keys(patch).length) return fail(res, 400, 'nothing to update');
      if (patch.status === 'done' && !patch.done_at) patch.done_at = new Date().toISOString();
      patch.updated_at = new Date().toISOString();
      const { data, error } = await supa.from('deal_timeline_items').update(patch).eq('id', b.id).select().single();
      if (error) return fail(res, 500, error.message);
      return ok(res, { item: data });
    }

    if (op === 'propose') {
      if (!b?.deal_id || !b?.change) return fail(res, 400, 'deal_id and change required');
      let item = null;
      if (b.item_id) ({ data: item } = await supa.from('deal_timeline_items').select('*').eq('id', b.item_id).maybeSingle());
      else if (b.item_key) ({ data: item } = await supa.from('deal_timeline_items').select('*').eq('deal_id', b.deal_id).eq('key', b.item_key).maybeSingle());
      if (!item) return fail(res, 404, 'timeline item not found');
      // one pending proposal per item
      const { count } = await supa.from('deal_timeline_proposals')
        .select('id', { count: 'exact', head: true }).eq('item_id', item.id).eq('status', 'pending');
      if (count > 0) return ok(res, { deduped: true });
      const { data: deal } = await supa.from('deals').select('address, city').eq('id', b.deal_id).maybeSingle();
      const { data, error } = await supa.from('deal_timeline_proposals').insert({
        deal_id: b.deal_id, item_id: item.id, item_key: item.key,
        address: deal ? [deal.address, deal.city].filter(Boolean).join(', ') : null,
        change: pick(b.change, ITEM_FIELDS), reason: b.reason || null,
        source: ['cron','cowork','agent','system'].includes(b.source) ? b.source : 'agent'
      }).select().single();
      if (error) return fail(res, 500, error.message);
      return ok(res, { proposal: data });
    }

    if (op === 'approve' || op === 'reject') {
      if (!b?.proposal_id) return fail(res, 400, 'proposal_id required');
      const { data: p } = await supa.from('deal_timeline_proposals').select('*').eq('id', b.proposal_id).maybeSingle();
      if (!p) return fail(res, 404, 'proposal not found');
      if (p.status !== 'pending') return fail(res, 409, `already ${p.status}`);
      if (op === 'approve') {
        const patch = pick(p.change, ITEM_FIELDS);
        if (patch.status === 'done' && !patch.done_at) patch.done_at = new Date().toISOString();
        patch.updated_at = new Date().toISOString();
        const { error: uErr } = await supa.from('deal_timeline_items').update(patch).eq('id', p.item_id);
        if (uErr) return fail(res, 500, uErr.message);
      }
      const { error } = await supa.from('deal_timeline_proposals')
        .update({ status: op === 'approve' ? 'approved' : 'rejected', decided_by: who, decided_at: new Date().toISOString() })
        .eq('id', p.id);
      if (error) return fail(res, 500, error.message);
      return ok(res, { [op === 'approve' ? 'approved' : 'rejected']: true });
    }

    return fail(res, 400, `unknown op: ${op}`);
  } catch (e) {
    return fail(res, 500, e.message);
  }
}
